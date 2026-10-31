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

export interface OfflinePinConfiguration {
  readonly kek: Buffer;
  readonly keyVersion: number;
}

/**
 * The server key that seals offline-unlock PINs at rest (base64-encoded 32-byte AES-256 key) plus its
 * version. Returns null when unset so the feature stays dormant WITHOUT breaking the whole management
 * boundary in deployments that have not provisioned the key yet — set/rotate then rejects with a clear
 * config error and the offline bootstrap simply omits the staff roster. A present-but-malformed key is a
 * hard failure: a half-configured secret must not silently disable the feature.
 */
export function readOfflinePinConfiguration(
  environment: Environment = process.env,
): OfflinePinConfiguration | null {
  const raw = environment.OFFLINE_PIN_KEK;
  if (raw === undefined || raw.trim() === "") return null;
  const kek = Buffer.from(raw.trim(), "base64");
  if (kek.length !== 32) {
    throw new Error("OFFLINE_PIN_KEK must be a base64-encoded 32-byte (256-bit) key.");
  }
  const versionRaw = environment.OFFLINE_PIN_KEK_VERSION?.trim();
  const keyVersion = versionRaw ? Number(versionRaw) : 1;
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new Error("OFFLINE_PIN_KEK_VERSION must be a positive integer.");
  }
  return { kek, keyVersion };
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
 * token and login rejects with a clear config error) — exactly mirroring `readOfflinePinConfiguration`.
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
