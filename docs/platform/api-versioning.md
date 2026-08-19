# API Versioning and Compatibility

The current stable namespace is `/api/v1`. A V1 minor evolution may add endpoints, optional request
fields, and response fields that older clients can safely ignore. Removing or renaming fields,
changing meanings, making optional input required, or changing error semantics incompatibly is a
breaking change and requires a deliberate new major API version plus an ADR.

Deprecations are documented before removal, remain observable, and include a migration path and
date. Installed POS versions may lag: the server will maintain a declared grace period and support
older clients through that window. The exact supported-client matrix and grace duration will be
approved before the first business endpoint ships.

Responses should evolve additively; SDK schemas should accept additive unknown response fields
unless a field is security-sensitive. Required fields are not added within V1 where an older client
would fail. Future minimum-version enforcement will use client metadata and a clear upgrade error,
not silent behavior changes. No negotiation framework or `/api/v2` exists in Phase 1A-R.
