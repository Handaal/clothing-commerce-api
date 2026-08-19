# Integration Architecture

All clients configure an API base URL and instantiate `@shifted/clothing-commerce-sdk`. The SDK
uses standard `fetch`, validates successful responses against the Zod-derived contract, and exposes
typed network, HTTP, and contract errors. It can send `X-Client-Type` and `X-Client-Version`.

Allowed client types are `pos-desktop`, `storefront`, and `admin-mobile`. Metadata is diagnostic and
will later support compatibility policy; it is not authentication or device management. Custom
headers are covered by API CORS preflight support.

No client receives server secrets or directly uses privileged Supabase access. Future authorization
and tenant isolation are enforced by the API regardless of UI state.
