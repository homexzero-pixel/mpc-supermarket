# POS integration

The storefront never completes a sale. It creates a **held basket** in the POS and lets the POS own final pricing, promotions, rounding, tax, payment, receipt numbering and stock movement. Everything POS-specific is behind one interface: `src/pos/adapter.ts`.

| Adapter method | When it is called | Must be |
|---|---|---|
| `fetchCatalogue()` | catalogue sync (every 15 min, or on demand) | read-only |
| `createHeldBasket(req)` | worker, after a customer taps Pay at Counter | idempotent on `request_key` / `external_ref` |
| `findHeldBasket(external_ref)` | before retrying an uncertain delivery, and before voiding | read-only |
| `updateHeldBasket(pos_ref, lines)` | before payment, with cashier adjustments and actual weights | replaces lines |
| `voidHeldBasket(pos_ref)` | order cancelled or expired | idempotent |
| `finalizeSale(req)` | cashier presses Cash / UPI / Card / Other | idempotent on `attempt_key`; returns receipt no. and final total |
| `lookupSale(attempt_key)` | after a timeout, before ever allowing another charge | read-only |
| `listSalesSince(iso)` | reconciliation screen | read-only |

`src/pos/simulator.ts` implements all of this (including failure injection) and is what the tests run against. `src/pos/http-adapter.ts` is a REST template: **its endpoint paths and field names are placeholders**, to be mapped to the real vendor API.

## Error semantics the adapter must preserve

- Throw `PosError(message, uncertain=false)` when the POS definitely did **not** apply the request (validation error, connection refused). The worker retries or reports.
- Throw `PosError(message, uncertain=true)` when it **may** have applied it (timeout, dropped connection, 5xx). The worker then *looks up* before retrying, and a payment stays "pending" until `lookupSale` settles it — staff cannot charge twice.

## If the POS can only create completed sales

Do not map `createHeldBasket` to "create sale". Options, in order of preference:
1. Use the POS's held-bill / parked-sale / quotation / estimate feature.
2. Keep the basket only in this system and let the cashier screen be the source; at payment, `finalizeSale` creates the completed sale in one call (still idempotent on `attempt_key`).
3. If the POS is a local desktop program with no API, the print agent PC can drop an import file into the POS's import folder — needs the vendor's file format.

## What we need from the POS vendor / owner

1. API documentation and a **test (sandbox) account** — base URL, authentication method, rate limits.
2. Product master fields: item id, name, barcode(s), unit / pack size, sold-by-weight flag, selling price, MRP, tax class, availability/stock, department.
3. Held-bill endpoints: create, fetch by our reference, replace lines, void — and whether they accept an idempotency key or a client reference we can search by.
4. Finalise/payment endpoint: payment methods supported, how UPI/card terminals are triggered, response fields (receipt number, final total, round-off).
5. Sales list / lookup by our reference, for reconciliation.
6. Whether the POS can print the counter slip itself (then the print agent is optional) and whether its billing screen can open a held bill from a scanned code (`SS-YYYYMMDD-M042` Code 128 on our slip).
7. Cashier user ids, if sales must be attributed to POS users.

Set `POS_ADAPTER=http`, `POS_BASE_URL`, `POS_API_KEY` (secret) once mapped, then run a held bill → payment → void cycle against the sandbox before going live.
