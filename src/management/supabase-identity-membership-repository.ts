import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { ProviderBindingRecord, UserIdentityRecord } from "../authorization/model";
import type {
  IdentityMembershipRecord,
  IdentityMembershipRepository,
  TenantSummaryRecord,
} from "./identity-membership-resolver";

const ProviderBindingRowSchema = z.object({
  id: z.string().uuid(),
  user_identity_id: z.string().uuid(),
  provider: z.string().min(1),
  provider_subject: z.string().min(1),
  unlinked_at: z.string().nullable(),
});

const UserIdentityRowSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["active", "suspended", "deactivated"]),
});

const MembershipRowSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  status: z.enum(["invited", "active", "suspended", "deactivated"]),
});

const TenantSummaryRowSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  status: z.enum(["provisioning", "active", "suspended", "archived"]),
});

function parseRows<T>(schema: z.ZodType<T>, value: unknown): T[] {
  const parsed = z.array(schema).safeParse(value);
  if (!parsed.success) {
    throw new Error("Identity bootstrap row failed validation.");
  }
  return parsed.data;
}

function requireNoQueryError(error: unknown): void {
  if (error) {
    throw new Error("An unexpected identity bootstrap query error occurred.");
  }
}

/**
 * Server-only adapter for the identity bootstrap. Membership lookup is bound to the id of the verified
 * identity (`findMembershipsForIdentity`); there is deliberately no caller-supplied-id method, no "find
 * all", and no search. It exposes no write method or generic query escape hatch.
 */
export class SupabaseIdentityMembershipRepository implements IdentityMembershipRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findProviderBindings(
    provider: string,
    providerSubject: string,
  ): Promise<ProviderBindingRecord[]> {
    const { data, error } = await this.client
      .from("user_identity_provider_bindings")
      .select("id,user_identity_id,provider,provider_subject,unlinked_at")
      .eq("provider", provider)
      .eq("provider_subject", providerSubject)
      .limit(2);
    requireNoQueryError(error);
    return parseRows(ProviderBindingRowSchema, data).map((row) => ({
      id: row.id,
      userIdentityId: row.user_identity_id,
      provider: row.provider,
      providerSubject: row.provider_subject,
      unlinkedAt: row.unlinked_at,
    }));
  }

  async findUserIdentities(id: string): Promise<UserIdentityRecord[]> {
    const { data, error } = await this.client
      .from("user_identities")
      .select("id,status")
      .eq("id", id)
      .limit(2);
    requireNoQueryError(error);
    return parseRows(UserIdentityRowSchema, data);
  }

  async findMembershipsForIdentity(identityId: string): Promise<IdentityMembershipRecord[]> {
    const { data, error } = await this.client
      .from("memberships")
      .select("id,tenant_id,status")
      .eq("user_identity_id", identityId);
    requireNoQueryError(error);
    return parseRows(MembershipRowSchema, data).map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      status: row.status,
    }));
  }

  async findActiveTenantSummaries(tenantIds: readonly string[]): Promise<TenantSummaryRecord[]> {
    if (tenantIds.length === 0) {
      return [];
    }
    const { data, error } = await this.client
      .from("tenants")
      .select("id,display_name,status")
      .in("id", [...tenantIds])
      .eq("status", "active");
    requireNoQueryError(error);
    return parseRows(TenantSummaryRowSchema, data).map((row) => ({
      id: row.id,
      name: row.display_name,
      status: row.status,
    }));
  }
}

export interface SupabaseIdentityMembershipRepositoryConfiguration {
  readonly url: string;
  readonly serviceRoleKey: string;
}

export function createSupabaseIdentityMembershipRepository(
  configuration: SupabaseIdentityMembershipRepositoryConfiguration,
): SupabaseIdentityMembershipRepository {
  const client = createClient(configuration.url, configuration.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return new SupabaseIdentityMembershipRepository(client);
}
