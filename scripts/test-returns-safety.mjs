import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createResources, docker, handleInterrupts } from "./returns-test-resources.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const self = fileURLToPath(import.meta.url);
const image = "postgres:17.6-alpine";

function createFixture() {
  const scope = createResources();
  const volume = `supabase_db_${scope.projectId}`;
  const container = `probe_${scope.projectId}`;
  docker(["volume", "create", ...scope.labelArgs, volume]);
  docker([
    "run",
    "--detach",
    "--name",
    container,
    ...scope.labelArgs,
    "--mount",
    `type=volume,source=${volume},target=/proof`,
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--entrypoint",
    "sh",
    image,
    "-c",
    "echo preserved-data > /proof/sentinel; exec sleep 600",
  ]);
  return { scope, volume, container };
}

// Worker exercises the very same finally and signal cleanup used by the runners.
if (process.argv.includes("--worker")) {
  const fixture = createFixture();
  const remove = handleInterrupts(() => fixture.scope.cleanup());
  process.send({ volume: fixture.volume, container: fixture.container });
  process.once("message", (mode) => {
    if (mode === "interrupt") {
      // Windows lacks POSIX signal delivery; dispatch the actual registered SIGINT handler.
      process.emit("SIGINT");
      return;
    }
    try {
      if (mode === "failure") throw new Error("Expected test failure");
    } catch {
      process.exitCode = 1;
    } finally {
      remove();
      fixture.scope.cleanup();
      process.disconnect();
    }
  });
} else {
  const normal = snapshotDevelopment();
  if (process.argv.includes("--with-runners")) {
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(
      join(root, "artifacts/returns-safety-development-before.json"),
      JSON.stringify(normal, null, 2),
    );
  }
  // A second, live volume with data represents an unrelated developer-owned resource.
  // Its creator retains the only cleanup authority; the subject scope never gets its identity.
  const unrelated = createFixture();
  try {
    for (const mode of ["success", "failure", "interrupt"]) {
      const worker = spawn(process.execPath, [self, "--worker"], {
        cwd: root,
        windowsHide: true,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const fixture = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`Worker exited before readiness: ${code}`)));
      });
      assert(docker(["volume", "inspect", fixture.volume]));
      const exited = new Promise((resolve) =>
        worker.once("exit", (code, signal) => resolve({ code, signal })),
      );
      if (mode === "interrupt" && process.platform !== "win32") worker.kill("SIGINT");
      else worker.send(mode);
      const { code, signal } = await exited;
      assert.equal(signal, null);
      assert.equal(code, mode === "success" ? 0 : mode === "interrupt" ? 130 : 1);
      assert(
        !docker(["volume", "ls", "--format", "{{.Name}}"]).split("\n").includes(fixture.volume),
      );
      assert(
        !docker(["container", "ls", "--all", "--format", "{{.Names}}"])
          .split("\n")
          .includes(fixture.container),
      );
      assert.equal(
        docker(["exec", unrelated.container, "cat", "/proof/sentinel"]),
        "preserved-data",
      );
      console.log(`PASS ${mode}: owned resources removed; unrelated data preserved`);
    }

    const subject = createFixture();
    try {
      const marker = join(subject.scope.workdir, ".returns-test-owner.json");
      const saved = readFileSync(marker, "utf8");
      writeFileSync(marker, "not-owned");
      assert.throws(() => subject.scope.cleanup(), /ownership/);
      writeFileSync(marker, saved);
      assert(docker(["volume", "inspect", subject.volume]));

      // Reproduce misrouting: even a discovery result returning a normal development
      // container is rejected by identity/labels BEFORE any destructive command.
      const foreign = JSON.parse(docker(["container", "inspect", unrelated.container]))[0];
      foreign.Name = "/supabase_db_clothing-commerce-api";
      foreign.Config.Labels["com.supabase.cli.project"] = "clothing-commerce-api";
      let deletes = 0;
      assert.throws(
        () =>
          subject.scope.cleanup((args) => {
            if (args[1] === "rm") deletes++;
            if (args[0] === "container" && args[1] === "inspect") return JSON.stringify([foreign]);
            return docker(args);
          }),
        /unowned/,
      );
      assert.equal(deletes, 0);
      console.log("PASS invalid marker and normal-project misrouting: zero deletions");

      const configPath = join(subject.scope.workdir, "supabase/config.toml");
      mkdirSync(dirname(configPath));
      const config = `project_id = "${subject.scope.projectId}"\n`;
      writeFileSync(configPath, config);
      subject.scope.bindConfig(config);
      writeFileSync(configPath, 'project_id = "clothing-commerce-api"\n');
      assert.throws(() => subject.scope.cleanup(), /configuration changed/);
      writeFileSync(configPath, config);
      assert(docker(["volume", "inspect", subject.volume]));
      console.log("PASS normal-project config substitution: cleanup aborted");

      let removedContainer = false;
      assert.throws(
        () =>
          subject.scope.cleanup((args) => {
            if (args[0] === "volume" && args[1] === "rm")
              throw new Error("Injected Docker failure");
            const result = docker(args);
            if (args[0] === "container" && args[1] === "rm") removedContainer = true;
            return result;
          }),
        /Injected Docker failure/,
      );
      assert(removedContainer);
      assert(existsSync(subject.scope.workdir));
      assert(docker(["volume", "inspect", subject.volume]));
      assert.equal(
        docker(["exec", unrelated.container, "cat", "/proof/sentinel"]),
        "preserved-data",
      );
      subject.scope.cleanup(); // Retry only the remaining, still-proven owned volume.
      console.log(
        "PASS midway Docker failure: no fallback; evidence retained; exact owned retry succeeds",
      );
    } finally {
      if (existsSync(subject.scope.workdir)) subject.scope.cleanup();
    }

    if (process.argv.includes("--with-runners")) {
      for (const name of [
        "test-returns-persistence.mjs",
        "test-returns.mjs",
        "test-persistence.mjs",
      ]) {
        const result = spawnSync(process.execPath, [join(root, "scripts", name)], {
          cwd: root,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        });
        // Local diagnostic artifact only; do not emit database/credential contents.
        writeFileSync(
          join(root, "artifacts", `returns-safety-${name}.log`),
          `${result.stdout}\n${result.stderr}`,
        );
        assert.equal(result.status, 0, `${name} failed; see artifacts/returns-safety-${name}.log`);
        assert.deepEqual(snapshotDevelopment(), normal, "Normal dev Supabase changed");
        console.log(
          `PASS ${name}: normal dev containers, ports, volumes, schema, data and migrations unchanged`,
        );
      }
    }
    const after = snapshotDevelopment();
    assert.deepEqual(after, normal, "Normal dev Supabase changed");
    if (process.argv.includes("--with-runners"))
      writeFileSync(
        join(root, "artifacts/returns-safety-development-after.json"),
        JSON.stringify(after, null, 2),
      );
    console.log(
      `PASS development resource preservation (${normal ? "live stack with logical database fingerprints" : "normal stack absent"})`,
    );
  } finally {
    unrelated.scope.cleanup();
  }
}

function snapshotDevelopment() {
  const ids = docker([
    "container",
    "ls",
    "--all",
    "--quiet",
    "--filter",
    "label=com.supabase.cli.project=clothing-commerce-api",
  ])
    .split(/\s+/)
    .filter(Boolean);
  if (!ids.length) return null;
  const containers = JSON.parse(docker(["container", "inspect", ...ids]))
    .map((r) => ({
      id: r.Id,
      name: r.Name,
      started: r.State.StartedAt,
      running: r.State.Running,
      restarts: r.RestartCount,
      ports: r.HostConfig.PortBindings,
      mounts: r.Mounts,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const volume = JSON.parse(docker(["volume", "inspect", "supabase_db_clothing-commerce-api"]));
  const db = containers.find((r) => r.name === "/supabase_db_clothing-commerce-api");
  assert(db?.running, "Normal dev database must already be running for preservation proof");
  const digest = (args) =>
    createHash("sha256")
      .update(
        docker([
          "exec",
          db.id,
          "pg_dump",
          "--username",
          "supabase_admin",
          "--dbname",
          "postgres",
          ...args,
        ]).replace(/^\\(?:un)?restrict .*$/gm, ""),
      )
      .digest("hex");
  return {
    containers,
    volume,
    schema: digest(["--schema-only"]),
    data: digest(["--data-only", "--schema=public", "--schema=supabase_migrations"]),
  };
}
