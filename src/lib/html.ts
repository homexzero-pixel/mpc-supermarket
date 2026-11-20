/** Tiny auto-escaping HTML template helper. */
export class SafeHtml {
  constructor(public readonly value: string) {}
  toString() {
    return this.value;
  }
}
export const raw = (s: string) => new SafeHtml(s);

const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ENT[c]);
}

function render(v: unknown): string {
  if (v == null || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  values.forEach((v, i) => (out += render(v) + strings[i + 1]));
  return new SafeHtml(out);
}

/** JSON that is safe to embed inside a <script> element. */
export function jsonScript(v: unknown) {
  const s = JSON.stringify(v)
    .split('<').join('\\u003c')
    .split('>').join('\\u003e')
    .split('&').join('\\u0026')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
  return raw(s);
}
