import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Row = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
// migrations live next to the source; when running from dist/ fall back to src/
function migrationsDir() {
  const candidates = [path.join(here, 'migrations'), path.resolve(here, '../../../src/db/migrations')];
  return candidates.find((d) => fs.existsSync(d)) as string;
}

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }
  get<T = Row>(sql: string, ...p: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...p) as T | undefined;
  }
  all<T = Row>(sql: string, ...p: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...p) as T[];
  }
  run(sql: string, ...p: SQLInputValue[]) {
    return this.raw.prepare(sql).run(...p);
  }
  exec(sql: string) {
    this.raw.exec(sql);
  }
  /** Run fn inside a transaction (IMMEDIATE so concurrent writers serialise). Nested calls use savepoints. */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth}`;
    if (this.depth === 0) this.raw.exec('BEGIN IMMEDIATE');
    else this.raw.exec(`SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const r = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return r;
    } catch (e) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }
  migrate() {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const dir = migrationsDir();
    const done = new Set(this.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      this.tx(() => {
        this.raw.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
        this.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', f, new Date().toISOString());
      });
    }
  }
  close() {
    this.raw.close();
  }
}
