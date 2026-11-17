// Character import: turns the WowAuctionHelper addon export (paste string or
// SavedVariables file) into the app's character model:
//   { id, name, realm, faction, professions: {key: {rank, max}}, known: {key: [spellIds]} }

import { parseSavedVariables } from './lua.js';

// Localised skill names -> profession keys (EU client languages).
const NAMES = {
  alchemy: ['Alchemy', 'Alchemie', 'Alchimie', 'Alquimia', 'Алхимия', 'Alchimia'],
  blacksmithing: ['Blacksmithing', 'Schmiedekunst', 'Forge', 'Herrería', 'Кузнечное дело', 'Forgiatura', 'Ferraria'],
  enchanting: ['Enchanting', 'Verzauberkunst', 'Enchantement', 'Encantamiento', 'Наложение чар', 'Incantamento', 'Encantamento'],
  engineering: ['Engineering', 'Ingenieurskunst', 'Ingénierie', 'Ingeniería', 'Инженерное дело', 'Ingegneria', 'Engenharia'],
  leatherworking: ['Leatherworking', 'Lederverarbeitung', 'Travail du cuir', 'Peletería', 'Кожевничество', 'Conciatura', 'Couraria'],
  tailoring: ['Tailoring', 'Schneiderei', 'Couture', 'Sastrería', 'Портняжное дело', 'Sartoria', 'Alfaiataria'],
  mining: ['Mining', 'Smelting', 'Bergbau', 'Verhüttung', 'Minage', 'Fondre', 'Minería', 'Fundición', 'Горное дело', 'Выплавка металлов', 'Estrazione', 'Mineração'],
  cooking: ['Cooking', 'Kochkunst', 'Cuisine', 'Cocina', 'Кулинария', 'Cucina', 'Culinária'],
  firstaid: ['First Aid', 'Erste Hilfe', 'Secourisme', 'Primeros auxilios', 'Первая помощь', 'Primo Soccorso', 'Primeiros Socorros'],
  herbalism: ['Herbalism', 'Kräuterkunde', 'Herboristerie', 'Herboristería', 'Травничество', 'Erbalismo', 'Herborismo'],
  skinning: ['Skinning', 'Kürschnerei', 'Dépeçage', 'Desuello', 'Снятие шкур', 'Scuoiatura', 'Esfolamento'],
  fishing: ['Fishing', 'Angeln', 'Pêche', 'Pesca', 'Рыбная ловля'],
};
// Profession skill line ids (language independent) -> keys
export const SKILL_LINES = {
  171: 'alchemy', 164: 'blacksmithing', 333: 'enchanting', 202: 'engineering', 165: 'leatherworking',
  197: 'tailoring', 186: 'mining', 185: 'cooking', 129: 'firstaid', 182: 'herbalism', 393: 'skinning', 356: 'fishing',
};
const NAME_TO_KEY = new Map();
for (const [k, list] of Object.entries(NAMES)) for (const n of list) NAME_TO_KEY.set(n.toLowerCase(), k);

export function professionKeyFromName(name) {
  return NAME_TO_KEY.get(String(name || '').toLowerCase()) || null;
}

/** Accepts the "WAH1:{json}" paste string or the raw SavedVariables file text. */
export function parseCharacterImport(text) {
  const t = text.trim();
  let data;
  if (t.startsWith('WAH1:')) {
    data = JSON.parse(t.slice(5));
  } else if (t.startsWith('{')) {
    data = JSON.parse(t);
  } else {
    const vars = parseSavedVariables(t);
    data = vars.WowAuctionHelperDB;
    if (!data) throw new Error('No WowAuctionHelperDB found in this file.');
  }
  return data.chars || {};
}

/**
 * Convert raw addon records to characters, resolving recipes against the db.
 * recipes: recipe list from recipes.json
 */
export function toCharacters(rawChars, recipes) {
  const bySpell = new Map(recipes.map((r) => [r.id, r]));
  const byOut = new Map();
  const byName = new Map();
  for (const r of recipes) {
    if (r.out) {
      const list = byOut.get(r.out) || [];
      list.push(r);
      byOut.set(r.out, list);
    }
    byName.set(r.n.toLowerCase(), r);
  }

  const chars = [];
  for (const [key, c] of Object.entries(rawChars || {})) {
    const professions = {};
    const known = {};
    // skill list (all professions, even ones whose window was never opened)
    for (const [name, s] of Object.entries(c.skills || {})) {
      const k = SKILL_LINES[s.id] || professionKeyFromName(name);
      if (k) professions[k] = { rank: s.rank, max: s.max };
    }
    // trade windows: recipe lists identify the profession language-independently
    for (const [tradeName, t] of Object.entries(c.trades || {})) {
      const votes = {};
      const byProf = {};
      for (const rec of t.recipes || []) {
        let r = rec.s ? bySpell.get(rec.s) : null;
        if (!r && rec.i) {
          const cands = byOut.get(rec.i) || [];
          r = cands.length === 1 ? cands[0] : cands.find((x) => x.n === rec.n) || cands[0];
        }
        if (!r && rec.n) r = byName.get(String(rec.n).toLowerCase());
        if (r) {
          (byProf[r.p] = byProf[r.p] || []).push(r.id);
          votes[r.p] = (votes[r.p] || 0) + 1;
        }
      }
      const k = SKILL_LINES[t.id] || Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] || professionKeyFromName(tradeName);
      if (!k) continue;
      // file each recipe under its own profession (Forever moved some, e.g. healing potions -> First Aid)
      for (const [p, ids] of Object.entries(byProf)) known[p] = [...new Set([...(known[p] || []), ...ids])];
      known[k] = known[k] || [];
      professions[k] = { rank: t.rank ?? professions[k]?.rank ?? 0, max: t.max ?? professions[k]?.max ?? 0 };
    }
    chars.push({
      id: key,
      name: c.name || key.split('-')[0],
      realm: c.realm || '',
      faction: (c.faction || '').toLowerCase(),
      cls: c.class || '',
      level: c.level || null,
      updated: c.updated || null,
      professions,
      known,
    });
  }
  return chars;
}
