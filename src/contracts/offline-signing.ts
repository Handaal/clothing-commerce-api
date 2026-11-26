import {
  OfflineAttendanceCommandSchema,
  OfflineCustomerCommandSchema,
  OfflineCustomerPaymentCommandSchema,
  OfflineIntentCommandSchema,
  OfflineReturnCommandSchema,
  OfflineSaleCommandSchema,
  OfflineSaleHoldCommandSchema,
  type OfflineAttendanceCommand,
  type OfflineCustomerCommand,
  type OfflineCustomerPaymentCommand,
  type OfflineIntentCommand,
  type OfflineReturnCommand,
  type OfflineSaleCommand,
  type OfflineSaleHoldCommand,
} from "./pos";

/**
 * RFC 8785-style canonical JSON for the Phase 2I command subset. The schema permits only objects,
 * arrays, strings, booleans, null, and safe integers, so lexicographic key ordering plus JSON's
 * primitive encoding is cross-runtime deterministic.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new TypeError("Canonical offline numbers must be safe integers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    // Drop absent optional fields (value === undefined) so an omitted key and an explicit `undefined`
    // encode identically — a fully-settled sale that carries no installment fields signs byte-for-byte
    // as a pre-installment client did, regardless of how the command object was assembled.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Unsupported value in canonical offline command.");
}

export function canonicalizeOfflineSaleCommand(command: OfflineSaleCommand): string {
  return canonicalJson(OfflineSaleCommandSchema.parse(command));
}

export function canonicalizeOfflineCustomerPaymentCommand(
  command: OfflineCustomerPaymentCommand,
): string {
  return canonicalJson(OfflineCustomerPaymentCommandSchema.parse(command));
}

export function canonicalizeOfflineAttendanceCommand(command: OfflineAttendanceCommand): string {
  return canonicalJson(OfflineAttendanceCommandSchema.parse(command));
}

export function canonicalizeOfflineIntentCommand(command: OfflineIntentCommand): string {
  return canonicalJson(OfflineIntentCommandSchema.parse(command));
}

export function canonicalizeOfflineReturnCommand(command: OfflineReturnCommand): string {
  return canonicalJson(OfflineReturnCommandSchema.parse(command));
}

export function canonicalizeOfflineCustomerCommand(command: OfflineCustomerCommand): string {
  return canonicalJson(OfflineCustomerCommandSchema.parse(command));
}

export function canonicalizeOfflineSaleHoldCommand(command: OfflineSaleHoldCommand): string {
  return canonicalJson(OfflineSaleHoldCommandSchema.parse(command));
}
