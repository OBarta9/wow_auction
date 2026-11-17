"""List the auction houses the Blizzard API serves and, with --check, find out
which belong to your ruleset by comparing their lowest prices with TSM's
realm data (TSM files are per ruleset + faction, the API houses are not labelled).
"""
from __future__ import annotations

from . import tsm
from .aggregate import aggregate
from .blizzard import BlizzardClient
from .config import Config


def _match_score(stats: dict, ref: dict) -> tuple[float, int]:
    """Share of common items whose lowest buyout is within 3% of TSM's."""
    common = [i for i in stats if i in ref and ref[i].get("min")]
    if not common:
        return 0.0, 0
    hits = 0
    for i in common:
        a = stats[i][0]
        b = ref[i]["min"]
        if abs(a - b) <= max(1, 0.03 * b):
            hits += 1
    return hits / len(common), len(common)


def list_houses(cfg: Config, check: bool = False) -> None:
    if not cfg.blizzard_enabled:
        raise SystemExit("This command needs Blizzard API credentials (see README).")
    client = BlizzardClient(cfg.client_id, cfg.client_secret, cfg.region, cfg.locale)
    try:
        rulesets = client.rulesets(cfg.dynamic_ns)
        print("Rulesets:", ", ".join(f"{r['id']}={r['name']}" for r in rulesets))
    except Exception as e:  # noqa: BLE001
        print(f"(ruleset index failed: {e})")
    houses = client.auction_houses(cfg.dynamic_ns, cfg.ruleset_id)
    refs = {}
    if check:
        for fac in ("alliance", "horde"):
            refs[fac], _, _ = tsm.fetch_realm(cfg.game, cfg.region, cfg.ruleset, fac)
    configured = {v: k for k, v in cfg.houses.items()}
    print(f"\nHouses listed under ruleset {cfg.ruleset_id} (configured for '{cfg.ruleset}': {cfg.houses})")
    for h in houses:
        line = f"  {h['id']:>4}  {h['name']:<28}"
        if h["id"] in configured:
            line += f" <- configured as {configured[h['id']]}"
        if check:
            auctions = client.auctions(cfg.dynamic_ns, cfg.ruleset_id, h["id"])
            stats, _ = aggregate(auctions)
            line += f"  {len(auctions):>6} auctions"
            for fac, ref in refs.items():
                score, n = _match_score(stats, ref)
                line += f"  match {cfg.ruleset}-{fac}: {score:5.1%} of {n}"
        print(line)
    if check:
        print("\nThe house with the highest match per faction is yours. Neutral (Blackwater) houses have no TSM")
        print("file; they are usually the one whose id follows the pattern of the matching faction houses.")
        print('Put the ids into config.json as  "houses": {"alliance": .., "horde": .., "neutral": ..}')
