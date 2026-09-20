import {
  type AuthorizationContext,
  type AuthorizationResource,
  type AuthorizationService,
} from "../authorization";
import { AuthorizationError } from "../authorization/errors";
import {
  CreateReturnRequestSchema,
  type CreateReturnRequest,
  type SettleRefundRequest,
} from "../contracts/management/returns";
import { ReturnError } from "./errors";
import type { ReturnsRepository } from "./repository";

/** Authorization precedes all business reads/writes, including idempotent replay. The database owns
 * serialized quantity/money eligibility and the atomic return/receipt/refund transaction. */
export class ReturnsService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly repository: ReturnsRepository,
  ) {}
  private async authorize(context: AuthorizationContext, orderId: string, permissionKey: string) {
    const routing = await this.repository.orderRouting(context.tenant.id, orderId);
    const resource: AuthorizationResource =
      routing.channel === "online"
        ? { kind: "brand", id: routing.brand_id }
        : { kind: "branch", id: routing.branch_id! };
    return this.authorization.authorize(context, { permissionKey, resources: [resource] });
  }
  async eligibility(context: AuthorizationContext, orderId: string) {
    return this.repository.eligibility(
      await this.authorize(context, orderId, "returns.read"),
      orderId,
    );
  }
  async history(context: AuthorizationContext, orderId: string, limit = 25, cursor?: string) {
    return this.repository.history(
      await this.authorize(context, orderId, "returns.read"),
      orderId,
      limit,
      cursor,
    );
  }
  async detail(context: AuthorizationContext, returnId: string) {
    const orderId = await this.repository.returnOrderId(context.tenant.id, returnId);
    return this.repository.detail(await this.authorize(context, orderId, "returns.read"), returnId);
  }
  async create(
    context: AuthorizationContext,
    orderId: string,
    key: string,
    input: CreateReturnRequest,
    source: "admin-mobile" | "pos" | "management",
  ) {
    const parsed = CreateReturnRequestSchema.safeParse(input);
    if (!parsed.success) throw new ReturnError("INVALID_RETURN");
    const command = parsed.data;
    if (new Set(command.lines.map((l) => l.orderLineId)).size !== command.lines.length)
      throw new ReturnError("INVALID_RETURN");
    const restock = command.lines.some((l) => l.disposition === "restock");
    if (
      restock !== (command.inventoryLocationId !== null) ||
      (command.refundMode === "manual_confirmed") !== (command.settlementReference !== null)
    )
      throw new ReturnError("INVALID_RETURN");
    const proof = await this.authorize(context, orderId, "returns.create");
    await this.authorize(context, orderId, "payments.refund");
    if (command.inventoryLocationId)
      await this.authorization.authorize(context, {
        permissionKey: "inventory.receive",
        resources: [{ kind: "inventory_location", id: command.inventoryLocationId }],
      });
    return this.repository.create(proof, orderId, key, source, command);
  }
  async settle(
    context: AuthorizationContext,
    returnId: string,
    key: string,
    input: SettleRefundRequest,
  ) {
    const orderId = await this.repository.returnOrderId(context.tenant.id, returnId);
    return this.repository.settle(
      await this.authorize(context, orderId, "payments.refund"),
      returnId,
      key,
      input.settlementReference,
    );
  }
  async summaryIfAuthorized(context: AuthorizationContext, orderId: string) {
    try {
      return await this.repository.summary(
        await this.authorize(context, orderId, "returns.read"),
        orderId,
      );
    } catch (error) {
      if (error instanceof AuthorizationError) return undefined;
      throw error;
    }
  }
}
