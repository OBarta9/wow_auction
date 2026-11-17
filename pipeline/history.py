"""Rolling per-item daily price history and sales-rate estimates.

State file (kept in the state dir, not served to the browser):
{
  "days":  ["2026-11-10", ...],          # UTC dates, oldest first
  "cov":   [hours, ...],                  # hours of snapshot coverage usable for sales estimates
  "items": {"13446": [[market, min, qty, sold, n] | null, ...]}   # aligned with days
}

The browser gets a compact summary instead (see `summarize`).
"""
from __future__ import annotations

import statistics
from datetime import datetime, timezone


def _today(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def empty_history() -> dict:
    return {"days": [], "cov": [], "items": {}}


def update_history(hist: dict, stats: dict, sold: dict, ts: float, covered_hours: float, max_days: int) -> dict:
    day = _today(ts)
    days = hist.setdefault("days", [])
    cov = hist.setdefault("cov", [])
    items = hist.setdefault("items", {})

    if not days or days[-1] != day:
        days.append(day)
        cov.append(0.0)
        for arr in items.values():
            arr.append(None)
    # keep arrays aligned (defensive: items added on earlier days)
    n_days = len(days)
    for arr in items.values():
        while len(arr) < n_days:
            arr.insert(0, None)

    cov[-1] = round(cov[-1] + covered_hours, 3)

    for iid, (mn, market, _median, qty, _auctions) in stats.items():
        arr = items.get(iid)
        if arr is None:
            arr = [None] * n_days
            items[iid] = arr
        e = arr[-1]
        if e is None or e[4] == 0:
            sold_prev = e[3] if e else 0
            arr[-1] = [market, mn, qty, sold_prev, 1]
        else:
            n = e[4] + 1
            e[0] = round(e[0] + (market - e[0]) / n)
            e[1] = min(e[1], mn) if e[1] is not None else mn
            e[2] = round(e[2] + (qty - e[2]) / n, 1)
            e[4] = n

    for iid, q in sold.items():
        arr = items.get(iid)
        if arr is None:
            arr = [None] * n_days
            items[iid] = arr
        if arr[-1] is None:
            arr[-1] = [None, None, 0, 0, 0]
        arr[-1][3] += q

    # trim to max_days and drop items with no data left
    if len(days) > max_days:
        cut = len(days) - max_days
        del days[:cut]
        del cov[:cut]
        for iid in list(items):
            del items[iid][:cut]
    for iid in [k for k, v in items.items() if all(e is None for e in v)]:
        del items[iid]
    return hist


def summarize(hist: dict, spark_days: int = 14) -> dict:
    """Compact per-item summary for the browser:
    id -> [hist_market, hist_min, avg_qty, sold_per_day, days_seen, [daily market...]]
    hist_market / hist_min are medians of the daily values (robust to spikes).
    """
    cov_total = sum(hist.get("cov", [])) or 0.0
    out = {}
    for iid, arr in hist.get("items", {}).items():
        markets = [e[0] for e in arr if e and e[0] is not None]
        mins = [e[1] for e in arr if e and e[1] is not None]
        qtys = [e[2] for e in arr if e and e[4]]
        sold = sum(e[3] for e in arr if e)
        if not markets and not sold:
            continue
        sold_per_day = round(sold / (cov_total / 24.0), 2) if cov_total >= 1 else None
        out[iid] = [
            round(statistics.median(markets)) if markets else None,
            round(statistics.median(mins)) if mins else None,
            round(statistics.mean(qtys), 1) if qtys else 0,
            sold_per_day,
            len(markets),
            [e[0] if e and e[0] is not None else None for e in arr[-spark_days:]],
        ]
    return out
