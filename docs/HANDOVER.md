# Handover — Madhuram Scan & Shop

Status as delivered: complete working application running against a **POS simulator** and a **simulated printer**. The two connection points that need the shop's real systems are the POS adapter (`src/pos/http-adapter.ts`) and the print agent's printer targets (`agent.config.json`).

## What works

**Customers (phone-first, guest checkout, English/Tamil)**
- Entrance QR `/s/<branch>` opens the branch in shopping mode; the branch is kept for the whole trip.
- Search: product names, brands, barcode numbers, Tamil names, transliterations (`thakkali`), misspellings (`tomoto`); ranked exact → prefix → substring → fuzzy; paginated.
- Barcode scanning with the phone camera (native `BarcodeDetector`, ZXing fallback), camera requested only on tap. A still camera adds a packet **once**; "Scan another" adds the next identical packet. Duplicate barcodes ask the customer to choose; unknown barcodes offer search or "bring it to the cashier". Manual barcode entry when the camera is denied.
- Loose produce: approximate weight or "Weigh at counter"; basket shows **Estimated total**.
- Basket survives refresh and connection drops (stored on the phone). Prices and availability are re-checked on the basket page and on submission; changes are shown and must be accepted.
- **Pay at Counter** is idempotent (one key per attempt, reused on retry/refresh). Ticket page shows the large order code and counter, updates live (counter moves, paid status, POS bill number), and survives refresh.
- If the customer already has an unpaid order, a second basket requires explicit confirmation.
- Public site: home, branch, departments, product pages with related pack sizes, visit page; server-rendered, canonical URLs, sitemap, social previews, JSON-LD (`Organization`, `GroceryStore` once details are confirmed, `Product` with `InStoreOnly`, breadcrumbs). Private pages are `noindex`/no-store.

**Counter & POS handoff**
- Order + outbox + original print job are written in one transaction. The worker delivers the held basket to the POS with retries and look-up-before-retry, so it reaches the POS exactly once.
- Counter routing: default / least busy / round robin; reassignment prints a "moved" slip at the new counter.
- Counter slip (58/80 mm): store, branch, counter, large order code, time, items with pack sizes and quantities, weigh-at-counter lines, estimated total, **AWAITING PAYMENT**, Code 128 order barcode (`SS-YYYYMMDD-M042`).
- Print agent (outbound only): network (port 9100), USB/Windows shared printer, optional paper-out check; outcomes `sent / printed / failed / unknown`; failed originals can be retried, uncertain ones need an audited **COPY** reprint; outcomes survive agent restarts.

**Cashier**
- Live queue with waiting time, items, total, status, slip status, POS status; sound alerts; lookup by code, slip barcode, or POS reference.
- One cashier holds an order at a time (manager take-over, transfer, release). Adjust quantities, remove, add by barcode or search, enter weights; customer-submitted vs adjusted quantities and full history are kept.
- Payment only through the POS; paid only after POS confirmation; uncertain payments are resolved by look-up, never by charging again. Order, payment and print status are separate.
- Cancel with reason; unpaid baskets expire (configurable) and are voided in the POS.

**Owner / manager**
- Roles: owner, manager, cashier, scoped per branch. CSRF protection, scrypt passwords, login rate limit, audit log.
- Settings: pause/resume new submissions with a customer message, routing, expiry, counters, printers (paper width, language, agent), print agents (tokens shown once), **Print test slip**, entrance QR (SVG/PNG) and printable A4 sign, scale-label rules, store details (published only when marked confirmed).
- Catalogue: POS sync, CSV import with validation (leading zeros, scientific-notation detection), duplicate barcodes, products needing review.
- Daily overview (sales from POS-confirmed payments only) with drill-down; reconciliation (baskets missing in POS, POS sales not confirmed here, pending payments, print problems) with safe retries.
- Nuisance protection: per-IP rate limit, max open baskets per branch and per phone, hourly volume alert, pause switch.

## What was tested

`npm test` — 37 tests, all passing: unit tests (money/weight arithmetic, barcodes, scale labels, CSV, slip/ESC-POS encoding, search) and the acceptance scenarios below, run against a real HTTP server, the POS simulator and the real print-agent code.
`npm run test:e2e` — 3 Chromium tests on Pixel 7 / iPhone 13 viewports and a desktop screen, all passing.

| Scenario | Result |
|---|---|
| Customer scans the entrance QR | ✅ branch opens in shopping mode (API + browser) |
| Customer holds the camera still on a packet | ✅ added once; "Scan another" adds the second (browser, simulated detector) |
| Two packets + loose tomatoes | ✅ one held basket; slip says WEIGH AT COUNTER and ESTIMATED TOTAL |
| Double-tap / refresh after timeout | ✅ same code, one held basket, one original slip |
| Price changes during shopping | ✅ affected line shown with old → new price; accepted basket goes through |
| Printer switched off | ✅ order on cashier screen, alert raised, retry prints the original once |
| POS unreachable, then reconnects (incl. lost reply) | ✅ ticket shows pending; delivered once with original reference |
| Cashier adds a missed item and weighs tomatoes | ✅ POS re-prices and rounds; adjustment history kept |
| Two counters complete the same order | ✅ one payment, one sale, one stock posting |
| Payment reply lost | ✅ "Check payment" confirms from POS; second charge blocked |
| Customer leaves without paying | ✅ expires, voided in POS, excluded from revenue |
| Visitor from Google | ✅ product page without QR/login, explains in-store purchase, structured data |
| Security | ✅ token-only ticket access, staff login/role/CSRF, agent token, noindex on private pages |

Also checked by hand: `npm run demo:run` full purchase, `npm run demo`, compiled production build (`npm run build && npm start`) including the weak-secret refusal and security headers.

**Not tested:** real iPhone Safari and Android Chrome devices (only emulated viewports in Chromium), real camera scanning of printed barcodes, screen-reader walkthrough, a physical thermal printer, the live POS.

## Needs the live POS or physical printer to verify

1. **POS API mapping.** `src/pos/http-adapter.ts` uses placeholder endpoints. Needed: API docs and sandbox credentials, product master fields, held-bill create/find/update/void, finalise/payment (methods, terminal flow, receipt number, round-off), sales lookup by our reference, idempotency support. Details in `POS_INTEGRATION.md`.
2. **Can the POS open a held bill from our slip barcode**, or does the cashier use our screen? Decides whether cashiers stay in one screen.
3. **Printer hardware:** make/model, paper width (58/80 mm), connection (LAN IP / USB / Windows share), counter PC OS. Then print a test slip and check the layout, barcode scanning and cutting.
4. **Scale labels:** photos of 3–5 printed labels from the shop's weighing scale (weight-encoded and price-encoded if both exist) to configure the rules.
5. **Final on-site test:** a real phone at the entrance QR submits a basket and the slip prints at the assigned counter.

## Still needed from the owner

- Approved Tamil spelling of the brand and branch name (current Tamil text is a draft).
- Confirmed address, phone, opening hours, Google Maps link — matching the Google Business Profile.
- Domain name and hosting choice; product photos (optional, a fallback illustration is used meanwhile).
- The real product CSV or POS catalogue access.

## Known limitations

- Tamil text on the **thermal slip** needs raster printing, not yet implemented (falls back to English). Phones and the cashier screen show Tamil normally.
- No stock reservation while baskets wait; the POS's existing stock rules apply at payment.
- One server instance (SQLite, in-memory rate limits). Move to PostgreSQL and a shared limiter before scaling out.
- Promotions/offers are not modelled; the POS applies them at payment. Only MRP vs selling price is shown when the POS provides MRP.
