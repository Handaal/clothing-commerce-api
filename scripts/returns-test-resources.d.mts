// Type declarations for the disposable test-resource ownership boundary so it can be exercised from
// TypeScript guard tests. The runtime implementation lives in returns-test-resources.mjs.

type DockerExec = (args: string[]) => string;

export interface IsolatedResources {
  readonly runId: string;
  readonly projectId: string;
  readonly workdir: string;
  readonly labelArgs: string[];
  assertOwner(): void;
  bindConfig(text: string): void;
  plan(execute?: DockerExec): Record<string, Array<Record<string, unknown>>>;
  cleanup(execute?: DockerExec): void;
}

export declare function docker(args: string[]): string;

export declare function createResources(options?: { dockerExec?: DockerExec }): IsolatedResources;

export declare function handleInterrupts(cleanup: () => void): () => void;
