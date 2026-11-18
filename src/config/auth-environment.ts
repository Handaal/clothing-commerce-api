import { z } from "zod";

const NonEmptySecretSchema = z.string().trim().min(1);

const AuthorizedPartySchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    value === url.origin &&
    url.username === "" &&
    url.password === ""
  );
}, "Expected an exact HTTP(S) origin without path, query, fragment, or credentials");

const SupabaseUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:";
}, "Expected an HTTP(S) Supabase URL");

const ClerkEnvironmentSchema = z.object({
  CLERK_SECRET_KEY: NonEmptySecretSchema,
  CLERK_PUBLISHABLE_KEY: NonEmptySecretSchema,
  CLERK_AUTHORIZED_PARTIES: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((party) => party.trim())
        .filter(Boolean),
    )
    .pipe(z.array(AuthorizedPartySchema).min(1)),
  CLERK_JWT_KEY: NonEmptySecretSchema.optional(),
});

const SupabasePrivilegedEnvironmentSchema = z.object({
  SUPABASE_URL: SupabaseUrlSchema,
  SUPABASE_SERVICE_ROLE_KEY: NonEmptySecretSchema,
});

type Environment = Readonly<Record<string, string | undefined>>;

export function readClerkVerifierConfiguration(environment: Environment = process.env) {
  const parsed = ClerkEnvironmentSchema.parse(environment);

  return {
    secretKey: parsed.CLERK_SECRET_KEY,
    publishableKey: parsed.CLERK_PUBLISHABLE_KEY,
    authorizedParties: parsed.CLERK_AUTHORIZED_PARTIES,
    ...(parsed.CLERK_JWT_KEY ? { jwtKey: parsed.CLERK_JWT_KEY } : {}),
  };
}

export function readSupabasePrivilegedConfiguration(environment: Environment = process.env) {
  const parsed = SupabasePrivilegedEnvironmentSchema.parse(environment);

  return {
    url: parsed.SUPABASE_URL,
    serviceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/**
 * Offline PIN v2 (device-local verifiers, docs/pos/offline-pin-v2.md). DEFAULT OFF: only the exact value
 * "enabled" lets staff enrol an offline PIN and lets the bootstrap list offline unlock authorizations. Off ⇒
 * offline PIN sign-in is unavailable on every till. The retired server key OFFLINE_PIN_KEK is not read by
 * anything (KEK-sealed PINs were withdrawn in 20261115170000); do not provision it.
 */
export function readOfflinePinV2Enabled(environment: Environment = process.env): boolean {
  return environment.POS_OFFLINE_PIN_V2?.trim() === "enabled";
}

/**
 * ADR-042 §13.6: whether the offline bootstrap issues cached policies of existing vouchers for emergency
 * offline redemption. DEFAULT OFF: only the exact value "enabled" turns it on (any other value, or unset, keeps
 * every voucher online-only). Per-voucher opt-in is still required (`pos` channel policy `offlineEnabled`).
 * Sync-time reconciliation of an offline voucher sale always runs regardless of this flag, so a queued sale is
 * never lost.
 */
export function readOfflineCachedVouchersEnabled(environment: Environment = process.env): boolean {
  return environment.POS_OFFLINE_CACHED_VOUCHERS?.trim() === "enabled";
}

export interface PosAuthSigningConfiguration {
  /** HMAC secret used to sign + verify POS access tokens (HS256). */
  readonly signingKey: Buffer;
  /** Access-token lifetime in seconds (one shift). Revocation is still per-request via membership status. */
  readonly accessTtlSeconds: number;
}

/** Default POS access-token lifetime: one long shift. */
const DEFAULT_POS_ACCESS_TTL_SECONDS = 12 * 60 * 60;

/**
 * The server secret that signs POS-native (`pos_pin`) access tokens, plus their lifetime. Returns null
 * when `POS_AUTH_SIGNING_KEY` is unset so the provider stays dormant WITHOUT breaking the whole boundary
 * in deployments that have not provisioned it yet (the composite verifier simply never resolves a POS
 * token and login rejects with a clear config error) — exactly mirroring the dormant-when-unset pattern.
 * A present-but-malformed key is a hard failure: a half-configured secret must not silently disable auth.
 */
export function readPosAuthSigningConfiguration(
  environment: Environment = process.env,
): PosAuthSigningConfiguration | null {
  const raw = environment.POS_AUTH_SIGNING_KEY;
  if (raw === undefined || raw.trim() === "") return null;
  const signingKey = Buffer.from(raw.trim(), "base64");
  // HS256 needs a high-entropy key; require at least 32 bytes (256 bits) like the AES KEK.
  if (signingKey.length < 32) {
    throw new Error("POS_AUTH_SIGNING_KEY must be a base64-encoded key of at least 32 bytes.");
  }
  const ttlRaw = environment.POS_AUTH_ACCESS_TTL_SECONDS?.trim();
  const accessTtlSeconds = ttlRaw ? Number(ttlRaw) : DEFAULT_POS_ACCESS_TTL_SECONDS;
  if (!Number.isInteger(accessTtlSeconds) || accessTtlSeconds < 60) {
    throw new Error("POS_AUTH_ACCESS_TTL_SECONDS must be an integer of at least 60 seconds.");
  }
  return { signingKey, accessTtlSeconds };
}
