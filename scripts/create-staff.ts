import { createContext } from '../src/context.js';
import { hashPassword } from '../src/lib/auth.js';
import { newId } from '../src/lib/util.js';

// Usage: npm run create:staff -- <username> <role: owner|manager|cashier> "<Display Name>"   (password read from STAFF_PASSWORD)
const [username, role, displayName] = process.argv.slice(2);
const password = process.env.STAFF_PASSWORD ?? '';
if (!username || !['owner', 'manager', 'cashier'].includes(role) || password.length < 8) {
  console.error('Usage: STAFF_PASSWORD=... npm run create:staff -- <username> <owner|manager|cashier> "Display Name"  (password min 8 chars)');
  process.exit(1);
}
const ctx = createContext();
if (ctx.db.get('SELECT 1 FROM staff WHERE username = ?', username.toLowerCase())) {
  console.error('That username already exists');
  process.exit(1);
}
ctx.db.run('INSERT INTO staff (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)', newId('stf'), username.toLowerCase(), displayName || username, role, hashPassword(password));
console.log(`Created ${role} "${username}".`);
ctx.db.close();
