# ADR-002: API as the Commerce Core

- Status: Accepted
- Date: 2026-08-19

## Decision

The API is the single authoritative commerce core. POS and storefront are sales channels; admin
mobile is a management channel. Business rules and authorization execute in API application/domain
services. Inventory belongs to physical locations, not channels.

## Consequences

Clients cannot own independent inventory, order, customer, or product truth and cannot duplicate
authoritative server rules.
