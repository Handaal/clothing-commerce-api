# System Context

The platform has one commerce core and three independent clients:

```text
POS desktop -----------\
Storefront ------------- HTTPS / versioned contract --> Commerce API --> Supabase PostgreSQL
Admin mobile ----------/
```

POS and online are sales channels; mobile is a management channel. They share one product and
variant domain, one authoritative inventory source tied to physical locations, one order domain
with channel identifiers, and one customer domain. Independent `pos_stock`, `website_stock`, or
mobile stock truths are prohibited.

Future authentication follows client identity → authenticated API request → API authorization →
database. Guest/customer storefront requests also terminate at the API. Client UI permissions are
never authoritative.
