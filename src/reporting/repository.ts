import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  InventoryReportResponseSchema,
  ProductsReportResponseSchema,
  PromotionsReportResponseSchema,
  ReportSummaryResponseSchema,
  ReturnsReportResponseSchema,
  SalesReportResponseSchema,
  SuppliersReportResponseSchema,
} from "../contracts/management/reporting";
import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import { InvalidCursorError } from "../management/cursor";
import { reportingDatabaseError } from "./errors";
import { EXPORT_DATASETS } from "./export";
import type { ReportExportDataset } from "../contracts/management/reporting-export";
import type {
  InventoryQuery,
  ProductsQuery,
  PromotionsQuery,
  ReturnsQuery,
  SalesQuery,
  SuppliersQuery,
  SummaryQuery,
} from "./request";

/**
 * The reporting read boundary. Every method derives the tenant from the verified authorization proof and
 * calls one sanctioned reporting_private RPC; no report SQL, aggregation, or currency math lives in TS.
 * The database returns an offset-based `pageInfo`; the repository re-encodes it as the platform's opaque
 * forward cursor so clients never construct offsets or URLs.
 */

export function encodeReportingCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset })).toString("base64url");
}

export function decodeReportingCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { v?: unknown }).v === 1 &&
      Number.isSafeInteger((value as { o?: unknown }).o) &&
      (value as { o: number }).o >= 0
    ) {
      return (value as { o: number }).o;
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError();
}

/** Rewrites the DB `{ hasMore, nextOffset }` page info to the external `{ hasMore, nextCursor }`. */
function withCursor(raw: unknown): unknown {
  if (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { pageInfo?: unknown }).pageInfo === "object" &&
    (raw as { pageInfo: { nextOffset?: unknown } }).pageInfo !== null
  ) {
    const record = raw as { pageInfo: { hasMore: boolean; nextOffset: number | null } };
    const nextOffset = record.pageInfo.nextOffset;
    return {
      ...record,
      pageInfo: {
        hasMore: record.pageInfo.hasMore,
        nextCursor: nextOffset === null ? null : encodeReportingCursor(nextOffset),
      },
    };
  }
  return raw;
}

export class ReportingRepository {
  constructor(private readonly client: SupabaseClient) {}

  private tenant(proof: AuthorizedOperationContext) {
    assertAuthorizedOperationProof(proof);
    return proof.authorization.tenant.id;
  }

  private async call(fn: string, args: Record<string, unknown>) {
    const { data, error } = await this.client.schema("reporting_private").rpc(fn, args);
    if (error) throw reportingDatabaseError(error);
    return data;
  }

  async summary(proof: AuthorizedOperationContext, query: SummaryQuery) {
    return ReportSummaryResponseSchema.parse(
      await this.call("report_summary", {
        p_tenant: this.tenant(proof),
        p_from: query.startDate,
        p_to: query.endDate,
      }),
    );
  }

  async sales(proof: AuthorizedOperationContext, query: SalesQuery) {
    return SalesReportResponseSchema.parse(
      await this.call("report_sales", {
        p_tenant: this.tenant(proof),
        p_from: query.startDate,
        p_to: query.endDate,
        p_view: query.view,
        p_bucket: query.bucket,
      }),
    );
  }

  async products(proof: AuthorizedOperationContext, query: ProductsQuery) {
    return ProductsReportResponseSchema.parse(
      withCursor(
        await this.call("report_products", {
          p_tenant: this.tenant(proof),
          p_from: query.startDate,
          p_to: query.endDate,
          p_level: query.level,
          p_view: query.view,
          p_limit: query.limit,
          p_offset: decodeReportingCursor(query.cursor),
        }),
      ),
    );
  }

  async inventory(
    proof: AuthorizedOperationContext,
    query: Omit<InventoryQuery, "startDate" | "endDate"> & {
      startDate: string | null;
      endDate: string | null;
    },
  ) {
    return InventoryReportResponseSchema.parse(
      withCursor(
        await this.call("report_inventory", {
          p_tenant: this.tenant(proof),
          p_from: query.startDate,
          p_to: query.endDate,
          p_view: query.view,
          p_limit: query.limit,
          p_offset: decodeReportingCursor(query.cursor),
        }),
      ),
    );
  }

  async returns(proof: AuthorizedOperationContext, query: ReturnsQuery) {
    return ReturnsReportResponseSchema.parse(
      withCursor(
        await this.call("report_returns", {
          p_tenant: this.tenant(proof),
          p_from: query.startDate,
          p_to: query.endDate,
          p_view: query.view,
          p_limit: query.limit,
          p_offset: decodeReportingCursor(query.cursor),
        }),
      ),
    );
  }

  async promotions(proof: AuthorizedOperationContext, query: PromotionsQuery) {
    return PromotionsReportResponseSchema.parse(
      await this.call("report_promotions", {
        p_tenant: this.tenant(proof),
        p_from: query.startDate,
        p_to: query.endDate,
      }),
    );
  }

  async suppliers(proof: AuthorizedOperationContext, query: SuppliersQuery) {
    return SuppliersReportResponseSchema.parse(
      withCursor(
        await this.call("report_suppliers", {
          p_tenant: this.tenant(proof),
          p_from: query.startDate,
          p_to: query.endDate,
          p_limit: query.limit,
          p_offset: decodeReportingCursor(query.cursor),
        }),
      ),
    );
  }

  /**
   * Fetches one bounded export dataset. Delegates to the dataset's sanctioned reporting_private RPC, which
   * derives its own currency/period math, enforces the row bound (RP413 on overflow — never truncates),
   * and returns `{ period, rows }`. The rows are validated against the dataset's row contract here.
   */
  async export(
    proof: AuthorizedOperationContext,
    query: {
      dataset: ReportExportDataset;
      startDate: string;
      endDate: string;
      level: string;
      maxRows: number;
    },
  ) {
    const config = EXPORT_DATASETS[query.dataset];
    const args: Record<string, unknown> = {
      p_tenant: this.tenant(proof),
      p_from: query.startDate,
      p_to: query.endDate,
      p_max_rows: query.maxRows,
    };
    if (config.usesLevel) {
      args.p_level = query.level;
    }
    return config.parse(await this.call(config.rpc, args));
  }
}

export function createReportingRepository(configuration: { url: string; serviceRoleKey: string }) {
  return new ReportingRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
