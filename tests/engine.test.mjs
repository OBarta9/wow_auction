// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { PriceBook } from '../web/js/engine/prices.js';
import { computeCrafting, skillColor, skillUpChance, recipeStatus } from '../web/js/engine/crafting.js';
import { vendorFlips, marketFlips, crossHouse, disenchantFlips, ladderProfit } from '../web/js/engine/opportunities.js';
import { formatMoney, parseMoney } from '../web/js/engine/money.js';
import { parseSavedVariables } from '../web/js/lua.js';
import { parseCharacterImport, toCharacters } from '../web/js/character.js';

// house row: [min, market, now, hist, qty, auctions, soldPerDay, saleRate, avgSale]
const items = {
  1: { n: 'Ore', q: 1, il: 40, sp: 50, b: 0, c: 7 },
  2: { n: 'Bar', q: 1, il: 40, sp: 100, b: 0, c: 7 },
  3: { n: 'Sword', q: 2, il: 45, sp: 2000, b: 2, c: 2 },
  4: { n: 'Vial', q: 1, il: 1, sp: 1, bp: 20, b: 0, c: 7 },
  5: { n: 'Potion', q: 1, il: 40, sp: 10, b: 0, c: 0 },
  6: { n: 'Dust', q: 1, il: 40, sp: 0, b: 0, c: 7 },
  7: { n: 'Soulbound Helm', q: 2, il: 45, sp: 500, b: 1, c: 4 },
};
const house = {
  items: {
    1: [90, 100, 95, 110, 500, 20, 300, 0.8, 100],
    2: [300, 400, 380, 420, 50, 5, 40, 0.5, 400],
    3: [1000, 9000, 8000, 9500, 3, 3, 2, 0.2, 9000],
    5: [600, 800, 750, 700, 100, 10, 50, 0.7, 790],
    6: [500, 600, 600, 650, 200, 10, 100, 0.8, 600],
  },
  ladder: { 3: [[1000, 1], [1500, 1], [9000, 1]] },
};
const vendor = { 4: { bp: 20 } };
const recipes = [
  { id: 100, n: 'Smelt Bar', p: 'mining', out: 2, q: [1, 1], r: [[1, 2]], s: [50, 75, 100, 125], src: 'trainer' },
  { id: 101, n: 'Make Sword', p: 'blacksmithing', out: 3, q: [1, 1], r: [[2, 10]], s: [100, 120, 140, 160], src: 'item', ri: 999 },
  { id: 102, n: 'Make Potion', p: 'alchemy', out: 5, q: [1, 1], r: [[4, 1], [1, 3]], s: [1, 10, 20, 30], src: 'trainer' },
  { id: 103, n: 'Enchant Thing', p: 'enchanting', out: null, q: [1, 1], r: [[6, 2]], s: [100, 110, 120, 130], src: 'trainer' },
  { id: 104, n: 'Mystery', p: 'alchemy', out: 5, q: [1, 1], r: [[12345, 1]], s: [1, 10, 20, 30], src: 'trainer' },
];

const pb = (settings = {}) => new PriceBook({ house, items, vendor, settings });

test('money format/parse', () => {
  assert.equal(formatMoney(12345, { html: false }), '1g 23s 45c');
  assert.equal(formatMoney(-500, { html: false }), '−5s');
  assert.equal(parseMoney('1g 50s'), 15000);
  assert.equal(parseMoney('2.5g'), 25000);
  assert.equal(parseMoney('120'), 120);
  assert.equal(parseMoney('abc'), null);
});

test('price book sources, vendor and cut', () => {
  const b = pb();
  assert.equal(b.ahPrice(1, 'min'), 90);
  assert.equal(b.ahPrice(1, 'market'), 100);
  assert.equal(b.ahPrice(1, 'hist'), 110);
  assert.equal(b.ahPrice(1, 'conservative'), 95);
  assert.deepEqual(b.buyCost(4), { price: 20, src: 'vendor' });
  assert.equal(b.sellNet(5).price, 800 * 0.95);
  // vendor beats AH when AH net is lower than vendor sell price
  assert.equal(new PriceBook({ house: { items: { 2: [10, 10, 10, 10] } }, items }).sellNet(2).src, 'vendor');
  assert.deepEqual(new PriceBook({ house, items, settings: { overrides: { 1: 0 } } }).buyCost(1), { price: 0, src: 'override' });
});

test('crafting profit with intermediate crafting', () => {
  const rows = computeCrafting({ recipes, pb: pb(), opts: { intermediates: 'all' } });
  const sword = rows.find((r) => r.recipe.id === 101);
  // bar: buy 400 vs smelt 2 ore * 100 = 200 -> craft
  assert.equal(sword.reagents[0].src, 'craft');
  assert.equal(sword.cost, 2000);
  assert.equal(sword.value, 9000 * 0.95);
  assert.equal(sword.profit, 9000 * 0.95 - 2000);
  const sword2 = computeCrafting({ recipes, pb: pb(), opts: { intermediates: 'off' } }).find((r) => r.recipe.id === 101);
  assert.equal(sword2.cost, 4000);
  const potion = rows.find((r) => r.recipe.id === 102);
  assert.equal(potion.cost, 20 + 300);
  const ench = rows.find((r) => r.recipe.id === 103);
  assert.equal(ench.value, null);
  assert.equal(ench.cost, 1200);
  const mystery = rows.find((r) => r.recipe.id === 104);
  assert.equal(mystery.cost, null);
  assert.deepEqual(mystery.missing, [12345]);
});

test('skill colors, chances and status', () => {
  const s = [100, 120, 140, 160];
  assert.equal(skillColor(s, 90), 'red');
  assert.equal(skillColor(s, 110), 'orange');
  assert.equal(skillColor(s, 130), 'yellow');
  assert.equal(skillColor(s, 150), 'green');
  assert.equal(skillColor(s, 160), 'grey');
  assert.equal(skillUpChance(s, 110), 1);
  assert.equal(skillUpChance(s, 140), 0.5);
  assert.equal(skillUpChance(s, 170), 0);
  const chars = [
    { name: 'A', professions: { blacksmithing: { rank: 150 } }, known: { blacksmithing: [101] } },
    { name: 'B', professions: { alchemy: { rank: 5 } } },
  ];
  assert.equal(recipeStatus(recipes[1], chars).status, 'known');
  assert.equal(recipeStatus(recipes[2], chars).status, 'trainer');
  assert.equal(recipeStatus(recipes[0], chars).status, 'none');
  assert.equal(recipeStatus({ ...recipes[2], s: [50, 60, 70, 80] }, chars).status, 'low');
});

test('opportunities', () => {
  const b = pb();
  const vf = vendorFlips(b);
  assert.equal(vf.length, 1); // sword min 1000 < vendor 2000
  assert.equal(vf[0].qty, 2);
  assert.equal(vf[0].profitTotal, 2000 - 1000 + 2000 - 1500);
  const mf = marketFlips(b, { minDiscount: 0.3 });
  const s = mf.find((r) => r.id === 3);
  assert.ok(s && s.qty === 2);
  assert.equal(ladderProfit([[10, null]], 20).qtyKnown, false);
  const other = new PriceBook({ house: { items: { 1: [200, 300, 300, 300, 1, 1, 5, 0.5, 300] } }, items, settings: { ahCut: 0.15 } });
  const cx = crossHouse([{ label: 'A', pb: b }, { label: 'N', pb: other }], { minMargin: 0.1 });
  assert.ok(cx.some((r) => r.id === 1 && r.from === 'A' && r.to === 'N'));
  const table = { skill: [[60, 200], [99, 300]], rules: [{ q: 2, kind: 'weapon', il: [41, 45], out: [{ id: 6, p: 1, n: [20, 20] }] }] };
  const de = disenchantFlips(b, table, { enchantingSkill: 300, minMargin: 0.1 });
  assert.equal(de.length, 1);
  assert.equal(Math.round(de[0].sellUnit), Math.round(20 * 600 * 0.95));
  assert.equal(disenchantFlips(b, table, { enchantingSkill: 100 }).length, 0);
});

test('SavedVariables parser', () => {
  const sv = `
WowAuctionHelperDB = {
	["chars"] = {
		["Ondra-Normal"] = {
			["name"] = "Ondra",
			["faction"] = "Alliance",
			["skills"] = {
				["Alchemy"] = { ["rank"] = 250, ["max"] = 300, ["id"] = 171 },
			},
			["trades"] = {
				["Alchimie"] = {
					["rank"] = 251, ["max"] = 300,
					["recipes"] = {
						{ ["s"] = 102, ["n"] = "Make Potion", ["i"] = 5 }, -- [1]
						{ ["n"] = "Smelt Bar" }, -- [2]
					},
				},
			},
		},
	},
	["version"] = 1,
	["esc"] = "a\\"b\\\\c\\n",
	["neg"] = -1.5e2,
}
Other = nil
`;
  const v = parseSavedVariables(sv);
  assert.equal(v.WowAuctionHelperDB.version, 1);
  assert.equal(v.WowAuctionHelperDB.esc, 'a"b\\c\n');
  assert.equal(v.WowAuctionHelperDB.neg, -150);
  assert.equal(v.Other, null);
  const chars = toCharacters(parseCharacterImport(sv), recipes);
  assert.equal(chars.length, 1);
  assert.equal(chars[0].professions.alchemy.rank, 251);
  // Smelt Bar resolves by name to mining; votes are split -> alchemy wins only if majority; here 1:1
  assert.ok(chars[0].known.alchemy?.includes(102) || chars[0].known.mining?.includes(102));
  const paste = 'WAH1:' + JSON.stringify({ chars: { 'X-Y': { name: 'X', trades: { Forge: { id: 164, rank: 150, max: 225, recipes: [{ s: 101 }] } } } } });
  const c2 = toCharacters(parseCharacterImport(paste), recipes);
  assert.deepEqual(c2[0].known.blacksmithing, [101]);
  assert.equal(c2[0].professions.blacksmithing.rank, 150);
});
