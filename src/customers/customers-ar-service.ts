import { z } from "zod";
import { type AuthorizationContext, type AuthorizationService } from "../authorization";
import {
  RecordCustomerPaymentRequestSchema,
  type RecordCustomerPaymentRequest,
} from "../contracts/management/customers";
import { CustomerArError } from "./customers-ar-errors";
import type { CustomersArRepository } from "./customers-ar-repository";

/**
 * Customer accounts-receivable (installments) write service. Recording a paydown captures money from the
 * customer, so it is gated on `payments.capture` (the same grant a register uses to take payment); reading
 * dues and payment history reuses the commerce read grant (`orders.read`). Both gates are tenant-wide:
 * installments are a tenant-global ledger with no branch/brand scope, mirroring suppliers' payables.
 */
export const CustomerArPermission = {
  recordPayment: "payments.capture",
  read: "orders.read",
} as const;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CustomerArError("INVALID_CUSTOMER_PAYMENT");
  return result.data;
}

export class CustomersArService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: CustomersArRepository,
  ) {}

  private authorize(context: AuthorizationContext, permissionKey: string) {
    // No resource target: the shared authorizer requires a permission-coupled tenant-wide grant.
    return this.authorization.authorize(context, { permissionKey });
  }

  async recordPayment(
    context: AuthorizationContext,
    customerId: string,
    key: string,
    input: RecordCustomerPaymentRequest,
  ) {
    return this.repository.recordPayment(
      await this.authorize(context, CustomerArPermission.recordPayment),
      parse(z.string().uuid(), customerId),
      key,
      parse(RecordCustomerPaymentRequestSchema, input),
    );
  }

  async payments(context: AuthorizationContext, customerId: string) {
    return this.repository.listPayments(
      await this.authorize(context, CustomerArPermission.read),
      parse(z.string().uuid(), customerId),
    );
  }

  async dues(context: AuthorizationContext) {
    return this.repository.dues(await this.authorize(context, CustomerArPermission.read));
  }
}
