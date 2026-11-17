// Small DOM helpers and a reusable sortable table.
import { formatMoney } from './engine/money.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const money = (c, opts) => formatMoney(c, opts);

let wowheadBase = 'classic';
export function setWowheadFlavor(f) {
  wowheadBase = f || 'classic';
}

export function itemLink(id, items) {
  const it = items[id];
  const name = it ? it.n : `Item ${id}`;
  const q = it ? it.q : 1;
  return `<a class="item q${q}" href="https://www.wowhead.com/${wowheadBase}/item=${id}" target="_blank" rel="noopener">${esc(name)}</a>`;
}

export function spellLink(id, name) {
  return `<a class="item q1" href="https://www.wowhead.com/${wowheadBase}/spell=${id}" target="_blank" rel="noopener">${esc(name)}</a>`;
}

export function skillCell(s, color) {
  const [a, b, c, d] = s;
  const mark = (cls, v, key) => `<span class="${cls}${color === key ? '' : ''}" title="${key}">${v}</span>`;
  return `<span class="skill">${mark('sk-orange', a, 'orange')}${mark('sk-yellow', b, 'yellow')}${mark('sk-green', c, 'green')}${mark('sk-grey', d, 'grey')}</span>`;
}

export function pct(v, digits = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '<span class="muted">—</span>';
  const cls = v > 0 ? 'pos' : v < 0 ? 'negv' : '';
  return `<span class="${cls}">${(v * 100).toFixed(digits)}%</span>`;
}

export function num(v, digits = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '<span class="muted">—</span>';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function sparkline(values, w = 90, h = 22) {
  const pts = (values || []).map((v, i) => [i, v]).filter(([, v]) => v !== null && v !== undefined);
  if (pts.length < 2) return '<span class="muted small">—</span>';
  const n = values.length;
  const ys = pts.map(([, v]) => v);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const d = pts
    .map(([i, v], k) => `${k ? 'L' : 'M'}${((i / (n - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`)
    .join('');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="#e5b84b" stroke-width="1.5"/></svg>`;
}

export function toast(msg, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/**
 * Render a sortable table.
 * columns: [{key, label, num?, html(row), sort?(row)}]
 * opts: {sortKey, sortDir, pageSize, detail(row) -> html | null, onSort(key, dir), empty}
 */
export function renderTable(container, columns, rows, opts = {}) {
  const state = {
    sortKey: opts.sortKey ?? columns[0].key,
    sortDir: opts.sortDir ?? -1,
    shown: opts.pageSize ?? 200,
    open: new Set(),
  };
  const sorted = () => {
    const col = columns.find((c) => c.key === state.sortKey) || columns[0];
    const get = col.sort || ((r) => r[col.key]);
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      const na = va === null || va === undefined || Number.isNaN(va);
      const nb = vb === null || vb === undefined || Number.isNaN(vb);
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'string') return va.localeCompare(vb) * state.sortDir;
      return (va - vb) * state.sortDir;
    });
  };

  const draw = () => {
    const list = sorted();
    const head = columns
      .map(
        (c) =>
          `<th data-k="${c.key}" class="${c.num ? 'num' : ''} ${c.key === state.sortKey ? 'sorted' : ''}" title="${esc(c.title || '')}">${esc(c.label)}${
            c.key === state.sortKey ? (state.sortDir < 0 ? ' ▼' : ' ▲') : ''
          }</th>`,
      )
      .join('');
    const body = [];
    list.slice(0, state.shown).forEach((r, idx) => {
      const expandable = !!opts.detail;
      body.push(
        `<tr class="row${expandable ? ' expandable' : ''}" data-i="${idx}">${columns
          .map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls || ''}">${c.html ? c.html(r) : esc(r[c.key])}</td>`)
          .join('')}</tr>`,
      );
      if (expandable && state.open.has(r)) {
        body.push(`<tr class="detail"><td colspan="${columns.length}">${opts.detail(r) || ''}</td></tr>`);
      }
    });
    const more =
      list.length > state.shown
        ? `<button class="btn more" data-more>Show more (${list.length - state.shown} hidden)</button>`
        : '';
    container.innerHTML = list.length
      ? `<div class="summary">${list.length.toLocaleString('en-US')} rows</div><div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table></div>${more}`
      : `<div class="panel muted">${opts.empty || 'Nothing matches the current filters.'}</div>`;

    container.querySelectorAll('th[data-k]').forEach((th) =>
      th.addEventListener('click', () => {
        const k = th.dataset.k;
        if (state.sortKey === k) state.sortDir *= -1;
        else {
          state.sortKey = k;
          const col = columns.find((c) => c.key === k);
          state.sortDir = col.num ? -1 : 1;
        }
        opts.onSort?.(state.sortKey, state.sortDir);
        draw();
      }),
    );
    if (opts.detail) {
      container.querySelectorAll('tr.row').forEach((tr) =>
        tr.addEventListener('click', (e) => {
          if (e.target.closest('a')) return;
          const r = list[+tr.dataset.i];
          if (state.open.has(r)) state.open.delete(r);
          else state.open.add(r);
          draw();
        }),
      );
    }
    container.querySelector('[data-more]')?.addEventListener('click', () => {
      state.shown += opts.pageSize ?? 200;
      draw();
    });
  };
  draw();
}

/** Toggle chips. options: [{value, label, cls?}], selected: Set */
export function chips(options, selected, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  for (const o of options) {
    const el = document.createElement('span');
    el.className = `chip ${o.cls || ''} ${selected.has(o.value) ? 'on' : ''}`;
    el.textContent = o.label;
    el.addEventListener('click', () => {
      if (selected.has(o.value)) selected.delete(o.value);
      else selected.add(o.value);
      el.classList.toggle('on');
      onChange(selected);
    });
    wrap.appendChild(el);
  }
  return wrap;
}

/** Debounce helper for text inputs. */
export function debounce(fn, ms = 200) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
