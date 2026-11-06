import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertAuthorizedOperationProof, type AuthorizedOperationContext } from "../authorization";
import {
  RecordCustomerPaymentResponseSchema,
  CustomerPaymentsResponseSchema,
  CustomerDuesResponseSchema,
  type RecordCustomerPaymentRequest,
} from "../contracts/management/customers";
import { customerArDatabaseError } from "./customers-ar-errors";

/**
 * Service-role repository for the customer accounts-receivable (installments) write surface. It calls the
 * SECURITY DEFINER functions in customers_ar_private; the role gating lives in those grants, so this
 * repository only forwards the already-authorized tenant/actor and parses the jsonb responses.
 */
export interface CustomersArRepository {
  recordPayment(
    proof: AuthorizedOperationContext,
    customerId: string,
    key: string,
    input: RecordCustomerPaymentRequest,
  ): Promise<ReturnType<typeof RecordCustomerPaymentResponseSchema.parse>>;
  listPayments(
    proof: AuthorizedOperationContext,
    customerId: string,
  ): Promise<ReturnType<typeof CustomerPaymentsResponseSchema.parse>>;
  dues(
    proof: AuthorizedOperationContext,
  ): Promise<ReturnType<typeof CustomerDuesResponseSchema.parse>>;
}

export class SupabaseCustomersArRepository implements CustomersArRepository {
  constructor(private readonly client: SupabaseClient) {}

  private tenant(proof: AuthorizedOperationContext) {
    assertAuthorizedOperationProof(proof);
    return proof.authorization.tenant.id;
  }

  async recordPayment(
    proof: AuthorizedOperationContext,
    customerId: string,
    key: string,
    input: RecordCustomerPaymentRequest,
  ) {
    const { data, error } = await this.client
      .schema("customers_ar_private")
      .rpc("record_customer_payment", {
        p_tenant: this.tenant(proof),
        p_customer: customerId,
        p_actor: proof.authorization.membership.id,
        p_key: key,
        p_input: input,
      });
    if (error) throw customerArDatabaseError(error);
    return RecordCustomerPaymentResponseSchema.parse(data);
  }

  async listPayments(proof: AuthorizedOperationContext, customerId: string) {
    const { data, error } = await this.client
      .schema("customers_ar_private")
      .rpc("list_customer_payments", {
        p_tenant: this.tenant(proof),
        p_customer: customerId,
        p_limit: 200,
      });
    if (error) throw customerArDatabaseError(error);
    return CustomerPaymentsResponseSchema.parse({ items: data });
  }

  async dues(proof: AuthorizedOperationContext) {
    const { data, error } = await this.client
      .schema("customers_ar_private")
      .rpc("customer_dues", { p_tenant: this.tenant(proof) });
    if (error) throw customerArDatabaseError(error);
    return CustomerDuesResponseSchema.parse({ items: data });
  }
}

export function createSupabaseCustomersArRepository(configuration: {
  url: string;
  serviceRoleKey: string;
}) {
  return new SupabaseCustomersArRepository(
    createClient(configuration.url, configuration.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  );
}
