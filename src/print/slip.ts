/**
 * Printer-independent slip document. The server builds it, stores it with the
 * print job, and renders a plain-text preview; the store print agent encodes
 * the same document to ESC/POS for the thermal printer.
 */
export type SlipOp =
  | { t: 'text'; s: string; alt?: string; align?: 'left' | 'center' | 'right'; bold?: boolean; size?: 1 | 2 | 3; invert?: boolean }
  | { t: 'row'; left: string; right: string; alt?: string; bold?: boolean }
  | { t: 'rule'; ch?: string }
  | { t: 'feed'; n?: number }
  | { t: 'barcode'; data: string }
  | { t: 'cut' };

export interface SlipDoc {
  width_chars: number;
  ops: SlipOp[];
}

export const charsForPaper = (mm: number) => (mm <= 58 ? 32 : 48);

/** Money for thermal printers: most code pages lack the rupee sign. */
export function slipMoney(paise: number) {
  const neg = paise < 0;
  const a = Math.abs(paise);
  return `${neg ? '-' : ''}Rs.${Math.floor(a / 100).toLocaleString('en-IN')}.${String(a % 100).padStart(2, '0')}`;
}

export function wrap(s: string, width: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let w of words) {
    while ([...w].length > width) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push([...w].slice(0, width).join(''));
      w = [...w].slice(width).join('');
    }
    if (!cur) cur = w;
    else if ([...cur].length + 1 + [...w].length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

const len = (s: string) => [...s].length;

/** Plain-text preview (what a staff screen shows; mirrors the printed layout). */
export function renderPreview(doc: SlipDoc, opts: { useAlt?: boolean } = {}): string {
  const W = doc.width_chars;
  const out: string[] = [];
  const pad = (s: string, align: string, width: number) => {
    const l = len(s);
    if (l >= width) return s;
    if (align === 'center') return ' '.repeat(Math.floor((width - l) / 2)) + s;
    if (align === 'right') return ' '.repeat(width - l) + s;
    return s;
  };
  for (const op of doc.ops) {
    switch (op.t) {
      case 'text': {
        const size = op.size ?? 1;
        const width = Math.floor(W / size);
        const text = opts.useAlt && op.alt ? op.alt : op.s;
        for (const line of wrap(text, width)) {
          const shown = size > 1 ? [...line].join(' '.repeat(size - 1)) : line;
          out.push(pad(op.invert ? `[ ${shown} ]` : shown, op.align ?? 'left', W));
        }
        break;
      }
      case 'row': {
        const left = opts.useAlt && op.alt ? op.alt : op.left;
        const lw = W - len(op.right) - 1;
        const lines = wrap(left, lw);
        lines.forEach((l, i) => out.push(i === lines.length - 1 ? l + ' '.repeat(Math.max(1, W - len(l) - len(op.right))) + op.right : l));
        break;
      }
      case 'rule':
        out.push((op.ch ?? '-').repeat(W));
        break;
      case 'feed':
        for (let i = 0; i < (op.n ?? 1); i++) out.push('');
        break;
      case 'barcode':
        out.push(pad('||| ' + op.data + ' |||', 'center', W));
        break;
      case 'cut':
        out.push('- - - - - - - - - - - - - - - - - - - - - - - -'.slice(0, W));
        break;
    }
  }
  return out.join('\n');
}
