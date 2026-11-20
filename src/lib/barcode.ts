/**
 * Barcode helpers.
 *
 * Product barcodes are always handled as strings (leading zeros are significant).
 * Scale-label (in-store weighing) barcodes are NOT parsed unless the branch has a
 * rule configured, because label formats differ: some encode weight, others price.
 * Configure rules only after inspecting sample labels printed by the shop's scale.
 */

export function normaliseBarcode(input: string): string {
  return String(input ?? '').replace(/[\s-]/g, '').trim();
}

export function isNumeric(s: string) {
  return /^\d+$/.test(s);
}

/** GS1 mod-10 check digit validation for EAN-8, UPC-A, EAN-13, GTIN-14. */
export function hasValidGs1CheckDigit(code: string): boolean {
  if (!isNumeric(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop() as number;
  let sum = 0;
  digits.reverse().forEach((d, i) => (sum += d * (i % 2 === 0 ? 3 : 1)));
  return (10 - (sum % 10)) % 10 === check;
}

export function gs1CheckDigit(body: string): string {
  const digits = body.split('').map(Number).reverse();
  let sum = 0;
  digits.forEach((d, i) => (sum += d * (i % 2 === 0 ? 3 : 1)));
  return String((10 - (sum % 10)) % 10);
}

/** Alternative spellings of the same GTIN (UPC-A <-> EAN-13 with leading zero). */
export function barcodeVariants(code: string): string[] {
  const c = normaliseBarcode(code);
  const out = new Set([c]);
  if (isNumeric(c)) {
    if (c.length === 12) out.add('0' + c);
    if (c.length === 13 && c.startsWith('0')) out.add(c.slice(1));
    if (c.length === 14 && c.startsWith('0')) out.add(c.slice(1));
  }
  return [...out];
}

export interface ScaleLabelRule {
  name: string;
  /** Barcode must start with one of these prefixes (e.g. ["21"]). */
  prefixes: string[];
  length: number;            // usually 13
  itemStart: number;         // 0-based index of the item (PLU) code
  itemLength: number;
  valueStart: number;
  valueLength: number;
  valueType: 'weight_g' | 'price_paise';
  /** For price labels: multiply the encoded number to get paise (e.g. 1 if encoded in paise, 100 if in rupees). */
  valueMultiplier?: number;
  /** For weight labels: multiply the encoded number to get grams (1 if encoded in grams). */
  checkDigit?: boolean;
}

export interface ScaleLabelResult {
  rule: string;
  plu: string;
  weightGrams?: number;
  pricePaise?: number;
}

export function parseScaleLabel(raw: string, rules: ScaleLabelRule[]): ScaleLabelResult | null {
  const code = normaliseBarcode(raw);
  if (!isNumeric(code)) return null;
  for (const r of rules) {
    if (code.length !== r.length) continue;
    if (!r.prefixes.some((p) => code.startsWith(p))) continue;
    if (r.checkDigit !== false && r.length === 13 && !hasValidGs1CheckDigit(code)) continue;
    const plu = code.slice(r.itemStart, r.itemStart + r.itemLength);
    const value = Number(code.slice(r.valueStart, r.valueStart + r.valueLength));
    if (!Number.isFinite(value)) continue;
    const mult = r.valueMultiplier ?? 1;
    return r.valueType === 'weight_g'
      ? { rule: r.name, plu, weightGrams: value * mult }
      : { rule: r.name, plu, pricePaise: value * mult };
  }
  return null;
}

export function validateScaleRules(json: unknown): ScaleLabelRule[] {
  if (!Array.isArray(json)) throw new Error('Scale label rules must be a JSON array');
  return json.map((r: any, i) => {
    const need = ['name', 'prefixes', 'length', 'itemStart', 'itemLength', 'valueStart', 'valueLength', 'valueType'];
    for (const k of need) if (r?.[k] === undefined) throw new Error(`Rule ${i + 1}: missing "${k}"`);
    if (!Array.isArray(r.prefixes) || r.prefixes.some((p: unknown) => typeof p !== 'string' || !/^\d+$/.test(p as string)))
      throw new Error(`Rule ${i + 1}: prefixes must be an array of digit strings`);
    if (!['weight_g', 'price_paise'].includes(r.valueType)) throw new Error(`Rule ${i + 1}: valueType must be weight_g or price_paise`);
    if (r.itemStart + r.itemLength > r.length || r.valueStart + r.valueLength > r.length) throw new Error(`Rule ${i + 1}: positions exceed length`);
    return r as ScaleLabelRule;
  });
}
