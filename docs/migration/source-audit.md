# Phase 1A Source Audit

The preserved source repository was audited before extraction: root rules, tech stack, README, all
five documentation files, all three applications, five shared packages, Supabase placeholders,
root scripts, CI, health route, Zod contract, API client, Electron main/preload/renderer security,
Expo Router configuration, and Next.js configuration.

Original dependency graph:

```text
web -> contracts -> zod
POS -> api-client -> contracts -> zod
admin mobile -> api-client -> contracts -> zod
all projects -> shared config
root -> pnpm workspaces + Turborepo
```

Baseline on 2026-08-19 passed `format:check`, `lint`, strict `typecheck`, 4 tests, the Next.js,
Electron directory-package, and Expo web builds, plus `git diff --check`. The original repository
was clean before extraction.
