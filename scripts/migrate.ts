import { createContext } from '../src/context.js';
import { config } from '../src/config.js';

const ctx = createContext();
console.log(`Database ${config.databasePath} is up to date.`);
ctx.db.close();
