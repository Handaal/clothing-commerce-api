import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const supabaseEntrypoint = join(repositoryRoot, "node_modules", "supabase", "dist", "supabase.js");
const testFile = join("supabase", "tests", "phase_2b_inventory_rls.test.sql");
const expectedTestCount = 30;
const excludedServices = [
  "gotrue",
  "realtime",
  "storage-api",
  "imgproxy",
  "kong",
  "mailpit",
  "postgrest",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
];

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });

  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "none"}`,
    );
  }

  return result;
}

function runSupabase(args, options) {
  return run(process.execPath, [supabaseEntrypoint, ...args], options);
}

function verifyExpectedTestPlan() {
  const testSource = readFileSync(join(repositoryRoot, testFile), "utf8");
  const planMatches = [...testSource.matchAll(/\bselect\s+plan\(\s*(\d+)\s*\)\s*;/giu)];

  if (planMatches.length !== 1) {
    throw new Error(`Expected exactly one pgTAP plan declaration, found ${planMatches.length}.`);
  }

  const declaredTestCount = Number(planMatches[0][1]);

  if (declaredTestCount !== expectedTestCount) {
    throw new Error(
      `Expected a ${expectedTestCount}-assertion pgTAP plan, found ${declaredTestCount}.`,
    );
  }

  process.stdout.write(
    `Verified expected inventory pgTAP plan: ${expectedTestCount} assertions.\n`,
  );
}

verifyExpectedTestPlan();
run("docker", ["version", "--format", "Docker engine {{.Server.Version}}"]);
runSupabase(["--version"]);

let startAttempted = false;

try {
  startAttempted = true;
  runSupabase(["start", "--exclude", excludedServices.join(",")]);
  runSupabase(["db", "reset", "--local", "--no-seed"]);
  runSupabase(["test", "db", testFile, "--local"]);
  process.stdout.write("Phase 2B inventory Supabase RLS tests passed from a reset database.\n");
} finally {
  if (startAttempted) {
    const cleanup = runSupabase(["stop", "--no-backup"], { allowFailure: true });

    if (cleanup.status !== 0) {
      process.stderr.write("Failed to stop the local Supabase stack and remove its test data.\n");
      process.exitCode = 1;
    } else {
      process.stdout.write("Stopped the local Supabase stack and removed its disposable data.\n");
    }
  }
}
