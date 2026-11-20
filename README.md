# Madhuram Scan & Shop (MPC)

Mobile-first storefront and in-store **Scan & Shop** for Madhuram Pazhamudhir Cholai.

A shopper scans the entrance QR, scans or searches products on their phone while picking them from the shelf, and taps **Pay at Counter**. The server hands the basket to the supermarket POS as a **held bill** and prints a counter slip marked **AWAITING PAYMENT** at the assigned counter. The phone shows **"Go to Counter 2 · Order M042"**. The cashier opens the basket by scanning the slip, checks the goods, weighs loose produce, collects payment through the POS, and the POS issues the final bill.

```
entrance QR ─► phone basket ─► Pay at Counter ─► server (order + outbox, one transaction)
                                                   ├─► worker ─► POS held basket (idempotent)
                                                   └─► print job ─► store print agent ─► thermal printer
cashier screen ─► open order ─► verify / weigh / add ─► POS finalises sale ─► paid (receipt from POS)
```

## Try it (demo mode)

Requires Node.js 22.13 or later.

```bash
npm install
```

```bash
npm run demo
```

Then open `http://localhost:3000/s/main` on a phone-sized window (this is the entrance QR link) and `http://localhost:3000/staff` for the cashier screen (`cashier1` / `mpc-demo-2026`). Slips "print" to `data/sim-prints/*.txt`.

To run one complete purchase automatically (QR → basket → counter slip → cashier verification → paid receipt):

```bash
npm run demo:run
```

Demo mode is labelled on every screen and slip. Demo data uses made-up barcodes in the GS1 `200` in-store range and a separate POS-simulator database, so it never mixes with production data.

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

`npm test` runs unit tests and the acceptance scenarios from the brief against a real HTTP server, the POS simulator and the real print-agent code. `npm run test:e2e` drives Chromium on phone and desktop screens (screenshots in `test-results/`).

## Commands

| Command | Purpose |
|---|---|
| `npm run demo` | Seed demo data, start server, worker and a simulated print agent |
| `npm run demo:run` | Scripted end-to-end purchase in an isolated temp instance |
| `npm run build` / `npm start` | Compile and run the production server |
| `npm run agent` | Run the store print agent (compiled) — see `docs/PRINT_AGENT.md` |
| `npm run setup:branch -- main "Main Store" 2 M` | Create a branch, counters, printers and a print-agent token |
| `STAFF_PASSWORD=… npm run create:staff -- name owner "Display Name"` | Create a staff login |
| `npm run import:csv -- catalogue.csv` | Import / validate a product CSV |
| `npm run migrate` | Apply database migrations |

## Stack decision

No existing POS code, API documentation or catalogue was supplied, so this is a standalone project:

- **TypeScript + Express 5, server-rendered HTML.** Public pages are crawlable without JavaScript and fast on low-end Android phones; the basket and scanner are a small framework-free script (`public/js/shop.js`).
- **SQLite (Node's built-in `node:sqlite`) with WAL.** One file, zero setup, transactional; right-sized for a single shop. All SQL lives in a thin data layer, so moving to PostgreSQL later is mechanical.
- **Transactional outbox + background worker** for reliable, idempotent POS delivery.
- **Outbound-only store print agent** (ESC/POS) on the counter PC, so no ports are opened in the shop.
- **POS behind an adapter** (`src/pos/adapter.ts`): a full simulator for demo/tests and a REST adapter template for the live POS.
- Barcode scanning uses the browser's `BarcodeDetector` where available and falls back to ZXing (self-hosted), with manual entry and search always available.

## Where things are

```
src/
  server.ts            HTTP app, security headers, error handling
  worker.ts            outbox delivery, expiry, print lease checks, payment recovery, catalogue sync
  orders/service.ts    checkout, routing, cashier adjustments, payment, cancellation
  catalogue/service.ts search (exact/prefix/trigram/fuzzy), barcode lookup, POS sync, CSV import
  print/               slip layout, ESC/POS encoder, print jobs and agent protocol
  pos/                 adapter interface, simulator, REST adapter template
  routes/ views/       pages and APIs (public, customer API, staff, admin, agent)
  db/migrations/       schema
agent/print-agent.ts   runs on the counter PC
public/                CSS, JS, logo and icons
docs/                  setup, print agent, POS integration, cashier guide, handover
```

## Documentation

- [docs/HANDOVER.md](docs/HANDOVER.md) — what works, what was tested, what still needs the live POS and printer
- [docs/SETUP.md](docs/SETUP.md) — production deployment, domain, Google Search Console
- [docs/PRINT_AGENT.md](docs/PRINT_AGENT.md) — installing the counter print agent
- [docs/POS_INTEGRATION.md](docs/POS_INTEGRATION.md) — the POS contract and what we need from the vendor
- [docs/CASHIER_GUIDE.md](docs/CASHIER_GUIDE.md) — one-page guide for counter staff
