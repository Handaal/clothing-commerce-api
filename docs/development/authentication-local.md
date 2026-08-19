# Local Staff Authentication and Authorization

## What runs locally

Phase 1D has three distinct development paths:

- `pnpm test:authorization` is deterministic and needs no Clerk account, Supabase service key, or
  network. It uses a provider verifier double and in-memory authorization repository while keeping
  the real mapping and evaluation services under test.
- `pnpm test:authorization:integration` starts and resets a disposable local Supabase API stack,
  applies test-only fixtures, and exercises the real `SupabaseAuthorizationRepository`. It needs
  Docker but no Clerk account, cloud project, `.env`, or production credential.
- Running a future protected route against real development services requires a Clerk development
  instance and a Supabase project populated with matching foundational identity records. Phase 1D
  deliberately adds no public protected route or automatic provisioning workflow.

All local database tests remain cloud-credential-free and do not call Clerk. The repository
integration runner starts local Supabase Auth only because the CLI emits the local service-role key
when that service is present; it does not create or authenticate a user.

## Environment variables

Copy `.env.example` to the local environment mechanism used by Next.js and set only development
values:

| Variable                    | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `CLERK_SECRET_KEY`          | Server credential used by `@clerk/backend`; never client-visible        |
| `CLERK_PUBLISHABLE_KEY`     | Identifies the Clerk instance required by request authentication        |
| `CLERK_AUTHORIZED_PARTIES`  | Comma-separated exact HTTP(S) origins allowed to send session requests  |
| `CLERK_JWT_KEY`             | Optional PEM public key for networkless session-token verification      |
| `SUPABASE_URL`              | Server Data API URL                                                     |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged server key used only inside the narrow authorization adapter |

`CLERK_AUTHORIZED_PARTIES` should normally include `http://localhost:3000` for local browser
development and exact deployed admin origins in staging/production. Paths, wildcards, credentials,
queries, fragments, and non-HTTP schemes are rejected. Do not prefix secrets with `NEXT_PUBLIC_`,
`VITE_`, or `EXPO_PUBLIC_`.

Configuration is validated only when `createServerAuthorizationBoundary()` is created, so health,
unit, authorization, persistence, and RLS tests do not require secrets. Invalid or missing values
fail startup/composition rather than producing a partially trusted boundary.

## Clerk development setup

1. Create or select a Clerk **development** instance for staff/admin users.
2. Copy its publishable and secret keys into local server configuration; do not commit them.
3. Add the exact local admin origin to `CLERK_AUTHORIZED_PARTIES`.
4. Optionally copy the instance JWT public key to `CLERK_JWT_KEY` for networkless verification.
5. Sign in through a staff client and send its short-lived Clerk session token normally. The API
   accepts only `session_token`, not Clerk organization roles or metadata as authorization.

Clerk's official backend request-authentication reference is
[`authenticateRequest()`](https://clerk.com/docs/reference/backend/authenticate-request). Clerk's
browser testing helpers require development credentials and target end-to-end UI flows; they are
not needed for this repository's deterministic authorization suite.

## Provisioning matching local records

The verified Clerk `userId` must match one linked row in
`user_identity_provider_bindings(provider, provider_subject)` with provider exactly `clerk`. That
row points to a global active UserIdentity. An active Tenant and active Membership for the selected
Tenant are also required. Permission evaluation additionally needs current Role, RolePermission,
AccessScope, target, and MembershipRoleAssignment records.

Phase 1D does not ship seed data or a provisioning command. In disposable local development, use a
reviewed fixture or a future approved admin workflow. Never improvise manual production changes.
Do not use email as the binding key.

When diagnosing a specific development account in a trusted SQL console, query narrowly:

```sql
select id, user_identity_id, provider, linked_at, unlinked_at
from public.user_identity_provider_bindings
where provider = 'clerk'
  and provider_subject = '<exact verified development Clerk userId>';
```

Avoid broad binding-table dumps. Provider subjects are sensitive linkage metadata: do not paste
them into tickets, screenshots, logs, fixtures, or commits. Follow with targeted UserIdentity,
Membership, and assignment queries by the returned internal UUIDs. Ordinary authenticated Data API
access intentionally cannot read provider bindings.

## Commands

```powershell
pnpm install --frozen-lockfile
pnpm test:authorization
pnpm test:authorization:integration
pnpm typecheck
pnpm test
pnpm test:persistence
pnpm test:rls
pnpm build
```

On Windows use `pnpm.cmd` when PowerShell execution policy blocks `pnpm.ps1`.

The authorization tests cover 57 deterministic cases across Clerk result handling, provider
mapping, identity/Tenant/Membership/Device lifecycle, Permission and exact scope evaluation,
multi-role escalation, foreign-Tenant resources, protected Roles, configuration, runtime proof
validation, and privileged operation gating. The integration suite adds 20 cases over the actual
PostgreSQL tables and Data API adapter, including controlled corrupt states in the disposable DB.

## Troubleshooting

- **401 `UNAUTHENTICATED`:** verify a Clerk session token is present, unexpired, from the configured
  instance, and sent from an authorized party. Do not log the token.
- **`PROVIDER_BINDING_MISSING`:** confirm the exact development Clerk `userId` has a linked `clerk`
  binding. Email and metadata do not substitute.
- **Tenant denial:** confirm the selected UUID and the derived UserIdentity have one active
  Membership. A selector never proves access.
- **Lifecycle denial:** inspect UserIdentity, Membership, Tenant, and trusted Device status with
  narrow UUID predicates.
- **Permission/scope denial:** inspect current assignment, active Role/Permission/AccessScope, and
  exact scope targets. Branch and Warehouse scopes do not imply InventoryLocation scope.
- **Configuration parse failure:** verify authorized parties are exact origins and all credentials
  are server-only non-empty values.
- **Supabase query failure:** verify the development URL/key pair and foundational migrations. Do
  not work around it by exporting a generic service-role client.
- **Repository integration:** ensure Docker is running and ports `54321` and `54322` are available.
  The runner stops/removes its stack even after a failed test; rerun the command from the repository
  root after resolving the first reset, fixture, or adapter error.

## Development, CI, staging, and production

CI uses no Clerk or Supabase production credentials for authorization tests. Its repository
integration uses only the disposable local CLI stack. Staging and production must use separate
Clerk/Supabase projects,
secret-manager injection, exact deployed authorized parties, restricted server networking, and
redacted logs. Key rotation, webhook-driven provider lifecycle, audit events, and deployment
automation require their own operational design before production launch.
