import { createClerkRequestVerifier } from "../authentication/clerk-request-verifier";
import { CompositeExternalIdentityVerifier } from "../authentication/composite-external-identity-verifier";
import { PosTokenVerifier } from "../authentication/pos-token";
import { createClerkStaffLoginProvisioner } from "../authentication/staff-login-provisioner";
import { createServerAuthorizationBoundary } from "../authentication/server-authorization-boundary";
import { CatalogReadService } from "../catalog/catalog-read-service";
import { createSupabaseCatalogReadRepository } from "../catalog/supabase-catalog-read-repository";
import { CatalogManagementService } from "../catalog/catalog-management-service";
import { createSupabaseCatalogWriteRepository } from "../catalog/supabase-catalog-write-repository";
import { StorefrontCatalogService } from "../catalog/storefront-catalog-service";
import { createSupabaseStorefrontCatalogRepository } from "../catalog/storefront-catalog-repository";
import { CollectionManagementService } from "../catalog/collection-management-service";
import { createSupabaseCollectionRepository } from "../catalog/collection-repository";
import { StorefrontCollectionService } from "../catalog/storefront-collection-service";
import { createSupabaseStorefrontCollectionRepository } from "../catalog/storefront-collection-repository";
import { CategoryService } from "../catalog/category-service";
import { createSupabaseCategoryRepository } from "../catalog/category-repository";
import { SubscriberService, createSupabaseSubscriberRepository } from "../marketing/subscribers";
import {
  readClerkVerifierConfiguration,
  readOfflinePinV2Enabled,
  readOfflineCachedVouchersEnabled,
  readPosAuthSigningConfiguration,
  readSupabasePrivilegedConfiguration,
} from "../config/auth-environment";
import { FulfillmentService } from "../fulfillments";
import { createSupabaseFulfillmentRepository } from "../fulfillments";
import { InventoryReadService } from "../inventory/inventory-read-service";
import { createSupabaseInventoryReadRepository } from "../inventory/supabase-inventory-read-repository";
import { InventoryService } from "../inventory/inventory-service";
import { createSupabaseInventoryRepository } from "../inventory/supabase-inventory-repository";
import { InventoryChannelService } from "../inventory/channel-service";
import { createSupabaseInventoryChannelRepository } from "../inventory/supabase-inventory-channel-repository";
import { OrderService } from "../orders";
import { createSupabaseOrdersRepository } from "../orders";
import { OrdersReadService } from "../orders/orders-read-service";
import { OnlineOrderOperationsService } from "../orders/online-order-operations-service";
import { CustomersReadService, CustomersArService } from "../customers";
import {
  createSupabaseCustomersReadRepository,
  createSupabaseCustomersArRepository,
} from "../customers";
import { SuppliersService } from "../suppliers/service";
import { createSuppliersRepository } from "../suppliers/repository";
import { StaffService } from "../staff/service";
import { createStaffRepository } from "../staff/repository";
import { AttendanceService } from "../attendance/service";
import { createAttendanceRepository } from "../attendance/repository";
import { PromotionsService } from "../promotions/service";
import { MerchandisingService } from "../merchandising/service";
import { createMerchandisingRepository } from "../merchandising/repository";
import { createSupabaseMediaUploadSigner } from "../merchandising/storage-signer";
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
  PosAuthService,
  PosSaleService,
  createPosAuthRepository,
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
  const posAuthSigningConfiguration = readPosAuthSigningConfiguration(environment);

  const { contextResolver, authorizationService } = createServerAuthorizationBoundary(environment);
  // POS-native (pos_pin) tokens must bootstrap identity too (/me/tenants, /me/context), not just Clerk —
  // the POS floor carries a pos token on every request. Mirror the authorization boundary's composite so
  // the identity resolver accepts both; dormant (Clerk-only) when POS_AUTH_SIGNING_KEY is unset.
  const posIdentityVerifier = posAuthSigningConfiguration
    ? new PosTokenVerifier(new Uint8Array(posAuthSigningConfiguration.signingKey))
    : null;
  const identityVerifier = new CompositeExternalIdentityVerifier(
    createClerkRequestVerifier(clerkConfiguration),
    posIdentityVerifier,
  );

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
  // One Storage signer for every server-chosen media destination (product media + storefront hero).
  // It returns null when Storage is unreachable, which the contract models as uploadUrl: null.
  const mediaUploadSigner = createSupabaseMediaUploadSigner(supabaseConfiguration);
  const catalogManagementService = new CatalogManagementService(
    authorizationService,
    createSupabaseCatalogWriteRepository(supabaseConfiguration),
    mediaUploadSigner,
  );

  // The public Storefront read surface over the DB-enforced published-only boundary.
  const storefrontCatalogService = new StorefrontCatalogService(
    createSupabaseStorefrontCatalogRepository(supabaseConfiguration),
  );

  // Collections: tenant-wide merchandising groupings. The management surface authorizes catalog.author
  // tenant-wide; the public surface reads the DB-enforced published-only collection boundary.
  const collectionManagementService = new CollectionManagementService(
    authorizationService,
    createSupabaseCollectionRepository(supabaseConfiguration),
  );
  const storefrontCollectionService = new StorefrontCollectionService(
    createSupabaseStorefrontCollectionRepository(supabaseConfiguration),
  );
  // Categories: tenant-wide taxonomy (catalog.author) plus the published-only public list.
  const categoryService = new CategoryService(
    authorizationService,
    createSupabaseCategoryRepository(supabaseConfiguration),
  );

  // Storefront email sign-ups: public subscribe + management list (orders.read).
  const subscriberService = new SubscriberService(
    createSupabaseSubscriberRepository(supabaseConfiguration),
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
  const ordersReadRepository = createSupabaseOrdersReadRepository(supabaseConfiguration);
  const ordersReadService = new OrdersReadService(
    ordersReadRepository,
    orderService,
    fulfillmentService,
    returnsService,
  );
  // Staff fulfil/cancel of ONLINE orders over the canonical Order + Fulfillment services.
  const onlineOrderOperationsService = new OnlineOrderOperationsService(
    orderService,
    fulfillmentService,
    ordersReadService,
    ordersReadRepository,
  );
  const customersReadService = new CustomersReadService(
    createSupabaseCustomersReadRepository(supabaseConfiguration),
  );
  const customersArService = new CustomersArService(
    authorizationService,
    createSupabaseCustomersArRepository(supabaseConfiguration),
  );
  const posSaleService = new PosSaleService(
    authorizationService,
    createSupabasePosSaleRepository(supabaseConfiguration),
    createSupabaseOrdersRepository(supabaseConfiguration),
  );

  // POS-native (pos_pin) authentication: public connected sign-in + admin account management. Dormant
  // (login rejects with a clear config error) when POS_AUTH_SIGNING_KEY is unset.
  const posAuthService = new PosAuthService(
    authorizationService,
    createPosAuthRepository(supabaseConfiguration),
    posAuthSigningConfiguration,
  );
  const offlinePosService = new OfflinePosService(
    authorizationService,
    createSupabasePosSaleRepository(supabaseConfiguration),
    createSupabaseOfflinePosRepository(supabaseConfiguration),
    null, // retired OFFLINE_PIN_KEK slot (ignored)
    (username, pin) => posAuthService.reauthenticate(username, pin),
    readOfflineCachedVouchersEnabled(environment),
    readOfflinePinV2Enabled(environment),
  );

  return {
    contextResolver,
    identityMembershipResolver,
    contextService,
    catalogReadService,
    catalogManagementService,
    storefrontCatalogService,
    collectionManagementService,
    storefrontCollectionService,
    categoryService,
    subscriberService,
    inventoryReadService,
    inventoryService,
    // ADR-042 Website/POS channel stock (read + initialize + admin split). Enforcement is not reachable here.
    inventoryChannelService: new InventoryChannelService(
      authorizationService,
      createSupabaseInventoryChannelRepository(supabaseConfiguration),
    ),
    ordersReadService,
    onlineOrderOperationsService,
    customersReadService,
    customersArService,
    returnsService,
    suppliersService: new SuppliersService(
      authorizationService,
      createSuppliersRepository(supabaseConfiguration),
    ),
    staffService: new StaffService(
      authorizationService,
      createStaffRepository(supabaseConfiguration),
      createClerkStaffLoginProvisioner({
        secretKey: clerkConfiguration.secretKey,
        publishableKey: clerkConfiguration.publishableKey,
      }),
    ),
    attendanceService: new AttendanceService(
      authorizationService,
      createAttendanceRepository(supabaseConfiguration),
    ),
    // Storefront merchandising: catalog sales (promotions.* permissions) and home-page content
    // (catalog.author), plus the public content read.
    merchandisingService: new MerchandisingService(
      authorizationService,
      createMerchandisingRepository(supabaseConfiguration),
      mediaUploadSigner,
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
    posAuthService,
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
