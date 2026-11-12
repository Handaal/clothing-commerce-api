// Type declarations for the reusable isolated-suite harness so its DB-free helpers can be unit tested
// from TypeScript. The runtime implementation lives in isolated-supabase-suite.mjs.

export declare const ROOT: string;
export declare const EXCLUDE_KEEP_API: string;
export declare const EXCLUDE_DB_ONLY: string;

export declare function freePort(): Promise<number>;

export declare function verifyPgtapPlan(file: string, expected?: number): void;

export interface IsolatedSuiteSpec {
  name: string;
  excluded?: string;
  setupSql?: string[];
  extraSql?: string;
  rls?: { files: string[]; plans?: Array<{ file: string; expected?: number }> };
  vitest?: { dir: string; env: (status: Record<string, string>) => Record<string, string | undefined> };
}

export declare function selectExcluded(spec: {
  excluded?: string;
  rls?: unknown;
  vitest?: unknown;
}): string;

export declare function createIsolatedStack(options?: {
  excluded?: string;
  extraPorts?: number;
}): Promise<{
  resources: { cleanup(): void; assertOwner(): void };
  root: string;
  isolated: string;
  projectId: string;
  dbContainer: string;
  ports: { apiPort: number; dbPort: number; extra: number[] };
  supa: (args: string[], opts?: Record<string, unknown>) => unknown;
  sql: (source: string) => unknown;
  run: (command: string, args: string[], opts?: Record<string, unknown>) => unknown;
  applyFixtures: (files?: string[]) => void;
  getStatus: () => Record<string, string>;
  cleanup: () => void;
}>;

export declare function runIsolatedSupabaseSuite(spec: IsolatedSuiteSpec): Promise<void>;

export declare function bootIsolatedApiServer(args: {
  stack: Awaited<ReturnType<typeof createIsolatedStack>>;
  nextPort: number;
  env: Record<string, string | undefined>;
  healthPath?: string;
}): Promise<{
  server: unknown;
  baseUrl: string;
  killer: () => void;
  diagnosticTail: () => string;
}>;

export declare const crypto: Crypto;
