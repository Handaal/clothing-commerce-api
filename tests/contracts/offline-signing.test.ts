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
});
