import { z } from "zod";
import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import { ReportingError } from "./errors";
import {
  InventoryQuerySchema,
  ProductsQuerySchema,
  PromotionsQuerySchema,
  ReturnsQuerySchema,
  SalesQuerySchema,
  SummaryQuerySchema,
  SuppliersQuerySchema,
  type InventoryQuery,
  type ProductsQuery,
  type PromotionsQuery,
  type ReturnsQuery,
  type SalesQuery,
  type SummaryQuery,
  type SuppliersQuery,
} from "./request";
import type { ReportingRepository } from "./repository";

export const ReportingPermission = { read: "reports.read" } as const;

/** UI guidance: reporting is tenant-wide, so a scoped grant never confers reporting capability. */
export function reportCapabilities(context: AuthorizationContext) {
  const canRead = context.assignments.some(
    (a) => a.scopeMode === "tenant" && a.permissionKeys.includes(ReportingPermission.read),
  );
  return { canRead };
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ReportingError("INVALID_REPORT_QUERY");
  return result.data;
}

export class ReportingService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: ReportingRepository,
  ) {}

  // No resource target: the shared authorizer requires a permission-coupled tenant-wide grant. A
  // brand/branch-scoped reports.read grant therefore cannot become tenant-wide reporting.
  private authorize(context: AuthorizationContext) {
    return this.authorization.authorize(context, { permissionKey: ReportingPermission.read });
  }

  async summary(context: AuthorizationContext, query: SummaryQuery) {
    return this.repository.summary(await this.authorize(context), parse(SummaryQuerySchema, query));
  }

  async sales(context: AuthorizationContext, query: SalesQuery) {
    return this.repository.sales(await this.authorize(context), parse(SalesQuerySchema, query));
  }

  async products(context: AuthorizationContext, query: ProductsQuery) {
    return this.repository.products(
      await this.authorize(context),
      parse(ProductsQuerySchema, query),
    );
  }

  async inventory(context: AuthorizationContext, query: InventoryQuery) {
    const parsed = parse(InventoryQuerySchema, query);
    // Current balances are current state (no period); every other view is event-period bound.
    if (parsed.view !== "balances" && (!parsed.startDate || !parsed.endDate)) {
      throw new ReportingError("INVALID_REPORT_QUERY");
    }
    return this.repository.inventory(await this.authorize(context), {
      ...parsed,
      startDate: parsed.startDate ?? null,
      endDate: parsed.endDate ?? null,
    });
  }

  async returns(context: AuthorizationContext, query: ReturnsQuery) {
    return this.repository.returns(await this.authorize(context), parse(ReturnsQuerySchema, query));
  }

  async promotions(context: AuthorizationContext, query: PromotionsQuery) {
    return this.repository.promotions(
      await this.authorize(context),
      parse(PromotionsQuerySchema, query),
    );
  }

  async suppliers(context: AuthorizationContext, query: SuppliersQuery) {
    return this.repository.suppliers(
      await this.authorize(context),
      parse(SuppliersQuerySchema, query),
    );
  }
}
