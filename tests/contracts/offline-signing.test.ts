import { describe, expect, it } from "vitest";

import { canonicalizeOfflineSaleCommand, type OfflineSaleCommand } from "../../src/contracts";

const command: OfflineSaleCommand = {
  schemaVersion: 1,
  localSaleId: "local-1",
  syncCommandId: "10000000-0000-4000-8000-000000000001",
  grantId: "10000000-0000-4000-8000-000000000002",
  deviceId: "10000000-0000-4000-8000-000000000003",
  registerId: "10000000-0000-4000-8000-000000000004",
  acceptedAt: "2026-09-06T10:00:00.000Z",
  currency: "USD",
  lines: [
    {
      variantId: "10000000-0000-4000-8000-000000000005",
      quantity: 2,
      grantedUnitPriceMinor: 2599,
      priceId: "10000000-0000-4000-8000-000000000006",
    },
  ],
  totalMinor: 5198,
  cashReceivedMinor: 6000,
  changeMinor: 802,
  offlineSaleOrdinal: 1,
  cumulativeExposureMinor: 5198,
};

describe("offline command canonicalization", () => {
  it("is independent of input property insertion order", () => {
    const reordered = Object.fromEntries(
      Object.entries(command).reverse(),
    ) as unknown as OfflineSaleCommand;
    expect(canonicalizeOfflineSaleCommand(reordered)).toBe(canonicalizeOfflineSaleCommand(command));
  });

  it("covers every immutable commercial fact", () => {
    const original = canonicalizeOfflineSaleCommand(command);
    for (const changed of [
      { ...command, totalMinor: 5199 },
      { ...command, acceptedAt: "2026-09-06T10:00:01.000Z" },
      { ...command, lines: [{ ...command.lines[0]!, quantity: 3 }] },
    ])
      expect(canonicalizeOfflineSaleCommand(changed)).not.toBe(original);
  });

  // The installment fields are additive: a fully-settled command must encode (and thus sign) exactly as a
  // pre-installment client produced it. Equivalently, omitting the fields and setting them to undefined
  // must be indistinguishable, and the encoding must carry none of the installment keys.
  it("keeps a full-pay command byte-identical to the pre-installment encoding", () => {
    const canonical = canonicalizeOfflineSaleCommand(command);
    for (const key of ["customerId", "amountPaidMinor", "outstandingMinor"]) {
      expect(canonical).not.toContain(key);
    }
    expect(
      canonicalizeOfflineSaleCommand({
        ...command,
        customerId: undefined,
        amountPaidMinor: undefined,
        outstandingMinor: undefined,
      }),
    ).toBe(canonical);
  });

  it("includes the installment fields and distinguishes them from a full-pay sale", () => {
    const installment: OfflineSaleCommand = {
      ...command,
      cashReceivedMinor: 2000,
      changeMinor: 0,
      customerId: "10000000-0000-4000-8000-00000000000a",
      amountPaidMinor: 2000,
      outstandingMinor: 3198,
    };
    const canonical = canonicalizeOfflineSaleCommand(installment);
    expect(canonical).toContain('"amountPaidMinor":2000');
    expect(canonical).toContain('"outstandingMinor":3198');
    expect(canonical).toContain('"customerId":"10000000-0000-4000-8000-00000000000a"');
    expect(canonical).not.toBe(canonicalizeOfflineSaleCommand(command));
  });

  it("rejects an incoherent installment (partial fields or wrong remainder)", () => {
    expect(() =>
      canonicalizeOfflineSaleCommand({
        ...command,
        amountPaidMinor: 2000,
      } as OfflineSaleCommand),
    ).toThrow();
    expect(() =>
      canonicalizeOfflineSaleCommand({
        ...command,
        customerId: "10000000-0000-4000-8000-00000000000a",
        amountPaidMinor: 2000,
        outstandingMinor: 1,
      } as OfflineSaleCommand),
    ).toThrow();
  });
});
