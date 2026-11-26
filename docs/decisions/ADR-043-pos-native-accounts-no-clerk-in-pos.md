# ADR-043 — POS-native PIN accounts, no Clerk in the POS, bounded offline sign-in

- Status: **Accepted by owner (2026-11-18 prompt), implementation in progress — uncommitted**
- Supersedes: the "Clerk owner provisioning mode" retained in the POS by ADR-040 / `pos-native-auth-v1.md`
- Related: ADR-040 (pos_pin provider, `docs/pos/pos-native-auth-v1.md`), ADR-042 §13 (online-first,
  bounded emergency offline), `docs/pos/offline-pin-v2.md` (device-local sealed verifiers, same-PIN model)
- Progress log: §9 of this file (kept current as phases land)

## 1. Phase 0 baseline (2026-11-18)

| Repo                           | Branch                            | HEAD      | Dirty files at start                       |
| ------------------------------ | --------------------------------- | --------- | ------------------------------------------ |
| clothing-commerce-api          | `feat/pos-pin-provider`           | `0a747db` | 177 (pre-existing ADR-042 work, preserved) |
| clothing-commerce-pos          | `feat/pos-pin-login`              | `1a40f49` | 114 (pre-existing, preserved)              |
| clothing-commerce-admin-mobile | `feat/mobile-ui-refresh-sdk-0.19` | `2dc4234` | 117 (pre-existing, preserved)              |
| clothing-commerce-storefront   | `feat/home-hero-redesign`         | `08a5b84` | 27 — not touched by this ADR               |

### 1.1 Traced current flow (before this ADR)

**POS renderer boot.** `src/renderer/main.tsx` wrapped `<App/>` in `<ClerkProvider>` and rendered a
"Clerk key missing" error screen when `VITE_CLERK_PUBLISHABLE_KEY` was absent — the POS could not reach
its login at all without a Clerk key. `App.tsx` `PosRoot` mounted `useAuth/useUser/useClerk` always and
offered an "owner setup" mode that signed into Clerk (`StaffPinSignIn` via `@clerk/react/legacy`
`useSignIn`) to reach `PosUsersManager` with a Clerk bearer and create the first pos_pin accounts.

**Connected login.** `LocalLogin` (roster → PIN pad) → `window.posSession.login` → main
`PosSessionManager.login` → SDK `posPinLogin` → `POST /api/v1/pos/auth/login` (public body route) →
`PosAuthService.login`: durable per-username lockout (`pos_login_begin`/`pos_login_record`, 5 failures →
30 s), one scrypt always (decoy verifier for unknown usernames), account resolved only for an **active**
identity with an **active** membership; on success an HS256 `iss="pos"` JWT (TTL
`POS_AUTH_ACCESS_TTL_SECONDS`, default 12 h) + public operator fields. No PIN hash is returned.

**Is the POS-native login independent of Clerk?** Traced, not inferred:
`CompositeExternalIdentityVerifier` runs `PosTokenVerifier` first; a bearer whose unverified `iss` is
`"pos"` is verified with the server HS256 key and **never** falls through to Clerk (a bad POS token is a hard
401). Authorization is then re-resolved per request (binding `pos_pin`/subject → active identity → active
membership in the requested tenant → RBAC). The login endpoint itself is public and uses no Clerk call.
The API _process_ still requires Clerk server env (`readClerkVerifierConfiguration`) because the same
boundary serves Admin Mobile and the storefront — that is server infrastructure, not a POS dependency;
no Clerk key, session or network call is needed by the POS. **Verdict: independent.**

**Account lifecycle.** `PosUsersManager` (POS admin desk) → SDK `listPosLogins/createPosLogin/
updatePosLogin/setPosLoginPin` (each re-authorizes tenant-wide `staff.manage` + anti-escalation
`assert_covers_target`) and `updateStaffStatus` (deactivate). It mirrors a display-only roster into the
device-local `pos_users` table (`pin_hash = ''`).

**Second local credential store (defect).** `src/main/local-users/store.ts` is the old cafe-style local
account store: `login/createUser/setPin/verifyPin` IPC remained exposed, and `AdminGate` fell back to
`posAuth.login` (that store) for admin step-up on `OFFLINE`, `NOT_CONFIGURED` **and** `ERROR`. Cached roster
rows have empty hashes (never verify), but any legacy locally-created row with a real hash would authenticate
— a second, unsynchronised, non-revocable credential authority.

**Offline sign-in.** Offline PIN v2: after a successful online sign-in the main process enrols the same PIN as
a device-bound scrypt verifier sealed by the OS key store (`OfflinePinEnroller`), the server records an
enrollment version, and the bootstrap returns `offlinePinAuthorizations` only for currently authorised
offline sellers. `StaffRoster.verifyPin` requires device id, a non-revoked authorization, an **active**
catalog snapshot and an unexpired lease (`accepted_until`, `operator_expires_at`), with a persistent
5-failure lockout. Server register policy 12 h lease / 12 h catalog, hard 24 h bound (migration
`20261114210000_offline_grant_lease_hard_bound`). Revocations prune at the next successful bootstrap.

**Fallback decision (defect).** `PosSessionManager.mapFailure` sent `400/401/403/429 → INVALID_CREDENTIALS`,
`503 → NOT_CONFIGURED`, network → `OFFLINE`, **anything else → `ERROR`**; `LocalLogin` fell back offline on
`OFFLINE` **or `ERROR`** — so a 500, a contract-violating response, or an unexpected 4xx-shaped body could
open the till offline.

**PIN length.** Max 8 in POS (`POS_PIN_MAX_LENGTH`, pad/keyboard silently stop appending after 8 — a silent
truncation of what the user typed), 64-char IPC caps, server `^[0-9]{4,12}$` on login/create/set-PIN/
override-password, `max(64)` on the offline-enrollment step-up, 4–8 on the legacy Clerk staff-login
contract (Admin Mobile/Clerk; out of scope, see §8).

**Gaps found.** (G1) `set_pos_login_pin` did not revoke the member's offline-PIN enrollments — an old PIN kept
working offline on enrolled tills after a reset until re-enrolment. (G2) No server last-active-POS-admin guard
(demotion or deactivation could leave a tenant with no POS admin; recoverable only via Admin Mobile).
(G3) No request-size bound on the public login body. (G4) First POS admin required POS Clerk owner mode.

## 2. Decision — authority

The **API is the only credential authority** for POS accounts: identity, username (instance-global,
normalised lower-case), active status, `posRole` (admin|cashier), `posPermissions` (POS section ids) and the
online PIN verifier (salted scrypt, `DEFAULT_SCRYPT_PARAMS`). API RBAC (role + scope assignments) remains the
sole authority for what API calls are allowed; `posRole/posPermissions` only shape the POS UI. A
renderer-supplied role/permission list is never trusted by the server.

The device-local `pos_users` table is **a display-only roster cache** (username, name, role, active). It is
never an authenticator: the local login/create/set-PIN/verify IPC is removed and the store refuses to verify.

## 3. Online sign-in contract

`POST /api/v1/pos/auth/login` `{ username, pin }` → `200 { accessToken, expiresAt, operator{membershipId,
tenantId, username, displayName, role, permissions} }`. Errors: `400 VALIDATION_ERROR` (malformed — e.g.
non-digit or < 4 digits), `401 INVALID_CREDENTIALS` (unknown user, wrong PIN, inactive identity or
membership — one indistinguishable response), `413 PAYLOAD_TOO_LARGE` (transport limit, §6), `429
ACCOUNT_LOCKED`, `503 POS_AUTH_NOT_CONFIGURED`. Token: HS256 JWT, `iss="pos"`, `sub` = server-minted subject,
lifetime `POS_AUTH_ACCESS_TTL_SECONDS` (default 12 h), no refresh token; revocation = per-request membership
re-resolution (deactivation is immediate online). The token is held only in the Electron main process
(OS-encrypted `pos-session.protected.json`).

**Device authentication is separate from staff authentication.** Staff PIN login proves _who_; the device
enrolment (device id + Ed25519 device key, register assignment) proves _which till_ and gates offline
authority (bootstrap, grant, sync). They stay separate because a staff member may use several tills and a till
serves many staff; device revocation must not require PIN resets and vice versa. Connected staff requests
are scoped by tenant header + RBAC; offline ingestion is additionally device-signed.

## 4. Online vs. offline — the semantic rule

| Online outcome                                                                         | Classification                       | Offline fallback                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| network failure (no HTTP response), HTTP 502/503/504 without `POS_AUTH_NOT_CONFIGURED` | **unreachable**                      | allowed **only** if offline authority valid (device verifier + lease + active catalog) |
| 400/401/403/404/413/429                                                                | **definitive rejection**             | **never**                                                                              |
| 503 `POS_AUTH_NOT_CONFIGURED`                                                          | server misconfiguration (definitive) | never                                                                                  |
| 500, unparseable/contract-invalid response, anything else                              | **unknown**                          | never (fail closed, generic error)                                                     |

The same rule applies to admin step-up.

## 5. Local data, offline window, reconciliation

- Cached locally: display roster (no secrets); OS-encrypted session token; device key; sealed per-device
  offline PIN verifiers (scrypt over PIN with salt‖deviceId, sealed with `safeStorage`); authority grant,
  catalog snapshot, outbox. No plaintext PIN is ever persisted; no hash reaches the renderer.
- Offline sign-in eligibility: unchanged — enrolled verifier for exactly the authorised enrollment id+version,
  device id present, active catalog snapshot, `now ≤ accepted_until` and `now ≤ operator_expires_at`
  (12 h normal, hard cap 24 h server-enforced), lockout not engaged, OS key store available. Any failure ⇒
  `UNAVAILABLE`/`INVALID`, fail closed. After expiry the till requires a connection.
- PIN reset ⇒ server revokes that member's active offline enrollments (`pin_reset`) in the same transaction
  (G1 fix); the device prunes at the next bootstrap and the next successful online sign-in re-enrols the new
  PIN. Deactivation/role loss ⇒ `is_offline_seller` false ⇒ authorization withdrawn at next bootstrap;
  online sign-in rejected immediately.
- Offline window while the server already changed an account: the till keeps working only within the already
  issued bounded authority (accepted ADR-042 risk). Ingestion never silently drops a sale. No privileges are
  granted from local data.

### 5.1 Offline operator attribution (implemented 2026-11-18)

- **What is attributed.** Each offline sale carries `unlockedByMembershipId` inside the device-signed command:
  the member who unlocked the till offline with a verified device-bound PIN, else the signed-in online operator.
  The value lives only in the Electron main process (`OfflineRuntime`): it is set solely by a successful
  `verifyStaffPin`, never by a failure or by the renderer, cleared by `endStaffSession` (sign-out, or an online
  sign-in taking over) and absent after a restart. Omitted ⇒ canonical form unchanged (older tills).
- **Server verification** (`20261118130000_offline_operator_attribution.sql`, AFTER INSERT trigger on
  `offline_sale_ingestions`, same transaction as the sale): the claim is verified when it is the grant operator,
  or the member held an offline-PIN enrollment on **that device** covering `acceptedAt`. One immutable row in
  `offline_sale_operator_attributions`: `verified_unlock` ⇒ attributed to that member; `unverified_claim` ⇒ the
  claim is kept as evidence only and attribution falls back to the grant operator; `grant_operator` ⇒ no claim.
- **Reconciliation.** Through the existing `pos_sync_conflicts` surface (`kind = sync_integrity`), shown by the
  existing POS review and Admin Mobile sync-conflicts screens (labels added, en + ar):
  `OFFLINE_OPERATOR_UNVERIFIED` (claim not verifiable for that device/time — never trusted) and
  `OFFLINE_OPERATOR_CHANGED_BEFORE_SYNC` (verified at acceptance, but before sync the member was suspended/
  deactivated or that enrollment was revoked for a PIN reset/removal; the sale stays attributed to them). The sale
  is never rejected, rewritten or lost, and the grant's authority and limits are unchanged.
- **Scope/limits.** `orders.created_by` and payment/fulfilment actors remain the grant operator (the authority
  holder); per-cashier reporting must read `offline_sale_operator_attributions`. Only the sale lane is attributed
  (attendance already carries `membershipId`; payments, returns and intents still use the grant operator).
  Deploy order: server before tills (an older server's strict schema refuses the new field).

## 6. PIN policy

ASCII digits only (`^[0-9]{4,}$`), minimum 4, **no product maximum**, never truncated, enforced identically in
the API contracts (login, create, set-PIN, override-password re-auth, offline step-up), POS UI (pad + keyboard),
POS IPC, Admin Mobile UI. Infrastructure limit, _not_ a PIN rule: the public POS auth body is read with a
**16 KiB** cap (`413 PAYLOAD_TOO_LARGE`, body never parsed past the cap), and POS IPC rejects a credential
string longer than the same 16 384 characters as a malformed transport message. A PIN that fits a 16 KiB
request (~16 000 digits) is accepted. **Owner decision requested**: confirm 16 KiB is acceptable as the
transport ceiling (§10).

## 7. Bootstrap (first POS admin) without POS Clerk

The tenant owner creates the first POS admin in **Admin Mobile** (Staff → POS sign-in accounts), which is
already Clerk-authenticated (unchanged, in scope only for compatibility) and calls the existing
`createPosLogin` with tenant-wide `staff.manage` + anti-escalation. The owner chooses the PIN; there is no
default PIN, no support code, no open registration, no unauthenticated endpoint. A fresh till with an empty
roster cache offers "type your username" sign-in (server-verified) and tells the owner where to create the
first account. Thereafter POS admins whose API role holds `staff.manage` manage accounts in the POS Team desk.

## 8. Clerk scope after this ADR

Removed from POS: provider, hooks, `@clerk/react` dependency, `VITE_CLERK_PUBLISHABLE_KEY` requirement, owner
mode, `StaffPinSignIn`. Retained elsewhere (unchanged): Admin Mobile Clerk auth, storefront, API Clerk
verifier for non-POS tokens, and the API's legacy Clerk `createStaffLogin` (4–8 digit contract; it provisions
_Clerk_ accounts and is not a POS credential path — left unchanged by scope rule 5).

## 9. Progress log and evidence

- 2026-11-18 Phase 0/1: baseline + trace + this ADR.
- 2026-11-18 Phase 2 (API): `PosPinSchema` (`src/contracts/pos.ts`) used by login, create, set-PIN, override-password
  re-auth and offline-enrollment step-up; `parseJsonBody` bounded reader + `413 PAYLOAD_TOO_LARGE`
  (`POS_CREDENTIAL_MAX_BODY_BYTES` = 16 KiB) on the five credential routes; migration
  **`20261118120000_pos_native_account_lifecycle.sql`** (additive triggers: PIN reset revokes offline enrollments
  `pin_reset`; last-active-POS-admin guard ST414 → `LAST_POS_ADMIN` 409 on demotion and on membership
  suspension/deactivation); pre-existing defect fixed: `setPosLoginPin` committed but always answered 500
  (PostgreSQL `+00:00` timestamp vs. strict ISO contract) — now normalised. SDK **0.40.0** (wire-compatible;
  sha256 `aaed3de81d4413f293301b431025aab2a2728cd660b0c4b7288e7ed9956bd6ba`), vendored in the POS only.
- 2026-11-18 Phase 3 (POS): Clerk removed (dependency, provider, hooks, key, owner mode, `StaffPinSignIn`, Vite
  define, CSP CDN allowances); `LocalLogin` roster-first + username entry, no PIN cap, outage-only fallback;
  `classifyPosAuthFailure`; IPC PIN validators; `AdminGate` server-only, fail-closed offline; `pos_users`
  display-only (local schema **v24** erases legacy hashes, triggers refuse new ones; credential IPC removed);
  offline enrolment pattern `^[0-9]{4,}$`.
- 2026-11-18 §5.1 offline operator attribution (owner approved "Yes, build it"): contract field
  `unlockedByMembershipId`; migration **`20261118130000_offline_operator_attribution.sql`**; SDK **0.41.0**
  (sha256 `c8e0d77020693c5af3edaaef682afe5ed3d955042ab6d3122457d985792cf2a8`) vendored in the POS; POS local schema
  **v25** (`local_sale.unlocked_by_membership_id`), IPC `offline:end-staff-session`; conflict labels in POS and
  Admin Mobile.
- 2026-11-18 Admin Mobile: Staff → **POS sign-in accounts** screen (`src/staff/PosAccountsScreen.tsx`, route
  `app/staff/pos-accounts.tsx`) — list + create via existing `createPosLogin`; masked PIN; `TextField` gained
  optional `secure`/`numeric`. Admin Mobile Clerk auth untouched; SDK stays 0.38.0 (contract change is
  server-side validation only).

| Suite (exact command)                                                                                                                          | Result                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| api `pnpm test`                                                                                                                                | PASS 40 files / 481 tests                                 |
| api `pnpm typecheck`, `pnpm lint`, `pnpm test:openapi` (16), `pnpm test:sdk` (isolated tarball install, ESM+CJS)                               | PASS                                                      |
| api `pnpm --filter @shifted/clothing-commerce-sdk test`                                                                                        | PASS                                                      |
| api `pnpm test:pos:auth:lifecycle:persistence` (new, disposable container)                                                                     | PASS `ALL_POS_NATIVE_ACCOUNT_LIFECYCLE_ASSERTIONS_PASSED` |
| api `pnpm test:pos:auth:client` (new, real HTTP: Next.js + disposable `rt-<hex>` Supabase, POS compiled session manager + vendored SDK 0.40.0) | PASS 10/10 (H1–H10)                                       |
| api `pnpm test:pos:offline:lease-pin:persistence` (12 h / 24 h bounds, exact expiry, PIN v2)                                                   | PASS                                                      |
| api `pnpm test:pos:offline:conflicts:persistence`                                                                                              | PASS                                                      |
| api `pnpm test:pos:offline:pin-v2-client` (real HTTP, now incl. K10 attribution via the POS compiled sale service + sync worker)               | PASS 10/10                                                |
| api `pnpm test:pos:offline:attribution:persistence` (new, O1–O10)                                                                              | PASS `ALL_OFFLINE_OPERATOR_ATTRIBUTION_ASSERTIONS_PASSED` |
| pos `pnpm test`                                                                                                                                | PASS 68 files / 380 tests (4 skipped, pre-existing)       |
| pos `pnpm typecheck`, `pnpm lint`                                                                                                              | PASS                                                      |
| pos `pnpm acceptance:offline-pin` (real electron.exe, DPAPI, 20-digit PIN)                                                                     | PASS (exit 0, no PIN in profile files)                    |
| pos `pnpm build` with every Clerk variable unset (electron-builder `--dir`)                                                                    | PASS; renderer bundle 0 Clerk strings                     |
| admin-mobile `pnpm test` / `typecheck` / `lint`                                                                                                | PASS 119 files / 881 tests; PASS; PASS                    |
| api `test:pos:offline:http`, multidevice, other HTTP matrices                                                                                  | NOT RUN (paths untouched by this change)                  |

Isolation: every database-backed run used a uniquely named disposable container/project that the runner removed;
`docker ps -a` count 32 before and after every run; shared dev / production never contacted.

## 10. Open owner decisions and remaining work

1. **Transport ceiling** for credential requests: 16 KiB (implemented; confirm or choose another value). It caps a
   PIN at ~16 000 digits only as a by-product of the request bound; there is no PIN-field limit.
2. **Offline admin step-up**: implemented fail-closed (offline verifiers carry no POS role). Enabling it needs the
   role added to `offlinePinAuthorizations` (contract + migration + POS roster) — owner choice.
3. **Offline operator attribution**: implemented (§5.1). Remaining choice: whether order/payment actors should also
   switch to the verified unlocking member (today they stay the grant operator; attribution lives in its own table),
   and whether payments/returns/intents should carry the same field.
4. The POS auth routes are not described in `openapi/openapi.json` (pre-existing gap; the SDK is hand-written).
5. Legacy `CreateStaffLoginRequestSchema` (4–8 digits) provisions **Clerk** accounts for Admin Mobile staff; it is
   not a POS credential path and was left unchanged under scope rule 5.
