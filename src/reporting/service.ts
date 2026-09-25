import { z } from "zod";
import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import { EXPORT_MAX_RANGE_DAYS, EXPORT_MAX_ROWS } from "../contracts/management/reporting-export";
import { ReportingError } from "./errors";
import { EXPORT_MEDIA_TYPE, exportFilename, renderExportCsv } from "./export";
import {
  ExportQuerySchema,
  InventoryQuerySchema,
  ProductsQuerySchema,
  PromotionsQuerySchema,
  ReturnsQuerySchema,
  SalesQuerySchema,
  SummaryQuerySchema,
  SuppliersQuerySchema,
  type ExportQuery,
  type InventoryQuery,
  type ProductsQuery,
  type PromotionsQuery,
  type ReturnsQuery,
  type SalesQuery,
  type SummaryQuery,
  type SuppliersQuery,
} from "./request";
import type { ReportingRepository } from "./repository";

/** A rendered export document: the CSV body plus the metadata a client needs to save it. */
export interface ReportExportDocument {
  readonly filename: string;
  readonly mediaType: string;
  readonly body: string;
}

/** Inclusive tenant-local calendar-day span, e.g. the same day counts as 1. */
function inclusiveCalendarDays(startDate: string, endDate: string): number {
  const from = Date.parse(`${startDate}T00:00:00Z`);
  const to = Date.parse(`${endDate}T00:00:00Z`);
  return Math.floor((to - from) / 86_400_000) + 1;
}

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

  /**
   * Produces one bounded CSV export. Authorization is the SAME tenant-wide reports.read as the JSON
   * reports (no export permission). The date range is bounded here (EXPORT_RANGE_TOO_LARGE); the row bound
   * is enforced in the RPC (EXPORT_TOO_MANY_ROWS) — neither ever silently truncates. Returns the CSV body
   * plus its media type and download filename so the caller never constructs the payload itself.
   */
  async export(context: AuthorizationContext, query: ExportQuery): Promise<ReportExportDocument> {
    const parsed = parse(ExportQuerySchema, query);
    // Authorize before doing any bound work, then enforce the date bound before touching persistence.
    const proof = await this.authorize(context);
    if (inclusiveCalendarDays(parsed.startDate, parsed.endDate) > EXPORT_MAX_RANGE_DAYS) {
      throw new ReportingError("EXPORT_RANGE_TOO_LARGE");
    }
    const { rows } = await this.repository.export(proof, {
      dataset: parsed.dataset,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      level: parsed.level,
      maxRows: EXPORT_MAX_ROWS,
    });
    return {
      filename: exportFilename(parsed.dataset, parsed.startDate, parsed.endDate),
      mediaType: EXPORT_MEDIA_TYPE,
      body: renderExportCsv(parsed.dataset, rows),
    };
  }
}
