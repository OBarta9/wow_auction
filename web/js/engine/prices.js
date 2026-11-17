// PriceBook: one place that answers "what does this item cost to buy" and
// "what do I get for selling it", for one auction house.
//
// house:  house-<slug>.json from the pipeline:
//         { fields:[...], items:{id:[min, market, now, hist, qty, auctions, soldPerDay, saleRate, avgSale]},
//           ladder:{id:[[unit, qty],...]}, spark:{id:[...]}, sources:{...} }
// items:  static item db { id: {n, q, il, rl, sp, bp, st, c, sc, b} }
// vendor: { id: {bp, lim} } items purchasable from NPC vendors

export const PRICE_SOURCES = {
  market: 'Market value (TSM 14-day)',
  now: 'Current market (latest scan)',
  min: 'Lowest buyout',
  hist: 'Historical (TSM 60-day)',
  conservative: 'Lowest of market / now / historical / avg sale price (safest)',
};

const IDX = { min: 0, market: 1, now: 2, hist: 3, qty: 4, auctions: 5, soldPerDay: 6, saleRate: 7, avgSale: 8 };

export class PriceBook {
  constructor({ house = null, items = {}, vendor = {}, names = {}, settings = {} } = {}) {
    this.p = house?.items || {};
    this.ladderData = house?.ladder || {};
    this.sparkData = house?.spark || {};
    this.hasDepth = Object.keys(this.ladderData).length > 0;
    this.items = items;
    this.names = names;
    this.vendor = vendor;
    this.s = {
      buySource: 'market',
      sellSource: 'market',
      ahCut: 0.05,
      useVendor: true,
      overrides: {},
      ...settings,
    };
  }

  item(id) {
    return this.items[id] || null;
  }

  name(id) {
    return this.items[id]?.n || this.names[id] || `Item ${id}`;
  }

  /** Current AH stats or null. */
  ah(id) {
    const r = this.p[id];
    if (!r) return null;
    const o = {};
    for (const [k, i] of Object.entries(IDX)) o[k] = r[i] ?? null;
    return o;
  }

  hist(id) {
    const a = this.ah(id);
    if (!a) return null;
    return { market: a.hist, soldPerDay: a.soldPerDay, saleRate: a.saleRate, avgSale: a.avgSale, spark: this.sparkData[id] || [] };
  }

  /** Cheapest listings [[unit, qty|null], ...]; without listing depth: [[min, null]]. */
  ladder(id) {
    const l = this.ladderData[id];
    if (l && l.length) return l;
    const a = this.p[id];
    return a && a[IDX.min] ? [[a[IDX.min], null]] : [];
  }

  /** AH unit price by source, with sensible fallbacks. */
  ahPrice(id, source) {
    const r = this.p[id];
    if (!r) return null;
    const v = (k) => r[IDX[k]] ?? null;
    switch (source) {
      case 'min':
        return v('min');
      case 'now':
        return v('now') ?? v('market');
      case 'hist':
        return v('hist') ?? v('market');
      case 'conservative': {
        const vals = [v('market'), v('now'), v('hist'), v('avgSale')].filter((x) => x !== null && x > 0);
        return vals.length ? Math.min(...vals) : v('min');
      }
      case 'market':
      default:
        return v('market') ?? v('now') ?? v('min');
    }
  }

  /** Vendor price, if a vendor friendly to your faction sells it (settings.faction 'A' | 'H' | null). */
  vendorBuy(id) {
    if (!this.s.useVendor) return null;
    const v = this.vendor[id];
    if (!v) return null;
    if (this.s.faction && v.fac && !v.fac.includes(this.s.faction)) return null;
    return v.bp ?? this.items[id]?.bp ?? null;
  }

  /** Cheapest way to acquire one unit: {price, src: 'override'|'vendor'|'ah'} or {price:null}. */
  buyCost(id) {
    const ov = this.s.overrides[id];
    if (ov !== undefined && ov !== null) return { price: ov, src: 'override' };
    const v = this.vendorBuy(id);
    const a = this.ahPrice(id, this.s.buySource);
    if (v !== null && (a === null || v <= a)) return { price: v, src: 'vendor' };
    if (a !== null) return { price: a, src: 'ah' };
    return { price: null, src: null };
  }

  /** Net proceeds for selling one unit: max(AH after cut, vendor). */
  sellNet(id, { allowAh = true } = {}) {
    const it = this.items[id];
    const vendorSell = it?.sp || 0;
    const gross = allowAh ? this.ahPrice(id, this.s.sellSource) : null;
    const ahNet = gross !== null ? gross * (1 - this.s.ahCut) : null;
    if (ahNet !== null && ahNet >= vendorSell) return { price: ahNet, gross, src: 'ah' };
    if (vendorSell > 0) return { price: vendorSell, gross: vendorSell, src: 'vendor' };
    return { price: ahNet, gross, src: ahNet !== null ? 'ah' : null };
  }
}
