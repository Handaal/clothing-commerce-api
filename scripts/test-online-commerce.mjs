// Online commerce DB/RLS/concurrency + real-API acceptance — restored on the per-run-isolated boundary.
//
// Boots the REAL Next.js API server on loopback against a disposable rt-<hex> Supabase and drives it over
// HTTP (mirrors test-offline-pos-http-isolated). Replaces the shared-CLI stub that reset + stopped the
// shared dev project. Never touches the shared dev project; cleans up only this run's resources.
//
// AUTH: the server verifies Clerk RS256 JWTs using CLERK_JWT_KEY with a per-run local test key — the
// repo's standard local-test path, NOT a verifier override or production bypass (production sets
// CLERK_JWT_KEY to the real Clerk key). No production auth is weakened.
import { generateKeyPairSync, sign, webcrypto as crypto } from "node:crypto";
import {
  bootIsolatedApiServer,
  createIsolatedStack,
  EXCLUDE_KEEP_API,
} from "./isolated-supabase-suite.mjs";
import { sanitizedChildEnv } from "./supabase-isolation-guard.mjs";
import { handleInterrupts } from "./returns-test-resources.mjs";
import { join } from "node:path";

const stack = await createIsolatedStack({ excluded: EXCLUDE_KEEP_API, extraPorts: 1 });
const nextPort = stack.ports.extra[0];
let killServer = () => {};
const removeInterruptHandlers = handleInterrupts(() => {
  killServer();
  stack.cleanup();
});
try {
  // phase_2l_online depends on phase_2h_pos_sale (shared tenant/brand FKs), so both are required.
  stack.applyFixtures(["phase_2h_pos_sale.setup.sql", "phase_2l_online.setup.sql"]);
  const status = stack.getStatus();

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const baseUrl = `http://127.0.0.1:${nextPort}`;
  const now = Math.floor(Date.now() / 1000);
  const part = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const payload =
    part({ alg: "RS256", typ: "JWT", kid: "local-acceptance" }) +
    "." +
    part({
      sub: "pos-full",
      sid: "sess_local_acceptance",
      iss: "https://clerk.local.test",
      azp: baseUrl,
      iat: now,
      nbf: now - 5,
      exp: now + 3600,
    });
  const token =
    payload + "." + sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url");

  const serverEnv = {
    SUPABASE_URL: status.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.local.test$").toString("base64")}`,
    CLERK_SECRET_KEY: "sk_test_local_acceptance_only",
    CLERK_JWT_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    CLERK_AUTHORIZED_PARTIES: baseUrl,
    OFFLINE_PIN_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  };
  const server = await bootIsolatedApiServer({ stack, nextPort, env: serverEnv });
  killServer = server.killer;
  process.stdout.write(
    "Real Next.js API + isolated Supabase ready; running online-commerce acceptance.\n",
  );

  try {
    stack.run(
      process.execPath,
      [
        join(stack.root, "node_modules/vitest/vitest.mjs"),
        "run",
        "tests/online-commerce-integration",
        "--testTimeout=60000",
        "--hookTimeout=60000",
      ],
      {
        cwd: stack.root,
        stdio: "inherit",
        env: sanitizedChildEnv({
          ONLINE_TEST_URL: server.baseUrl,
          ONLINE_TEST_TOKEN: token,
          // The suite re-reads the committed state directly from the disposable DB via the service-role
          // client, so it requires SUPABASE_URL/SERVICE_ROLE_KEY (its own disposable-DB guard) in addition
          // to the HTTP entrypoint. Point both at THIS run's isolated stack.
          SUPABASE_URL: status.API_URL,
          SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
          POS_TEST_SUPABASE_URL: status.API_URL,
          POS_TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
          POS_TEST_SUPABASE_ANON_KEY: status.ANON_KEY,
        }),
      },
    );
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    process.stderr.write(
      `\n----- API server log tail -----\n${server.diagnosticTail()}\n----- end server log -----\n`,
    );
    throw error;
  }
  process.stdout.write("Isolated online-commerce acceptance passed.\n");
} finally {
  removeInterruptHandlers();
  killServer();
  stack.cleanup();
}
