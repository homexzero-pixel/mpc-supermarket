import { esc } from '../lib/html.js';

/** Original, simple illustrations used when a product has no photo. */
const GLYPHS: Record<string, string> = {
  fruits: '<circle cx="50" cy="56" r="26" fill="#F2B632"/><path d="M50 30c6-12 18-15 26-14-4 9-14 15-26 14Z" fill="#6FA83A"/><path d="M50 30v-8" stroke="#6B4B1F" stroke-width="3" stroke-linecap="round"/>',
  vegetables: '<path d="M30 70c0-22 9-38 20-38s20 16 20 38c0 8-9 12-20 12s-20-4-20-12Z" fill="#D94A2B"/><path d="M50 32c-8-8-16-8-20-6 4 6 12 8 20 6Zm0 0c8-8 16-8 20-6-4 6-12 8-20 6Z" fill="#3E7D2B"/>',
  'rice-grains': '<path d="M28 40h44l-4 42H32l-4-42Z" fill="#E9D9B6"/><path d="M28 40c4-10 40-10 44 0" fill="#D4BE8D"/><g fill="#fff"><ellipse cx="42" cy="58" rx="3" ry="6"/><ellipse cx="52" cy="64" rx="3" ry="6" transform="rotate(20 52 64)"/><ellipse cx="60" cy="55" rx="3" ry="6" transform="rotate(-15 60 55)"/></g>',
  'dals-pulses': '<path d="M24 56h52a26 22 0 0 1-52 0Z" fill="#C9772C"/><g fill="#F2B632"><circle cx="38" cy="52" r="5"/><circle cx="50" cy="49" r="5"/><circle cx="62" cy="52" r="5"/><circle cx="44" cy="44" r="5"/><circle cx="56" cy="44" r="5"/></g>',
  dairy: '<path d="M38 26h24v10l8 12v34a4 4 0 0 1-4 4H34a4 4 0 0 1-4-4V48l8-12V26Z" fill="#fff" stroke="#2F6DB5" stroke-width="3"/><path d="M30 56h40v14H30z" fill="#2F6DB5"/>',
  'oils-masala': '<path d="M42 22h16v12l8 10v38a4 4 0 0 1-4 4H38a4 4 0 0 1-4-4V44l8-10V22Z" fill="#F4C430"/><path d="M34 56h32v16H34z" fill="#0B5A2A"/>',
  snacks: '<path d="M30 28h40l-4 10 4 10-4 10 4 10-4 10 4 10H30l4-10-4-10 4-10-4-10 4-10-4-10Z" fill="#E4572E"/><circle cx="50" cy="58" r="10" fill="#F2B632"/>',
  beverages: '<path d="M36 28h28l-4 56H40l-4-56Z" fill="#7FC8BF"/><path d="M38 44h24" stroke="#fff" stroke-width="3"/><path d="M56 28l6-12" stroke="#0B5A2A" stroke-width="3" stroke-linecap="round"/>',
  'personal-care': '<rect x="36" y="34" width="28" height="50" rx="6" fill="#B79AD8"/><rect x="44" y="20" width="12" height="14" rx="2" fill="#6E4FA0"/><path d="M42 56h16" stroke="#fff" stroke-width="3" stroke-linecap="round"/>',
  household: '<path d="M30 44h40v36a4 4 0 0 1-4 4H34a4 4 0 0 1-4-4V44Z" fill="#6C8EA4"/><path d="M38 44V32a12 12 0 0 1 24 0v12" fill="none" stroke="#3E5A6C" stroke-width="4"/><circle cx="50" cy="62" r="7" fill="#fff"/>',
};
const DEFAULT_GLYPH = '<circle cx="50" cy="52" r="24" fill="#0B5A2A" opacity=".85"/>';

export function deptSvg(slug: string, color = '#E8F1E4') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="${esc(color)}"/>${GLYPHS[slug] ?? DEFAULT_GLYPH}</svg>`;
}

export function itemSvg(item: { name_en: string; department: string | null; pack_label: string | null }, color = '#F3F6EF') {
  const words = item.name_en.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 16) { if (cur) lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 2);
  const glyph = GLYPHS[item.department ?? ''] ?? DEFAULT_GLYPH;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">
  <rect width="240" height="240" fill="${esc(color)}"/>
  <g transform="translate(60 22) scale(1.2)">${glyph}</g>
  ${shown.map((l, i) => `<text x="120" y="${172 + i * 22}" text-anchor="middle" font-family="Poppins, Arial, sans-serif" font-size="17" font-weight="600" fill="#1E2A22">${esc(l)}</text>`).join('')}
  ${item.pack_label ? `<text x="120" y="${172 + shown.length * 22 + 2}" text-anchor="middle" font-family="Poppins, Arial, sans-serif" font-size="14" fill="#55625A">${esc(item.pack_label)}</text>` : ''}
</svg>`;
}
