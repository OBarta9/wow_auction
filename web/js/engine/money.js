// Money helpers. All prices are in copper.

export function formatMoney(copper, { html = true, sign = false } = {}) {
  if (copper === null || copper === undefined || Number.isNaN(copper)) return html ? '<span class="muted">—</span>' : '—';
  const neg = copper < 0;
  let c = Math.round(Math.abs(copper));
  const g = Math.floor(c / 10000);
  c -= g * 10000;
  const s = Math.floor(c / 100);
  c -= s * 100;
  const parts = [];
  if (g) parts.push(html ? `<span class="g">${g.toLocaleString('en-US')}g</span>` : `${g}g`);
  if (s || (g && c)) parts.push(html ? `<span class="s">${s}s</span>` : `${s}s`);
  if (c || (!g && !s)) parts.push(html ? `<span class="c">${c}c</span>` : `${c}c`);
  const pre = neg ? '−' : sign ? '+' : '';
  return html ? `<span class="money${neg ? ' neg' : ''}">${pre}${parts.join(' ')}</span>` : pre + parts.join(' ');
}

/** Parse "1g 20s 5c", "1.5g", "250s", "12000" (copper) -> copper. */
export function parseMoney(text) {
  if (text === null || text === undefined) return null;
  const t = String(text).trim().toLowerCase();
  if (!t) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t));
  let total = 0;
  let matched = false;
  for (const m of t.matchAll(/(-?\d+(?:\.\d+)?)\s*([gsc])/g)) {
    matched = true;
    const v = parseFloat(m[1]);
    total += m[2] === 'g' ? v * 10000 : m[2] === 's' ? v * 100 : v;
  }
  return matched ? Math.round(total) : null;
}
