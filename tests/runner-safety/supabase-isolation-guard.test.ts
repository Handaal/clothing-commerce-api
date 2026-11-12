// Guard tests for the destructive-runner isolation boundary. They prove the runners abort BEFORE any
// destructive Supabase/Docker command across the full threat matrix, and that a disposable run creates and
// cleans ONLY its own resources. Everything here uses pure functions, injected fake docker executors, or
// filesystem-only resource minting — no test starts Docker, touches Supabase, or reaches a real database.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ISOLATED_PROJECT_PATTERN,
  SHARED_PROJECT_ID,
  SHARED_DB_CONTAINER,
  assertIsolatedSupabaseArgs,
  assertLoopbackDbHost,
  assertNotSharedProject,
  failClosedLegacyRunner,
  liveSharedContainers,
  sanitizedChildEnv,
} from "../../scripts/supabase-isolation-guard.mjs";
import { createResources } from "../../scripts/returns-test-resources.mjs";

// A fake docker that reports an EMPTY namespace for every `ls` query — the only docker surface the
// resource minter touches during creation/cleanup. It never has to exec a destructive command.
const emptyDocker = () => "";

describe("failClosedLegacyRunner — the hard stop for shared-project runners", () => {
  it("throws unconditionally, names the runner, and advertises no bypass", () => {
    expect(() => failClosedLegacyRunner("test:rls")).toThrow(/Refusing to run test:rls/);
    expect(() => failClosedLegacyRunner("test:rls")).toThrow(/no shared-reset bypass/i);
  });
  it("still throws even if a legacy opt-in env var is present (bypass removed)", () => {
    const prior = process.env.SUPABASE_ALLOW_SHARED_RESET;
    process.env.SUPABASE_ALLOW_SHARED_RESET = "1";
    try {
      expect(() => failClosedLegacyRunner("test:orders:rls")).toThrow(/DISABLED/);
    } finally {
      if (prior === undefined) delete process.env.SUPABASE_ALLOW_SHARED_RESET;
      else process.env.SUPABASE_ALLOW_SHARED_RESET = prior;
    }
  });
});

describe("assertNotSharedProject", () => {
  it("rejects the shared/default project id", () => {
    expect(() => assertNotSharedProject(SHARED_PROJECT_ID)).toThrow(/shared project/);
  });
  it("rejects a non-disposable id (empty, default name, arbitrary)", () => {
    for (const bad of ["", "supabase", "clothing-commerce-pos", "rt-not-hex", "rt-ABCDEF"])
      expect(() => assertNotSharedProject(bad)).toThrow(/non-disposable project id/);
  });
  it("accepts a disposable rt-<32hex> project id", () => {
    const id = "rt-" + "a".repeat(32);
    expect(ISOLATED_PROJECT_PATTERN.test(id)).toBe(true);
    expect(() => assertNotSharedProject(id)).not.toThrow();
  });
});

describe("assertLoopbackDbHost", () => {
  it("accepts loopback hosts only", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"])
      expect(() => assertLoopbackDbHost(host)).not.toThrow();
  });
  it("rejects external / shared DB hosts before any write", () => {
    for (const host of ["db.project.supabase.co", "10.0.0.5", "0.0.0.0", "example.com"])
      expect(() => assertLoopbackDbHost(host, "database")).toThrow(/non-loopback database host/);
  });
});

describe("assertIsolatedSupabaseArgs", () => {
  const repoRoot = "C:/repo";
  it("rejects a destructive start without an isolated --workdir", () => {
    expect(() => assertIsolatedSupabaseArgs(["start", "--exclude", "x"], { repoRoot })).toThrow(
      /isolated --workdir/,
    );
  });
  it("rejects db reset without --workdir", () => {
    expect(() => assertIsolatedSupabaseArgs(["db", "reset", "--local"], { repoRoot })).toThrow(
      /isolated --workdir/,
    );
  });
  it("rejects db push without --workdir", () => {
    expect(() => assertIsolatedSupabaseArgs(["db", "push"], { repoRoot })).toThrow(
      /isolated --workdir/,
    );
  });
  it("rejects --workdir pointing at the repo root", () => {
    expect(() => assertIsolatedSupabaseArgs(["stop", "--workdir", repoRoot], { repoRoot })).toThrow(
      /isolated --workdir/,
    );
  });
  it("rejects an explicit --project-id targeting the shared project", () => {
    expect(() =>
      assertIsolatedSupabaseArgs(
        ["db", "reset", "--workdir", "/tmp/rt-x", "--project-id", SHARED_PROJECT_ID],
        { repoRoot },
      ),
    ).toThrow(/explicitly targeting/);
  });
  it("allows a destructive command pinned to a disposable workdir", () => {
    expect(() =>
      assertIsolatedSupabaseArgs(["start", "--workdir", "/tmp/rt-abc", "--exclude", "x"], {
        repoRoot,
      }),
    ).not.toThrow();
  });
  it("ignores non-destructive commands (status/test db)", () => {
    expect(() =>
      assertIsolatedSupabaseArgs(["status", "--output", "json"], { repoRoot }),
    ).not.toThrow();
    expect(() =>
      assertIsolatedSupabaseArgs(["test", "db", "x.test.sql", "--local"], { repoRoot }),
    ).not.toThrow();
  });
});

describe("sanitizedChildEnv", () => {
  it("strips every inherited DB-redirecting variable", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      SUPABASE_URL: "https://shared.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "shared",
      POSTGRES_PASSWORD: "shared",
      PGHOST: "shared-db",
      PGPORT: "5432",
      POS_TEST_SUPABASE_URL: "https://shared.supabase.co",
      DATABASE_URL: "postgres://shared/db",
      DB_URL: "postgres://shared/db",
      SUPABASE_DB_URL: "postgres://shared/db",
      DIRECT_URL: "postgres://shared/db",
      SUPABASE_ALLOW_SHARED_RESET: "1",
    };
    const env = sanitizedChildEnv({}, base);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
    for (const key of [
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "POSTGRES_PASSWORD",
      "PGHOST",
      "PGPORT",
      "POS_TEST_SUPABASE_URL",
      "DATABASE_URL",
      "DB_URL",
      "SUPABASE_DB_URL",
      "DIRECT_URL",
      "SUPABASE_ALLOW_SHARED_RESET",
    ])
      expect(env[key]).toBeUndefined();
  });
  it("applies disposable overrides last, and an undefined override deletes", () => {
    const base = { SUPABASE_URL: "https://shared.supabase.co", KEEP: "1" };
    const env = sanitizedChildEnv(
      { SUPABASE_URL: "http://127.0.0.1:55001", REMOVE: undefined },
      { ...base, REMOVE: "x" },
    );
    expect(env.SUPABASE_URL).toBe("http://127.0.0.1:55001"); // isolated value survives
    expect(env.KEEP).toBe("1");
    expect(env.REMOVE).toBeUndefined();
  });
});

describe("liveSharedContainers (read-only shared-stack probe)", () => {
  it("queries the shared label and parses only non-empty names", () => {
    const seen: string[][] = [];
    const dockerExec = (args: string[]) => {
      seen.push(args);
      return `${SHARED_DB_CONTAINER}\nsupabase_kong_${SHARED_PROJECT_ID}\n`;
    };
    expect(liveSharedContainers(dockerExec)).toEqual([
      SHARED_DB_CONTAINER,
      `supabase_kong_${SHARED_PROJECT_ID}`,
    ]);
    expect(seen[0]).toContain(`label=com.supabase.cli.project=${SHARED_PROJECT_ID}`);
    expect(seen[0]).not.toContain("rm");
  });
});

describe("disposable run — creates and cleans only its own resources", () => {
  const created: Array<{ cleanup: (exec: () => string) => void; workdir: string }> = [];
  afterEach(() => {
    for (const r of created.splice(0)) {
      try {
        r.cleanup(emptyDocker);
      } catch {
        /* already cleaned */
      }
    }
  });

  it("mints a disposable rt-<hex> project with a private ownership marker and scoped labels", () => {
    const r = createResources({ dockerExec: emptyDocker });
    created.push(r);
    expect(ISOLATED_PROJECT_PATTERN.test(r.projectId)).toBe(true);
    expect(() => assertNotSharedProject(r.projectId)).not.toThrow();
    // Labels pin container/volume/network to THIS project id and workdir.
    const labels = r.labelArgs.join(" ");
    expect(labels).toContain(`com.supabase.cli.project=${r.projectId}`);
    expect(labels).toContain(`com.supabase.cli.workdir=${r.workdir}`);
    // The marker file exists and records this run's identity.
    const marker = JSON.parse(readFileSync(join(r.workdir, ".returns-test-owner.json"), "utf8"));
    expect(marker.projectId).toBe(r.projectId);
    expect(marker.workdir).toBe(r.workdir);
  });

  it("cleanup removes this run's workdir and never a foreign label", () => {
    const r = createResources({ dockerExec: emptyDocker });
    expect(existsSync(r.workdir)).toBe(true);
    // Cleanup plans against the empty namespace (0 owned docker resources) then removes the workdir only.
    r.cleanup(emptyDocker);
    expect(existsSync(r.workdir)).toBe(false);
  });

  it("bindConfig fails closed if the project_id swap did not take (would fall back to shared)", () => {
    const r = createResources({ dockerExec: emptyDocker });
    created.push(r);
    expect(() => r.bindConfig(`project_id = "${SHARED_PROJECT_ID}"\n`)).toThrow(
      /Invalid isolated Supabase project/,
    );
    // The positive bind re-reads the on-disk config as an ownership check; write it as a real runner would.
    const config = `project_id = "${r.projectId}"\n`;
    mkdirSync(join(r.workdir, "supabase"));
    writeFileSync(join(r.workdir, "supabase", "config.toml"), config);
    expect(() => r.bindConfig(config)).not.toThrow();
  });
});

describe("two concurrent disposable runs are fully disjoint", () => {
  it("have disjoint project ids, workdirs, labels, and cleanup scopes", () => {
    const a = createResources({ dockerExec: emptyDocker });
    const b = createResources({ dockerExec: emptyDocker });
    try {
      expect(a.projectId).not.toBe(b.projectId);
      expect(a.workdir).not.toBe(b.workdir);
      // Each run's labels name only its own project id — neither can match the other's resources.
      expect(a.labelArgs.join(" ")).toContain(a.projectId);
      expect(a.labelArgs.join(" ")).not.toContain(b.projectId);
      expect(b.labelArgs.join(" ")).toContain(b.projectId);
      expect(b.labelArgs.join(" ")).not.toContain(a.projectId);
      // The cleanup label filter each run would issue is distinct (captured via an inspecting fake).
      const scope = (r: ReturnType<typeof createResources>) => {
        const calls: string[][] = [];
        r.plan((args: string[]) => {
          calls.push(args);
          return "";
        });
        return calls.flat().filter((a) => a.includes("com.supabase.cli.project="));
      };
      const scopeA = scope(a);
      const scopeB = scope(b);
      expect(scopeA.every((f) => f.includes(a.projectId))).toBe(true);
      expect(scopeB.every((f) => f.includes(b.projectId))).toBe(true);
      expect(scopeA.some((f) => f.includes(b.projectId))).toBe(false);
    } finally {
      a.cleanup(emptyDocker);
      b.cleanup(emptyDocker);
    }
  });
});
