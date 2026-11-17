"""Turn a raw auction snapshot into compact per-item price statistics.

Output per item id (all prices in copper, per single unit):
    [min, market, median, quantity, auctions]
plus a short "ladder" of the cheapest price levels: [[unit_price, qty], ...]
so the UI can tell how much can be bought below a given price.

"market" is a TSM-style value: the quantity-weighted mean of the cheapest
15% of listed units (at least one auction). It ignores absurd high listings
and is what you would realistically pay when buying a handful.
"""
from __future__ import annotations

from collections import defaultdict

MARKET_FRACTION = 0.15
LADDER_LEVELS = 6

# Blizzard time_left codes -> compact ints (used for sale estimation)
TIME_LEFT = {"SHORT": 0, "MEDIUM": 1, "LONG": 2, "VERY_LONG": 3}


def unit_buyout(a: dict) -> float | None:
    """Per-unit buyout for one auction, or None for bid-only auctions."""
    qty = a.get("quantity") or 1
    if a.get("unit_price"):  # retail commodities style
        return float(a["unit_price"])
    buyout = a.get("buyout") or 0
    if buyout <= 0:
        return None
    # Classic API: buyout is the price of the whole stack.
    return buyout / qty


def item_key(a: dict) -> int:
    return int(a["item"]["id"])


def aggregate(auctions: list[dict]) -> tuple[dict, dict]:
    listings: dict[int, list[tuple[float, int]]] = defaultdict(list)
    bid_only: dict[int, int] = defaultdict(int)
    for a in auctions:
        try:
            iid = item_key(a)
        except (KeyError, TypeError, ValueError):
            continue
        qty = int(a.get("quantity") or 1)
        unit = unit_buyout(a)
        if unit is None:
            bid_only[iid] += qty
            continue
        listings[iid].append((unit, qty))

    stats: dict[str, list] = {}
    ladder: dict[str, list] = {}
    for iid, rows in listings.items():
        rows.sort(key=lambda r: r[0])
        total_qty = sum(q for _, q in rows)
        # market value: cheapest MARKET_FRACTION of units
        cutoff = max(1.0, total_qty * MARKET_FRACTION)
        acc_q = 0
        acc_v = 0.0
        for unit, q in rows:
            take = min(q, cutoff - acc_q)
            if take <= 0:
                break
            acc_q += take
            acc_v += unit * take
        market = acc_v / acc_q if acc_q else rows[0][0]
        # weighted median
        half = total_qty / 2.0
        run = 0
        median = rows[-1][0]
        for unit, q in rows:
            run += q
            if run >= half:
                median = unit
                break
        stats[str(iid)] = [
            round(rows[0][0]),
            round(market),
            round(median),
            total_qty,
            len(rows),
        ]
        levels: list[list] = []
        for unit, q in rows:
            u = round(unit)
            if levels and levels[-1][0] == u:
                levels[-1][1] += q
            elif len(levels) < LADDER_LEVELS:
                levels.append([u, q])
            else:
                break
        ladder[str(iid)] = levels
    return stats, ladder


def compact_snapshot(auctions: list[dict]) -> dict[str, list[int]]:
    """auction id -> [item id, quantity, time_left code] for sale estimation."""
    out = {}
    for a in auctions:
        try:
            out[str(a["id"])] = [item_key(a), int(a.get("quantity") or 1), TIME_LEFT.get(a.get("time_left"), 3)]
        except (KeyError, TypeError, ValueError):
            continue
    return out


def estimate_disappeared(prev: dict[str, list[int]], cur_ids: set[str], gap_hours: float) -> dict[str, int]:
    """Quantity per item of auctions that vanished although they could not have
    expired in the elapsed time -> bought (or cancelled). A rough sales proxy.

    time_left buckets: SHORT <30m, MEDIUM 30m-2h, LONG 2h-12h, VERY_LONG >12h.
    """
    if gap_hours <= 2:
        min_code = 2  # LONG or VERY_LONG cannot expire within 2h
    elif gap_hours <= 12:
        min_code = 3
    else:
        return {}  # too long between snapshots to tell
    out: dict[str, int] = defaultdict(int)
    for aid, (iid, qty, tl) in prev.items():
        if tl >= min_code and aid not in cur_ids:
            out[str(iid)] += qty
    return dict(out)
