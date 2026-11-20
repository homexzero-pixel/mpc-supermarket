import { Db } from './db/index.js';
import { config } from './config.js';
import { CatalogueService } from './catalogue/service.js';
import { PrintService } from './print/service.js';
import { OrderService } from './orders/service.js';
import type { PosAdapter } from './pos/adapter.js';
import { SimulatedPos } from './pos/simulator.js';
import { HttpPosAdapter } from './pos/http-adapter.js';

export interface AppContext {
  db: Db;
  pos: PosAdapter;
  sim?: SimulatedPos;
  catalogue: CatalogueService;
  print: PrintService;
  orders: OrderService;
}

export function createContext(opts: { databasePath?: string; posSimPath?: string; pos?: PosAdapter } = {}): AppContext {
  const db = new Db(opts.databasePath ?? config.databasePath);
  db.migrate();
  let sim: SimulatedPos | undefined;
  let pos: PosAdapter;
  if (opts.pos) pos = opts.pos;
  else if (config.posAdapter === 'http') pos = new HttpPosAdapter(config.posBaseUrl!, config.posApiKey!);
  else pos = sim = new SimulatedPos(opts.posSimPath ?? config.posSimDatabasePath);
  if (pos instanceof SimulatedPos) sim = pos;
  const catalogue = new CatalogueService(db);
  catalogue.ensureDepartments();
  const print = new PrintService(db);
  const orders = new OrderService(db, catalogue, print, pos);
  return { db, pos, sim, catalogue, print, orders };
}
