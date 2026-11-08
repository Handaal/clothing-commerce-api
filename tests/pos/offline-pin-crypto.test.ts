import { scryptSync } from "node:crypto";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCRYPT_PARAMS,
  decryptOfflinePin,
  deriveOnlinePinVerifier,
  deriveStaffPinVerifier,
  encryptOfflinePin,
  verifyOnlinePin,
  type StaffPinVerifier,
} from "../../src/pos/offline-pin-crypto";

/**
 * Independent re-implementation of the POS verifier (`src/main/offline/staff-roster.ts`
 * `deriveStaffPinVerifier`). A test passes ONLY if the server-emitted verifier validates against this,
 * which is the real contract: the POS re-derives scrypt(pin, saltBytes || utf8(deviceId), ...) and
 * compares the bytes. If this helper and the server ever diverge, offline unlock silently breaks — so the
 * check is deliberately written from the spec, not by calling the server code.
 */
function posVerifies(verifier: StaffPinVerifier, pin: string, deviceId: string): boolean {
  const salt = Buffer.from(verifier.saltBase64, "base64");
  const material = Buffer.concat([salt, Buffer.from(deviceId, "utf8")]);
  const recomputed = scryptSync(pin, material, verifier.keyLength, {
    N: verifier.n,
    r: verifier.r,
    p: verifier.p,
    maxmem: 256 * 1024 * 1024,
  });
  return recomputed.toString("base64") === verifier.hashBase64;
}

const KEK = randomBytes(32);
const DEVICE = "device-0001-aaaa-bbbb-cccc";

describe("offline PIN at-rest sealing", () => {
  it("round-trips a PIN through AES-256-GCM and never stores plaintext", () => {
    const sealed = encryptOfflinePin("4821", KEK, 2);
    expect(sealed.cipherAlgorithm).toBe("aes-256-gcm");
    expect(sealed.keyVersion).toBe(2);
    // Ciphertext/IV/tag are the only persisted material and contain no plaintext.
    expect(sealed.ciphertextBase64).not.toContain("4821");
    expect(decryptOfflinePin(sealed, KEK)).toBe("4821");
  });

  it("fails to unseal with the wrong key (authenticated encryption)", () => {
    const sealed = encryptOfflinePin("4821", KEK);
    expect(() => decryptOfflinePin(sealed, randomBytes(32))).toThrow();
  });

  it("uses a fresh IV per call so identical PINs seal to distinct ciphertext", () => {
    const a = encryptOfflinePin("0000", KEK);
    const b = encryptOfflinePin("0000", KEK);
    expect(a.ivBase64).not.toBe(b.ivBase64);
    expect(a.ciphertextBase64).not.toBe(b.ciphertextBase64);
  });
});

describe("device-bound scrypt verifier", () => {
  it("emits a verifier the POS KDF validates for the correct PIN", () => {
    const verifier = deriveStaffPinVerifier("4821", DEVICE, DEFAULT_SCRYPT_PARAMS);
    expect(verifier).toMatchObject({ algorithm: "scrypt", n: 16384, r: 8, p: 1, keyLength: 32 });
    expect(Buffer.from(verifier.saltBase64, "base64").length).toBeGreaterThanOrEqual(16);
    expect(posVerifies(verifier, "4821", DEVICE)).toBe(true);
    expect(posVerifies(verifier, "0000", DEVICE)).toBe(false);
  });

  it("is device-bound: the same PIN yields a verifier that fails on another device", () => {
    const verifier = deriveStaffPinVerifier("4821", DEVICE, DEFAULT_SCRYPT_PARAMS);
    expect(posVerifies(verifier, "4821", "a-different-device-id")).toBe(false);
  });

  it("honors overridden cost parameters end-to-end", () => {
    const params = { n: 1024, r: 4, p: 2, keyLength: 24, saltLength: 20 };
    const verifier = deriveStaffPinVerifier("987654", DEVICE, params);
    expect(Buffer.from(verifier.saltBase64, "base64").length).toBe(20);
    expect(verifier.keyLength).toBe(24);
    expect(posVerifies(verifier, "987654", DEVICE)).toBe(true);
  });
});

describe("online (non-device-bound) scrypt verifier", () => {
  it("verifies the correct PIN and rejects a wrong one", () => {
    const verifier = deriveOnlinePinVerifier("4821", DEFAULT_SCRYPT_PARAMS);
    expect(verifier).toMatchObject({ algorithm: "scrypt", n: 16384, r: 8, p: 1, keyLength: 32 });
    expect(verifyOnlinePin("4821", verifier)).toBe(true);
    expect(verifyOnlinePin("0000", verifier)).toBe(false);
  });

  it("is NOT device-bound: the same PIN verifies independent of any device id", () => {
    // The online verifier folds no device id into the salt, so two verifiers for the same PIN both
    // validate that PIN — the distinction from the offline verifier the connected login relies on.
    const a = deriveOnlinePinVerifier("135790", DEFAULT_SCRYPT_PARAMS);
    const b = deriveOnlinePinVerifier("135790", DEFAULT_SCRYPT_PARAMS);
    expect(a.saltBase64).not.toBe(b.saltBase64);
    expect(verifyOnlinePin("135790", a)).toBe(true);
    expect(verifyOnlinePin("135790", b)).toBe(true);
  });

  it("returns false (never throws) on malformed stored material", () => {
    const verifier = deriveOnlinePinVerifier("4821", DEFAULT_SCRYPT_PARAMS);
    expect(verifyOnlinePin("4821", { ...verifier, hashBase64: "!!!not-base64!!!" })).toBe(false);
    expect(verifyOnlinePin("4821", { ...verifier, keyLength: 1 })).toBe(false);
  });

  it("honors overridden cost parameters end-to-end", () => {
    const params = { n: 1024, r: 4, p: 2, keyLength: 24, saltLength: 20 };
    const verifier = deriveOnlinePinVerifier("987654", params);
    expect(Buffer.from(verifier.saltBase64, "base64").length).toBe(20);
    expect(verifier.keyLength).toBe(24);
    expect(verifyOnlinePin("987654", verifier)).toBe(true);
    expect(verifyOnlinePin("000000", verifier)).toBe(false);
  });
});
