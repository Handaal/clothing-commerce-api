# SDK Release Process

1. Change the canonical Zod contract and server behavior compatibly.
2. Regenerate OpenAPI and pass contract/drift tests.
3. Update the SDK using semantic versioning and build it.
4. Pack and validate the exact artifact in all clients.
5. In the future, publish the approved artifact to a private registry.
6. Let each client repository upgrade that explicit version independently.

No registry credentials or public publication are used in Phase 1A-R.
