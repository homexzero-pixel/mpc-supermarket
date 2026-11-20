/**
 * Decimal-safe money and weight helpers. All money is integer paise and all
 * weight is integer grams, so no floating point is ever used for totals.
 */
export function parseRupeesToPaise(input: string | number): number {
  const s = String(input).trim().replace(/[₹,\s]/g, '');
  const m = s.match(/^(-)?(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`Invalid amount: ${input}`);
  const paise = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return m[1] ? -paise : paise;
}

/** Integer division rounding half away from zero. */
export function divRoundHalfUp(num: number, den: number): number {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den === 0) throw new Error('bad division');
  const sign = Math.sign(num) * Math.sign(den);
  const n = Math.abs(num);
  const d = Math.abs(den);
  return sign * Math.floor((2 * n + d) / (2 * d));
}

/** Price of a weighed line: price per kg (paise) x grams, rounded to the nearest paisa. */
export function weightLinePaise(pricePerKgPaise: number, grams: number) {
  return divRoundHalfUp(pricePerKgPaise * grams, 1000);
}

export function formatPaise(paise: number, opts: { symbol?: boolean } = {}) {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const r = rupees.toLocaleString('en-IN');
  const s = p === 0 ? r : `${r}.${String(p).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${opts.symbol === false ? '' : '₹'}${s}`;
}

export function formatGrams(g: number) {
  if (g >= 1000) {
    const kg = g / 1000;
    return `${Number.isInteger(kg) ? kg : kg.toFixed(3).replace(/0+$/, '')} kg`;
  }
  return `${g} g`;
}

export interface LineForTotal {
  sold_by: 'pack' | 'piece' | 'weight' | string;
  unit_price_paise: number;
  qty: number;
  est_grams?: number | null;
  actual_grams?: number | null;
}

/** Returns the line amount and whether it is an estimate (unweighed loose produce). */
export function lineAmount(l: LineForTotal): { paise: number; estimated: boolean; unknown: boolean } {
  if (l.sold_by === 'weight') {
    if (l.actual_grams != null) return { paise: weightLinePaise(l.unit_price_paise, l.actual_grams), estimated: false, unknown: false };
    if (l.est_grams != null) return { paise: weightLinePaise(l.unit_price_paise, l.est_grams), estimated: true, unknown: false };
    return { paise: 0, estimated: true, unknown: true };
  }
  return { paise: l.unit_price_paise * l.qty, estimated: false, unknown: false };
}

export function basketTotal(lines: LineForTotal[]) {
  let paise = 0;
  let estimated = false;
  let unknownCount = 0;
  for (const l of lines) {
    if (l.qty <= 0) continue;
    const a = lineAmount(l);
    paise += a.paise;
    estimated ||= a.estimated;
    if (a.unknown) unknownCount++;
  }
  return { paise, estimated, unknownCount };
}
