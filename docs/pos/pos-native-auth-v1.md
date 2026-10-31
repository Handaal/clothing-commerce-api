# POS-native authentication V1 (username + PIN)

> Status: **Design draft** — 2026-10-26. Proposes ADR-040. No code written yet.
> Scope: the POS desktop app only. Mobile/admin/storefront keep Clerk unchanged.

## 1. Problem

POS floor staff sign in with a short **username + numeric PIN** (min 4 digits). The current
`feat/staff-pin-login` branch implements this by minting a **Clerk** account whose password *is* the
PIN ([`staff-login-provisioner.ts`](../../src/authentication/staff-login-provisioner.ts),
`skipPasswordChecks: true`). That works only because provisioning bypasses the policy server-side; at
**sign-in** time Clerk still enforces its password policy, whose minimum length cannot be lowered to 4
(Clerk's floor is 8, and this instance requires 15). "PIN = Clerk password" and "4-digit PIN" are
therefore fundamentally incompatible.

We will **replace Clerk in the POS with a POS-native authentication provider** that issues the POS its
own session tokens, while keeping Clerk for the mobile app. The PIN policy becomes ours (min 4), owned
by the API, against the **same database and the same authorization model**.

## 2. Key principle: new *authentication* provider, not a new *authorization* model

The authorization pipeline is already provider-neutral
([`context-resolver.ts`](../../src/authorization/context-resolver.ts)):

```
Request
→ ExternalIdentityVerifier.verifyRequest      → { provider, subject }   (else 401)
→ AuthorizationContextResolver.resolve({ request, requestedTenantId })
     → exactly one active provider binding (provider, subject)
     → active UserIdentity
     → active Membership in the requested tenant
     → active Tenant
     → effective RBAC assignments
→ AuthorizationContext → service → tenant-filtered repository
```

`ExternalIdentityVerifier` is an interface; Clerk is just one implementation
([`clerk-request-verifier.ts`](../../src/authentication/clerk-request-verifier.ts)). Provider bindings
already carry a free-form `provider` string ([`model.ts`](../../src/authorization/model.ts)
`ProviderBindingRecord`).

**We add a second authentication provider, `pos_pin`. Everything downstream of `{ provider, subject }`
is unchanged.** The `docs/api/authentication.md` invariant — "no second *authorization* model; a tenant
header / role name / `service_role` is never trusted" — still holds. This must be stated explicitly in
the ADR so the boundary guarantee isn't read as weakened.

## 3. Credential model

### 3.1 Provider binding

A POS-native login is a provider binding `(provider = "pos_pin", provider_subject = <server-minted id>)`
pointing at the existing `user_identities` / membership / RBAC rows. The subject is **server-minted**
(a random opaque id, e.g. the credential row id) — never client-supplied — identical to how the Clerk
subject is treated today. This preserves the verified-identity → binding → membership/RBAC trust chain
that commit 8ba2cf1 was careful to keep.

Username lives where the branch already put it: `user_identities.login_username`
(nullable, globally partial-unique). It is the login *identifier*, resolved to an identity at login.

### 3.2 PIN storage

PIN cryptography already exists ([`offline-pin-crypto.ts`](../../src/pos/offline-pin-crypto.ts)):

- **At-rest seal** — AES-256-GCM under `OFFLINE_PIN_KEK`. A DB dump yields only ciphertext. Today this
  exists so bootstrap can transiently unseal the PIN and mint the **device-bound** offline scrypt
  verifier.
- **Device-bound scrypt verifier** — `scrypt(pin, salt ‖ utf8(deviceId), …)`, byte-for-byte matched by
  the POS offline roster ([`src/main/offline/staff-roster.ts`] in the POS repo).

For the **online** login we add one artifact: a **non-device-bound online scrypt verifier**
`scrypt(pin, salt, …)` stored next to the sealed PIN. Rationale:

- Online login then verifies with a constant-time hash compare and **never unseals plaintext** — the
  KEK-sealed copy stays reserved solely for minting device-bound offline verifiers. Defense in depth.
- Reuses the exact scrypt family already in `offline-pin-crypto.ts` (add a `deriveOnlinePinVerifier`
  sibling without the deviceId salt term).

> Decision to confirm (§9): online scrypt verifier **vs.** unseal-and-compare at login. Recommend the
> online verifier.

Net: one PIN set by staff → sealed (offline minting) + online verifier (connected login) + device-bound
verifiers (minted per device at bootstrap). **Connected and offline finally verify the same PIN.**

## 4. Token model

Login issues a short-lived **access token** and a rotating **refresh token**.

### 4.1 Access token

- Format: signed JWT, `iss = "pos"`, signed with a server-only `POS_AUTH_SIGNING_KEY`.
  - Recommend **Ed25519 (EdDSA) via `jose`** so only the signing node holds the private key and verifiers
    need only the public key; `HS256` is acceptable if we keep signing+verifying in the same service.
- Claims: `iss`, `sub` = the `pos_pin` provider subject, `jti`, `exp`, `iat`, and a **device binding**
  `did` = enrolled POS device id (see §4.3). Optionally `tid` (tenant) as a hint only — authorization is
  still re-resolved per request, never trusted from the token.
- Lifetime: one shift — recommend **8–12 h** access, or shorter (e.g. 1 h) with silent refresh.
- The SDK already takes a `getToken` provider, so the access token drops straight into the existing
  bearer flow. **No change to how downstream routes authorize** beyond selecting the verifier (§5).

### 4.2 Refresh token

- Opaque high-entropy string; **only a hash is stored** server-side (revocation + rotation). Each use
  rotates (new refresh, old invalidated) so theft is detectable.
- Lifetime: register-session length (e.g. until end of day / explicit sign-out), bounded by an absolute
  cap.

### 4.3 Device binding (recommended)

POS devices already enroll an **Ed25519** keypair ([offline-pos-v1](./offline-pos-v1.md)). Bind the
token to the enrolled `device_id` (`did` claim) so a stolen token can't be replayed off-device, mirroring
the offline device-bound verifier. This also unifies the "which device" story across connected + offline.

> Decision to confirm (§9): device binding mandatory vs. optional for V1.

### 4.4 Revocation

Three independent layers, all already partly present:

1. Membership/identity status — `suspended`/`deactivated` already breaks `context-resolver` resolution.
2. Refresh rotation + server-side hash store — revoke a session by deleting its refresh row.
3. Access `jti`/token-version denylist for immediate kill (short TTL keeps the list small).

## 5. Boundary composition

`createServerAuthorizationBoundary` ([`server-authorization-boundary.ts`](../../src/authentication/server-authorization-boundary.ts))
composes a dispatcher:

```
CompositeExternalIdentityVerifier([ PosTokenVerifier, ClerkRequestVerifier ])
  • bearer JWT with iss === "pos"  → PosTokenVerifier  → { provider: "pos_pin", subject }
  • otherwise (Clerk session token) → ClerkRequestVerifier → { provider: "clerk",  subject }
```

`PosTokenVerifier implements ExternalIdentityVerifier`: verify signature + `exp` + device binding + `jti`
denylist, return `{ provider: "pos_pin", subject: claims.sub }`. Resolution continues exactly as today.
Mobile is untouched — Clerk tokens still route to the Clerk verifier.

## 6. Endpoints (`/api/v1/pos/auth`)

| Method & path              | Body                                   | Returns                                             |
|----------------------------|----------------------------------------|-----------------------------------------------------|
| `POST /pos/auth/login`     | `{ username, pin, deviceId }`          | `{ accessToken, refreshToken, expiresAt, operator }`|
| `POST /pos/auth/refresh`   | `{ refreshToken, deviceId }`           | rotated `{ accessToken, refreshToken, expiresAt }`  |
| `POST /pos/auth/logout`    | `{ refreshToken }`                     | `204` (revokes the session)                         |

- **Login**: resolve `login_username` → identity → `pos_pin` binding + online verifier → constant-time
  verify → mint tokens. `operator` = `{ membershipId, username, displayName }` (mirrors the offline
  `OfflineStaffPinResult`).
- **Errors are collapsed**: unknown username and wrong PIN return one indistinguishable failure, with
  timing equalisation (the offline roster already does a throwaway scrypt on the unknown-user path —
  reuse that pattern).
- **Throttle/lockout**: per `(username, device)` — 5 failures → 30 s lockout, matching the offline
  roster constants, enforced server-side (durable, not just in-memory, so a restart isn't a bypass).
- Provisioning stays `POST /api/v1/staff/logins` but switches its provisioner from Clerk to the
  **Pos-native provisioner** (writes `login_username` + sealed PIN + online verifier + `pos_pin`
  binding via the existing `create_staff_login` RPC, adapted). The Clerk `StaffLoginProvisioner` is
  removed from the POS path.

## 7. POS client changes (pos repo)

1. Remove `@clerk/react` / `ClerkProvider`; replace `useAuth`/`useUser`/`useClerk` in
   `src/renderer/App.tsx` with a POS auth context backed by the new endpoints (shape-compatible with the
   existing `PosAuth` interface so the rest of `App.tsx` is untouched).
2. `StaffPinSignIn` stops calling Clerk `signIn.create` and calls `POST /pos/auth/login`. The
   username→PIN-pad UI is kept verbatim.
3. Token/session persistence + silent refresh live in the **Electron main process** (`safeStorage`),
   feeding the access token to the SDK's `getToken` and refreshing on expiry/401.
4. Offline bootstrap (today authorized by a Clerk token) is repointed to the POS access token. The
   offline PIN roster verifier is **unchanged**.

## 8. Rollout (dual-run, mobile-safe)

1. **Phase 0** — this doc + ADR-040.
2. **Phase 1 (API)** — `pos_pin` provider + online verifier storage; login/refresh/logout; token
   issuer + `PosTokenVerifier`; composite boundary; durable throttle; migration; tests (unit, RLS,
   persistence, SDK shape); OpenAPI + SDK methods; version bump.
3. **Phase 2 (SDK)** — publish, bump POS SDK dep.
4. **Phase 3 (POS)** — remove Clerk, add auth context + session storage, repoint bootstrap.
5. Throughout, the API accepts **both** Clerk and POS tokens, so mobile is unaffected and the POS can
   cut over independently. Any POS logins already provisioned in Clerk by the current branch are
   re-provisioned under `pos_pin` (or dual-bound during transition).

## 9. Decisions to confirm before Phase 1

1. **Signing**: Ed25519 (`jose`) vs HS256.
2. **Lifetimes**: access (8–12 h shift vs ~1 h + refresh) and refresh (end-of-day vs absolute cap).
3. **Device binding**: mandatory vs optional in V1.
4. **PIN verification**: dedicated online scrypt verifier (recommended) vs unseal-and-compare.
5. **Username uniqueness**: keep global partial-unique, or scope per tenant.
6. **Keep `/staff/logins` Clerk-minting at all?** Recommend dropping it from the POS path entirely.

## 10. Security notes

- A 4-digit PIN is ~10⁴ entropy. Mitigations: durable server lockout, device-bound tokens, short access
  TTL, collapsed+timing-equalised errors, PIN never logged, signing key server-only, refresh rotation.
  This is acceptable for a physical, device-bound POS floor terminal and is an explicit business choice.
- `service_role`, tenant header, client metadata, and role names remain non-authoritative — unchanged.
