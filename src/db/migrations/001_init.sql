-- Madhuram Scan & Shop - initial schema
-- Money is stored as integer paise. Weight is stored as integer grams.

CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL,
  name_ta TEXT,
  order_prefix TEXT NOT NULL DEFAULT 'M',
  accepting_orders INTEGER NOT NULL DEFAULT 1,
  pause_message_en TEXT,
  pause_message_ta TEXT,
  routing TEXT NOT NULL DEFAULT 'default',          -- default | least_busy | round_robin
  default_counter_id TEXT,
  expiry_minutes INTEGER NOT NULL DEFAULT 120,
  max_open_orders INTEGER NOT NULL DEFAULT 60,
  max_orders_per_hour_alert INTEGER NOT NULL DEFAULT 80,
  scale_label_rules TEXT NOT NULL DEFAULT '[]',     -- JSON, see src/lib/barcode.ts
  store_info TEXT NOT NULL DEFAULT '{}',            -- JSON, owner-verified details only
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE printers (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  paper_width_mm INTEGER NOT NULL DEFAULT 80,        -- 58 or 80
  language TEXT NOT NULL DEFAULT 'en',               -- en | ta (ta requires raster-capable agent)
  agent_id TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE counters (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  printer_id TEXT REFERENCES printers(id),
  rr_seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE(branch_id, number)
);

CREATE TABLE print_agents (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  last_status TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE staff (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
  branch_ids TEXT NOT NULL DEFAULT '*',              -- '*' or JSON array of branch ids
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff(id),
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE departments (
  slug TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_ta TEXT,
  sort INTEGER NOT NULL DEFAULT 100,
  color TEXT NOT NULL DEFAULT '#E8F1E4'
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pos_item_id TEXT NOT NULL UNIQUE,                  -- stable POS identifier
  slug TEXT NOT NULL UNIQUE,
  group_key TEXT,                                    -- links pack sizes of the same product
  name_en TEXT NOT NULL,
  name_ta TEXT,
  brand TEXT,
  department TEXT REFERENCES departments(slug),
  pack_label TEXT,                                   -- "500 ml", "1 kg", "per kg"
  sold_by TEXT NOT NULL CHECK (sold_by IN ('pack','piece','weight')),
  price_paise INTEGER NOT NULL,                      -- per pack/piece, or per kg for weight
  mrp_paise INTEGER,                                 -- only when supplied by POS
  max_qty INTEGER NOT NULL DEFAULT 20,
  available INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  image_url TEXT,
  aliases TEXT NOT NULL DEFAULT '',                  -- approved Tamil / transliterated aliases
  is_demo INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX items_department ON items(department, active);
CREATE INDEX items_group ON items(group_key);

CREATE TABLE item_barcodes (
  barcode TEXT NOT NULL,                             -- always a string: leading zeros matter
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (barcode, item_id)
);
CREATE INDEX item_barcodes_item ON item_barcodes(item_id);

CREATE VIRTUAL TABLE items_fts USING fts5(
  name_en, name_ta, brand, aliases, pack_label, department,
  content='items', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, name_en, name_ta, brand, aliases, pack_label, department)
  VALUES (new.id, new.name_en, coalesce(new.name_ta,''), coalesce(new.brand,''), new.aliases, coalesce(new.pack_label,''), coalesce(new.department,''));
END;
CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, name_en, name_ta, brand, aliases, pack_label, department)
  VALUES ('delete', old.id, old.name_en, coalesce(old.name_ta,''), coalesce(old.brand,''), old.aliases, coalesce(old.pack_label,''), coalesce(old.department,''));
END;
CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, name_en, name_ta, brand, aliases, pack_label, department)
  VALUES ('delete', old.id, old.name_en, coalesce(old.name_ta,''), coalesce(old.brand,''), old.aliases, coalesce(old.pack_label,''), coalesce(old.department,''));
  INSERT INTO items_fts(rowid, name_en, name_ta, brand, aliases, pack_label, department)
  VALUES (new.id, new.name_en, coalesce(new.name_ta,''), coalesce(new.brand,''), new.aliases, coalesce(new.pack_label,''), coalesce(new.department,''));
END;

CREATE TABLE catalogue_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,                              -- pos | csv
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,                              -- running | ok | partial | failed
  stats TEXT NOT NULL DEFAULT '{}',
  issues TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  code TEXT NOT NULL,                                -- short customer-facing code, e.g. M042
  business_date TEXT NOT NULL,                       -- YYYY-MM-DD in store timezone
  ticket_token TEXT NOT NULL UNIQUE,                 -- unguessable; grants ticket access
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',   -- awaiting_payment | in_progress | paid | cancelled | expired
  payment_status TEXT NOT NULL DEFAULT 'unpaid',     -- unpaid | pending | paid | failed
  counter_id TEXT REFERENCES counters(id),
  pos_ref TEXT,
  pos_status TEXT NOT NULL DEFAULT 'pending',        -- pending | delivered | failed
  pos_last_error TEXT,
  has_unweighed INTEGER NOT NULL DEFAULT 0,
  est_total_paise INTEGER NOT NULL,
  final_total_paise INTEGER,
  receipt_no TEXT,
  payment_method TEXT,
  payment_attempt_key TEXT,
  claimed_by TEXT REFERENCES staff(id),
  claimed_at TEXT,
  client_fingerprint TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  closed_at TEXT,
  UNIQUE(branch_id, business_date, code)
);
CREATE INDEX orders_branch_status ON orders(branch_id, status);
CREATE INDEX orders_branch_date ON orders(branch_id, business_date);

CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  pos_item_id TEXT NOT NULL,
  name_snapshot TEXT NOT NULL,
  pack_label TEXT,
  sold_by TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  submitted_qty INTEGER NOT NULL,                    -- what the customer sent (0 for cashier-added)
  qty INTEGER NOT NULL,                              -- current quantity after cashier adjustments
  est_grams INTEGER,                                 -- customer estimate for loose produce (nullable)
  actual_grams INTEGER,                              -- weighed at counter
  scanned_barcode TEXT,
  source TEXT NOT NULL DEFAULT 'customer',           -- customer | cashier
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX order_lines_order ON order_lines(order_id);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL,                          -- customer | staff | system | pos | agent
  actor_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX order_events_order ON order_events(order_id);

-- Transactional outbox for reliable POS delivery
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                                -- pos_submit | pos_void
  ref_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',            -- pending | done | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(kind, ref_id)
);

CREATE TABLE print_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  printer_id TEXT REFERENCES printers(id),
  counter_id TEXT REFERENCES counters(id),
  kind TEXT NOT NULL,                                -- original | copy | transfer | test
  status TEXT NOT NULL DEFAULT 'queued',             -- queued | claimed | sent | printed | failed | unknown | cancelled
  payload TEXT NOT NULL,                             -- JSON slip document
  preview TEXT NOT NULL,                             -- plain-text rendering for screens
  agent_id TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX print_jobs_one_original ON print_jobs(order_id) WHERE kind = 'original';
CREATE INDEX print_jobs_queue ON print_jobs(printer_id, status);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  order_id TEXT,
  print_job_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX alerts_open ON alerts(branch_id, resolved_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  staff_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  data TEXT NOT NULL DEFAULT '{}'
);
