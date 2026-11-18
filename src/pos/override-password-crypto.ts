import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * ADR-042 §6.3 (revised, verifier v2) — POS override-password cryptography with NO recoverable copy.
 *
 * Why this replaced the first design: the first implementation sealed the password with AES-256-GCM under
 * the server KEK and decrypted it at every bootstrap to mint device verifiers. Anyone holding the KEK and a
 * database copy could therefore recover every admin's plaintext password. That is not acceptable for an
 * admin credential (owner rule: the server must not be able to recover user plaintext).
 *
 * v2 keeps only a slow, salted, one-way verifier on the server and derives per-device material from it:
 *
 *   server (set time, plaintext only transiently in this request):
 *       serverVerifier = scrypt(password, salt, keyLength, { N, r, p })          -- stored, with salt + params
 *   server (each bootstrap, no plaintext involved):
 *       deviceTag = HMAC-SHA256(key = serverVerifier,
 *                               msg = "pos-override-v2" ‖ 0 ‖ deviceId ‖ 0 ‖ membershipId ‖ 0 ‖ verifierVersion)
 *       sent to the till with salt + params (never serverVerifier itself)
 *   till (main process, offline):
 *       candidate = HMAC-SHA256(scrypt(typed, salt, …), same msg)  ==  deviceTag   (constant-time)
 *
 * Properties:
 *   - The server holds no ciphertext and no key that yields plaintext; a database dump (with or without any
 *     server key) only permits an offline guessing attack costing one scrypt per guess.
 *   - A till's material is bound to that device, that admin and that verifier version: it cannot be replayed
 *     on another device, and a password change/clear (version bump) makes it useless at the next bootstrap.
 *     Extracting it requires breaking the OS key store first, and then still costs one scrypt per guess.
 *   - Neither the stored verifier nor the device tag is a credential by itself: the till accepts only a typed
 *     password, and the server accepts only a device-signed one-use assertion it recorded as issued.
 *
 * The till verifier MUST stay byte-identical to `clothing-commerce-pos/src/main/offline/override-roster.ts`.
 */
export const OVERRIDE_VERIFIER_ALGORITHM = "scrypt-hmac-sha256-v2" as const;
const DEVICE_TAG_CONTEXT = "pos-override-v2";
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export interface OverrideVerifierParams {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
  readonly saltLength: number;
}

/** Override passwords are admin credentials: twice the PIN's scrypt work factor (N = 2^15, ~32 MiB). */
export const OVERRIDE_VERIFIER_PARAMS: OverrideVerifierParams = {
  n: 32768,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
};

export interface OverrideServerVerifier {
  readonly algorithm: typeof OVERRIDE_VERIFIER_ALGORITHM;
  readonly saltBase64: string;
  readonly hashBase64: string;
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
}

export interface OverrideDeviceVerifier {
  readonly algorithm: typeof OVERRIDE_VERIFIER_ALGORITHM;
  readonly saltBase64: string;
  readonly deviceTagBase64: string;
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
}

function scrypt(
  password: string,
  salt: Buffer,
  params: Omit<OverrideVerifierParams, "saltLength">,
) {
  return scryptSync(password, salt, params.keyLength, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

function tag(serverHash: Buffer, deviceId: string, membershipId: string, version: number): Buffer {
  return createHmac("sha256", serverHash)
    .update([DEVICE_TAG_CONTEXT, deviceId, membershipId, String(version)].join("\u0000"), "utf8")
    .digest();
}

/** Set time: the one-way verifier stored by the server. A fresh random salt per call. */
export function deriveOverrideServerVerifier(
  password: string,
  params: OverrideVerifierParams = OVERRIDE_VERIFIER_PARAMS,
): OverrideServerVerifier {
  const salt = randomBytes(params.saltLength);
  return {
    algorithm: OVERRIDE_VERIFIER_ALGORITHM,
    saltBase64: salt.toString("base64"),
    hashBase64: scrypt(password, salt, params).toString("base64"),
    n: params.n,
    r: params.r,
    p: params.p,
    keyLength: params.keyLength,
  };
}

/** Bootstrap: the device-, admin- and version-bound material a till receives. Uses no plaintext. */
export function deriveOverrideDeviceVerifier(
  stored: OverrideServerVerifier,
  deviceId: string,
  membershipId: string,
  verifierVersion: number,
): OverrideDeviceVerifier {
  const serverHash = Buffer.from(stored.hashBase64, "base64");
  return {
    algorithm: OVERRIDE_VERIFIER_ALGORITHM,
    saltBase64: stored.saltBase64,
    deviceTagBase64: tag(serverHash, deviceId, membershipId, verifierVersion).toString("base64"),
    n: stored.n,
    r: stored.r,
    p: stored.p,
    keyLength: stored.keyLength,
  };
}

/**
 * Reference implementation of the till's check (the POS has its own copy). Constant-time; false — never a
 * throw — on malformed material. Used by tests to prove server/till agreement.
 */
export function verifyOverrideOnDevice(
  password: string,
  device: OverrideDeviceVerifier,
  deviceId: string,
  membershipId: string,
  verifierVersion: number,
): boolean {
  try {
    if (device.algorithm !== OVERRIDE_VERIFIER_ALGORITHM) return false;
    const derived = scrypt(password, Buffer.from(device.saltBase64, "base64"), device);
    const candidate = tag(derived, deviceId, membershipId, verifierVersion);
    const expected = Buffer.from(device.deviceTagBase64, "base64");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}
