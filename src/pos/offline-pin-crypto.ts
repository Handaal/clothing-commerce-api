import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * POS-PIN credential cryptography. Three independent concerns live here:
 *
 *  1. AT-REST sealing of the PIN with AES-256-GCM under a server-held key (the OFFLINE_PIN_KEK). The PIN
 *     plaintext is held only transiently — sealed at set-time, unsealed transiently at bootstrap — so a
 *     database dump yields only ciphertext.
 *  2. The DEVICE-BOUND scrypt verifier the POS offline cashier checks against. The definition MUST match
 *     the POS verifier (`src/main/offline/staff-roster.ts` `deriveStaffPinVerifier`) byte-for-byte:
 *         scrypt(pin, saltBytes || utf8(deviceId), keyLength, { N, r, p })
 *     The device id is appended to the random salt BEFORE hashing, device-binding the verifier so a copied
 *     ledger cannot be brute-forced on another machine.
 *  3. The NON-device-bound ONLINE scrypt verifier the connected `pos_pin` login checks against:
 *         scrypt(pin, saltBytes, keyLength, { N, r, p })
 *     This lets the connected login verify a PIN with a constant-time hash compare WITHOUT ever unsealing
 *     the KEK-sealed copy — the sealed PIN stays reserved solely for minting device-bound offline
 *     verifiers at bootstrap. Defense in depth. One PIN therefore yields: sealed copy (offline minting) +
 *     online verifier (connected login) + device-bound verifiers (per device at bootstrap).
 */

export interface EncryptedOfflinePin {
  readonly keyVersion: number;
  readonly cipherAlgorithm: "aes-256-gcm";
  readonly ciphertextBase64: string;
  readonly ivBase64: string;
  readonly authTagBase64: string;
}

export interface ScryptVerifierParams {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
  readonly saltLength: number;
}

/** POS defaults (N=16384, r=8, p=1, keyLength=32); salt is 16 random bytes. */
export const DEFAULT_SCRYPT_PARAMS: ScryptVerifierParams = {
  n: 16384,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
};

export interface StaffPinVerifier {
  readonly algorithm: "scrypt";
  readonly saltBase64: string;
  readonly hashBase64: string;
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
}

const AES_IV_BYTES = 12;
// scrypt needs maxmem >= 128 * N * r. The POS default (N=16384, r=8) is ~16 MiB; allow generous headroom
// so larger server-chosen cost parameters still run. maxmem does not affect the derived bytes.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** Seal a PIN with AES-256-GCM under the KEK. A fresh random 96-bit IV is generated per call. */
export function encryptOfflinePin(pin: string, kek: Buffer, keyVersion = 1): EncryptedOfflinePin {
  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const ciphertext = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
  return {
    keyVersion,
    cipherAlgorithm: "aes-256-gcm",
    ciphertextBase64: ciphertext.toString("base64"),
    ivBase64: iv.toString("base64"),
    authTagBase64: cipher.getAuthTag().toString("base64"),
  };
}

/** Unseal a PIN. Throws if the auth tag fails (tamper/wrong key). */
export function decryptOfflinePin(material: EncryptedOfflinePin, kek: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(material.ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(material.authTagBase64, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(material.ciphertextBase64, "base64")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

/**
 * Compute the device-bound scrypt verifier the POS expects. `deviceId` is the id of the bootstrapping POS
 * device; it is appended to a fresh random salt before hashing, exactly as the POS verifier re-derives it.
 */
export function deriveStaffPinVerifier(
  pin: string,
  deviceId: string,
  params: ScryptVerifierParams,
): StaffPinVerifier {
  const salt = randomBytes(params.saltLength);
  const saltedDeviceBound = Buffer.concat([salt, Buffer.from(deviceId, "utf8")]);
  const hash = scryptSync(pin, saltedDeviceBound, params.keyLength, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return {
    algorithm: "scrypt",
    saltBase64: salt.toString("base64"),
    hashBase64: hash.toString("base64"),
    n: params.n,
    r: params.r,
    p: params.p,
    keyLength: params.keyLength,
  };
}

/**
 * Compute the NON-device-bound online scrypt verifier the connected `pos_pin` login checks against:
 * scrypt(pin, saltBytes, keyLength, { N, r, p }) over a fresh random salt. Unlike the offline verifier
 * there is no device-id salt term — the connected login happens server-side and is not bound to a device.
 */
export function deriveOnlinePinVerifier(
  pin: string,
  params: ScryptVerifierParams,
): StaffPinVerifier {
  const salt = randomBytes(params.saltLength);
  const hash = scryptSync(pin, salt, params.keyLength, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return {
    algorithm: "scrypt",
    saltBase64: salt.toString("base64"),
    hashBase64: hash.toString("base64"),
    n: params.n,
    r: params.r,
    p: params.p,
    keyLength: params.keyLength,
  };
}

/**
 * Constant-time check of a candidate PIN against a stored online verifier. Re-derives scrypt with the
 * stored salt + cost parameters and compares the bytes with `timingSafeEqual` (which also guards against a
 * length mismatch). Returns false — never throws — on any malformed stored material.
 */
export function verifyOnlinePin(pin: string, stored: StaffPinVerifier): boolean {
  try {
    const salt = Buffer.from(stored.saltBase64, "base64");
    const expected = Buffer.from(stored.hashBase64, "base64");
    const candidate = scryptSync(pin, salt, stored.keyLength, {
      N: stored.n,
      r: stored.r,
      p: stored.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}
