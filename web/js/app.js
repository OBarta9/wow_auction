// WoW Auction Helper - browser app. No build step, no dependencies.
import { PriceBook, PRICE_SOURCES } from './engine/prices.js';
import { computeCrafting, PROFESSIONS } from './engine/crafting.js';
import { vendorFlips, marketFlips, crossHouse, vendorResale, disenchantFlips, disenchantValue } from './engine/opportunities.js';
import { parseMoney } from './engine/money.js';
import { parseCharacterImport, toCharacters } from './character.js';
import { $, esc, money, itemLink, spellLink, skillCell, pct, num, sparkline, renderTable, chips, debounce, toast, setWowheadFlavor } from './ui.js';

const STORE_KEY = 'wah.v1';
const HOUSE_LABEL = { alliance: 'Alliance', horde: 'Horde', neutral: 'Blackwater (neutral)' };

// ---------------------------------------------------------------- state
const defaults = {
  house: null,
  tab: 'crafting',
  settings: {
    buySource: 'market',
    sellSource: 'market',
    oppSellSource: 'conservative',
    cutFaction: 0.05,
    cutNeutral: 0.15,
    useVendor: true,
    intermediates: 'craftable',
    wowhead: 'classic',
  },
  chars: [], // imported via addon / manual
  activeChars: null, // null = all
  overrides: {},
  f: {
    crafting: { profs: [], show: 'all', colors: [], skillMin: '', skillMax: '', minProfit: '', minMargin: '', minSold: '', hideBop: true, hideIncomplete: true, search: '' },
    flips: { minDiscount: 30, minSold: 1, reference: 'market', search: '' },
    vendor: { search: '' },
    de: { skill: '', minMargin: 10, search: '' },
    cross: { minMargin: 15, minSold: 0.5, search: '' },
    resale: { search: '', onlyLimited: false, minSold: 0.5 },
  },
};

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return {
      ...defaults,
      ...s,
      settings: { ...defaults.settings, ...(s.settings || {}) },
      f: Object.fromEntries(Object.entries(defaults.f).map(([k, v]) => [k, { ...v, ...((s.f || {})[k] || {}) }])),
    };
  } catch {
    return structuredClone(defaults);
  }
}
const state = loadState();
const save = () => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('could not save settings', e);
  }
};

const data = {
  items: {},
  recipes: [],
  vendor: {},
  disenchant: null,
  names: {},
  meta: null,
  apiChars: [],
  houses: {}, // slug -> house json
  staticMeta: null,
};
let cache = {}; // computed results, cleared when inputs change

// ---------------------------------------------------------------- loading
async function getJson(url, fallback = null) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return fallback;
    return await r.json();
  } catch {
    return fallback;
  }
}

async function loadHouse(slug) {
  if (!data.houses[slug]) data.houses[slug] = await getJson(`data/live/house-${slug}.json`, null);
  return data.houses[slug];
}

async function init() {
  const [items, recipes, vendor, disenchant, staticMeta, meta, names, chars] = await Promise.all([
    getJson('data/static/items.json', {}),
    getJson('data/static/recipes.json', []),
    getJson('data/static/vendor.json', {}),
    getJson('data/static/disenchant.json', null),
    getJson('data/static/meta.json', null),
    getJson('data/live/meta.json', null),
    getJson('data/live/names.json', {}),
    getJson('data/live/characters.json', null),
  ]);
  data.items = items.items || items;
  data.recipes = recipes.recipes || recipes;
  data.vendor = vendor.items || vendor;
  data.disenchant = disenchant;
  data.staticMeta = staticMeta;
  data.meta = meta;
  data.names = names || {};
  data.apiChars = chars?.characters || [];
  setWowheadFlavor(state.settings.wowhead);

  const houses = (meta?.houses || []).map((h) => h.slug);
  const sel = $('#house');
  sel.innerHTML = houses.map((h) => `<option value="${h}">${esc(HOUSE_LABEL[h] || h)}</option>`).join('');
  if (!houses.includes(state.house)) state.house = guessHouse(houses);
  sel.value = state.house || '';
  sel.addEventListener('change', async () => {
    state.house = sel.value;
    save();
    await loadHouse(state.house);
    invalidate();
    render();
  });
  if (state.house) await loadHouse(state.house);
  renderStatus();
  renderTabs();
  render();
}

function guessHouse(houses) {
  const fac = allChars().find((c) => c.faction)?.faction;
  if (fac && houses.includes(fac)) return fac;
  return houses[0] || null;
}

function renderStatus() {
  const m = data.meta;
  if (!m) {
    $('#status').innerHTML = 'No price data yet';
    return;
  }
  const ago = Math.round((Date.now() / 1000 - m.updated) / 60);
  const agoText = ago < 90 ? `${ago} min ago` : `${Math.round(ago / 60)} h ago`;
  const h = data.houses[state.house];
  const src = h?.sources || {};
  const parts = [];
  if (src.blizzard) parts.push('Blizzard API');
  if (src.tsm) parts.push('TSM');
  $('#status').innerHTML = `${esc(m.game)} ${esc(m.region.toUpperCase())} · ${esc(m.ruleset)} · updated ${agoText}${parts.length ? ' · ' + parts.join(' + ') : ''}`;
}

// ---------------------------------------------------------------- helpers
function allChars() {
  // API characters (from pipeline) + imported/manual characters (local). Local wins on same id.
  const local = new Map(state.chars.map((c) => [c.id, c]));
  const out = [...state.chars];
  for (const c of data.apiChars) if (!local.has(c.id)) out.push(resolveApiChar(c));
  return out;
}

function resolveApiChar(c) {
  if (c.known || !c.knownApi) return c;
  const byName = new Map(data.recipes.map((r) => [r.n.toLowerCase(), r]));
  const byApi = new Map(data.recipes.filter((r) => r.ai).map((r) => [r.ai, r]));
  const known = {};
  for (const [prof, list] of Object.entries(c.knownApi)) {
    known[prof] = list.map((x) => (byApi.get(x.id) || byName.get(String(x.n || '').toLowerCase()))?.id).filter(Boolean);
  }
  return { ...c, known };
}

function activeChars() {
  const all = allChars();
  if (!state.activeChars) return all;
  return all.filter((c) => state.activeChars.includes(c.id));
}

function houseCut(slug) {
  return slug === 'neutral' ? state.settings.cutNeutral : state.settings.cutFaction;
}

const FACTION_CODE = { alliance: 'A', horde: 'H' };

/** kind 'craft' sells at the crafting sell price, 'opp' at the (safer) opportunity sell price. */
function priceBook(slug = state.house, kind = 'craft') {
  const key = `pb:${slug}:${kind}`;
  if (!cache[key]) {
    cache[key] = new PriceBook({
      house: data.houses[slug],
      items: data.items,
      vendor: data.vendor,
      names: data.names,
      settings: {
        buySource: state.settings.buySource,
        sellSource: kind === 'opp' ? state.settings.oppSellSource : state.settings.sellSource,
        faction: FACTION_CODE[slug] || null,
        ahCut: houseCut(slug),
        useVendor: state.settings.useVendor,
        overrides: state.overrides,
      },
    });
  }
  return cache[key];
}

function invalidate() {
  cache = {};
  renderStatus();
}

function link(id) {
  if (data.items[id]) return itemLink(id, data.items);
  return itemLink(id, { [id]: { n: data.names[id] || `Item ${id}`, q: 1 } });
}

function matchesSearch(text, q) {
  return !q || String(text).toLowerCase().includes(q.toLowerCase());
}

function gold(v) {
  const c = parseMoney(v === '' || v === null || v === undefined ? null : /[gsc]/i.test(String(v)) ? v : `${v}g`);
  return c;
}

function noData() {
  if (!data.meta) {
    return `<div class="banner">No auction data found. Run <code>python wowah.py fetch</code> (or wait for the GitHub Action) and reload.</div>`;
  }
  if (!data.houses[state.house]) return `<div class="banner">Could not load prices for this auction house.</div>`;
  return '';
}

function noStatic() {
  return data.recipes.length
    ? ''
    : `<div class="banner">Recipe database is missing. Run <code>python wowah.py build-db</code>.</div>`;
}

function depthNote(pb) {
  return pb.hasDepth
    ? ''
    : `<div class="banner info">Only TSM summary prices are available for this house, so quantities and "buy up to" prices are unknown and totals are per unit. Add free Blizzard API keys to get full listing depth (see README).</div>`;
}

// ---------------------------------------------------------------- tabs
const TABS = [
  ['crafting', 'Crafting'],
  ['flips', 'Flips'],
  ['vendor', 'Vendor flips'],
  ['de', 'Disenchant'],
  ['cross', 'Cross-AH'],
  ['resale', 'Vendor resale'],
  ['lookup', 'Item lookup'],
  ['chars', 'Characters'],
  ['settings', 'Settings'],
];

function renderTabs() {
  const nav = $('#tabs');
  nav.innerHTML = TABS.map(([k, l]) => `<button data-tab="${k}" class="${state.tab === k ? 'active' : ''}">${l}</button>`).join('');
  nav.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      save();
      renderTabs();
      render();
    }),
  );
}

function render() {
  const main = $('#main');
  const fn = { crafting: renderCrafting, flips: renderFlips, vendor: renderVendor, de: renderDe, cross: renderCross, resale: renderResale, lookup: renderLookup, chars: renderChars, settings: renderSettings }[state.tab];
  main.innerHTML = '';
  fn(main);
}

/** Build a filter bar from field specs; calls onChange after each edit. */
function filterBar(container, f, specs, onChange) {
  const bar = document.createElement('div');
  bar.className = 'filters';
  for (const s of specs) {
    const wrap = document.createElement('label');
    wrap.className = s.type === 'check' ? 'check' : 'f';
    if (s.type === 'check') {
      wrap.innerHTML = `<input type="checkbox" ${f[s.key] ? 'checked' : ''}> ${esc(s.label)}`;
      wrap.querySelector('input').addEventListener('change', (e) => {
        f[s.key] = e.target.checked;
        save();
        onChange();
      });
    } else if (s.type === 'select') {
      wrap.innerHTML = `<span>${esc(s.label)}</span><select>${s.options.map(([v, l]) => `<option value="${v}" ${String(f[s.key]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      wrap.querySelector('select').addEventListener('change', (e) => {
        f[s.key] = e.target.value;
        save();
        onChange();
      });
    } else if (s.type === 'chips') {
      wrap.innerHTML = `<span>${esc(s.label)}</span>`;
      const set = new Set(f[s.key]);
      wrap.appendChild(
        chips(s.options, set, (sel) => {
          f[s.key] = [...sel];
          save();
          onChange();
        }),
      );
    } else {
      wrap.innerHTML = `<span>${esc(s.label)}</span><input type="${s.type || 'text'}" class="${s.cls || ''}" placeholder="${esc(s.placeholder || '')}" value="${esc(f[s.key] ?? '')}">`;
      wrap.querySelector('input').addEventListener(
        'input',
        debounce((e) => {
          f[s.key] = e.target.value;
          save();
          onChange();
        }, 250),
      );
    }
    bar.appendChild(wrap);
  }
  container.appendChild(bar);
}

// ---------------------------------------------------------------- crafting
function craftingRows() {
  if (!cache.crafting) {
    cache.crafting = computeCrafting({
      recipes: data.recipes,
      pb: priceBook(),
      chars: activeChars(),
      opts: { intermediates: state.settings.intermediates },
    });
  }
  return cache.crafting;
}

function renderCrafting(main) {
  main.insertAdjacentHTML(
    'beforeend',
    `<p class="intro">Profit per craft = what the result sells for after the ${Math.round(houseCut(state.house) * 100)}% AH cut − reagent cost. Reagents use the cheapest of AH, vendor or crafting them yourself. Click a row to see the reagents.</p>${noData()}${noStatic()}`,
  );
  if (!data.houses[state.house] || !data.recipes.length) return;
  const f = state.f.crafting;
  const chars = activeChars();
  const profOpts = Object.entries(PROFESSIONS).map(([k, l]) => ({ value: k, label: l }));
  const specs = [
    { type: 'chips', key: 'profs', label: 'Professions (none = all)', options: profOpts },
    { key: 'search', label: 'Search', cls: 'search', placeholder: 'recipe or reagent name' },
    {
      type: 'select',
      key: 'show',
      label: 'Show',
      options: [
        ['all', 'All recipes'],
        ['craftable', 'Craftable by my characters (known + trainer)'],
        ['known', 'Known recipes only'],
        ['learnable', 'Not known yet (trainer / recipe)'],
      ],
    },
    { key: 'skillMin', label: 'Skill from', type: 'number', cls: 'w-s' },
    { key: 'skillMax', label: 'Skill to', type: 'number', cls: 'w-s' },
    { key: 'minProfit', label: 'Min profit (g)', type: 'number', cls: 'w-s' },
    { key: 'minMargin', label: 'Min margin %', type: 'number', cls: 'w-s' },
    { key: 'minSold', label: 'Min sold/day', type: 'number', cls: 'w-s' },
    { type: 'check', key: 'hideIncomplete', label: 'Hide missing prices' },
    { type: 'check', key: 'hideBop', label: 'Hide BoP / enchants' },
  ];
  if (chars.length) {
    specs.splice(3, 0, {
      type: 'chips',
      key: 'colors',
      label: 'Skill-up color (your skill)',
      options: ['orange', 'yellow', 'green', 'grey'].map((c) => ({ value: c, label: c, cls: `sk-${c}` })),
    });
  }
  const tableHost = document.createElement('div');
  filterBar(main, f, specs, () => draw());
  main.appendChild(tableHost);

  const draw = () => {
    const rows = craftingRows().filter((r) => {
      const rc = r.recipe;
      if (f.profs.length && !f.profs.includes(rc.p)) return false;
      if (f.search) {
        const q = f.search.toLowerCase();
        const hit = rc.n.toLowerCase().includes(q) || r.reagents.some((x) => (data.items[x.id]?.n || data.names[x.id] || '').toLowerCase().includes(q));
        if (!hit) return false;
      }
      if (f.show === 'craftable' && !['known', 'trainer'].includes(r.status)) return false;
      if (f.show === 'known' && r.status !== 'known') return false;
      if (f.show === 'learnable' && !['trainer', 'recipe'].includes(r.status)) return false;
      if (f.colors.length && chars.length && !f.colors.includes(r.color)) return false;
      if (f.skillMin !== '' && rc.s[0] < +f.skillMin) return false;
      if (f.skillMax !== '' && rc.s[0] > +f.skillMax) return false;
      if (f.hideIncomplete && r.cost === null) return false;
      if (f.hideBop && (r.valueSrc === 'vendor (BoP)' || !rc.out)) return false;
      if (f.minProfit !== '' && (r.profit ?? -Infinity) < gold(f.minProfit)) return false;
      if (f.minMargin !== '' && (r.margin ?? -Infinity) < +f.minMargin / 100) return false;
      if (f.minSold !== '' && (r.soldPerDay ?? 0) < +f.minSold) return false;
      return true;
    });
    const cols = [
      {
        key: 'name',
        label: 'Recipe',
        sort: (r) => r.recipe.n,
        html: (r) => (r.recipe.out ? link(r.recipe.out) : spellLink(r.recipe.id, r.recipe.n)) + (avgOut(r) > 1 ? ` <span class="muted small">×${avgOut(r)}</span>` : ''),
      },
      { key: 'prof', label: 'Profession', sort: (r) => r.recipe.p, html: (r) => esc(PROFESSIONS[r.recipe.p] || r.recipe.p) },
      { key: 'skill', label: 'Skill', num: true, sort: (r) => r.recipe.s[0], html: (r) => skillCell(r.recipe.s, r.color) },
    ];
    if (chars.length) {
      cols.push({ key: 'status', label: 'Status', sort: (r) => r.status, html: (r) => statusBadge(r) });
    }
    cols.push(
      { key: 'cost', label: 'Cost', num: true, html: (r) => (r.cost !== null ? money(r.cost) : `<span class="muted" title="missing prices">? ${money(r.partialCost)}</span>`) },
      { key: 'value', label: 'Sells for (net)', num: true, html: (r) => money(r.value) + (r.valueSrc && r.valueSrc !== 'ah' ? `<span class="src">${esc(r.valueSrc)}</span>` : '') },
      { key: 'profit', label: 'Profit', num: true, html: (r) => money(r.profit) },
      { key: 'margin', label: 'Margin', num: true, html: (r) => pct(r.margin) },
      { key: 'soldPerDay', label: 'Sold/day', num: true, title: 'Units sold per day (TSM, all EU Forever rulesets)', html: (r) => num(r.soldPerDay, 1) },
      { key: 'saleRate', label: 'Sale rate', num: true, title: 'Share of auctions that sell (TSM)', html: (r) => pct(r.saleRate) },
      { key: 'expProfit', label: 'Exp. profit', num: true, title: 'Profit × sale rate: what one listing earns on average. Best default ranking.', html: (r) => money(r.expProfit) },
    );
    if (chars.length) {
      cols.push({ key: 'costPerSkillup', label: 'Cost / skill-up', num: true, title: 'Net cost (cost − resale) divided by chance to gain a point. For levelling.', html: (r) => (r.costPerSkillup !== null ? money(r.costPerSkillup) : '<span class="muted">—</span>') });
    }
    renderTable(tableHost, cols, rows, { sortKey: 'expProfit', sortDir: -1, detail: craftDetail });
  };
  draw();
}

function avgOut(r) {
  const q = r.recipe.q;
  const v = Array.isArray(q) ? (q[0] + (q[1] ?? q[0])) / 2 : q || 1;
  return Math.round(v * 10) / 10;
}

function statusBadge(r) {
  const t = { known: 'known', trainer: 'trainer', recipe: 'needs recipe', low: 'skill too low', none: '—' }[r.status];
  return `<span class="badge ${r.status}" title="${esc(r.char || '')}">${t}</span>`;
}

function craftDetail(r) {
  const pb = priceBook();
  const reagentRows = r.reagents
    .map((x) => {
      const via = x.src === 'craft' ? data.recipes.find((rc) => rc.id === x.via) : null;
      const srcText = x.src === 'craft' ? `craft: ${esc(via?.n || '')}` : x.src || 'no price';
      return `<tr><td>${link(x.id)}</td><td class="num">${x.n}</td><td class="num">${money(x.unit)}</td><td class="num">${money(x.unit !== null ? x.unit * x.n : null)}</td><td>${srcText}</td><td class="num">${money(pb.ahPrice(x.id, 'min'))}</td></tr>`;
    })
    .join('');
  const rc = r.recipe;
  const learn =
    rc.src === 'trainer'
      ? 'Taught by profession trainers'
      : rc.ri
        ? `Taught by ${link(rc.ri)}${r.recipeItemPrice ? ` — available for ${money(r.recipeItemPrice)}` : ' (not on AH right now)'}`
        : esc(rc.srcText || 'Other source');
  const out = rc.out ? pb.ah(rc.out) : null;
  return `<div class="grid2">
    <div><table class="data"><thead><tr><th>Reagent</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th><th>Source</th><th class="num">AH min</th></tr></thead><tbody>${reagentRows}</tbody></table></div>
    <div class="kv">
      <div>Learn</div><div>${learn}</div>
      ${rc.out ? `<div>Result on AH</div><div>min ${money(out?.min)}, market ${money(out?.market)}, historical ${money(out?.hist)}, avg sale ${money(out?.avgSale)}</div>` : ''}
      ${rc.out && out?.qty !== null && out?.qty !== undefined ? `<div>Listed</div><div>${num(out.qty)} units in ${num(out.auctions)} auctions</div>` : ''}
      ${r.char ? `<div>Best character</div><div>${esc(r.char)} (skill ${r.rank})</div>` : ''}
      ${r.skillUpChance !== null ? `<div>Skill-up chance</div><div>${pct(r.skillUpChance)}</div>` : ''}
      <div>Recipe id</div><div>${spellLink(rc.id, String(rc.id))}</div>
    </div></div>`;
}

// ---------------------------------------------------------------- generic opportunity tab
function oppTab(main, { intro, specs, f, compute, columns, sortKey = 'profitUnit', detail, needsStatic = false, extraBanner = '' }) {
  main.insertAdjacentHTML('beforeend', `<p class="intro">${intro}</p>${noData()}${needsStatic ? noStatic() : ''}${extraBanner}`);
  if (!data.houses[state.house]) return;
  const pb = priceBook(state.house, 'opp');
  main.insertAdjacentHTML('beforeend', depthNote(pb));
  const host = document.createElement('div');
  filterBar(main, f, specs, () => draw());
  main.appendChild(host);
  const draw = async () => {
    const rows = (await compute()).filter((r) => matchesSearch(pb.name(r.id), f.search));
    renderTable(host, columns, rows, { sortKey, sortDir: -1, detail });
  };
  draw();
}

const C = {
  item: { key: 'item', label: 'Item', sort: (r) => priceBook().name(r.id), html: (r) => link(r.id) },
  rate: { key: 'saleRate', label: 'Sale rate', num: true, title: 'Share of auctions that sell (TSM)', html: (r) => pct(r.saleRate) },
  buy: { key: 'buyUnit', label: 'Buy at', num: true, html: (r) => money(r.buyUnit) },
  maxBuy: { key: 'maxBuy', label: 'Buy up to', num: true, html: (r) => (r.qtyKnown ? money(r.maxBuy) : '<span class="muted">—</span>') },
  sell: (label = 'Sell (net)') => ({ key: 'sellUnit', label, num: true, html: (r) => money(r.sellUnit) }),
  profitUnit: { key: 'profitUnit', label: 'Profit / unit', num: true, html: (r) => money(r.profitUnit) },
  qty: { key: 'qty', label: 'Qty', num: true, html: (r) => num(r.qty) },
  total: { key: 'profitTotal', label: 'Total profit', num: true, html: (r) => money(r.profitTotal) },
  sold: { key: 'soldPerDay', label: 'Sold/day', num: true, html: (r) => num(r.soldPerDay, 1) },
  margin: { key: 'margin', label: 'Margin', num: true, sort: (r) => r.margin ?? r.profitUnit / r.buyUnit, html: (r) => pct(r.margin ?? r.profitUnit / r.buyUnit) },
};

function renderFlips(main) {
  const f = state.f.flips;
  oppTab(main, {
    intro: 'Items listed well below their usual market value. Buy them and relist at the reference price. Check sold/day: slow items can sit for days.',
    f,
    specs: [
      { key: 'search', label: 'Search', cls: 'search' },
      { key: 'minDiscount', label: 'Min discount %', type: 'number', cls: 'w-s' },
      { key: 'minSold', label: 'Min sold/day', type: 'number', cls: 'w-s' },
      { type: 'select', key: 'reference', label: 'Reference price', options: [['market', 'Market value (14-day)'], ['hist', 'Historical (60-day)'], ['min-of', 'Lower of the two']] },
    ],
    compute: () => marketFlips(priceBook(state.house, 'opp'), { minDiscount: (+f.minDiscount || 0) / 100, minSoldPerDay: +f.minSold || 0, reference: f.reference }),
    columns: [
      C.item,
      C.buy,
      { key: 'ref', label: 'Reference', num: true, html: (r) => money(r.ref) },
      { key: 'discount', label: 'Discount', num: true, html: (r) => pct(r.discount) },
      C.maxBuy,
      C.qty,
      C.profitUnit,
      C.total,
      C.sold,
      { key: 'saleRate', label: 'Sale rate', num: true, html: (r) => pct(r.saleRate) },
      { key: 'spark', label: 'Trend', sort: () => 0, html: (r) => sparkline(r.spark) },
    ],
  });
}

function renderVendor(main) {
  oppTab(main, {
    intro: 'Auctions listed below what an NPC vendor pays for the item. Buy them and sell to any vendor. Risk-free, but small.',
    f: state.f.vendor,
    needsStatic: true,
    specs: [{ key: 'search', label: 'Search', cls: 'search' }],
    compute: () => vendorFlips(priceBook(state.house, 'opp')),
    columns: [C.item, C.buy, C.maxBuy, C.sell('Vendor pays'), C.profitUnit, C.qty, C.total],
  });
}

function renderDe(main) {
  const f = state.f.de;
  const ench = Math.max(0, ...activeChars().map((c) => c.professions?.enchanting?.rank || 0));
  oppTab(main, {
    intro: `Green, blue and purple gear that is worth more disenchanted than its AH price. EV = expected value of the mats after the AH cut, using the standard vanilla disenchant tables. ${ench ? `Your best enchanting skill: ${ench}.` : ''}`,
    f,
    needsStatic: true,
    extraBanner: data.disenchant ? '' : '<div class="banner">Disenchant table missing (data/static/disenchant.json).</div>',
    specs: [
      { key: 'search', label: 'Search', cls: 'search' },
      { key: 'skill', label: 'Enchanting skill', type: 'number', cls: 'w-s', placeholder: String(ench || 300) },
      { key: 'minMargin', label: 'Min margin %', type: 'number', cls: 'w-s' },
    ],
    compute: () => disenchantFlips(priceBook(state.house, 'opp'), data.disenchant, { enchantingSkill: f.skill !== '' ? +f.skill : ench || 300, minMargin: (+f.minMargin || 0) / 100 }),
    columns: [
      C.item,
      { key: 'ilvl', label: 'iLvl', num: true, html: (r) => num(r.ilvl) },
      { key: 'deSkill', label: 'Skill', num: true, html: (r) => num(r.deSkill) },
      C.buy,
      C.sell('DE value (EV)'),
      C.profitUnit,
      C.margin,
      C.maxBuy,
      C.qty,
      C.total,
    ],
    detail: (r) =>
      `<table class="data"><thead><tr><th>Material</th><th class="num">Chance</th><th class="num">Avg qty</th><th class="num">Unit (net)</th></tr></thead><tbody>${r.parts
        .map((p) => `<tr><td>${link(p.id)}</td><td class="num">${pct(p.p)}</td><td class="num">${num(p.n, 1)}</td><td class="num">${money(p.unit)}</td></tr>`)
        .join('')}</tbody></table>`,
  });
}

function renderCross(main) {
  const f = state.f.cross;
  const slugs = (data.meta?.houses || []).map((h) => h.slug);
  oppTab(main, {
    intro:
      'Price differences between auction houses. Faction ↔ Blackwater (neutral, 15% cut) works with one character. Alliance ↔ Horde needs a character on each side and a neutral-AH handoff.',
    f,
    extraBanner: slugs.length < 2 ? '<div class="banner">Needs at least two auction houses of data.</div>' : '',
    specs: [
      { key: 'search', label: 'Search', cls: 'search' },
      { key: 'minMargin', label: 'Min margin %', type: 'number', cls: 'w-s' },
      { key: 'minSold', label: 'Min sold/day (target)', type: 'number', cls: 'w-s' },
    ],
    compute: async () => {
      await Promise.all(slugs.map(loadHouse));
      const books = slugs.filter((s) => data.houses[s]).map((s) => ({ slug: s, label: HOUSE_LABEL[s] || s, pb: priceBook(s, 'opp') }));
      return crossHouse(books, { minMargin: (+f.minMargin || 0) / 100 }).filter((r) => !+f.minSold || (r.soldPerDay ?? 0) >= +f.minSold);
    },
    columns: [C.item, { key: 'note', label: 'Route', html: (r) => esc(r.note) }, C.buy, C.sell('Sell (net)'), C.profitUnit, C.margin, C.qty, C.total, C.sold, C.rate],
  });
}

function renderResale(main) {
  const f = state.f.resale;
  oppTab(main, {
    intro: 'Items sold by NPC vendors (friendly to your faction) that go for more on the AH: limited-supply recipes, reagents people are too lazy to fetch, and so on. Prices use the safest estimate (lowest of market, historical and average sale price).',
    f,
    needsStatic: true,
    extraBanner: Object.keys(data.vendor).length ? '' : '<div class="banner">Vendor item list missing (data/static/vendor.json).</div>',
    specs: [
      { key: 'search', label: 'Search', cls: 'search' },
      { key: 'minSold', label: 'Min sold/day', type: 'number', cls: 'w-s' },
      { type: 'check', key: 'onlyLimited', label: 'Limited supply only' },
    ],
    compute: () => vendorResale(priceBook(state.house, 'opp')).filter((r) => (!f.onlyLimited || r.limited) && (!+f.minSold || (r.soldPerDay ?? 0) >= +f.minSold)),
    columns: [C.item, { key: 'buyUnit', label: 'Vendor price', num: true, html: (r) => money(r.buyUnit) }, C.sell('AH (net)'), C.profitUnit, C.margin, C.sold, C.rate, { key: 'note', label: 'Supply', html: (r) => esc(r.note) }, { key: 'where', label: 'Sold by', cls: 'wrap', html: (r) => esc(r.where || '') }],
  });
}

// ---------------------------------------------------------------- item lookup
function renderLookup(main) {
  main.insertAdjacentHTML('beforeend', `<p class="intro">Search any item to see its prices in every auction house, what it is used for and how to make it.</p>${noData()}`);
  const box = document.createElement('div');
  box.className = 'filters';
  box.innerHTML = `<label class="f"><span>Item name or id</span><input type="text" class="search" id="lk" placeholder="e.g. Arcanite Bar"></label>`;
  main.appendChild(box);
  const host = document.createElement('div');
  main.appendChild(host);
  const input = box.querySelector('#lk');
  input.value = state.lookup || '';
  const run = async () => {
    state.lookup = input.value;
    save();
    const q = input.value.trim().toLowerCase();
    if (!q) {
      host.innerHTML = '';
      return;
    }
    const pool = { ...data.names, ...Object.fromEntries(Object.entries(data.items).map(([k, v]) => [k, v.n])) };
    const hits = Object.entries(pool)
      .filter(([id, n]) => id === q || String(n).toLowerCase().includes(q))
      .map(([id, n]) => [id, n, (String(n).toLowerCase() === q || id === q ? 0 : 2) - (data.houses[state.house]?.items?.[id] ? 1 : 0)])
      .sort((a, b) => a[2] - b[2] || a[1].length - b[1].length)
      .slice(0, 8);
    const slugs = (data.meta?.houses || []).map((h) => h.slug);
    await Promise.all(slugs.map(loadHouse));
    host.innerHTML = hits.map(([id]) => lookupCard(+id, slugs)).join('') || '<div class="panel muted">No item found.</div>';
    host.querySelectorAll('[data-ov]').forEach((el) =>
      el.addEventListener('change', () => {
        const v = parseMoney(el.value);
        if (v === null) delete state.overrides[el.dataset.ov];
        else state.overrides[el.dataset.ov] = v;
        save();
        invalidate();
        toast('Price override saved. It is used as the buy price everywhere.');
      }),
    );
  };
  input.addEventListener('input', debounce(run, 300));
  run();
}

function lookupCard(id, slugs) {
  const it = data.items[id];
  const rows = slugs
    .filter((s) => data.houses[s])
    .map((s) => {
      const a = priceBook(s).ah(id);
      return `<tr><td>${esc(HOUSE_LABEL[s] || s)}</td><td class="num">${money(a?.min)}</td><td class="num">${money(a?.market)}</td><td class="num">${money(a?.now)}</td><td class="num">${money(a?.hist)}</td><td class="num">${num(a?.qty)}</td><td class="num">${num(a?.soldPerDay, 1)}</td><td>${sparkline(priceBook(s).sparkData[id])}</td></tr>`;
    })
    .join('');
  const madeBy = data.recipes.filter((r) => r.out === id);
  const usedIn = data.recipes.filter((r) => r.r.some(([x]) => x === id));
  const de = it ? disenchantValue(data.disenchant, it, priceBook()) : null;
  const v = data.vendor[id];
  return `<div class="panel"><h3>${link(id)} <span class="muted small">#${id}</span></h3>
    <div class="table-wrap"><table class="data"><thead><tr><th>House</th><th class="num">Min</th><th class="num">Market</th><th class="num">Now</th><th class="num">Historical</th><th class="num">Listed</th><th class="num">Sold/day (EU)</th><th>Trend</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="kv" style="margin-top:10px">
      ${it ? `<div>Vendor sells for</div><div>${money(it.sp)}</div>` : ''}
      ${v ? `<div>Vendors sell it for</div><div>${money(v.bp ?? it?.bp)} ${v.lim ? `(limited ${v.lim})` : ''}</div>` : ''}
      ${it ? `<div>Item level / quality</div><div>${it.il} / <span class="q${it.q}">${['Poor', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'][it.q] || it.q}</span>${it.b === 1 ? ' · BoP' : it.b === 2 ? ' · BoE' : ''}</div>` : ''}
      ${de ? `<div>Disenchant EV</div><div>${money(de.ev)} (skill ${de.skill})</div>` : ''}
      ${madeBy.length ? `<div>Made by</div><div>${madeBy.map((r) => `${esc(r.n)} <span class="muted">(${PROFESSIONS[r.p]} ${r.s[0]})</span>`).join(', ')}</div>` : ''}
      ${usedIn.length ? `<div>Used in</div><div>${usedIn.length} recipes: ${usedIn.slice(0, 12).map((r) => esc(r.n)).join(', ')}${usedIn.length > 12 ? ' …' : ''}</div>` : ''}
      <div>My price override</div><div><input type="text" data-ov="${id}" placeholder="e.g. 1g 50s" value="${state.overrides[id] !== undefined ? esc(money(state.overrides[id], { html: false })) : ''}"> <span class="muted small">empty = use AH/vendor</span></div>
    </div></div>`;
}

// ---------------------------------------------------------------- characters
function renderChars(main) {
  const all = allChars();
  main.insertAdjacentHTML(
    'beforeend',
    `<p class="intro">Characters decide which recipes count as craftable, the skill-up colors and your enchanting skill for disenchanting. There are three ways to add them: (1) characters listed in <code>config.json</code> are fetched from the Blizzard API automatically (level 10+, after logging out); (2) the <b>WowAuctionHelper</b> addon (in <code>addon/</code>) exports exact known recipes; (3) enter professions by hand.</p>`,
  );
  const imp = document.createElement('div');
  imp.className = 'grid2';
  imp.innerHTML = `
    <div class="panel"><h3>Import from the addon</h3>
      <p class="muted small">In game type <code>/wah</code>, press Ctrl+C, and paste here. Or upload <code>WTF/Account/&lt;ACCOUNT&gt;/SavedVariables/WowAuctionHelper.lua</code>.</p>
      <textarea id="imp" placeholder="WAH1:{...}"></textarea>
      <div class="row-flex" style="margin-top:8px"><button class="btn primary" id="impBtn">Import</button><input type="file" id="impFile" accept=".lua,.txt,.json"></div>
    </div>
    <div class="panel"><h3>Add a character by hand</h3>
      <div class="row-flex"><input type="text" id="newName" placeholder="Name"> <select id="newFac"><option value="alliance">Alliance</option><option value="horde">Horde</option></select> <button class="btn" id="addBtn">Add</button></div>
      <p class="muted small">Then set profession skill levels on its card below. Without a known-recipe list every trainer recipe up to your skill counts as craftable.</p>
    </div>`;
  main.appendChild(imp);

  const doImport = (text) => {
    try {
      const raw = parseCharacterImport(text);
      const chars = toCharacters(raw, data.recipes);
      for (const c of chars) {
        const i = state.chars.findIndex((x) => x.id === c.id);
        if (i >= 0) state.chars[i] = c;
        else state.chars.push(c);
      }
      save();
      invalidate();
      toast(`Imported ${chars.length} character(s).`);
      render();
    } catch (e) {
      toast(`Import failed: ${esc(e.message)}`, 6000);
    }
  };
  $('#impBtn').addEventListener('click', () => doImport($('#imp').value));
  $('#impFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) doImport(await file.text());
  });
  $('#addBtn').addEventListener('click', () => {
    const name = $('#newName').value.trim();
    if (!name) return;
    state.chars.push({ id: `manual:${name}`, name, faction: $('#newFac').value, professions: {}, known: {}, source: 'manual' });
    save();
    invalidate();
    render();
  });

  const list = document.createElement('div');
  list.className = 'grid2';
  for (const c of all) {
    const active = !state.activeChars || state.activeChars.includes(c.id);
    const isLocal = state.chars.some((x) => x.id === c.id);
    const profRows = Object.keys(PROFESSIONS)
      .map((k) => {
        const p = c.professions?.[k];
        const knownN = c.known?.[k]?.length;
        return `<tr><td>${PROFESSIONS[k]}</td><td><input type="number" min="0" max="300" data-c="${esc(c.id)}" data-p="${k}" value="${p ? p.rank : ''}" ${isLocal ? '' : 'disabled'}></td><td class="muted small">${knownN ? `${knownN} known recipes` : p ? 'recipes not imported' : ''}</td></tr>`;
      })
      .join('');
    const card = document.createElement('div');
    card.className = 'charcard';
    card.innerHTML = `<h4>${esc(c.name)} <span class="muted small">${esc(c.faction || '')} ${c.level ? '· ' + c.level : ''} · ${esc(c.source || 'addon')}</span></h4>
      <label class="check"><input type="checkbox" data-active="${esc(c.id)}" ${active ? 'checked' : ''}> use for calculations</label>
      <table>${profRows}</table>
      ${isLocal ? `<button class="btn danger" data-del="${esc(c.id)}">Remove</button>` : '<span class="muted small">From the Blizzard API (edit config.json to change)</span>'}`;
    list.appendChild(card);
  }
  main.appendChild(list);
  list.querySelectorAll('[data-active]').forEach((el) =>
    el.addEventListener('change', () => {
      const ids = allChars().map((c) => c.id);
      const cur = new Set(state.activeChars || ids);
      if (el.checked) cur.add(el.dataset.active);
      else cur.delete(el.dataset.active);
      state.activeChars = cur.size === ids.length ? null : [...cur];
      save();
      invalidate();
    }),
  );
  list.querySelectorAll('input[data-p]').forEach((el) =>
    el.addEventListener('change', () => {
      const c = state.chars.find((x) => x.id === el.dataset.c);
      if (!c) return;
      c.professions = c.professions || {};
      if (el.value === '') delete c.professions[el.dataset.p];
      else c.professions[el.dataset.p] = { rank: +el.value, max: 300 };
      save();
      invalidate();
    }),
  );
  list.querySelectorAll('[data-del]').forEach((el) =>
    el.addEventListener('click', () => {
      state.chars = state.chars.filter((c) => c.id !== el.dataset.del);
      save();
      invalidate();
      render();
    }),
  );
  if (!all.length) main.insertAdjacentHTML('beforeend', '<div class="panel muted">No characters yet: all recipes are shown.</div>');
}

// ---------------------------------------------------------------- settings
function renderSettings(main) {
  const s = state.settings;
  const opts = (sel) => Object.entries(PRICE_SOURCES).map(([k, l]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${esc(l)}</option>`).join('');
  main.innerHTML = `
  <div class="panel"><h3>Prices</h3><div class="filters" style="border:0;padding:0;background:none">
    <label class="f"><span>Buy reagents at</span><select data-s="buySource">${opts(s.buySource)}</select></label>
    <label class="f"><span>Sell crafted items at</span><select data-s="sellSource">${opts(s.sellSource)}</select></label>
    <label class="f"><span>Sell price for flips / resale</span><select data-s="oppSellSource">${opts(s.oppSellSource)}</select></label>
    <label class="f"><span>AH cut, faction houses %</span><input type="number" step="0.5" data-s="cutFaction" data-pct value="${s.cutFaction * 100}"></label>
    <label class="f"><span>AH cut, Blackwater %</span><input type="number" step="0.5" data-s="cutNeutral" data-pct value="${s.cutNeutral * 100}"></label>
    <label class="f"><span>Intermediate crafts</span><select data-s="intermediates">
      <option value="craftable" ${s.intermediates === 'craftable' ? 'selected' : ''}>Craft if cheaper (my characters)</option>
      <option value="all" ${s.intermediates === 'all' ? 'selected' : ''}>Craft if cheaper (any recipe)</option>
      <option value="off" ${s.intermediates === 'off' ? 'selected' : ''}>Always buy</option></select></label>
    <label class="check"><input type="checkbox" data-s="useVendor" ${s.useVendor ? 'checked' : ''}> Buy vendor reagents from vendors</label>
  </div></div>
  <div class="panel"><h3>Links</h3><label class="f"><span>Wowhead database</span><select data-s="wowhead">
    ${['classic', 'forever'].map((v) => `<option ${s.wowhead === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
  <div class="panel"><h3>Price overrides</h3>${
    Object.keys(state.overrides).length
      ? `<table class="data">${Object.entries(state.overrides).map(([id, v]) => `<tr><td>${link(+id)}</td><td class="num">${money(v)}</td><td><button class="btn" data-rm="${id}">remove</button></td></tr>`).join('')}</table>`
      : '<p class="muted">None. Set them in Item lookup (e.g. for mats you farm yourself, use 0).</p>'
  }</div>
  <div class="panel"><h3>Data</h3><div class="kv">
    <div>Recipe database</div><div>${data.recipes.length} recipes, ${Object.keys(data.items).length} items ${data.staticMeta ? `(${esc(data.staticMeta.source || '')} ${esc(data.staticMeta.build || '')})` : ''}</div>
    <div>Price data</div><div>${data.meta ? new Date(data.meta.updated * 1000).toLocaleString() : 'none'}</div>
    ${(data.meta?.errors || []).length ? `<div>Last fetch errors</div><div class="negv">${data.meta.errors.map(esc).join('<br>')}</div>` : ''}
  </div><p><button class="btn danger" id="reset">Reset all local settings</button></p></div>`;
  main.querySelectorAll('[data-s]').forEach((el) =>
    el.addEventListener('change', () => {
      const k = el.dataset.s;
      s[k] = el.type === 'checkbox' ? el.checked : el.dataset.pct !== undefined ? +el.value / 100 : el.value;
      if (k === 'wowhead') setWowheadFlavor(s.wowhead);
      save();
      invalidate();
    }),
  );
  main.querySelectorAll('[data-rm]').forEach((el) =>
    el.addEventListener('click', () => {
      delete state.overrides[el.dataset.rm];
      save();
      invalidate();
      render();
    }),
  );
  $('#reset').addEventListener('click', () => {
    if (!confirm('Reset settings, filters, imported characters and overrides?')) return;
    localStorage.removeItem(STORE_KEY);
    location.reload();
  });
}

init().catch((e) => {
  console.error(e);
  $('#main').innerHTML = `<div class="banner">Failed to start: ${esc(e.message)}</div>`;
});
