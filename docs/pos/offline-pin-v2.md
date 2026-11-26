# Offline PIN v2 — same PIN as sign-in, device-local verifier (KEK-sealed PINs retired)

Status: implemented 2026-11-15, **uncommitted**, not applied to shared dev. **Off by default**
(`POS_OFFLINE_PIN_V2`, see Configuration). With the flag unset, the server refuses enrollment and lists no unlock
authorizations, so offline sign-in is unavailable on every till. Production was not accessed.

**Owner decisions (2026-11-15):**

- **Login specification = shifted-cafe-v2, as is.** Pick your name from the roster, type your PIN on the pad
  (or keyboard), sign in. One PIN per person (4–8 digits). When the server is unreachable, the **same** screen
  and the **same PIN** open the till offline. No separate offline PIN and no extra setup screen.
- **Residual risk accepted: "Accept risk, harden OS".** The owner accepts that malware running as the till's
  Windows user could read or brute-force the locally stored verifier (details under Threat model). The feature
  is not blocked on TPM availability.
- **Activation stays separate.** Turning on `POS_OFFLINE_PIN_V2` in production or any shared environment needs
  its own explicit authorization from the owner. It is enabled only on disposable `rt-` test stacks.

Grade: **implemented and accepted under the documented threat model; not activated anywhere.**

## Purpose and why

v1 (`20261024120000`) stored every offline-unlock PIN encrypted under the server key `OFFLINE_PIN_KEK`, so each
bootstrap could decrypt it and mint a device-bound verifier. The KEK plus a database dump reveals every PIN. The
local-development KEK value was exposed in a transcript, so all v1 material is treated as compromised.

v2 removes every server-side PIN secret:

- The server stores **no PIN and nothing derived from it**, only `staff_offline_pin_enrollments`
  (membership, device, register, `verifier_version`, revocation).
- The device-bound verifier `scrypt(pin, salt ‖ deviceId)` (N=32768, r=8, p=1, 32 bytes) is computed **in the
  Electron main process**. It is sealed with the OS key store (Electron `safeStorage` = DPAPI on Windows) in
  `offline-pin-enrollments.sealed`. It is never in SQLite, the outbox, logs or telemetry.
- `OFFLINE_PIN_KEK` is not read by anything (the parser was removed). Never provision or recreate it.

## How it works

1. **Enrol: automatic, right after a successful online sign-in.** The floor login (`LocalLogin.tsx`, the
   shifted-cafe screen) sends username + PIN to the main process. The main process signs in with the server
   (`posPinLogin`). On success, still in the main process (`PosSessionManager` → `OfflineRuntime.
refreshOfflinePinAfterSignIn` → `OfflinePinEnroller.refreshAfterSignIn`):
   - If this till already holds a sealed verifier for this person that matches the PIN just used, nothing
     happens (`current`). A normal sign-in therefore does not create a new server version each time.
   - Otherwise (first sign-in on this till, PIN changed online, or the verifier was pruned after a revocation),
     it calls `POST /api/v1/pos/offline-pin-enrollments` with `{deviceId, registerId, stepUp: {username, pin}}`.
     The step-up is the credential the server just accepted. The server checks, in order:
     - the flag is on (`409 OFFLINE_PIN_DISABLED` otherwise);
     - the caller holds the register's seller permissions;
     - it **re-verifies the credential** with the sign-in verifier and the same lockout as sign-in, and the
       credential must resolve to the caller's own membership (`401 OFFLINE_PIN_STEP_UP_FAILED` otherwise);
     - the device is active and assigned to the register.

     The server then supersedes the caller's previous enrollment on that device (`verifier_version` + 1) and
     stores nothing about the credential. Only then does the till seal the verifier of that same PIN.

   - The refresh never throws into sign-in and never delays it. Any failure (flag off, offline, denied, storage
     unavailable) just leaves offline sign-in unprepared on this till.

   The renderer has **no** enrollment channel. The former `offline:enroll-offline-pin` IPC and the
   "My offline PIN" screen were removed; the IPC allowlist test enforces that.

   **Freshness:** a long-lived token is never treated as fresh. Enrollment happens only with a credential the
   server verified at that moment (sign-in plus the step-up re-check). Clerk-only owners without a POS sign-in
   are never enrolled. Offline unlock is by POS username.

2. **Authorise (every online bootstrap).** The bootstrap returns `offlinePinAuthorizations`: the enrollments on
   THIS device for sellers who are authorised right now (id + version only). The till installs them with the
   snapshot and prunes any local verifier whose id/version is no longer listed. So a person can sign in offline
   only after the till's next online check-in following their first online sign-in there.
3. **Unlock (offline).** On the same login screen, when the server is unreachable, `LocalLogin` falls back to
   `offline.verifyStaffPin` with the same username + PIN. Verification runs in the main process only:
   - username → authorization on the active snapshot → local verifier with the exact enrollment id + version
     - device id → constant-work scrypt compare;
   - refused when the lease (`accepted_until`, operator lease; 12 h, hard max 24 h) has ended;
   - 5 wrong attempts lock the username for 15 minutes. The lockout is kept in SQLite (`offline_pin_lockout`)
     **and** inside the OS-sealed file. The stricter copy wins, so deleting or editing the SQLite row does not
     reset it.
4. **Revoke.** `POST /api/v1/pos/offline-pin-enrollments/revoke` revokes your own enrollments (with seller
   access), or anyone's or a whole device's (with tenant-wide `staff.manage`). It takes effect at the device's
   next bootstrap, and at the latest when its current lease ends. The server never re-authorises a revoked or
   superseded version.

**v1 retirement** (`20261115170000` Part A + POS local schema v23):

- every `staff_offline_pin_credentials` row is retired and its ciphertext/IV/tag erased;
- `set_offline_pin` / `offline_sell_roster` raise `ST410` and lose transport execute;
- `PUT /api/v1/staff/{id}/offline-pin` answers `409 OFFLINE_PIN_REENROLLMENT_REQUIRED`;
- the POS deletes every cached server-minted verifier, refuses future inserts, and ignores a legacy
  `staffRoster` from an older server.

## Configuration

| Variable                    | Where      | Default | Effect                                                                                        |
| --------------------------- | ---------- | ------- | --------------------------------------------------------------------------------------------- |
| `POS_OFFLINE_PIN_V2`        | API server | unset   | only the exact value `enabled` allows enrollment and lists unlock authorizations at bootstrap |
| `OFFLINE_PIN_KEK(_VERSION)` | —          | absent  | **retired**: nothing reads it; never provision or recreate it                                 |

## Files

- **API:** `supabase/migrations/20261115170000_offline_pin_device_enrollment.sql`,
  `supabase/migrations/20261115190000_fix_pos_login_record_ambiguity.sql`, `src/pos/offline-service.ts`
  (`enrollOfflinePin` with step-up, `revokeOfflinePinEnrollments`, bootstrap gate), `src/contracts/pos.ts`,
  `app/api/v1/pos/offline-pin-enrollments/**`, `src/config/auth-environment.ts` (`readOfflinePinV2Enabled`),
  SDK 0.39.0.
- **POS:** `src/main/pos-session/manager.ts` (post-sign-in hook), `src/main/main.ts` (wiring),
  `src/main/offline/offline-pin-enroller.ts`, `offline-pin-enrollment.ts` (sealed store + sealed lockout),
  `staff-roster.ts` (unlock + lockout), `authority-store.ts`, `migrations.ts` v23, renderer
  `src/renderer/auth/LocalLogin.tsx` (unchanged shifted-cafe screen). Electron acceptance:
  `pnpm acceptance:offline-pin` (`tests/runtime/offline-pin`).

## Threat model (accepted 2026-11-15)

**This design is NOT resistant to malware running as the till's Windows user.** The owner accepted that risk
explicitly. Do not describe this feature as malware-resistant.

| Threat                                              | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Malware running as the till's Windows user**      | **Accepted residual risk.** DPAPI/safeStorage releases the sealed file to any process of that user. Such malware can read the verifier and brute-force the PIN offline: 4–8 digits = 10^4–10^8 guesses, so a 4-digit PIN falls almost immediately. It can also roll the sealed lockout back, read PINs as they are typed, or reuse a live session. **Because the offline PIN is the sign-in PIN, recovering it also reveals that person's online POS sign-in PIN.** Online use of that PIN remains subject to the server's sign-in lockout (fixed by `20261115190000`). |
| Database dump (+ any server key)                    | Nothing to recover: no PIN material is stored server-side.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Exposed `OFFLINE_PIN_KEK`                           | Irrelevant: v1 ciphertext is erased by the migration and no key is used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Disk or ledger copied to another machine/OS account | Verifier sealed by DPAPI for this Windows user; the device id is part of the KDF input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Guessing at the till (no code execution)            | Persistent lockout (5 tries / 15 min), kept in SQLite and in the sealed copy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Long-lived session reused to enrol                  | Refused: enrollment needs the credential re-verified by the server in the same request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Renderer compromise                                 | No enrollment channel. The renderer sends username + PIN only to the existing sign-in / offline-verify channels and never receives verifiers.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Stolen till kept offline                            | Usable until the current lease ends at most (≤ 12 h configured, hard max 24 h); a revoked version is never renewed.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PIN in logs/network                                 | Never logged or written to SQLite, outbox or telemetry. Sent only to the API (TLS in production) as the sign-in credential and the identical step-up. The Electron acceptance scans the whole profile for it.                                                                                                                                                                                                                                                                                                                                                           |

### Required operating safeguards ("harden OS", owner-chosen mitigations)

These are deployment requirements for every till before the flag is turned on. They reduce, but do not remove,
the accepted risk.

1. **Dedicated Windows account per till**: a standard (non-administrator) local account used only for the POS.
   No personal email, browsing or software installs under it.
2. **Device security**:
   - BitLocker (or equivalent) full-disk encryption;
   - Windows Update and Microsoft Defender (or equivalent) on, with real-time protection;
   - no remote-access tools except the managed ones;
   - auto-lock the Windows session when idle;
   - physical security for the till and its USB ports.
3. **DPAPI-protected storage only**: the till refuses to prepare offline sign-in when OS encryption is
   unavailable (`STORAGE_UNAVAILABLE`); nothing is ever stored in the clear.
4. **Keep the existing controls**: main-process-only verification, persistent lockout, 12 h lease (hard max
   24 h), revocation at the next check-in.
5. **Incident response**: if a till is suspected compromised, revoke its device
   (`revokeOfflinePinEnrollments` with `deviceId`), revoke the device itself, and have everyone who signed in
   on it **change their sign-in PIN** (it is the same as their offline PIN).
6. Prefer 6–8 digit sign-in PINs for staff who work offline. A 4-digit PIN is allowed (shifted-cafe spec), but
   it offers no real protection against the accepted malware threat.

## Rollout checklist (activation needs separate owner authorization per environment)

1. Deploy the API migrations (`20261115170000`, `20261115190000`) + code, the POS build with local schema v23,
   and SDK **0.39.0**.
2. Remove `OFFLINE_PIN_KEK` / `OFFLINE_PIN_KEK_VERSION` from the environment (nothing reads them).
3. Confirm every till meets the operating safeguards above.
4. **With explicit owner authorization for that environment**, set `POS_OFFLINE_PIN_V2=enabled`.
5. Each person signs in **online** once on each till they use. The till's next online check-in authorises
   offline sign-in there with the same PIN.
6. **Recovery:**
   - **forgotten PIN:** an admin resets the sign-in PIN online; the next online sign-in on each till re-enrols
     with the new PIN and the old version stops at that till's next check-in.
   - **lost/replaced device:** revoke the device (`deviceId` with staff.manage) and revoke the device itself.
   - **removed user:** deactivate the membership; their authorization disappears at the next check-in.
   - **till offline when revoked:** offline sign-in stops when the lease ends at the latest.

**Affected in local development (2026-11-15):** 2 memberships held v1 PINs
(`6162dfe0-b113-460b-97a9-dc4d9bd22991`, `b5321e06-39af-48aa-8e90-eaa280562471`); 0 devices were enrolled. v1
used the same PIN as the online POS login, so those two people should **change their online POS PIN** before
signing in on a till with the flag on. Shared local-dev purge (owner-approved): those 2 retired rows were deleted;
0 rows remain.

## Testing

- `pnpm test:pos:offline:pin-v2-client`: real HTTP on a disposable `rt-` stack, K1–K9:
  - same-PIN enrollment, unlock only after bootstrap;
  - lost connectivity; lockout survives restart;
  - superseded and revoked versions; lease end;
  - wrong PIN, another account's credential, missing proof;
  - sealed lockout copy.
- `pnpm test:pos:offline:lease-pin:persistence` (incl. sign-in failure accounting S1–S3).
- `pnpm test:pos:offline:pin-v1-cleanup:persistence` (old rows erased by the migration).
- API unit `tests/pos/offline-pin-service.test.ts`.
- POS `tests/offline/staff-roster.test.ts` (real SQLite + sealed store) and
  `tests/main/pos-session-manager.test.ts` (hook runs only after success, never blocks sign-in).
- `tests/offline/ipc-security.test.ts` (no renderer enrollment channel).
- `pnpm acceptance:offline-pin` (Electron + real DPAPI: crash between server record and seal, enrol once,
  repeat sign-in does not re-enrol, unlock, lockout, tamper, on-disk PIN scan).

## Troubleshooting

- **`OFFLINE_PIN_STEP_UP_FAILED`** — the credential did not verify, or belongs to another account. Before
  `20261115190000`, a failed connected sign-in crashed `staff_private.pos_login_record` (42702, ambiguous
  `failed_count`): wrong PINs answered 500 and **the sign-in lockout never engaged**. That migration fixes it;
  it is pending on shared dev.
- **`OFFLINE_PIN_DISABLED`** — `POS_OFFLINE_PIN_V2` is not `enabled` (the default).
- **Offline sign-in says wrong PIN right after the first online sign-in** — the till needs one online check-in
  (bootstrap) after that sign-in.
- **`UNAVAILABLE`** — lease ended, OS key store unavailable, or the till is not registered.
- **`OFFLINE_PIN_ENROLLMENT_DENIED`** — device not active/assigned, or the person is not a seller at this
  register.
