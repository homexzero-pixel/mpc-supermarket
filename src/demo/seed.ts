import type { AppContext } from '../context.js';
import type { PosCatalogueItem } from '../pos/adapter.js';
import { gs1CheckDigit } from '../lib/barcode.js';
import { hashPassword } from '../lib/auth.js';
import { randomToken, sha256 } from '../lib/util.js';

/**
 * DEMO DATA ONLY. Sample products with made-up barcodes in the GS1 "200"
 * restricted-circulation range (never assigned to real retail products), a
 * placeholder branch, and demo staff. Replace with the POS product master and
 * owner-confirmed store details before going live.
 */
type Row = [string, string, string | null, string, string | null, 'pack' | 'piece' | 'weight', number, number | null, string | null, string, string?];
//        pos_id, name_en, name_ta, dept, pack, sold_by, price ₹, mrp ₹, group, aliases, brand
const ROWS: Row[] = [
  // Fruits
  ['F101', 'Robusta Banana', 'ரோபஸ்டா வாழைப்பழம்', 'fruits', 'per kg', 'weight', 48, null, null, 'vazhaipazham, banana, bannana, kela'],
  ['F102', 'Poovan Banana (dozen)', 'பூவன் வாழைப்பழம்', 'fruits', '12 pcs', 'pack', 60, null, null, 'poovan, vazhaipazham, banana'],
  ['F103', 'Banganapalli Mango', 'பங்கனப்பள்ளி மாம்பழம்', 'fruits', 'per kg', 'weight', 120, null, null, 'mambazham, mango, manga'],
  ['F104', 'Shimla Apple', 'ஆப்பிள்', 'fruits', 'per kg', 'weight', 180, null, null, 'apple, aapil'],
  ['F105', 'Pomegranate', 'மாதுளை', 'fruits', 'per kg', 'weight', 160, null, null, 'mathulai, anar'],
  ['F106', 'Papaya', 'பப்பாளி', 'fruits', '1 pc (approx 1 kg)', 'piece', 45, null, null, 'pappali, papaya'],
  ['F107', 'Pineapple', 'அன்னாசி', 'fruits', '1 pc', 'piece', 70, null, null, 'annasi, pineapple'],
  ['F108', 'Guava', 'கொய்யா', 'fruits', 'per kg', 'weight', 80, null, null, 'koyya, guava'],
  // Vegetables
  ['V201', 'Tomato', 'தக்காளி', 'vegetables', 'per kg', 'weight', 40, null, null, 'thakkali, tomato, tomoto, takkali'],
  ['V202', 'Big Onion', 'பெரிய வெங்காயம்', 'vegetables', 'per kg', 'weight', 45, null, null, 'vengayam, onion, periya vengayam'],
  ['V203', 'Small Onion (Shallots)', 'சின்ன வெங்காயம்', 'vegetables', 'per kg', 'weight', 90, null, null, 'chinna vengayam, sambar onion, shallot'],
  ['V204', 'Potato', 'உருளைக்கிழங்கு', 'vegetables', 'per kg', 'weight', 38, null, null, 'urulaikizhangu, urulai, aloo'],
  ['V205', 'Carrot', 'கேரட்', 'vegetables', 'per kg', 'weight', 60, null, null, 'carrot, kerat'],
  ['V206', 'Brinjal', 'கத்தரிக்காய்', 'vegetables', 'per kg', 'weight', 50, null, null, 'kathirikai, kathrikai, eggplant'],
  ['V207', "Lady's Finger", 'வெண்டைக்காய்', 'vegetables', 'per kg', 'weight', 56, null, null, 'vendakkai, okra, bhindi'],
  ['V208', 'Drumstick', 'முருங்கைக்காய்', 'vegetables', '1 pc', 'piece', 12, null, null, 'murungakkai, drumstick'],
  ['V209', 'Coconut', 'தேங்காய்', 'vegetables', '1 pc', 'piece', 35, null, null, 'thengai, coconut, thenga'],
  ['V210', 'Coriander Leaves', 'கொத்தமல்லி', 'vegetables', '1 bunch', 'piece', 10, null, null, 'kothamalli, coriander, malli'],
  ['V211', 'Curry Leaves', 'கறிவேப்பிலை', 'vegetables', '1 bunch', 'piece', 5, null, null, 'karuveppilai, curry leaves'],
  ['V212', 'Green Chilli', 'பச்சை மிளகாய்', 'vegetables', 'per kg', 'weight', 80, null, null, 'pachai milagai, chilli'],
  ['V213', 'Spinach (Arai Keerai)', 'அரைக்கீரை', 'vegetables', '1 bunch', 'piece', 15, null, null, 'keerai, spinach'],
  // Rice & grains
  ['R301', 'Ponni Raw Rice', 'பொன்னி பச்சரிசி', 'rice-grains', '1 kg', 'pack', 68, 75, 'ponni-raw', 'ponni, arisi, rice', 'MPC Select'],
  ['R302', 'Ponni Raw Rice', 'பொன்னி பச்சரிசி', 'rice-grains', '5 kg', 'pack', 320, 360, 'ponni-raw', 'ponni, arisi, rice', 'MPC Select'],
  ['R303', 'Ponni Raw Rice', 'பொன்னி பச்சரிசி', 'rice-grains', '10 kg', 'pack', 620, 700, 'ponni-raw', 'ponni, arisi, rice', 'MPC Select'],
  ['R304', 'Idli Rice', 'இட்லி அரிசி', 'rice-grains', '1 kg', 'pack', 54, null, null, 'idli arisi, idly rice', 'MPC Select'],
  ['R305', 'Premium Basmati Rice', 'பாஸ்மதி அரிசி', 'rice-grains', '1 kg', 'pack', 140, 160, null, 'basmati, biryani rice', 'MPC Select'],
  ['R306', 'Whole Wheat Atta', 'கோதுமை மாவு', 'rice-grains', '1 kg', 'pack', 52, null, 'atta', 'atta, godhumai, wheat flour'],
  ['R307', 'Whole Wheat Atta', 'கோதுமை மாவு', 'rice-grains', '5 kg', 'pack', 245, 260, 'atta', 'atta, godhumai, wheat flour'],
  ['R308', 'Bombay Rava', 'ரவை', 'rice-grains', '500 g', 'pack', 30, null, null, 'rava, sooji, semolina'],
  ['R309', 'Ragi Flour', 'கேழ்வரகு மாவு', 'rice-grains', '500 g', 'pack', 42, null, null, 'ragi, kezhvaragu, finger millet'],
  // Dals
  ['D401', 'Toor Dal', 'துவரம் பருப்பு', 'dals-pulses', '500 g', 'pack', 85, null, 'toor', 'thuvaram paruppu, toor, sambar dal', 'MPC Select'],
  ['D402', 'Toor Dal', 'துவரம் பருப்பு', 'dals-pulses', '1 kg', 'pack', 165, 180, 'toor', 'thuvaram paruppu, toor, sambar dal', 'MPC Select'],
  ['D403', 'Moong Dal', 'பாசிப் பருப்பு', 'dals-pulses', '500 g', 'pack', 70, null, null, 'pasi paruppu, moong, green gram dal'],
  ['D404', 'Urad Dal', 'உளுத்தம் பருப்பு', 'dals-pulses', '500 g', 'pack', 78, null, null, 'ulundhu, urad, ulutham paruppu'],
  ['D405', 'Chana Dal', 'கடலைப் பருப்பு', 'dals-pulses', '500 g', 'pack', 55, null, null, 'kadalai paruppu, bengal gram dal'],
  // Dairy
  ['M501', 'Toned Milk', 'டோன்ட் பால்', 'dairy', '500 ml', 'pack', 27, null, 'milk', 'paal, milk'],
  ['M502', 'Toned Milk', 'டோன்ட் பால்', 'dairy', '1 L', 'pack', 53, null, 'milk', 'paal, milk'],
  ['M503', 'Fresh Curd', 'தயிர்', 'dairy', '500 g', 'pack', 35, null, null, 'thayir, curd, yogurt'],
  ['M504', 'Paneer', 'பனீர்', 'dairy', '200 g', 'pack', 90, null, null, 'paneer, cottage cheese'],
  ['M505', 'Farm Eggs', 'முட்டை', 'dairy', '6 pcs', 'pack', 42, null, 'eggs', 'muttai, egg'],
  ['M506', 'Farm Eggs', 'முட்டை', 'dairy', '12 pcs', 'pack', 82, null, 'eggs', 'muttai, egg'],
  ['M507', 'Pure Ghee', 'நெய்', 'dairy', '500 ml', 'pack', 340, 375, null, 'nei, ghee', 'MPC Select'],
  // Oils & masala
  ['O601', 'Cold Pressed Groundnut Oil', 'கடலை எண்ணெய்', 'oils-masala', '1 L', 'pack', 230, 260, 'groundnut-oil', 'kadalai ennai, groundnut oil, peanut oil'],
  ['O602', 'Cold Pressed Groundnut Oil', 'கடலை எண்ணெய்', 'oils-masala', '5 L', 'pack', 1090, 1250, 'groundnut-oil', 'kadalai ennai, groundnut oil'],
  ['O603', 'Gingelly Oil', 'நல்லெண்ணெய்', 'oils-masala', '500 ml', 'pack', 190, null, 'gingelly', 'nallennai, sesame oil, gingelly'],
  ['O604', 'Gingelly Oil', 'நல்லெண்ணெய்', 'oils-masala', '1 L', 'pack', 370, 400, 'gingelly', 'nallennai, sesame oil, gingelly'],
  ['O605', 'Sunflower Oil', 'சூரியகாந்தி எண்ணெய்', 'oils-masala', '1 L', 'pack', 150, null, null, 'sunflower oil, refined oil'],
  ['O606', 'Sambar Powder', 'சாம்பார் பொடி', 'oils-masala', '200 g', 'pack', 72, null, null, 'sambar podi, sambar masala', 'MPC Select'],
  ['O607', 'Turmeric Powder', 'மஞ்சள் தூள்', 'oils-masala', '100 g', 'pack', 32, null, null, 'manjal, turmeric, haldi'],
  ['O608', 'Iodised Salt', 'உப்பு', 'oils-masala', '1 kg', 'pack', 25, null, null, 'uppu, salt'],
  ['O609', 'Sugar', 'சர்க்கரை', 'oils-masala', '1 kg', 'pack', 46, null, null, 'sakkarai, sugar, seeni'],
  ['O610', 'Tamarind', 'புளி', 'oils-masala', '250 g', 'pack', 48, null, null, 'puli, tamarind'],
  // Snacks
  ['S701', 'Thenkuzhal Murukku', 'தேன்குழல் முறுக்கு', 'snacks', '200 g', 'pack', 60, null, null, 'murukku, muruku'],
  ['S702', 'Madras Mixture', 'மிக்சர்', 'snacks', '200 g', 'pack', 55, null, null, 'mixture, kara'],
  ['S703', 'Kerala Banana Chips', 'வாழைக்காய் சிப்ஸ்', 'snacks', '150 g', 'pack', 65, null, null, 'banana chips, chips'],
  // Beverages
  ['B801', 'Filter Coffee Powder', 'ஃபில்டர் காபி தூள்', 'beverages', '250 g', 'pack', 150, null, 'coffee', 'kaapi, coffee, filter coffee', 'MPC Select'],
  ['B802', 'Filter Coffee Powder', 'ஃபில்டர் காபி தூள்', 'beverages', '500 g', 'pack', 290, 320, 'coffee', 'kaapi, coffee, filter coffee', 'MPC Select'],
  ['B803', 'Tea Dust', 'டீ தூள்', 'beverages', '250 g', 'pack', 125, null, null, 'tea, chai, theyilai'],
  // Personal care
  ['P901', 'Neem Bath Soap (pack of 4)', 'வேப்பிலை சோப்பு', 'personal-care', '4 x 100 g', 'pack', 120, 140, null, 'soap, neem soap'],
  ['P902', 'Herbal Toothpaste', 'பற்பசை', 'personal-care', '150 g', 'pack', 95, null, null, 'toothpaste, paste'],
  ['P903', 'Coconut Hair Oil', 'தேங்காய் எண்ணெய்', 'personal-care', '200 ml', 'pack', 80, null, 'coconut-oil', 'thengai ennai, coconut oil, hair oil'],
  ['P904', 'Coconut Hair Oil', 'தேங்காய் எண்ணெய்', 'personal-care', '500 ml', 'pack', 190, null, 'coconut-oil', 'thengai ennai, coconut oil, hair oil'],
  // Household
  ['H951', 'Dishwash Bar', 'பாத்திரம் கழுவும் சோப்பு', 'household', '300 g', 'pack', 30, null, null, 'dishwash, vessel soap'],
  ['H952', 'Detergent Powder', 'சலவைத் தூள்', 'household', '1 kg', 'pack', 110, 125, null, 'detergent, washing powder'],
  ['H953', 'Floor Cleaner', 'தரை சுத்திகரிப்பான்', 'household', '500 ml', 'pack', 99, null, null, 'floor cleaner, phenyl'],
  ['H954', 'Camphor Tablets', 'கற்பூரம்', 'household', '50 g', 'pack', 60, null, null, 'karpooram, camphor'],
  ['H955', 'Agarbatti Sticks', 'ஊதுபத்தி', 'household', null, 'pack', 40, null, null, 'oodhubathi, incense'],
];

export const LEADING_ZERO_BARCODE = '071234500501' + gs1CheckDigit('071234500501');

/** Demo barcodes: 200 + 5-digit item number + 4 zeros pattern + GS1 check digit. */
export function demoBarcode(n: number) {
  const body = `200${String(n).padStart(5, '0')}1000`.slice(0, 12);
  return body + gs1CheckDigit(body);
}

export function demoCatalogue(): PosCatalogueItem[] {
  return ROWS.map(([id, en, ta, dept, pack, soldBy, price, mrp, group, aliases, brand], i) => {
    const barcodes: string[] = [];
    if (soldBy !== 'weight' && id !== 'H955') barcodes.push(demoBarcode(i + 1));
    if (id === 'M501') barcodes.push(LEADING_ZERO_BARCODE); // keeps its leading zero end-to-end
    if (soldBy === 'weight') barcodes.push(`plu:${id.slice(1).padStart(5, '0')}`);
    return {
      pos_item_id: id, name_en: en, name_ta: ta, department: dept, pack_label: pack, sold_by: soldBy, price_paise: price * 100,
      mrp_paise: mrp ? mrp * 100 : null, group_key: group, aliases, brand: brand ?? null, barcodes, available: id !== 'S703', max_qty: soldBy === 'pack' ? 20 : 30,
    };
  });
}

/** A deliberately shared barcode (two pack sizes), to demonstrate ambiguity handling. */
export const DEMO_DUPLICATE_BARCODE = '2009999910003';

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'mpc-demo-2026';

export interface DemoSeedResult {
  branchId: string;
  agentToken: string;
  staff: { username: string; role: string }[];
}

export async function seedDemo(ctx: AppContext, opts: { agentToken?: string } = {}): Promise<DemoSeedResult> {
  const { db, sim } = ctx;
  const items = demoCatalogue();
  const egg6 = items.find((i) => i.pos_item_id === 'M505')!;
  const egg12 = items.find((i) => i.pos_item_id === 'M506')!;
  egg6.barcodes.push(DEMO_DUPLICATE_BARCODE);
  egg12.barcodes.push(DEMO_DUPLICATE_BARCODE);
  if (sim) {
    for (const it of items) sim.upsertItem(it);
    sim.db.run(`UPDATE sim_items SET stock_milli = 0 WHERE pos_item_id = 'S703'`);
  }
  const branchId = 'br_main';
  if (!db.get('SELECT 1 FROM branches WHERE id = ?', branchId)) {
    db.tx(() => {
      db.run(
        `INSERT INTO branches (id, slug, name_en, name_ta, order_prefix, routing, is_demo, store_info) VALUES (?,?,?,?,?,?,?,?)`,
        branchId, 'main', 'Main Store', 'முதன்மைக் கடை', 'M', 'least_busy', 1, JSON.stringify({ verified: false }),
      );
      db.run(`INSERT INTO print_agents (id, branch_id, name, token_hash) VALUES ('agt_demo', ?, 'Demo counter PC', ?)`, branchId, sha256(opts.agentToken ?? 'unset'));
      db.run(`INSERT INTO printers (id, branch_id, name, paper_width_mm, agent_id) VALUES ('prn_c1', ?, 'Counter 1 thermal (80 mm)', 80, 'agt_demo')`, branchId);
      db.run(`INSERT INTO printers (id, branch_id, name, paper_width_mm, agent_id) VALUES ('prn_c2', ?, 'Counter 2 thermal (58 mm)', 58, 'agt_demo')`, branchId);
      db.run(`INSERT INTO counters (id, branch_id, number, name, printer_id) VALUES ('ctr_1', ?, 1, 'Counter 1', 'prn_c1')`, branchId);
      db.run(`INSERT INTO counters (id, branch_id, number, name, printer_id) VALUES ('ctr_2', ?, 2, 'Counter 2', 'prn_c2')`, branchId);
      db.run(`UPDATE branches SET default_counter_id = 'ctr_1' WHERE id = ?`, branchId);
    });
  }
  const agentToken = opts.agentToken ?? `mpcagent_demo_${randomToken(24)}`;
  db.run(`UPDATE print_agents SET token_hash = ? WHERE id = 'agt_demo'`, sha256(agentToken));

  const staff = [
    { username: 'owner', display_name: 'Owner (demo)', role: 'owner' },
    { username: 'manager', display_name: 'Manager (demo)', role: 'manager' },
    { username: 'cashier1', display_name: 'Cashier Priya (demo)', role: 'cashier' },
    { username: 'cashier2', display_name: 'Cashier Arun (demo)', role: 'cashier' },
  ];
  for (const s of staff) {
    if (!db.get('SELECT 1 FROM staff WHERE username = ?', s.username))
      db.run('INSERT INTO staff (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)', `stf_${s.username}`, s.username, s.display_name, s.role, hashPassword(DEMO_PASSWORD));
  }
  await ctx.catalogue.syncFromPos(ctx.pos, { isDemo: true });
  return { branchId, agentToken, staff };
}
