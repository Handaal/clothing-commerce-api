// Type declarations for the development-only provisioning CLI so its pure guard helpers can be unit
// tested from TypeScript. The runtime implementation lives in provision-dev-identity.mjs.

export declare const USAGE: string;

export declare function parseArgs(argv: readonly string[]): {
  help: boolean;
  clerkSubject: string | undefined;
};

export declare function requireOptIn(environment: Record<string, string | undefined>): void;

export declare function requireClerkSubject(clerkSubject: unknown): string;

export declare function assertLocalStatus(status: unknown): string;

export declare function main(
  argv: readonly string[],
  environment: Record<string, string | undefined>,
): number;
