import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basketTotal, divRoundHalfUp, formatPaise, parseRupeesToPaise, weightLinePaise } from '../src/lib/money.js';
import { barcodeVariants, gs1CheckDigit, hasValidGs1CheckDigit, parseScaleLabel, validateScaleRules } from '../src/lib/barcode.js';
import { csvRowsToItems, parseCsv } from '../src/catalogue/service.js';
import { encodeEscPos } from '../src/print/escpos.js';
import { renderPreview, wrap } from '../src/print/slip.js';
import { parseOrderBarcode } from '../src/print/service.js';
import { startHarness, type Harness } from '../src/demo/harness.js';
import { LEADING_ZERO_BARCODE, DEMO_DUPLICATE_BARCODE } from '../src/demo/seed.js';

describe('money (integer paise, no floating point)', () => {
  test('parses rupees exactly', () => {
    assert.equal(parseRupeesToPaise('42.5'), 4250);
    assert.equal(parseRupeesToPaise('₹1,234.05'), 123405);
    assert.equal(parseRupeesToPaise('0.10'), 10);
    assert.throws(() => parseRupeesToPaise('12.345'));
  });
  test('half-up rounding for weighed lines', () => {
    assert.equal(divRoundHalfUp(5, 2), 3);
    assert.equal(divRoundHalfUp(-5, 2), -3);
    assert.equal(weightLinePaise(4000, 620), 2480); // ₹40/kg x 620 g = ₹24.80
    assert.equal(weightLinePaise(3333, 333), 1110); // 1109.889 -> 1110
    assert.equal(weightLinePaise(4999, 1), 5); // 4.999 -> 5
  });
  test('0.1 + 0.2 style errors cannot happen', () => {
    const t = basketTotal([{ sold_by: 'pack', unit_price_paise: 10, qty: 1 }, { sold_by: 'pack', unit_price_paise: 20, qty: 1 }]);
    assert.equal(t.paise, 30);
  });
  test('unweighed loose produce marks the basket as estimated', () => {
    const t = basketTotal([{ sold_by: 'pack', unit_price_paise: 2700, qty: 2 }, { sold_by: 'weight', unit_price_paise: 4000, qty: 1, est_grams: null }]);
    assert.deepEqual(t, { paise: 5400, estimated: true, unknownCount: 1 });
  });
  test('formats Indian grouping', () => {
    assert.equal(formatPaise(12345678), '₹1,23,456.78');
    assert.equal(formatPaise(2700), '₹27');
  });
});

describe('barcodes', () => {
  test('GS1 check digits', () => {
    assert.ok(hasValidGs1CheckDigit('4006381333931'));
    assert.ok(!hasValidGs1CheckDigit('4006381333932'));
    assert.equal(gs1CheckDigit('400638133393'), '1');
  });
  test('leading zeros are preserved and UPC/EAN variants match', () => {
    assert.deepEqual(barcodeVariants('012345678905').sort(), ['0012345678905', '012345678905']);
    assert.ok(barcodeVariants('0712345005014').includes('712345005014'));
  });
  test('scale labels are only parsed with a configured rule', () => {
    const body = '212345' + '00620'.padStart(6, '0');
    const code = body.slice(0, 12) + gs1CheckDigit(body.slice(0, 12));
    assert.equal(parseScaleLabel(code, []), null);
    const rules = validateScaleRules([{ name: 'w', prefixes: ['21'], length: 13, itemStart: 2, itemLength: 5, valueStart: 7, valueLength: 5, valueType: 'weight_g' }]);
    const r = parseScaleLabel(code, rules)!;
    assert.equal(r.plu, '23450');
    assert.equal(r.weightGrams, 620);
    const priceRules = validateScaleRules([{ name: 'p', prefixes: ['21'], length: 13, itemStart: 2, itemLength: 5, valueStart: 7, valueLength: 5, valueType: 'price_paise' }]);
    assert.equal(parseScaleLabel(code, priceRules)!.pricePaise, 620);
  });
  test('invalid scale rules are rejected', () => {
    assert.throws(() => validateScaleRules([{ name: 'x' }]));
    assert.throws(() => validateScaleRules({}));
  });
  test('order slip barcode round-trips', () => {
    assert.deepEqual(parseOrderBarcode('ss-20261120-m042'), { business_date: '2026-11-20', code: 'M042' });
    assert.equal(parseOrderBarcode('M042'), null);
  });
});

describe('CSV import', () => {
  test('parses quotes, keeps barcodes as text, flags corruption', () => {
    const rows = parseCsv('﻿pos_item_id,name_en,price,barcodes,sold_by,pack_label\r\nA1,"Rice, Ponni ""special""",68.50,0071234500501|8901,pack,1 kg\nA2,Milk,27,8.90123E+12,pack,500 ml\nA3,Bad,abc,,pack,1 kg\n');
    const { items, errors } = csvRowsToItems(rows);
    assert.equal(items.length, 1);
    assert.equal(items[0].name_en, 'Rice, Ponni "special"');
    assert.equal(items[0].price_paise, 6850);
    assert.deepEqual(items[0].barcodes, ['0071234500501', '8901']);
    assert.equal(errors.length, 2);
    assert.match(errors.map((e) => e.problem).join(), /scientific notation/);
  });
});

describe('slip rendering', () => {
  test('wraps long names within paper width', () => {
    for (const l of wrap('A very long product name that should wrap neatly onto the next line', 32)) assert.ok(l.length <= 32);
    assert.deepEqual(wrap('   2 x Rs.27.00', 32), ['   2 x Rs.27.00']);
  });
  test('ESC/POS output starts with init, contains CODE128 and cut; Tamil falls back to alt text', () => {
    const doc = { width_chars: 32, ops: [{ t: 'text' as const, s: 'தக்காளி', alt: 'Tomato' }, { t: 'barcode' as const, data: 'SS-20261120-M001' }, { t: 'cut' as const }] };
    const buf = encodeEscPos(doc);
    assert.deepEqual([...buf.subarray(0, 2)], [0x1b, 0x40]);
    assert.ok(buf.includes(Buffer.from('Tomato')));
    assert.ok(buf.includes(Buffer.from([0x1d, 0x6b, 73])));
    assert.ok(buf.includes(Buffer.from([0x1d, 0x56, 66, 0])));
    assert.ok(!buf.includes(Buffer.from('தக்காளி')));
    assert.match(renderPreview(doc), /SS-20261120-M001/);
  });
});

describe('catalogue search & lookup', () => {
  let h: Harness;
  before(async () => (h = await startHarness()));
  after(() => h.close());
  test('exact barcode, leading zero, and UPC variant', () => {
    assert.equal(h.ctx.catalogue.lookupBarcode(LEADING_ZERO_BARCODE).items[0].pos_item_id, 'M501');
    assert.equal(h.ctx.catalogue.lookupBarcode(LEADING_ZERO_BARCODE.slice(1)).items[0].pos_item_id, 'M501');
  });
  test('duplicate barcode is reported as ambiguous, never silently picked', () => {
    const r = h.ctx.catalogue.lookupBarcode(DEMO_DUPLICATE_BARCODE);
    assert.equal(r.kind, 'ambiguous');
    assert.equal(r.items.length, 2);
  });
  test('unknown barcode returns no items', () => {
    assert.equal(h.ctx.catalogue.lookupBarcode('2009999999999').kind, 'unknown');
  });
  test('search: English, Tamil, transliteration, misspelling, brand', () => {
    const top = (q: string) => h.ctx.catalogue.search(q).items[0]?.pos_item_id;
    assert.equal(top('tomato'), 'V201');
    assert.equal(top('தக்காளி'), 'V201');
    assert.equal(top('thakkali'), 'V201');
    assert.equal(top('tomoto'), 'V201');
    assert.ok(h.ctx.catalogue.search('bannana').items.some((i) => i.pos_item_id.startsWith('F10')));
    assert.ok(h.ctx.catalogue.search('ponni').items.length >= 3);
  });
  test('scale label resolves to the produce item via PLU when a rule is configured', () => {
    const rules = validateScaleRules([{ name: 'w', prefixes: ['21'], length: 13, itemStart: 2, itemLength: 5, valueStart: 7, valueLength: 5, valueType: 'weight_g' }]);
    const body = '2100201' + '00750';
    const code = body + gs1CheckDigit(body);
    const r = h.ctx.catalogue.lookupBarcode(code, rules) as any;
    assert.equal(r.kind, 'scale');
    assert.equal(r.items[0].pos_item_id, 'V201');
    assert.equal(r.scale.weightGrams, 750);
  });
});
