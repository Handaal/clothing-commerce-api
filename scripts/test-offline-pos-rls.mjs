import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supabase = join(root, "node_modules", "supabase", "dist", "supabase.js");
const file = join("supabase", "tests", "phase_2i_offline_pos_rls.test.sql");
function run(command, args, allow = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  if (!allow && result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  return result;
}
const source = readFileSync(join(root, file), "utf8");
if (!/select\s+plan\(10\)/i.test(source))
  throw new Error("Expected Phase 2I 10-assertion pgTAP plan.");
const excluded = [
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
let started = false;
try {
  run("docker", ["version", "--format", "Docker engine {{.Server.Version}}"]);
  started = true;
  run(process.execPath, [supabase, "start", "--exclude", excluded.join(",")]);
  run(process.execPath, [supabase, "db", "reset", "--local", "--no-seed"]);
  run(process.execPath, [supabase, "test", "db", file, "--local"]);
} finally {
  if (started) {
    const result = run(process.execPath, [supabase, "stop", "--no-backup"], true);
    if (result.status !== 0) process.exitCode = 1;
  }
}
