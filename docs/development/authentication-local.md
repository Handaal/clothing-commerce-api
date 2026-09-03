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

Phase 1D shipped no seed data or provisioning command. For Phase 2F-B Admin Mobile real-runtime
acceptance, a reviewed **development-only** provisioning workflow now exists — see
[Development identity provisioning](#development-identity-provisioning) below. Never improvise manual
production changes. Do not use email as the binding key.

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

## Development identity provisioning

**Authentication is not authorization.** Signing into Clerk proves _who_ a person is; it grants **no**
Commerce access on its own. Access exists only when a tenant Membership carries a Role whose Permissions
are scoped by an AccessScope through an active MembershipRoleAssignment. The API never auto-creates any of
that during a request. To exercise the real `/me/tenants` → tenant selection → `/me/context` flow (and
later the Phase 2F-B Products / Inventory / Orders reads) against local infrastructure, you must bind a
real Clerk development user into that model **once**, out of band.

`pnpm dev:provision-identity` does exactly that, and nothing more. It is **development-only** and
**local-only**: it refuses to run without the explicit `COMMERCE_DEV_PROVISIONING=1` opt-in, and it only
knows how to target the local Supabase container (`supabase_db_clothing-commerce-api`). A non-local
Supabase host is a hard failure with no override — the command cannot reach a remote or production project.

### What it creates

A single minimum representative Phase 2F-B management reader:

- an **active** `dev-local` Tenant (`slug=dev-local`, `default_currency=USD`),
- an **active** UserIdentity bound to your Clerk subject through an **active** `clerk` provider binding,
- an **active** Membership of that identity in `dev-local`,
- an **active** Role `Dev Management Reader` granting **exactly** `catalog.read`, `inventory.read`, and
  `orders.read` — no mutation permissions, no owner/platform bypass,
- an **active**, tenant-wide AccessScope `Dev Tenant Wide`, and
- an **active** MembershipRoleAssignment tying them together.

It never creates permission-catalog entries: the three read permissions must already exist from canonical
migrations. If they are missing, the command fails and tells you to run `pnpm supabase:reset`.

### First create a real Clerk development user

1. In your Clerk **development** instance, create (or reuse) a staff/admin user.
2. Copy that user's **User ID** (the `user_…` subject) from the Clerk dashboard. This is the value the
   command binds. Treat it as sensitive linkage metadata: do not paste it into tickets, logs, or commits.

### Run it

```powershell
pnpm exec supabase start --exclude realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
pnpm supabase:reset            # applies migrations, incl. the read-permission catalog

$env:COMMERCE_DEV_PROVISIONING = "1"
pnpm dev:provision-identity -- --clerk-subject <REAL_CLERK_USER_ID>

pnpm dev                       # start the API with your CLERK_* + SUPABASE_* values
```

Start Admin Mobile with the **same** `CLERK_PUBLISHABLE_KEY` and sign in as that user. It prints a concise
summary (tenant / membership / role / assignment IDs, granted permissions, and created-vs-reused per
entity); it never prints the Clerk subject, service-role key, or any bearer token. `pnpm
dev:provision-identity -- --help` shows usage.

### Idempotency, conflicts, and reset

Running it again with the same subject reuses every row and creates no duplicates. All writes are wrapped
in one transaction — any failure rolls the whole graph back, never leaving a partial identity. It fails
loudly (and changes nothing) if the Clerk subject is already bound to a conflicting identity (an unlinked
binding, or a suspended/deactivated identity), or if the existing tenant/membership/role/scope conflicts
with the expected development shape; it will not silently rebind or widen access. To wipe the local data
entirely, `pnpm supabase:stop` (the local stack is disposable) or `pnpm supabase:reset` and re-provision.

### Seeding catalog data for the read slices

Identity provisioning authorizes `dev-local` but leaves it empty. To seed a small deterministic
catalog/inventory/order graph so the Admin Mobile Products (and later Inventory / Orders / Fulfillment)
read slices have data to render, run the local commerce fixture **after** provisioning the identity —
see [Local development commerce fixture](./commerce-fixture.md).

### Troubleshooting

- **`COMMERCE_DEV_PROVISIONING=1` error:** the opt-in env var is unset; export it for the session.
- **Non-local host refusal:** `SUPABASE_URL`/`supabase status` points at a non-local host. This command
  only provisions the local stack by design; use the local Supabase instance.
- **Container/API not running:** use the API-capable local start command above, then run
  `pnpm supabase:reset`.
- **Canonical read permissions missing:** the local DB is behind on migrations; run `pnpm supabase:reset`.
- **`PROVIDER_BINDING_MISSING` at runtime:** confirm you provisioned the exact Clerk User ID you signed in
  as. Email and metadata do not substitute.

## Commands

```powershell
pnpm install --frozen-lockfile
pnpm test:authorization
pnpm test:authorization:integration
pnpm typecheck
pnpm test
pnpm test:persistence
pnpm test:rls
pnpm test:dev:provisioning
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
