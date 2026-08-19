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
