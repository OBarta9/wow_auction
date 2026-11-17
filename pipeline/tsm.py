"""TradeSkillMaster public price data (free, no account or key needed).

https://tradeskillmaster.com/public-data
  realm file  /{game}/{region}/realm/{ruleset}-{faction}/items.csv
              itemId,name,marketValue,minBuyout,recent,historical,updatedAt
  region file /{game}/{region}/region/items.csv
              itemId,name,marketValue,historical,avgSalePrice,saleRate,soldPerDay,updatedAt

TSM's own definitions: marketValue = 14-day weighted market value,
recent = latest market value, historical = 60-day value, minBuyout = lowest
buyout at the last scan. Region sale stats come from TSM users' accounting.
"""
from __future__ import annotations

import csv
import io
import urllib.request
from datetime import datetime

BASE = "https://public-data.tradeskillmaster.com"
USER_AGENT = "wow-auction-helper/1.0 (personal use)"


def _get_csv(url: str) -> list[dict]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(text)))


def _int(v):
    try:
        return int(float(v)) if v not in (None, "") else None
    except ValueError:
        return None


def _float(v):
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def _ts(v) -> int | None:
    try:
        return int(datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp())
    except (AttributeError, ValueError):
        return None


def realm_url(game: str, region: str, ruleset: str, faction: str) -> str:
    return f"{BASE}/{game}/{region}/realm/{ruleset}-{faction}/items.csv"


def region_url(game: str, region: str) -> str:
    return f"{BASE}/{game}/{region}/region/items.csv"


def fetch_realm(game: str, region: str, ruleset: str, faction: str) -> tuple[dict, dict, int | None]:
    """-> ({id: {market, min, recent, hist}}, {id: name}, updated_ts)"""
    rows = _get_csv(realm_url(game, region, ruleset, faction))
    out, names, updated = {}, {}, None
    for r in rows:
        iid = _int(r.get("itemId"))
        if iid is None:
            continue
        out[str(iid)] = {
            "market": _int(r.get("marketValue")),
            "min": _int(r.get("minBuyout")),
            "recent": _int(r.get("recent")),
            "hist": _int(r.get("historical")),
        }
        if r.get("name"):
            names[str(iid)] = r["name"]
        updated = max(updated or 0, _ts(r.get("updatedAt")) or 0) or updated
    return out, names, updated


def fetch_region(game: str, region: str) -> tuple[dict, dict, int | None]:
    """-> ({id: {market, hist, avgSale, saleRate, soldPerDay}}, {id: name}, updated_ts)"""
    rows = _get_csv(region_url(game, region))
    out, names, updated = {}, {}, None
    for r in rows:
        iid = _int(r.get("itemId"))
        if iid is None:
            continue
        out[str(iid)] = {
            "market": _int(r.get("marketValue")),
            "hist": _int(r.get("historical")),
            "avgSale": _int(r.get("avgSalePrice")),
            "saleRate": _float(r.get("saleRate")),
            "soldPerDay": _float(r.get("soldPerDay")),
        }
        if r.get("name"):
            names[str(iid)] = r["name"]
        updated = max(updated or 0, _ts(r.get("updatedAt")) or 0) or updated
    return out, names, updated
