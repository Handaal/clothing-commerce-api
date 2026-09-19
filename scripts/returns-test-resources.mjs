import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  existsSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

// Only Phase 2M test infrastructure uses this boundary. No Supabase stop/reset, prune,
// wildcard deletion, or fallback cleanup is permitted here.
export function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Docker command failed: ${args.slice(0, 2).join(" ")}`);
  return result.stdout.trim();
}

export function createResources() {
  const runId = randomUUID().replaceAll("-", "");
  // Supabase truncates project IDs over 40 characters. Keep the entire UUID intact.
  const projectId = `rt-${runId}`;
  const parent = realpathSync(tmpdir());
  const workdir = mkdtempSync(join(parent, `${projectId}-`));
  const marker = JSON.stringify({ runId, projectId, workdir });
  writeFileSync(join(workdir, ".returns-test-owner.json"), marker, { flag: "wx" });
  let configuration;

  function assertOwner() {
    if (
      !/^rt-[a-f0-9]{32}$/.test(projectId) ||
      dirname(workdir) !== parent ||
      !basename(workdir).startsWith(`${projectId}-`) ||
      lstatSync(workdir).isSymbolicLink() ||
      realpathSync(workdir) !== workdir ||
      lstatSync(join(workdir, ".returns-test-owner.json")).isSymbolicLink() ||
      readFileSync(join(workdir, ".returns-test-owner.json"), "utf8") !== marker
    )
      throw new Error("Refusing cleanup: test ownership marker/path mismatch");
    if (
      configuration !== undefined &&
      readFileSync(join(workdir, "supabase/config.toml"), "utf8") !== configuration
    )
      throw new Error("Refusing operation: isolated Supabase configuration changed");
  }
  function bindConfig(text) {
    if (
      !text.includes(`project_id = "${projectId}"`) ||
      (text.match(/^project_id\s*=/gm) ?? []).length !== 1
    )
      throw new Error("Invalid isolated Supabase project");
    configuration = text;
    assertOwner();
  }
  const labels = {
    "com.supabase.cli.project": projectId,
    "com.docker.compose.project": projectId,
    "com.supabase.cli.workdir": workdir,
  };
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
  function inspect(kind, id, execute = docker) {
    return JSON.parse(execute([kind, "inspect", id]))[0];
  }
  function verify(kind, resource) {
    const name = (resource.Name ?? "").replace(/^\//, "");
    const metadata = kind === "container" ? resource.Config.Labels : resource.Labels;
    if (
      !name.endsWith(`_${projectId}`) ||
      metadata?.["com.supabase.cli.project"] !== projectId ||
      metadata?.["com.docker.compose.project"] !== projectId ||
      (kind === "container" && metadata?.["com.supabase.cli.workdir"] !== workdir)
    )
      throw new Error(`Refusing cleanup: unowned ${kind} ${name}`);
    return resource;
  }
  function plan(execute = docker) {
    assertOwner();
    const resources = {};
    for (const kind of ["container", "volume", "network"]) {
      const args =
        kind === "container" ? ["container", "ls", "--all", "--quiet"] : [kind, "ls", "--quiet"];
      const ids = execute([...args, "--filter", `label=com.supabase.cli.project=${projectId}`])
        .split(/\s+/)
        .filter(Boolean);
      resources[kind] = ids.map((id) => verify(kind, inspect(kind, id, execute)));
    }
    const volumes = new Set(resources.volume.map((r) => r.Name));
    const containers = new Set(resources.container.map((r) => r.Id));
    for (const container of resources.container)
      for (const mount of container.Mounts ?? [])
        if (mount.Type === "volume" && !volumes.has(mount.Name))
          throw new Error("Refusing cleanup: container mounts an unowned volume");
    for (const network of resources.network)
      if (Object.keys(network.Containers ?? {}).some((id) => !containers.has(id)))
        throw new Error("Refusing cleanup: network contains an unowned container");
    return resources;
  }
  function cleanup(execute = docker) {
    // Validate the ENTIRE plan before the first deletion. Recheck identity immediately
    // before each removal. Any inspection/removal failure stops cleanup, preserving evidence.
    const resources = plan(execute);
    for (const kind of ["container", "network", "volume"]) {
      for (const resource of resources[kind]) {
        assertOwner();
        const id = resource.Id ?? resource.Name;
        const current = verify(kind, inspect(kind, id, execute));
        if (current.Id !== resource.Id || current.CreatedAt !== resource.CreatedAt)
          throw new Error("Refusing cleanup: resource identity changed");
        execute([kind, "rm", ...(kind === "container" ? ["--force"] : []), id]);
      }
    }
    assertOwner();
    const link = join(workdir, "node_modules");
    if (existsSync(link)) {
      if (!lstatSync(link).isSymbolicLink())
        throw new Error("Refusing cleanup: unexpected node_modules directory");
      unlinkSync(link);
    }
    rmSync(workdir, { recursive: true });
  }
  // A cryptographically fresh project must start empty; never reuse another run's resources.
  const initial = plan();
  if (Object.values(initial).some((items) => items.length))
    throw new Error("Test namespace already exists");
  return { runId, projectId, workdir, labelArgs, assertOwner, bindConfig, plan, cleanup };
}

// Catchable interrupts use the same guarded cleanup as success/failure. SIGKILL or a
// host crash can leave test-owned resources behind; neither can trigger broader deletion.
export function handleInterrupts(cleanup) {
  let cleaning = false;
  const handler = (signal) => {
    if (cleaning) return;
    cleaning = true;
    try {
      cleanup();
    } catch (error) {
      process.stderr.write(`${error.message}; test resources retained.\n`);
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const interrupt = () => handler("SIGINT");
  const terminate = () => handler("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  return () => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  };
}
