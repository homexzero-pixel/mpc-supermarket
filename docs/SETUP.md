# Production setup

## 1. Server

Any small Linux VM (1 vCPU, 1 GB RAM) is enough for one shop. Node.js 22.13+.

```bash
git clone <this repo> /opt/mpc && cd /opt/mpc
```

```bash
npm ci && npm run build
```

Create `/opt/mpc/.env` from `.env.example`. Set `DEMO_MODE=false`, `PUBLIC_BASE_URL` to the real https address, a random `SESSION_SECRET` (`openssl rand -hex 32`), and the POS settings. Put `POS_API_KEY` and `SESSION_SECRET` in your host's secret store or a root-only file — never in git. The server refuses to start in production mode with a weak secret.

Run it under systemd (`/etc/systemd/system/mpc.service`):

```ini
[Unit]
Description=MPC Scan & Shop
After=network-online.target

[Service]
WorkingDirectory=/opt/mpc
EnvironmentFile=/opt/mpc/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/src/server.js
Restart=always
User=mpc

[Install]
WantedBy=multi-user.target
```

Put it behind HTTPS (Caddy, nginx or a managed load balancer) and set `TRUST_PROXY=true`. HTTPS is required: phone cameras only work on secure pages.

**Backups:** the whole state is `data/mpc.db` (+ `-wal`). Back it up at least nightly with `sqlite3 data/mpc.db ".backup '/backups/mpc-$(date +%F).db'"`. Run **one** server instance (SQLite + in-memory rate limits); move to PostgreSQL before running several.

## 2. First branch, staff and QR

```bash
npm run setup:branch -- main "Main Store" 2 M
```

This creates counters 1 and 2, a printer per counter and a print-agent token (shown once). Then create the owner:

```bash
STAFF_PASSWORD='choose-a-long-password' npm run create:staff -- owner owner "Owner"
```

Sign in at `/staff`, then in **Settings**:

1. Enter the store address, phone and hours exactly as on the Google Business Profile, and tick "confirmed by the owner" (nothing is published until then).
2. Set the Tamil branch name (owner-approved spelling).
3. Check paper width per printer, then **Print test slip**.
4. Download the entrance QR or open **Printable entrance sign** and print it (A4, laminate). The QR points at `/s/<branch>`, which never changes, so you can change counters and printers later without reprinting.

## 3. Catalogue

- **From the POS:** with `POS_ADAPTER=http` the worker syncs every `CATALOGUE_SYNC_MINUTES`. **Catalogue → Sync now** runs it on demand.
- **From a CSV:** Catalogue → Import CSV (template on that page) or `npm run import:csv -- file.csv`. Keep the barcode column formatted as **text** in Excel so leading zeros survive; rows with scientific-notation barcodes are rejected.
- Review **Duplicate barcodes** and **Products needing review** after each import.
- Product photos: set `image_url` per product; otherwise a clean illustrated fallback is shown.

## 4. Domain and Google

1. Point the domain (e.g. `shop.yourdomain.in`) at the server and set `PUBLIC_BASE_URL` to it.
2. When store details are confirmed and the catalogue is real, set `ALLOW_INDEXING=true` and restart. Until then every page carries `noindex` and `robots.txt` blocks crawling.
3. In [Google Search Console](https://search.google.com/search-console), add the domain property, verify it with the DNS TXT record, and submit `https://<domain>/sitemap.xml`.
4. Use the same shop name, address, phone and hours on the Google Business Profile and in Settings. Add the website link to the Business Profile.

Baskets, tickets, search results, staff and admin pages are always `noindex` and are excluded from the sitemap.

## 5. Go-live checklist

- [ ] `DEMO_MODE=false`, demo database not used
- [ ] POS adapter mapped to the vendor API and tested with a real held bill (see `POS_INTEGRATION.md`)
- [ ] Print agent installed and starting on boot on each counter PC; test slip printed
- [ ] Order barcode on slip scans into the POS / cashier screen
- [ ] Scale-label rules configured from real sample labels (or left empty)
- [ ] Staff accounts created; demo accounts not present
- [ ] Final on-site test: a real phone submits a basket and the slip prints at the assigned counter
