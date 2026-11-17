// Crafting profitability.
//
// recipe: { id, n, p, out, q:[min,max], r:[[itemId,count],...], s:[learn,yellow,green,grey], src, ri }
//   p   profession key (alchemy, blacksmithing, ...)
//   out crafted item id (null for enchants)
//   src 'trainer' | 'item' (taught by a recipe item `ri`) | 'other'
// character: { name, professions: {key: {rank, max}}, known: {key: [spellIds]} | undefined }

export const PROFESSIONS = {
  alchemy: 'Alchemy',
  blacksmithing: 'Blacksmithing',
  enchanting: 'Enchanting',
  engineering: 'Engineering',
  leatherworking: 'Leatherworking',
  tailoring: 'Tailoring',
  mining: 'Mining (smelting)',
  cooking: 'Cooking',
  firstaid: 'First Aid',
};

const STATUS_RANK = { known: 4, trainer: 3, recipe: 2, low: 1, none: 0 };

export function skillColor(s, rank) {
  if (rank === null || rank === undefined) return null;
  const [learn, yellow, green, grey] = s;
  if (rank < learn) return 'red';
  if (rank < yellow) return 'orange';
  if (rank < green) return 'yellow';
  if (rank < grey) return 'green';
  return 'grey';
}

/** Classic skill-up chance: 1 on orange, (grey-rank)/(grey-yellow) on yellow/green, 0 on grey. */
export function skillUpChance(s, rank) {
  const [learn, yellow, , grey] = s;
  if (rank < learn) return 0;
  if (rank < yellow) return 1;
  if (rank >= grey) return 0;
  if (grey <= yellow) return 0;
  return Math.max(0, Math.min(1, (grey - rank) / (grey - yellow)));
}

/** Best status of a recipe across the given characters. */
export function recipeStatus(recipe, chars) {
  let best = { status: 'none', rank: null, char: null };
  for (const c of chars || []) {
    const prof = c.professions?.[recipe.p];
    if (!prof) continue;
    const knownList = c.known?.[recipe.p];
    let st;
    if (knownList && knownList.includes(recipe.id)) st = 'known';
    else if (prof.rank < recipe.s[0]) st = 'low';
    else if (recipe.src === 'trainer') st = 'trainer';
    else st = 'recipe';
    if (STATUS_RANK[st] > STATUS_RANK[best.status] || (st === best.status && prof.rank > (best.rank ?? -1))) {
      best = { status: st, rank: prof.rank, char: c.name };
    }
  }
  return best;
}

export function avgQty(recipe) {
  const q = recipe.q;
  if (Array.isArray(q)) return (q[0] + (q[1] ?? q[0])) / 2;
  return q || 1;
}

/**
 * Cheapest unit cost for every item, allowing intermediate crafting.
 * Bellman-Ford style relaxation, so cycles (transmutes, conversions) are safe.
 */
export function computeUnitCosts(recipes, pb, { craftable = () => true, maxIter = 8 } = {}) {
  const cost = new Map();
  const get = (id) => {
    let c = cost.get(id);
    if (!c) {
      c = pb.buyCost(id);
      cost.set(id, c);
    }
    return c;
  };
  const producers = recipes.filter((r) => r.out && craftable(r));
  for (const r of recipes) for (const [id] of r.r) get(id);
  for (let i = 0; i < maxIter; i++) {
    let changed = false;
    for (const r of producers) {
      let total = 0;
      for (const [id, n] of r.r) {
        const c = get(id).price;
        if (c === null || c === undefined) {
          total = null;
          break;
        }
        total += c * n;
      }
      if (total === null) continue;
      const unit = total / avgQty(r);
      const cur = get(r.out);
      if (cur.price === null || unit < cur.price - 0.5) {
        cost.set(r.out, { price: unit, src: 'craft', via: r.id });
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { cost, get };
}

/**
 * Evaluate every recipe. Returns rows; filtering is done by the UI.
 * opts.intermediates: 'off' | 'craftable' (only recipes your characters can make) | 'all'
 */
export function computeCrafting({ recipes, pb, chars = [], opts = {} }) {
  const intermediates = opts.intermediates || 'craftable';
  const statusById = new Map(recipes.map((r) => [r.id, recipeStatus(r, chars)]));
  const hasChars = chars.length > 0;
  const craftable =
    intermediates === 'off'
      ? () => false
      : intermediates === 'all' || !hasChars
        ? () => true
        : (r) => ['known', 'trainer'].includes(statusById.get(r.id).status);
  const { get } = computeUnitCosts(recipes, pb, { craftable });

  const rows = [];
  for (const r of recipes) {
    let cost = 0;
    const missing = [];
    const reagents = r.r.map(([id, n]) => {
      const c = get(id);
      if (c.price === null || c.price === undefined) missing.push(id);
      else cost += c.price * n;
      return { id, n, unit: c.price, src: c.src, via: c.via };
    });
    const qty = avgQty(r);
    let value = null;
    let valueSrc = null;
    let soldPerDay = null;
    let saleRate = null;
    let ahQty = null;
    if (r.out) {
      const it = pb.item(r.out);
      const bop = it?.b === 1;
      const sell = pb.sellNet(r.out, { allowAh: !bop });
      if (sell.price !== null) {
        value = sell.price * qty;
        valueSrc = bop ? 'vendor (BoP)' : sell.src;
      }
      const a = pb.ah(r.out);
      soldPerDay = a?.soldPerDay ?? null;
      saleRate = a?.saleRate ?? null;
      ahQty = a?.qty ?? null;
    }
    const complete = missing.length === 0;
    const profit = complete && value !== null ? value - cost : null;
    const st = statusById.get(r.id);
    const rank = st.rank;
    const color = skillColor(r.s, rank);
    const chance = rank !== null ? skillUpChance(r.s, rank) : null;
    const netCost = complete ? cost - (value ?? 0) : null;
    const costPerSkillup = chance && netCost !== null ? netCost / chance : null;
    const recipeItemPrice = r.ri ? pb.ahPrice(r.ri, 'min') ?? pb.vendorBuy(r.ri) : null;
    rows.push({
      recipe: r,
      reagents,
      cost: complete ? cost : null,
      partialCost: cost,
      missing,
      value,
      valueSrc,
      profit,
      margin: profit !== null && cost > 0 ? profit / cost : null,
      soldPerDay,
      saleRate,
      // profit weighted by the chance a listing sells (TSM sale rate); a liquidity-aware ranking
      expProfit: profit !== null && saleRate !== null ? profit * saleRate : null,
      ahQty,
      status: st.status,
      rank,
      char: st.char,
      color,
      skillUpChance: chance,
      costPerSkillup,
      recipeItemPrice,
    });
  }
  return rows;
}
