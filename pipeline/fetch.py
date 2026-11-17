"""Collect prices from TSM public data and (optionally) the Blizzard API, merge
them and write the browser data files.

cfg.live_dir (served to the browser):
    meta.json            what was fetched and when
    house-<slug>.json    per-item prices for one auction house (alliance/horde/neutral)
    names.json           item names seen in price data (fallback for items missing from the static db)
    characters.json      professions of characters from the Blizzard profile API (optional)
cfg.state_dir (kept between runs, not served):
    snapshot-<slug>.json.gz   previous Blizzard snapshot (for sales estimates)
    history-<slug>.json.gz    rolling daily history from Blizzard snapshots

house-<slug>.json format:
{
  "ts": 1763380000, "house": "alliance",
  "fields": ["min","market","now","hist","qty","auctions","soldPerDay","saleRate","avgSale"],
  "items":  {"13446": [min, market, now, hist, qty, auctions, soldPerDay, saleRate, avgSale]},
  "ladder": {"13446": [[unit, qty], ...]},     # cheapest listings, Blizzard only
  "spark":  {"13446": [daily market, ...]},    # own history, Blizzard only
  "sources": {"tsm": ts|null, "blizzard": ts|null, "tsmRegion": ts|null}
}
min      lowest buyout (Blizzard now, else TSM minBuyout)
market   TSM 14-day market value, else Blizzard "cheapest 15%" average now
now      Blizzard cheapest-15% average now, else TSM "recent"
hist     TSM 60-day historical, else median of own daily history
soldPerDay / saleRate / avgSale   TSM region stats (EU-wide), else own estimate
"""
from __future__ import annotations

import gzip
import json
import time
import traceback
from pathlib import Path

from . import tsm
from .aggregate import aggregate, compact_snapshot, estimate_disappeared
from .blizzard import BlizzardClient
from .config import Config
from .history import empty_history, summarize, update_history

FIELDS = ["min", "market", "now", "hist", "qty", "auctions", "soldPerDay", "saleRate", "avgSale"]


def write_json(path: Path, data, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        if pretty:
            json.dump(data, f, indent=1, ensure_ascii=False)
        else:
            json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    tmp.replace(path)


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    try:
        if path.suffix == ".gz":
            with gzip.open(path, "rt", encoding="utf-8") as f:
                return json.load(f)
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_gz_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as f:
        json.dump(data, f, separators=(",", ":"))
    tmp.replace(path)


# ---------------------------------------------------------------------------
def blizzard_house(cfg: Config, client: BlizzardClient, slug: str, house_id: int, ts: float) -> dict:
    """Fetch one house, update state; returns {stats, ladder, hist_summary, info}."""
    auctions = client.auctions(cfg.dynamic_ns, cfg.ruleset_id, house_id)
    stats, ladder = aggregate(auctions)

    snap_path = cfg.state_dir / f"snapshot-{slug}.json.gz"
    prev = read_json(snap_path, None)
    cur = compact_snapshot(auctions)
    sold: dict = {}
    covered = 0.0
    if prev and prev.get("auctions"):
        gap_h = (ts - prev["ts"]) / 3600.0
        if 0.2 <= gap_h <= 12:
            sold = estimate_disappeared(prev["auctions"], set(cur), gap_h)
            covered = gap_h
    write_gz_json(snap_path, {"ts": ts, "auctions": cur})

    hist_path = cfg.state_dir / f"history-{slug}.json.gz"
    hist = read_json(hist_path, None) or empty_history()
    update_history(hist, stats, sold, ts, covered, cfg.history_days)
    write_gz_json(hist_path, hist)
    return {
        "stats": stats,
        "ladder": ladder,
        "hist": summarize(hist),
        "info": {"auctions": len(auctions), "items": len(stats), "disappeared": sum(sold.values())},
    }


def merge_house(slug: str, ts: float, tsm_realm: dict | None, tsm_region: dict | None, bz: dict | None) -> dict:
    items: dict[str, list] = {}
    ids = set()
    if tsm_realm:
        ids.update(tsm_realm)
    if bz:
        ids.update(bz["stats"])
    for iid in ids:
        t = (tsm_realm or {}).get(iid) or {}
        b = (bz or {}).get("stats", {}).get(iid)        # [min, market_now, median, qty, auctions]
        h = (bz or {}).get("hist", {}).get(iid)         # [hist_market, hist_min, avg_qty, sold/day, days, spark]
        r = (tsm_region or {}).get(iid) or {}
        mn = b[0] if b else t.get("min")
        now = b[1] if b else t.get("recent")
        market = t.get("market") or (b[1] if b else None)
        hist = t.get("hist") or (h[0] if h and h[4] >= 2 else None)
        qty = b[3] if b else None
        auctions = b[4] if b else None
        sold = r.get("soldPerDay") if r.get("soldPerDay") is not None else (h[3] if h else None)
        items[iid] = [mn, market, now, hist, qty, auctions, sold, r.get("saleRate"), r.get("avgSale")]
    out = {
        "ts": int(ts),
        "house": slug,
        "fields": FIELDS,
        "items": items,
        "ladder": (bz or {}).get("ladder", {}),
        "spark": {k: v[5] for k, v in ((bz or {}).get("hist") or {}).items() if v[5] and any(x is not None for x in v[5])},
    }
    return out


def run_fetch(cfg: Config) -> dict:
    ts = time.time()
    names: dict = read_json(cfg.live_dir / "names.json", {}) or {}
    meta_houses = []
    errors = []

    tsm_region = None
    tsm_region_ts = None
    if cfg.use_tsm:
        try:
            tsm_region, n, tsm_region_ts = tsm.fetch_region(cfg.game, cfg.region)
            names.update(n)
            print(f"TSM region data: {len(tsm_region)} items")
        except Exception as e:  # noqa: BLE001 - keep going with other sources
            errors.append(f"TSM region: {e}")
            print(f"! TSM region data failed: {e}")

    client = None
    if cfg.blizzard_enabled:
        client = BlizzardClient(cfg.client_id, cfg.client_secret, cfg.region, cfg.locale)
    else:
        print("Blizzard API: no credentials, using TSM data only (no neutral AH, no listing depth).")

    for slug, house_id in cfg.houses.items():
        tsm_realm = None
        tsm_ts = None
        if cfg.use_tsm and slug in ("alliance", "horde"):
            try:
                tsm_realm, n, tsm_ts = tsm.fetch_realm(cfg.game, cfg.region, cfg.ruleset, slug)
                names.update(n)
                print(f"TSM {cfg.ruleset}-{slug}: {len(tsm_realm)} items")
            except Exception as e:  # noqa: BLE001
                errors.append(f"TSM {slug}: {e}")
                print(f"! TSM {slug} failed: {e}")
        bz = None
        if client is not None and house_id:
            try:
                print(f"Blizzard house {house_id} ({slug}) ...", flush=True)
                bz = blizzard_house(cfg, client, slug, int(house_id), ts)
                i = bz["info"]
                print(f"  {i['auctions']} auctions, {i['items']} items, ~{i['disappeared']} units vanished since last scan")
            except Exception as e:  # noqa: BLE001
                errors.append(f"Blizzard {slug}: {e}")
                print(f"! Blizzard {slug} failed: {e}")
                traceback.print_exc()
        if not tsm_realm and not bz:
            continue
        data = merge_house(slug, ts, tsm_realm, tsm_region, bz)
        data["sources"] = {"tsm": tsm_ts, "tsmRegion": tsm_region_ts, "blizzard": int(ts) if bz else None}
        write_json(cfg.live_dir / f"house-{slug}.json", data)
        meta_houses.append(
            {
                "slug": slug,
                "id": house_id,
                "items": len(data["items"]),
                "auctions": (bz or {}).get("info", {}).get("auctions"),
                "sources": data["sources"],
            }
        )

    if not meta_houses:
        raise SystemExit("No price data could be fetched:\n  " + "\n  ".join(errors))

    write_json(cfg.live_dir / "names.json", names)

    if client is not None and cfg.characters:
        from .characters import fetch_characters

        try:
            chars = fetch_characters(cfg, client)
            write_json(cfg.live_dir / "characters.json", {"ts": int(ts), "characters": chars}, pretty=True)
        except Exception as e:  # noqa: BLE001
            errors.append(f"characters: {e}")
            print(f"! character fetch failed: {e}")

    meta = {
        "updated": int(ts),
        "game": cfg.game,
        "region": cfg.region,
        "ruleset": cfg.ruleset,
        "houses": meta_houses,
        "errors": errors,
    }
    write_json(cfg.live_dir / "meta.json", meta, pretty=True)
    return meta
