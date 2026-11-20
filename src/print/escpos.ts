import type { SlipDoc } from './slip.js';
import { wrap } from './slip.js';

/**
 * Minimal ESC/POS encoder (Epson-compatible command set, used by most 58/80 mm
 * thermal receipt printers). Text mode prints ASCII only; lines containing
 * other scripts (e.g. Tamil) fall back to their English `alt` text. Printing
 * Tamil requires raster (image) mode - see docs/PRINTING.md.
 */
const ESC = 0x1b;
const GS = 0x1d;

function ascii(s: string) {
  return s.replace(/₹/g, 'Rs.').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '?');
}
const hasNonAscii = (s: string) => /[^\x20-\x7e₹‘’“”–—]/.test(s);

export function encodeEscPos(doc: SlipDoc): Buffer {
  const W = doc.width_chars;
  const bytes: number[] = [ESC, 0x40]; // initialise
  const push = (...b: number[]) => bytes.push(...b);
  const text = (s: string) => push(...Buffer.from(ascii(s) + '\n', 'latin1'));
  const align = (a?: string) => push(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0);
  const bold = (on?: boolean) => push(ESC, 0x45, on ? 1 : 0);
  const size = (n = 1) => push(GS, 0x21, ((n - 1) << 4) | (n - 1));
  const invert = (on?: boolean) => push(GS, 0x42, on ? 1 : 0);

  for (const op of doc.ops) {
    switch (op.t) {
      case 'text': {
        const s = hasNonAscii(op.s) && op.alt ? op.alt : op.s;
        align(op.align); bold(op.bold); size(op.size); invert(op.invert);
        for (const line of wrap(s, Math.floor(W / (op.size ?? 1)))) text(line);
        invert(false); size(1); bold(false); align('left');
        break;
      }
      case 'row': {
        const left = hasNonAscii(op.left) && op.alt ? op.alt : op.left;
        bold(op.bold);
        const lines = wrap(left, W - op.right.length - 1);
        lines.forEach((l, i) => text(i === lines.length - 1 ? l + ' '.repeat(Math.max(1, W - l.length - op.right.length)) + op.right : l));
        bold(false);
        break;
      }
      case 'rule':
        text((op.ch ?? '-').repeat(W));
        break;
      case 'feed':
        push(ESC, 0x64, op.n ?? 1);
        break;
      case 'barcode': {
        const data = Buffer.from('{B' + ascii(op.data), 'latin1');
        align('center');
        push(GS, 0x48, 2); // HRI below
        push(GS, 0x68, 72); // height
        push(GS, 0x77, 2); // module width
        push(GS, 0x6b, 73, data.length, ...data); // CODE128
        text('');
        align('left');
        break;
      }
      case 'cut':
        push(ESC, 0x64, 3, GS, 0x56, 66, 0);
        break;
    }
  }
  return Buffer.from(bytes);
}

/** DLE EOT 4: request roll paper sensor status. */
export const PAPER_STATUS_REQUEST = Buffer.from([0x10, 0x04, 4]);
/** Interpret the response byte to DLE EOT 4. */
export function paperStatusFromByte(b: number): 'ok' | 'near_end' | 'out' {
  if ((b & 0x60) === 0x60) return 'out';
  if ((b & 0x0c) === 0x0c) return 'near_end';
  return 'ok';
}
