import { createClerkRequestVerifier } from "../authentication/clerk-request-verifier";
import { createServerAuthorizationBoundary } from "../authentication/server-authorization-boundary";
import { CatalogReadService } from "../catalog/catalog-read-service";
import { createSupabaseCatalogReadRepository } from "../catalog/supabase-catalog-read-repository";
import { CatalogManagementService } from "../catalog/catalog-management-service";
import { createSupabaseCatalogWriteRepository } from "../catalog/supabase-catalog-write-repository";
import { StorefrontCatalogService } from "../catalog/storefront-catalog-service";
import { createSupabaseStorefrontCatalogRepository } from "../catalog/storefront-catalog-repository";
import {
  readClerkVerifierConfiguration,
  readSupabasePrivilegedConfiguration,
} from "../config/auth-environment";
import { FulfillmentService } from "../fulfillments";
import { createSupabaseFulfillmentRepository } from "../fulfillments";
import { InventoryReadService } from "../inventory/inventory-read-service";
import { createSupabaseInventoryReadRepository } from "../inventory/supabase-inventory-read-repository";
import { InventoryService } from "../inventory/inventory-service";
import { createSupabaseInventoryRepository } from "../inventory/supabase-inventory-repository";
import { OrderService } from "../orders";
import { createSupabaseOrdersRepository } from "../orders";
import { OrdersReadService } from "../orders/orders-read-service";
import { CustomersReadService } from "../customers";
import { createSupabaseCustomersReadRepository } from "../customers";
import { SuppliersService } from "../suppliers/service";
import { createSuppliersRepository } from "../suppliers/repository";
import { StaffService } from "../staff/service";
import { createStaffRepository } from "../staff/repository";
import { AttendanceService } from "../attendance/service";
import { createAttendanceRepository } from "../attendance/repository";
import { PromotionsService } from "../promotions/service";
import { createPromotionsRepository } from "../promotions/repository";
import { ReportingService } from "../reporting/service";
import { createReportingRepository } from "../reporting/repository";
import { SettingsService } from "../settings/service";
import { createSettingsRepository } from "../settings/repository";
import { ReturnsService } from "../returns/service";
import { createReturnsRepository } from "../returns/repository";
import { createSupabaseOrdersReadRepository } from "../orders/supabase-orders-read-repository";
import {
  OfflinePosService,
  PosSaleService,
  createSupabaseOfflinePosRepository,
  createSupabasePosSaleRepository,
} from "../pos";
import { ManagementContextService } from "./context-service";
import { IdentityMembershipResolver } from "./identity-membership-resolver";
import { createSupabaseIdentityMembershipRepository } from "./supabase-identity-membership-repository";
import { createSupabaseOrganizationReadRepository } from "./supabase-organization-read-repository";

/**
 * Production composition root for the management API. Creating it validates all server-only configuration
 * once. It wires the identity bootstrap resolver, the tenant authorization context resolver, and every
 * read service. No secret or privileged client escapes this boundary.
 */
export function createManagementApiBoundary(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const clerkConfiguration = readClerkVerifierConfiguration(environment);
  const supabaseConfiguration = readSupabasePrivilegedConfiguration(environment);

  const { contextResolver, authorizationService } = createServerAuthorizationBoundary(environment);
  const identityVerifier = createClerkRequestVerifier(clerkConfiguration);

  const identityMembershipResolver = new IdentityMembershipResolver(
    identityVerifier,
    createSupabaseIdentityMembershipRepository(supabaseConfiguration),
  );

  const contextService = new ManagementContextService(
    createSupabaseOrganizationReadRepository(supabaseConfiguration),
  );

  const catalogReadService = new CatalogReadService(
    createSupabaseCatalogReadRepository(supabaseConfiguration),
  );

  // The Phase 2J catalog WRITE surface. It authorizes catalog.author / catalog.publish against the
  // target product's brand before any privileged database access.
  const catalogManagementService = new CatalogManagementService(
    authorizationService,
    createSupabaseCatalogWriteRepository(supabaseConfiguration),
  );

  // The public Storefront read surface over the DB-enforced published-only boundary.
  const storefrontCatalogService = new StorefrontCatalogService(
    createSupabaseStorefrontCatalogRepository(supabaseConfiguration),
  );

  const inventoryReadService = new InventoryReadService(
    createSupabaseInventoryReadRepository(supabaseConfiguration),
  );

  // The Phase 2G inventory WRITE surface. It authorizes every command against the target inventory
  // location(s) via the shared authorization service before any privileged database access.
  const inventoryService = new InventoryService(
    authorizationService,
    createSupabaseInventoryRepository(supabaseConfiguration),
  );

  const orderService = new OrderService(
    authorizationService,
    createSupabaseOrdersRepository(supabaseConfiguration),
  );
  const fulfillmentService = new FulfillmentService(
    authorizationService,
    createSupabaseFulfillmentRepository(supabaseConfiguration),
  );
  const returnsService = new ReturnsService(
    authorizationService,
    createReturnsRepository(supabaseConfiguration),
  );
  const ordersReadService = new OrdersReadService(
    createSupabaseOrdersReadRepository(supabaseConfiguration),
    orderService,
    fulfillmentService,
    returnsService,
  );
  const customersReadService = new CustomersReadService(
    createSupabaseCustomersReadRepository(supabaseConfiguration),
  );
  const posSaleService = new PosSaleService(
    authorizationService,
    createSupabasePosSaleRepository(supabaseConfiguration),
    createSupabaseOrdersRepository(supabaseConfiguration),
  );
  const offlinePosService = new OfflinePosService(
    authorizationService,
    createSupabasePosSaleRepository(supabaseConfiguration),
    createSupabaseOfflinePosRepository(supabaseConfiguration),
  );

  return {
    contextResolver,
    identityMembershipResolver,
    contextService,
    catalogReadService,
    catalogManagementService,
    storefrontCatalogService,
    inventoryReadService,
    inventoryService,
    ordersReadService,
    customersReadService,
    returnsService,
    suppliersService: new SuppliersService(
      authorizationService,
      createSuppliersRepository(supabaseConfiguration),
    ),
    staffService: new StaffService(
      authorizationService,
      createStaffRepository(supabaseConfiguration),
    ),
    attendanceService: new AttendanceService(
      authorizationService,
      createAttendanceRepository(supabaseConfiguration),
    ),
    promotionsService: new PromotionsService(
      authorizationService,
      createPromotionsRepository(supabaseConfiguration),
    ),
    reportingService: new ReportingService(
      authorizationService,
      createReportingRepository(supabaseConfiguration),
    ),
    settingsService: new SettingsService(
      authorizationService,
      createSettingsRepository(supabaseConfiguration),
    ),
    posSaleService,
    offlinePosService,
  } as const;
}

export type ManagementApiBoundary = ReturnType<typeof createManagementApiBoundary>;

let cachedBoundary: ManagementApiBoundary | undefined;

/**
 * Lazily-memoized production boundary for the route handlers. It is created on first request (not at
 * module load) so configuration is validated in the request runtime, and reused thereafter.
 */
export function getManagementApiBoundary(): ManagementApiBoundary {
  cachedBoundary ??= createManagementApiBoundary();
  return cachedBoundary;
}
