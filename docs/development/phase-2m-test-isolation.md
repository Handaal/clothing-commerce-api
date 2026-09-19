# Phase 2M test infrastructure safety closeout

This closes the local data-loss incident recorded in [Phase 2M validation](phase-2m-validation.md).
The earlier incident record remains unchanged; the lost data has not been recovered.

## Exact destructive path

The early, uncommitted `scripts/test-returns.mjs` implementation ran:

```text
node C:\Users\ydelk\Desktop\clothing-commerce-api\node_modules\supabase\dist\supabase.js stop --no-backup
cwd: C:\Users\ydelk\Desktop\clothing-commerce-api
```

Its `finally` block invoked `run(process.execPath, [supabase, "stop", "--no-backup"])`.
The shared `run()` helper still defaulted to `cwd: root`. Startup and reset explicitly overrode that
default with the temporary workdir, but cleanup did not. Cleanup supplied neither `--workdir` nor
`--project-id`, so the CLI read the repository's `supabase/config.toml`, selected project
`clothing-commerce-api`, stopped that normal development stack, and removed its data volume
`supabase_db_clothing-commerce-api`.

This was **Supabase `stop --no-backup`**, not an application-issued `docker compose down -v`, explicit
`docker volume rm`, or a collision between the original test and development project names.
The installed CLI's `stop --help` describes `--no-backup` as deleting all data volumes after stopping.

Evidence was checked against the original execution transcript, not just the validation summary:
the script captured at 2026-09-19 05:12:25 UTC and again at 05:18:36 UTC shows `cwd: root`; the
05:13:33 edit isolated startup but retained cleanup without a workdir override; the Docker inspection
at 05:18:36 showed the normal stack/volume absent while the temporary project survived. The 05:19:18
correction changed the default workdir. The restarted development database's current container start
time is 2026-09-19T05:19:31.343685373Z. Restarting did not recover the deleted volume's prior data.

## Corrected isolation and invariant

`scripts/returns-test-resources.mjs` is the shared ownership boundary for the two Phase 2M runners.
Each run generates a UUID and project `rt-<32 hexadecimal characters>`. The 35-character project ID
fits the installed Supabase CLI's 40-character limit without truncation. A unique temporary workdir
contains an exact ownership marker. The marker, resolved directory, project ID and saved Supabase
configuration must agree.

The integration runner passes `--workdir` explicitly to every Supabase invocation. API, database and
Next.js ports are selected from currently free ports. A fresh project starts with migrations; there
is no database reset. Persistence uses a separately labelled container and tmpfs storage, with no
published ports. Neither runner uses Supabase stop, global prune, wildcard removal or cleanup that
depends on the caller's current directory.

Before any deletion, cleanup inspects the complete set selected by the **exact generated project
label**, then validates every resource's full name and both project labels. Containers must also
carry the exact workdir label. Every mounted volume and network member must belong to that plan.
The normal project `clothing-commerce-api` fails these checks and cannot enter a deletion plan.
Cleanup rechecks identity before removing exact container/network IDs and exact owned volume names.
Filesystem cleanup validates the resolved temporary path and marker and unlinks node_modules before
removing the temporary directory.

**Safety invariant:** no ownership proof means no deletion. Inspection errors, mismatched labels,
configuration changes, unknown mounts or Docker failures stop cleanup. There is no broader fallback.
Resources that cannot be proven owned are retained for inspection, even if that leaves a test leak.

## Failure and interruption

Success and assertion failures use the same guarded `finally` cleanup. SIGINT/SIGTERM handlers use
that same ownership boundary and exit nonzero. Synchronous Docker/CLI calls can delay signal handling
until the call returns. The integration runner first stops only its own spawned Next.js process tree.
A Docker failure midway stops immediately; remaining owned resources and the marker stay available.
The regression proves a retry can remove only those remaining owned resources.

SIGKILL, Windows force-termination, Docker daemon loss or a host crash cannot guarantee cleanup;
they may leave isolated test resources. They do not authorize deletion of anything else. Inspect the
exact run marker, resource names, labels and mounts before manually recovering such a run. Never use
the normal development project's stop/reset command or prune all resources as recovery.

## Reproduction and validation

```bash
pnpm test:returns:safety
pnpm test:returns:safety --with-runners
```

The first command creates real Docker volumes with sentinel data. It proves success, failure and
interruption remove the subject run's ephemeral resources while another run's data survives. It also
proves invalid markers, normal-project discovery/configuration substitution and midway Docker errors
fail closed. Linux sends an actual SIGINT to the worker; Windows invokes the registered SIGINT handler
because Windows does not provide equivalent POSIX signal delivery.

The second command additionally runs Phase 2M persistence/integration and the normal foundation
persistence gate. When the normal development stack is already running, it compares container IDs,
start times, restart counts, ports, mounts, volume metadata, full schema fingerprints and logical
public/migration data fingerprints before and after each runner. These are read-only observations;
the proof never writes a sentinel into the developer's database. A separate unrelated volume holds
the regression sentinel. Local proof manifests and command logs are kept under ignored `artifacts/`.
If the normal stack is absent, the output says so rather than claiming a live-stack proof.

CI runs the narrow safety regression before Phase 2M persistence/integration. No Returns domain,
OpenAPI, SDK, migration or client code is changed by this closeout.

Executed on 2026-09-19 with the existing development stack running and populated: all safety scenarios,
Phase 2M persistence (20 assertions and two expected errors), integration (19 HTTP tests and 228 RLS
assertions), and the normal foundation persistence gate (two complete migration/invariant cycles)
passed. Development before/after manifests were identical, including database container
`ab440f658b6f`, its original start time, ports, volume metadata, schema and public/migration data
fingerprints. Frozen install, formatting, lint, strict TypeScript and `git diff --check` also passed.
The 229-test unit suite was not rerun because this closeout changes only test infrastructure and docs.
