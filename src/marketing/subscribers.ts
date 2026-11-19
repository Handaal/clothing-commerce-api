import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { AuthorizationContext } from "../authorization";
import { AuthorizationError } from "../authorization/errors";
import type { SubscriberListResponse } from "../contracts/management/subscribers";
import type { StorefrontSubscribeResponse } from "../contracts/storefront/subscribers";
import { ManagementReadPermission } from "../management/visibility";

/** The tenant (or brand) isn't an active storefront. Mapped to 404 by the public runner. */
export class SubscriberError extends Error {
  readonly code = "STOREFRONT_UNAVAILABLE";
  readonly httpStatus = 404;
  constructor() {
    super("This storefront is not available.");
    this.name = "SubscriberError";
  }
}

export interface SubscriberRepository {
  subscribe(input: {
    tenantId: string;
    brandId: string | null;
    email: string;
    source: string;
  }): Promise<void>;
  list(tenantId: string, limit: number): Promise<SubscriberListResponse>;
}

const RowSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  brand_id: z.string().uuid().nullable(),
  source: z.string(),
  created_at: z.string(),
});

/**
 * Server-only adapter. The public write goes through the sanctioned SECURITY DEFINER function
 * (service_role cannot write the table directly); reads select the table with the service role.
 */
export class SupabaseSubscriberRepository implements SubscriberRepository {
  constructor(private readonly client: SupabaseClient) {}

  async subscribe(input: {
    tenantId: string;
    brandId: string | null;
    email: string;
    source: string;
  }) {
    const { error } = await this.client.schema("online_private").rpc("subscribe_storefront_email", {
      p_tenant_id: input.tenantId,
      p_brand_id: input.brandId,
      p_email: input.email,
      p_source: input.source,
    });
    if (error) {
      if (error.code === "MK001") throw new SubscriberError();
      throw new Error("An unexpected sign-up error occurred.");
    }
  }

  async list(tenantId: string, limit: number): Promise<SubscriberListResponse> {
    const { data, error, count } = await this.client
      .from("storefront_subscribers")
      .select("id, email, brand_id, source, created_at", { count: "exact" })
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) throw new Error("An unexpected subscriber read error occurred.");
    return {
      subscribers: (data ?? []).map((raw) => {
        const row = RowSchema.parse(raw);
        return {
          id: row.id,
          email: row.email,
          brandId: row.brand_id,
          source: row.source,
          createdAt: new Date(row.created_at).toISOString(),
        };
      }),
      total: count ?? 0,
    };
  }
}

export class SubscriberService {
  constructor(private readonly repository: SubscriberRepository) {}

  /** PUBLIC: always answers the same way so membership is never revealed. */
  async subscribe(input: {
    tenantId: string;
    brandId?: string;
    email: string;
    source?: string;
  }): Promise<StorefrontSubscribeResponse> {
    await this.repository.subscribe({
      tenantId: input.tenantId,
      brandId: input.brandId ?? null,
      email: input.email,
      source: input.source ?? "website",
    });
    return { subscribed: true };
  }

  async list(context: AuthorizationContext, limit: number): Promise<SubscriberListResponse> {
    const permitted = context.assignments.some((assignment) =>
      assignment.permissionKeys.includes(ManagementReadPermission.orders),
    );
    if (!permitted) throw new AuthorizationError("PERMISSION_DENIED");
    return this.repository.list(context.tenant.id, limit);
  }
}

export function createSupabaseSubscriberRepository(configuration: {
  readonly url: string;
  readonly serviceRoleKey: string;
}): SupabaseSubscriberRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  return new SupabaseSubscriberRepository(client);
}
