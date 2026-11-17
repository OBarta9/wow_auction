"""Build the static game database used by the web app (web/data/static/).

Sources (all free, no keys):
  * wago.tools DB2 CSV exports of the WoW Forever client (product "wowf"):
    recipes, reagents, skill-up levels, recipe items, item metadata.
  * QuestieDB (Forever data + corrections, GPLv3): which items NPC vendors sell, vendor names.
  * cmangos classic-db: limited-supply vendor stock, trainer skill requirements.
  * TSM public item list: used only to drop recipes for items that do not exist in Forever.
The optional sources are best-effort: if one fails the build continues without it.

Outputs:
  items.json       {id: {n, q, il, rl, sp, bp, vs, st, c, sc, b, nd}}
  recipes.json     [{id, n, p, cat, out, q:[min,max], r:[[item, count]], s:[learn,yellow,green,grey], sk, src, ri, ench}]
  vendor.json      {id: {bp, lim, npcs:[ids], where}}
  disenchant.json  disenchant tables (see DISENCHANT below)
  meta.json        provenance
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import re
import statistics
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

from .config import ROOT, STATIC_DIR
from .luadata import parse_value

WAGO = "https://wago.tools"
PRODUCT = "wowf"  # WoW Forever on wago.tools
ERA_PRODUCT = "wow_classic_era"  # only used to map trainer "teach" spells
TABLES = [
    "SkillLineAbility", "SpellName", "SpellEffect", "SpellReagents", "ItemSparse", "Item",
    "ItemEffect", "ItemXItemEffect", "TradeSkillCategory", "AreaTable",
]
QUESTIE = "https://raw.githubusercontent.com/Questie/QuestieDB/master"
QUESTIE_FILES = {
    "items": f"{QUESTIE}/data/Forever/foreverItemDB.lua",
    "item_fixes": f"{QUESTIE}/src/corrections/Forever/generated/foreverBaseItem.lua",
    "npcs": f"{QUESTIE}/data/Forever/foreverNpcDB.lua",
    "npc_fixes": f"{QUESTIE}/src/corrections/Forever/generated/foreverBaseNpc.lua",
}
CMANGOS = "https://raw.githubusercontent.com/cmangos/classic-db/master/Full_DB/ClassicDB_1_12_1_z2815.sql.gz"
TSM_REGION = "https://public-data.tradeskillmaster.com/forever/eu/region/items.csv"

PROFESSIONS = {
    171: "alchemy", 164: "blacksmithing", 333: "enchanting", 202: "engineering", 165: "leatherworking",
    197: "tailoring", 185: "cooking", 129: "firstaid", 186: "mining",
}
ITEM_FLAG_NO_DISENCHANT = 0x8000
USER_AGENT = "wow-auction-helper/1.0 (personal use)"
CACHE = ROOT / ".cache"


# ----------------------------------------------------------------------------- io
def http_get(url: str, timeout: int = 180) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {last}")


def cached(url: str, path: Path, use_cache: bool) -> Path:
    if use_cache and path.exists() and path.stat().st_size > 0:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading {url}")
    data = http_get(url)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    return path


def read_csv(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def i(v, default=0) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def f(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def latest_build(product: str = PRODUCT) -> str:
    data = json.loads(http_get(f"{WAGO}/api/builds"))
    builds = data.get(product) or []
    if not builds:
        raise SystemExit(f"wago.tools has no builds for product '{product}'")
    builds.sort(key=lambda b: b.get("created_at", ""), reverse=True)
    return builds[0]["version"]


# ----------------------------------------------------------------------------- DB2
def load_db2(build: str, use_cache: bool) -> dict[str, list[dict]]:
    out = {}
    for t in TABLES:
        p = cached(f"{WAGO}/db2/{t}/csv?build={build}", CACHE / "db2" / build / f"{t}.csv", use_cache)
        out[t] = read_csv(p)
        print(f"  {t}: {len(out[t])} rows")
    return out


def build_items(db: dict) -> dict:
    cls = {r["ID"]: (i(r["ClassID"]), i(r["SubclassID"])) for r in db["Item"]}
    items = {}
    for r in db["ItemSparse"]:
        name = r.get("Display_lang")
        if not name:
            continue
        c, sc = cls.get(r["ID"], (None, None))
        it = {
            "n": name,
            "q": i(r.get("OverallQualityID")),
            "il": i(r.get("ItemLevel")),
            "rl": i(r.get("RequiredLevel")),
            "sp": i(r.get("SellPrice")),
            "bp": i(r.get("BuyPrice")),
            "vs": max(1, i(r.get("VendorStackCount"), 1)),
            "st": i(r.get("Stackable"), 1),
            "c": c,
            "sc": sc,
            "b": i(r.get("Bonding")),
        }
        if i(r.get("Flags_0")) & ITEM_FLAG_NO_DISENCHANT:
            it["nd"] = 1
        if r.get("RequiredSkill") and i(r.get("RequiredSkillRank")):
            it["rs"] = i(r.get("RequiredSkillRank"))
        items[r["ID"]] = it
    return items


def build_recipes(db: dict, items: dict, trainer_req: dict, tsm_ids: set | None) -> tuple[list, dict]:
    names = {r["ID"]: r["Name_lang"] for r in db["SpellName"]}
    effects = defaultdict(list)
    for r in db["SpellEffect"]:
        effects[r["SpellID"]].append(r)
    reagents = {r["SpellID"]: r for r in db["SpellReagents"]}
    cats = {r["ID"]: r for r in db["TradeSkillCategory"]}
    cls = {r["ID"]: i(r["ClassID"]) for r in db["Item"]}

    # recipe items: item (class 9) -> on-use spell (TriggerType 6) -> taught spell
    item_effects = {r["ID"]: r for r in db["ItemEffect"]}
    item_spells = defaultdict(list)
    if db.get("ItemXItemEffect"):
        for r in db["ItemXItemEffect"]:
            e = item_effects.get(r["ItemEffectID"])
            if e:
                item_spells[r["ItemID"]].append(e)
    else:  # older (Era) schema
        for e in item_effects.values():
            item_spells[e.get("ParentItemID")].append(e)
    taught_by = defaultdict(set)
    for iid, effs in item_spells.items():
        if cls.get(iid) != 9:
            continue
        for e in effs:
            if e.get("TriggerType") != "6":
                continue
            sp = e["SpellID"]
            taught_by[sp].add(iid)
            for se in effects.get(sp, []):
                if se["Effect"] == "36":  # learn spell
                    taught_by[se["EffectTriggerSpell"]].add(iid)

    def qty(e) -> list[int]:
        if "EffectDieSides" in e and e.get("EffectDieSides") not in (None, ""):
            b, d = i(e["EffectBasePoints"]), i(e["EffectDieSides"])
            return [b + 1, b + max(d, 1)]
        b, v = f(e.get("EffectBasePointsF")), f(e.get("Variance"))
        lo, hi = round(b * (1 - v / 2)), round(b * (1 + v / 2))
        return [max(1, lo), max(1, hi)]

    known = lambda iid: iid in items or (tsm_ids is not None and iid in tsm_ids)  # noqa: E731
    recipes, stats = [], defaultdict(int)
    approx_offsets = []
    pending_approx = []
    for r in db["SkillLineAbility"]:
        prof = PROFESSIONS.get(i(r["SkillLine"]))
        if not prof:
            continue
        sp = r["Spell"]
        name = names.get(sp)
        if not name or r.get("AcquireMethod") == "3":
            stats["skipped_retired_or_unnamed"] += 1
            continue
        effs = effects.get(sp, [])
        create = next((e for e in effs if e["Effect"] == "24"), None)
        enchant = next((e for e in effs if e["Effect"] == "53"), None)
        if not create and not enchant:
            stats["skipped_no_effect"] += 1
            continue
        out = i(create["EffectItemType"]) if create else None
        rr = reagents.get(sp)
        regs = []
        if rr:
            for k in range(8):
                rid = i(rr.get(f"Reagent_{k}"))
                if rid:
                    regs.append([rid, max(1, i(rr.get(f"ReagentCount_{k}"), 1))])
        if out and not known(str(out)):
            stats["skipped_unknown_output"] += 1
            continue
        if any(not known(str(x)) for x, _ in regs):
            stats["skipped_unknown_reagent"] += 1
            continue
        yellow = i(r["TrivialSkillLineRankLow"])
        grey = i(r["TrivialSkillLineRankHigh"])
        green = (yellow + grey) // 2
        teach = sorted(taught_by.get(sp, ()), key=lambda x: (items.get(x, {}).get("b") == 1, i(x)))
        learn, sk = None, "exact"
        if teach:
            ranks = [items[t]["rs"] for t in teach if t in items and items[t].get("rs")]
            learn = min(ranks) if ranks else None
            src = "item"
        else:
            src = "trainer"
            if sp in trainer_req:
                learn = trainer_req[sp]
            elif r.get("AcquireMethod") == "1":
                learn = 1
        cat = cats.get(r.get("TradeSkillCategoryID") or "")
        rec = {
            "id": i(sp),
            "n": name,
            "p": prof,
            "cat": cat["Name_lang"] if cat else None,
            "out": out,
            "q": qty(create) if create else [1, 1],
            "r": regs,
            "s": [learn, yellow, green, grey],
            "sk": sk,
            "src": src,
        }
        if teach:
            rec["ri"] = i(teach[0])
            if len(teach) > 1:
                rec["ris"] = [i(t) for t in teach]
        if enchant:
            rec["ench"] = i(enchant.get("EffectMiscValue_0"))
        if learn is not None and yellow:
            approx_offsets.append(yellow - learn)
        else:
            pending_approx.append(rec)
        recipes.append(rec)
        stats[f"recipes_{src}"] += 1

    # Recipes without a known learn level: estimate from the typical yellow-learn gap.
    gap = int(statistics.median([g for g in approx_offsets if 0 <= g <= 60]) if approx_offsets else 25)
    for rec in pending_approx:
        rec["s"][0] = max(1, rec["s"][1] - gap)
        rec["sk"] = "approx"
    for rec in recipes:  # keep thresholds ordered
        s = rec["s"]
        s[1] = max(s[1], s[0])
        s[2] = max(s[2], s[1])
        s[3] = max(s[3], s[2])
    stats["learn_level_estimated"] = len(pending_approx)
    stats["estimate_gap"] = gap
    recipes.sort(key=lambda x: (x["p"], x["s"][0], x["n"]))
    return recipes, dict(stats)


# ----------------------------------------------------------------------------- optional sources
def questie_vendors(use_cache: bool) -> tuple[dict, dict]:
    """-> ({item id: [npc ids]}, {npc id: {name, zone, fac}})"""
    paths = {k: CACHE / "questie" / Path(u).name for k, u in QUESTIE_FILES.items()}
    for k, u in QUESTIE_FILES.items():
        try:
            cached(u, paths[k], use_cache)
        except RuntimeError as e:
            if k in ("items",):
                raise
            print(f"  (optional) {e}")
    vendors: dict[int, list] = {}
    line_re = re.compile(r"^\[(\d+)\] = (\{.*\}),\s*$")
    for line in paths["items"].read_text(encoding="utf-8").splitlines():
        m = line_re.match(line)
        if not m or "{" not in m.group(2)[1:]:
            continue
        try:
            row = parse_value(m.group(2))
        except (ValueError, IndexError):
            continue
        v = row.get(14)
        if isinstance(v, dict) and v:
            vendors[int(m.group(1))] = [int(x) for x in v.values() if isinstance(x, (int, float))]
    # Forever corrections: vendors (replace) / vendors_add (append)
    if paths["item_fixes"].exists():
        cur = None
        for line in paths["item_fixes"].read_text(encoding="utf-8").splitlines():
            m = re.match(r"\s*\[(\d+)\] = \{", line)
            if m:
                cur = int(m.group(1))
                continue
            m = re.match(r"\s*\[itemKeys\.(vendors|vendors_add)\] = (\{[^}]*\}|nil)", line)
            if m and cur:
                ids = [int(x) for x in re.findall(r"\d+", m.group(2))]
                if m.group(1) == "vendors":
                    if ids:
                        vendors[cur] = ids
                    else:
                        vendors.pop(cur, None)
                elif ids:
                    vendors[cur] = sorted(set(vendors.get(cur, [])) | set(ids))
    # NPCs: name (1), zoneID (9), friendlyToFaction (13: "A", "H", "AH")
    npcs: dict[int, dict] = {}
    npc_re = re.compile(r"^\[(\d+)\] = (\{.*\}),\s*$")
    if paths["npcs"].exists():
        for line in paths["npcs"].read_text(encoding="utf-8").splitlines():
            m = npc_re.match(line)
            if not m:
                continue
            try:
                row = parse_value(m.group(2))
            except (ValueError, IndexError):
                continue
            npcs[int(m.group(1))] = {"name": row.get(1), "zone": row.get(9), "fac": row.get(13)}
    if paths["npc_fixes"].exists():
        cur = None
        for line in paths["npc_fixes"].read_text(encoding="utf-8").splitlines():
            m = re.match(r"\s*\[(\d+)\] = \{", line)
            if m:
                cur = int(m.group(1))
                npcs.setdefault(cur, {"name": None, "zone": None, "fac": None})
                continue
            m = re.match(r"\s*\[npcKeys\.(name|zoneID|friendlyToFaction)\] = (\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|-?\d+|nil)", line)
            if m and cur:
                raw = m.group(2)
                val = None if raw == "nil" else (int(raw) if raw.lstrip("-").isdigit() else re.sub(r"\\(.)", r"\1", raw[1:-1]))
                key = {"name": "name", "zoneID": "zone", "friendlyToFaction": "fac"}[m.group(1)]
                npcs[cur][key] = val
    return vendors, npcs


def _sql_values(s: str) -> list[str]:
    out, buf, q, k = [], [], False, 0
    while k < len(s):
        c = s[k]
        if q:
            if c == "\\" and k + 1 < len(s):
                buf.append(s[k + 1])
                k += 2
                continue
            if c == "'":
                q = False
            else:
                buf.append(c)
        elif c == "'":
            q = True
        elif c == ",":
            out.append("".join(buf))
            buf = []
        else:
            buf.append(c)
        k += 1
    out.append("".join(buf))
    return out


def cmangos_data(use_cache: bool) -> dict:
    """-> {"limited": {item: maxcount}, "trainer": {spell: reqskillvalue}} from cmangos classic-db."""
    parsed = CACHE / "cmangos" / "parsed.json"
    if use_cache and parsed.exists():
        return json.loads(parsed.read_text())
    gz = cached(CMANGOS, CACHE / "cmangos" / "classicdb.sql.gz", use_cache)
    want = {"npc_vendor", "npc_vendor_template", "npc_trainer", "npc_trainer_template"}
    cols: dict[str, list] = defaultdict(list)
    rows: dict[str, list] = defaultdict(list)
    cur = None
    tup = re.compile(r"\(((?:[^()']|'(?:\\.|[^'\\])*')*)\)")
    with gzip.open(gz, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = re.match(r"CREATE TABLE `(\w+)`", line)
            if m:
                cur = m.group(1)
                continue
            if cur in want and line.startswith("  `"):
                cols[cur].append(line.split("`")[1])
                continue
            m = re.match(r"INSERT INTO `(\w+)`(?: \(([^)]*)\))? VALUES\s*(.*)", line, re.S)
            if m and m.group(1) in want:
                t = m.group(1)
                c = [x.strip(" `") for x in m.group(2).split(",")] if m.group(2) else cols[t]
                for tm in tup.finditer(m.group(3)):
                    rows[t].append(dict(zip(c, _sql_values(tm.group(1)))))
    limited: dict[str, int] = {}
    for r in rows["npc_vendor"] + rows["npc_vendor_template"]:
        mc = i(r.get("maxcount"))
        if mc > 0:
            limited[r["item"]] = max(limited.get(r["item"], 0), mc)
    trainer: dict[str, int] = {}
    for r in rows["npc_trainer"] + rows["npc_trainer_template"]:
        v = i(r.get("reqskillvalue"))
        if v > 0:
            trainer[r["spell"]] = v
    data = {"limited": limited, "trainer": trainer}
    parsed.parent.mkdir(parents=True, exist_ok=True)
    parsed.write_text(json.dumps(data))
    return data


def tsm_item_ids() -> set:
    text = http_get(TSM_REGION).decode("utf-8-sig")
    return {r["itemId"] for r in csv.DictReader(io.StringIO(text)) if r.get("itemId")}


# ----------------------------------------------------------------------------- disenchanting
# Vanilla disenchant tables (cmangos disenchant_loot_template; Forever's
# ItemDisenchantLoot brackets match). n = [min, max] count, p = chance.
DUST = {"strange": 10940, "soul": 11083, "vision": 11137, "dream": 11176, "illusion": 16204}
ESS = {
    "lmagic": 10938, "gmagic": 10939, "lastral": 10998, "gastral": 11082, "lmystic": 11134, "gmystic": 11135,
    "lnether": 11174, "gnether": 11175, "leternal": 16202, "geternal": 16203,
}
SHARD = {
    "sglim": 10978, "lglim": 11084, "sglow": 11138, "lglow": 11139, "srad": 11177, "lrad": 11178,
    "sbril": 14343, "lbril": 14344, "nexus": 20725,
}
UNCOMMON = [  # (ilvl range, dust, dust n, essence, essence n, shard)
    ((5, 15), "strange", [1, 2], "lmagic", [1, 2], None),
    ((16, 20), "strange", [2, 3], "gmagic", [1, 2], "sglim"),
    ((21, 25), "strange", [4, 6], "lastral", [1, 2], "sglim"),
    ((26, 30), "soul", [1, 2], "gastral", [1, 2], "lglim"),
    ((31, 35), "soul", [2, 5], "lmystic", [1, 2], "sglow"),
    ((36, 40), "vision", [1, 2], "gmystic", [1, 2], "lglow"),
    ((41, 45), "vision", [2, 5], "lnether", [1, 2], "srad"),
    ((46, 50), "dream", [1, 2], "gnether", [1, 2], "lrad"),
    ((51, 55), "dream", [2, 5], "leternal", [1, 2], "sbril"),
    ((56, 60), "illusion", [1, 2], "geternal", [1, 2], "lbril"),
    ((61, 99), "illusion", [2, 5], "geternal", [2, 2], "lbril"),
]
RARE = [((1, 25), "sglim"), ((26, 30), "lglim"), ((31, 35), "sglow"), ((36, 40), "lglow"), ((41, 45), "srad"),
        ((46, 50), "lrad"), ((51, 55), "sbril"), ((56, 65), "lbril")]
EPIC = [((40, 45), "srad", [2, 4]), ((46, 50), "lrad", [2, 4]), ((51, 55), "sbril", [2, 4]),
        ((56, 60), "nexus", [1, 1]), ((61, 99), "nexus", [1, 2])]


def disenchant_table() -> dict:
    rules = []
    for (lo, hi), dust, dn, ess, en, shard in UNCOMMON:
        for kind in ("armor", "weapon"):
            if (lo, hi) == (5, 15):
                pd, pe, ps = (0.8, 0.2, 0) if kind == "armor" else (0.2, 0.8, 0)
            elif (lo, hi) == (16, 20):
                pd, pe, ps = (0.75, 0.2, 0.05) if kind == "armor" else (0.2, 0.75, 0.05)
            elif (lo, hi) == (21, 25):
                pd, pe, ps = (0.75, 0.15, 0.10) if kind == "armor" else (0.15, 0.75, 0.10)
            elif lo >= 51 and kind == "weapon":
                pd, pe, ps = 0.22, 0.75, 0.03
            else:
                pd, pe, ps = (0.75, 0.2, 0.05) if kind == "armor" else (0.2, 0.75, 0.05)
            out = [{"id": DUST[dust], "p": pd, "n": dn}, {"id": ESS[ess], "p": pe, "n": en}]
            if shard and ps:
                out.append({"id": SHARD[shard], "p": ps, "n": [1, 1]})
            rules.append({"q": 2, "kind": kind, "il": [lo, hi], "out": out})
    for (lo, hi), shard in RARE:
        rules.append({"q": 3, "kind": "any", "il": [lo, hi], "out": [{"id": SHARD[shard], "p": 1, "n": [1, 1]}]})
    rules.append({"q": 3, "kind": "any", "il": [66, 999], "out": [{"id": SHARD["lbril"], "p": 0.995, "n": [1, 1]}, {"id": SHARD["nexus"], "p": 0.005, "n": [1, 1]}]})
    for (lo, hi), shard, n in EPIC:
        rules.append({"q": 4, "kind": "any", "il": [lo, hi], "out": [{"id": SHARD[shard], "p": 1, "n": n}]})
    return {
        "note": "Vanilla disenchant tables (cmangos). Skill: enchanting skill needed by item level.",
        "skill": [[20, 1], [25, 25], [30, 50], [35, 75], [40, 100], [45, 125], [50, 150], [55, 175], [60, 200], [65, 225], [999, 250]],
        "rules": rules,
    }


# ----------------------------------------------------------------------------- main
def write(name: str, data, pretty: bool = False) -> None:
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    path = STATIC_DIR / name
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1 if pretty else None, separators=None if pretty else (",", ":"))
    print(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


def build(build_id: str | None = None, cache: bool = True) -> None:
    build_id = build_id or latest_build()
    print(f"WoW Forever client build {build_id} (wago.tools product '{PRODUCT}')")
    db = load_db2(build_id, cache)
    items = build_items(db)
    print(f"  items with names: {len(items)}")

    trainer_req: dict = {}
    limited: dict = {}
    sources = ["wago.tools DB2"]
    try:
        print("cmangos classic-db (trainer skill levels, limited vendor stock) ...")
        cm = cmangos_data(cache)
        # cmangos lists the trainer's "teach" spell; follow learn-spell effects (effect 36)
        # to the recipe spell. Teach spells only exist in the Classic Era client data.
        teach = defaultdict(list)
        era = latest_build(ERA_PRODUCT)
        era_effects = read_csv(cached(f"{WAGO}/db2/SpellEffect/csv?build={era}", CACHE / "db2" / era / "SpellEffect.csv", cache))
        for r in era_effects + db["SpellEffect"]:
            if r["Effect"] == "36":
                teach[r["SpellID"]].append(r["EffectTriggerSpell"])
        for sp, v in cm["trainer"].items():
            for target in teach.get(sp, [sp]):
                trainer_req[target] = min(v, trainer_req.get(target, v))
        limited = {k: v for k, v in cm["limited"].items()}
        sources.append("cmangos classic-db")
    except Exception as e:  # noqa: BLE001
        print(f"  (skipped: {e})")

    tsm_ids = None
    try:
        tsm_ids = tsm_item_ids()
        print(f"TSM item list: {len(tsm_ids)} items traded in Forever")
    except Exception as e:  # noqa: BLE001
        print(f"  (TSM list skipped: {e})")

    print("Building recipes ...")
    recipes, stats = build_recipes(db, items, trainer_req, tsm_ids)
    print(f"  {len(recipes)} recipes; {stats}")

    vendor = {}
    try:
        print("QuestieDB (vendor items) ...")
        vend, npcs = questie_vendors(cache)
        zones = {i(r["ID"]): r.get("AreaName_lang") for r in db.get("AreaTable", [])}
        for iid, npc_ids in vend.items():
            it = items.get(str(iid))
            if not it or not it.get("bp"):
                continue
            known_npcs = [npcs[n] for n in npc_ids if n in npcs and npcs[n].get("name")]
            fac = "".join(sorted({c for n in known_npcs for c in (n.get("fac") or "")}))
            places = sorted({f"{n['name']} ({zones[n['zone']]})" if zones.get(n.get("zone")) else n["name"] for n in known_npcs})
            entry = {"bp": round(it["bp"] / max(1, it.get("vs", 1))), "npcs": npc_ids[:8]}
            if str(iid) in limited:
                entry["lim"] = limited[str(iid)]
            if fac:
                entry["fac"] = fac
            if places:
                entry["where"] = ", ".join(places[:3]) + (f" +{len(places) - 3} more" if len(places) > 3 else "")
            vendor[str(iid)] = entry
        sources.append("QuestieDB")
        print(f"  {len(vendor)} vendor-sold items")
    except Exception as e:  # noqa: BLE001
        print(f"  (skipped: {e})")

    write("items.json", items)
    write("recipes.json", recipes)
    write("vendor.json", vendor)
    write("disenchant.json", disenchant_table())
    write(
        "meta.json",
        {
            "build": build_id,
            "product": PRODUCT,
            "source": " + ".join(sources),
            "generated": int(time.time()),
            "counts": {"items": len(items), "recipes": len(recipes), "vendor": len(vendor)},
            "stats": stats,
        },
        pretty=True,
    )
