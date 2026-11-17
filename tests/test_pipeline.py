"""Run: python3 -m unittest discover -s tests"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline import fetch  # noqa: E402
from pipeline.aggregate import aggregate, compact_snapshot, estimate_disappeared  # noqa: E402
from pipeline.characters import parse_professions  # noqa: E402
from pipeline.config import Config  # noqa: E402
from pipeline.history import empty_history, summarize, update_history  # noqa: E402
from pipeline.luadata import parse_value  # noqa: E402


def auction(aid, item, qty, buyout=None, unit=None, tl="LONG"):
    a = {"id": aid, "item": {"id": item}, "quantity": qty, "time_left": tl}
    if buyout is not None:
        a["buyout"] = buyout
    if unit is not None:
        a["unit_price"] = unit
    return a


class FakeClient:
    """Mimics BlizzardClient.auctions() with a queue of snapshots."""

    def __init__(self, snapshots):
        self.snapshots = list(snapshots)

    def auctions(self, ns, ruleset, house):
        return self.snapshots.pop(0)


class AggregateTest(unittest.TestCase):
    def test_unit_prices_market_and_ladder(self):
        auctions = [
            auction(1, 10, 20, buyout=2000),  # 100/unit (item auction, total buyout)
            auction(2, 10, 5, unit=90),  # commodity, unit price
            auction(3, 10, 100, unit=150),
            auction(4, 10, 1),  # bid only -> ignored
            auction(5, 11, 1, buyout=999999),
        ]
        stats, ladder = aggregate(auctions)
        mn, market, median, qty, n = stats["10"]
        self.assertEqual(mn, 90)
        self.assertEqual(qty, 125)
        self.assertEqual(n, 3)
        # cheapest 15% of 125 units = 18.75 units: 5 @ 90 + 13.75 @ 100
        self.assertAlmostEqual(market, round((5 * 90 + 13.75 * 100) / 18.75), delta=1)
        self.assertEqual(median, 150)
        self.assertEqual(ladder["10"], [[90, 5], [100, 20], [150, 100]])
        self.assertEqual(stats["11"][0], 999999)

    def test_disappeared(self):
        prev = compact_snapshot([auction(1, 10, 5, unit=1, tl="VERY_LONG"), auction(2, 10, 3, unit=1, tl="SHORT"), auction(3, 11, 1, unit=1, tl="LONG")])
        sold = estimate_disappeared(prev, {"3"}, gap_hours=1.0)
        self.assertEqual(sold, {"10": 5})  # SHORT may have expired, so not counted
        self.assertEqual(estimate_disappeared(prev, set(), gap_hours=5), {"10": 5})  # LONG may expire in 5h
        self.assertEqual(estimate_disappeared(prev, set(), gap_hours=20), {})


class HistoryTest(unittest.TestCase):
    def test_rolling_days(self):
        h = empty_history()
        day = 86400
        t0 = 1_800_000_000
        update_history(h, {"10": [90, 100, 100, 50, 3]}, {}, t0, 0, 3)
        update_history(h, {"10": [80, 120, 100, 70, 3]}, {"10": 6}, t0 + 3600, 1, 3)
        self.assertEqual(h["items"]["10"][-1][:5], [110, 80, 60.0, 6, 2])
        for k in range(1, 5):
            update_history(h, {"10": [90, 100 + k, 100, 50, 3]}, {}, t0 + k * day, 24, 3)
        self.assertEqual(len(h["days"]), 3)
        s = summarize(h)
        self.assertEqual(s["10"][0], 103)
        self.assertEqual(len(s["10"][5]), 3)


class FetchMergeTest(unittest.TestCase):
    def test_blizzard_plus_tsm_merge_and_state(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Config(live_dir=Path(d) / "live", state_dir=Path(d) / "state")
            snap1 = [auction(1, 10, 10, unit=100, tl="VERY_LONG"), auction(2, 10, 10, unit=120, tl="VERY_LONG")]
            snap2 = [auction(2, 10, 10, unit=120, tl="VERY_LONG"), auction(3, 10, 4, unit=130)]
            client = FakeClient([snap1, snap2])
            fetch.blizzard_house(cfg, client, "alliance", 111, 1_800_000_000)
            bz = fetch.blizzard_house(cfg, client, "alliance", 111, 1_800_000_000 + 3600)
            self.assertEqual(bz["info"]["disappeared"], 10)
            tsm_realm = {"10": {"market": 115, "min": 99, "recent": 118, "hist": 140}, "12": {"market": 5, "min": 4, "recent": 5, "hist": 6}}
            tsm_region = {"10": {"soldPerDay": 42.0, "saleRate": 0.5, "avgSale": 110}}
            out = fetch.merge_house("alliance", 1, tsm_realm, tsm_region, bz)
            row = out["items"]["10"]
            self.assertEqual(row[fetch.FIELDS.index("min")], 120)  # Blizzard "now" beats stale TSM min
            self.assertEqual(row[fetch.FIELDS.index("market")], 115)  # TSM market value
            self.assertEqual(row[fetch.FIELDS.index("hist")], 140)
            self.assertEqual(row[fetch.FIELDS.index("qty")], 14)
            self.assertEqual(row[fetch.FIELDS.index("soldPerDay")], 42.0)
            self.assertEqual(out["items"]["12"][0], 4)  # TSM-only item
            self.assertEqual(out["ladder"]["10"], [[120, 10], [130, 4]])
            self.assertTrue((Path(d) / "state" / "history-alliance.json.gz").exists())


class MiscTest(unittest.TestCase):
    def test_lua_parse(self):
        v = parse_value("{'Name\\'s',nil,3,{[8]={{1.5,2}}},\"H\",{1,2}}")
        self.assertEqual(v[1], "Name's")
        self.assertIsNone(v[2])
        self.assertEqual(v[4][8][1], {1: 1.5, 2: 2})
        self.assertEqual(v[5], "H")

    def test_profile_professions(self):
        data = json.loads(
            """{"primaries":[{"profession":{"name":"Alchemy","id":171},"tiers":[{"skill_points":250,"max_skill_points":300,
            "known_recipes":[{"name":"Major Healing Potion","id":555}]}],"specialization":null}],
            "secondaries":[{"profession":{"name":"First Aid","id":129},"skill_points":300,"max_skill_points":300}]}"""
        )
        prof, known = parse_professions(data)
        self.assertEqual(prof["alchemy"], {"rank": 250, "max": 300})
        self.assertEqual(prof["firstaid"]["rank"], 300)
        self.assertEqual(known["alchemy"], [{"id": 555, "n": "Major Healing Potion"}])


if __name__ == "__main__":
    unittest.main()
