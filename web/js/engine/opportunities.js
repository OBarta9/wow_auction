// Non-crafting money makers. Every function returns rows shaped like
// { id, buyUnit, maxBuy, sellUnit, profitUnit, qty, qtyKnown, profitTotal, soldPerDay, note, ... }
// so the UI can render them with one table component.
// Without Blizzard listing depth the ladder is just [[minBuyout, null]] and
// quantities are unknown (qtyKnown=false, totals are per single unit).

/** Walk the cheapest-price ladder and keep levels where buying is profitable. */
export function ladderProfit(ladder, sellUnit, minProfitUnit = 1) {
  let qty = 0;
  let cost = 0;
  let maxBuy = null;
  let qtyKnown = true;
  for (const [unit, q] of ladder) {
    if (sellUnit - unit < minProfitUnit) break;
    const n = q ?? 1;
    if (q === null || q === undefined) qtyKnown = false;
    qty += n;
    cost += unit * n;
    maxBuy = unit;
  }
  return { qty, cost, profit: qty ? sellUnit * qty - cost : 0, maxBuy, qtyKnown };
}

function row(id, lad, sellUnit, r, extra = {}) {
  return {
    id: +id,
    buyUnit: lad[0][0],
    maxBuy: r.maxBuy,
    sellUnit,
    profitUnit: sellUnit - lad[0][0],
    qty: r.qtyKnown ? r.qty : null,
    qtyKnown: r.qtyKnown,
    profitTotal: r.qtyKnown ? r.profit : null,
    ...extra,
  };
}

/** Auctions listed below what a vendor pays for the item. Zero risk. */
export function vendorFlips(pb) {
  const rows = [];
  for (const id of Object.keys(pb.p)) {
    const sp = pb.item(id)?.sp || 0;
    if (!sp) continue;
    const lad = pb.ladder(id);
    if (!lad.length || lad[0][0] >= sp) continue;
    const r = ladderProfit(lad, sp);
    if (!r.qty) continue;
    rows.push(row(id, lad, sp, r, { soldPerDay: null, note: 'Buy and sell to any vendor' }));
  }
  return rows;
}

/** Listings well below the item's usual market value: buy and relist. */
export function marketFlips(pb, { minDiscount = 0.3, minSoldPerDay = 0, reference = 'market' } = {}) {
  const rows = [];
  const cut = pb.s.ahCut;
  for (const id of Object.keys(pb.p)) {
    const a = pb.ah(id);
    const ref = reference === 'hist' ? a.hist ?? a.market : reference === 'min-of' ? Math.min(...[a.market, a.hist].filter((x) => x)) : a.market;
    if (!ref || !Number.isFinite(ref)) continue;
    if (minSoldPerDay && (a.soldPerDay ?? 0) < minSoldPerDay) continue;
    const lad = pb.ladder(id);
    if (!lad.length) continue;
    const limit = ref * (1 - minDiscount);
    const eligible = lad.filter(([u]) => u <= limit);
    if (!eligible.length) continue;
    const sellNet = ref * (1 - cut);
    const r = ladderProfit(eligible, sellNet);
    if (!r.qty) continue;
    rows.push(
      row(id, lad, sellNet, r, {
        ref,
        discount: 1 - lad[0][0] / ref,
        soldPerDay: a.soldPerDay,
        saleRate: a.saleRate,
        spark: pb.sparkData[id] || null,
        note: `${Math.round((1 - lad[0][0] / ref) * 100)}% below reference`,
      }),
    );
  }
  return rows;
}

/** Buy in one auction house, sell in another (faction AH <-> Blackwater, or via a cross-faction alt). */
export function crossHouse(books, { minMargin = 0.1 } = {}) {
  // books: [{slug, label, pb}]
  const rows = [];
  for (const from of books) {
    for (const to of books) {
      if (from === to) continue;
      const cut = to.pb.s.ahCut;
      for (const id of Object.keys(from.pb.p)) {
        const target = to.pb.ahPrice(id, to.pb.s.sellSource);
        if (!target) continue;
        const sellNet = target * (1 - cut);
        const lad = from.pb.ladder(id);
        if (!lad.length) continue;
        if (sellNet < lad[0][0] * (1 + minMargin)) continue;
        const r = ladderProfit(lad, sellNet, lad[0][0] * minMargin);
        if (!r.qty) continue;
        rows.push(
          row(id, lad, sellNet, r, {
            from: from.label,
            to: to.label,
            soldPerDay: to.pb.ah(id)?.soldPerDay ?? null,
            saleRate: to.pb.ah(id)?.saleRate ?? null,
            margin: sellNet / lad[0][0] - 1,
            note: `${from.label} → ${to.label}`,
          }),
        );
      }
    }
  }
  return rows;
}

/** Items you can buy from an NPC vendor and sell on the AH (limited-supply recipes, reagents...). */
export function vendorResale(pb) {
  const rows = [];
  const cut = pb.s.ahCut;
  for (const [id, v] of Object.entries(pb.vendor)) {
    if (pb.s.faction && v.fac && !v.fac.includes(pb.s.faction)) continue;
    const bp = v.bp ?? pb.item(id)?.bp;
    if (!bp) continue;
    const price = pb.ahPrice(id, pb.s.sellSource);
    if (!price) continue;
    const net = price * (1 - cut);
    if (net <= bp) continue;
    const a = pb.ah(id);
    rows.push({
      id: +id,
      buyUnit: bp,
      sellUnit: net,
      profitUnit: net - bp,
      margin: net / bp - 1,
      qty: v.lim || null,
      qtyKnown: !!v.lim,
      profitTotal: v.lim ? (net - bp) * v.lim : null,
      soldPerDay: a?.soldPerDay ?? null,
      saleRate: a?.saleRate ?? null,
      ahQty: a?.qty ?? null,
      limited: !!v.lim,
      note: v.lim ? `Limited supply (${v.lim} per restock)` : 'Unlimited vendor item',
      where: v.where || null,
    });
  }
  return rows;
}

/** Enchanting skill needed to disenchant an item of a given level/quality. */
export function deSkillFor(table, ilvl, quality) {
  const list = (quality >= 3 && table.skillRare) || table.skill;
  for (const [maxIl, skill] of list) if (ilvl <= maxIl) return skill;
  return list[list.length - 1][1];
}

/** Expected disenchant value of one item, or null if no rule matches. */
export function disenchantValue(table, item, pb) {
  if (!table || !item || ![2, 4].includes(item.c) || item.q < 2 || item.q > 4) return null;
  const kind = item.c === 2 ? 'weapon' : 'armor';
  const rule = table.rules.find(
    (r) => r.q === item.q && (r.kind === kind || r.kind === 'any') && item.il >= r.il[0] && item.il <= r.il[1],
  );
  if (!rule) return null;
  let ev = 0;
  const parts = [];
  for (const o of rule.out) {
    const n = Array.isArray(o.n) ? (o.n[0] + o.n[1]) / 2 : o.n;
    const unit = pb.sellNet(o.id).price ?? 0;
    ev += o.p * n * unit;
    parts.push({ id: o.id, p: o.p, n, unit });
  }
  return { ev, parts, skill: deSkillFor(table, item.il, item.q) };
}

/** Green/blue/purple gear on the AH that is worth more as enchanting mats. */
export function disenchantFlips(pb, table, { enchantingSkill = 300, minMargin = 0.1 } = {}) {
  const rows = [];
  if (!table) return rows;
  for (const id of Object.keys(pb.p)) {
    const it = pb.item(id);
    if (it?.b === 1) continue; // BoP can't be bought anyway
    const de = disenchantValue(table, it, pb);
    if (!de || de.skill > enchantingSkill) continue;
    const lad = pb.ladder(id);
    if (!lad.length || de.ev < lad[0][0] * (1 + minMargin)) continue;
    const r = ladderProfit(lad, de.ev, lad[0][0] * minMargin);
    if (!r.qty) continue;
    rows.push(row(id, lad, de.ev, r, { soldPerDay: null, deSkill: de.skill, parts: de.parts, ilvl: it.il, note: `Disenchant (skill ${de.skill})` }));
  }
  return rows;
}
