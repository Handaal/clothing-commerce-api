# ADR-012: Identity Integration and Application Authorization Foundation

- Status: Accepted
- Date: 2026-08-19

## Context

Phase 1C-B trusts signed provider-neutral database claims but cannot prove that an internal
UserIdentity belongs to the external person presenting a request. Service-role access also bypasses
RLS. Phase 1D must establish identity provenance, current lifecycle checks, Permission and
AccessScope evaluation, and a safe privileged-operation sequence without making Clerk the domain
authorization model.

## Decision

- Clerk initially verifies staff/admin session tokens. Its verified `userId` maps through the
  existing unique provider-plus-subject binding to the internal UserIdentity.
- The client selects one Tenant as requested context. The server requires the derived active
  UserIdentity, an active Membership for that exact Tenant, and an active Tenant.
- Authorization loads current assignments from the database on every request. Client token claims
  do not carry authoritative Roles, Permissions, scopes, or internal IDs.
- Permission and scope remain coupled per MembershipRoleAssignment. Each protected resource must
  be covered by an assignment that itself grants the requested Permission.
- Explicit Brand, Branch, Warehouse, and InventoryLocation targets use exact-match semantics. No
  facility hierarchy is inferred. Brand and physical location are orthogonal.
- Resource ownership is resolved before privileged business access. The private service-role
  adapter exposes only authorization-state reads and resource Tenant lookup, never a generic
  client or mutation method.
- Successful authorization issues an immutable in-process proof tracked by a module-private
  runtime registry. Privileged repositories must call the exported assertion; structural objects,
  casts, copies, and deserialized values are not valid capabilities.
- `roles.is_protected` identifies protected Roles. No Phase 1D runtime operation can rename,
  archive, delete, or change their Permissions. A future platform workflow needs separate review;
  high-risk Permission delegation remains disabled until catalog classification and founder policy
  are approved.
- Verified active Device context is optional until Device authentication exists; if supplied,
  revoked or inactive Devices are denied.
- Until a reviewed Device credential verifier exists, the plain `VerifiedDeviceIdentity` extension
  shape is server-internal only and the composition root supplies no Device context.

## Alternatives rejected

- Trust internal identity/Tenant claims from the client: breaks identity provenance and Tenant
  isolation.
- Use Clerk metadata or organization roles: makes the external provider the authorization model
  and permits stale/user-editable policy.
- Union all Role Permissions and all scopes independently: creates cross-assignment privilege
  escalation.
- Infer Branch/Warehouse descendant access: grants authority not explicitly persisted.
- Put authorization only in RLS: cannot express operation Permission/scope semantics and does not
  protect service-role operations.
- Add authorization caching now: adds invalidation and revocation risk without evidence of need.

## Consequences

Every staff/admin request performs current-state authorization reads. Correctness and immediate
next-request revocation take precedence over optimization. Future protected services must require
and runtime-assert authorization proof before narrow privileged repositories. A disposable
Supabase integration suite exercises the real adapter and controlled corrupt state without
altering migrations. There is no new public API, schema
migration, Permission seed, customer authentication, or offline POS policy. Provider lifecycle,
high-risk delegation, audit storage, and transaction-level rechecks for future critical mutations
remain separately governed work.
