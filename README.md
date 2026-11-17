# WoW Auction Helper (WoW Forever, EU Normal)

A free personal tool that shows every way to make gold on the WoW Forever auction house:

| Tab | What it finds |
|---|---|
| **Crafting** | Profit for every recipe. Reagents come from the AH, a vendor or your own crafts, whichever is cheapest. Results can be ranked by **expected profit** (profit × chance the auction sells), and you can filter by profession, skill range, skill-up colour, known or learnable recipes, profit, margin and sales per day. It also shows the cost per skill-up for levelling. |
| **Flips** | Items listed far below their usual market value: buy them and relist. |
| **Vendor flips** | AH listings cheaper than what an NPC vendor pays for the item. Risk-free. |
| **Disenchant** | Green, blue and purple gear worth more as enchanting materials. |
| **Cross-AH** | Price gaps between the Alliance, Horde and Blackwater (neutral) auction houses. |
| **Vendor resale** | Vendor items, including limited-supply recipes, that sell for more on the AH, and where to buy them. |
| **Item lookup** | Prices in every house, what an item is used in and how to make it, plus your own price overrides (for example, 0 for mats you farm). |
| **Characters** | Your professions and known recipes. They come from the Blizzard API, the included addon, or are entered by hand. |

Everything is free:
* **Data:** TradeSkillMaster's public price files (no account needed), plus the Blizzard API if you add a free key.
* **Hosting:** GitHub Actions and GitHub Pages, or just your own PC.

There is no server to run. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

---

## Option A: always-on with GitHub (recommended)

The repo updates prices every hour and publishes the app to a GitHub Pages URL you can open on any device.

1. **Merge this code into `main`.** Scheduled workflows only run on the default branch.
2. **Turn on Pages:** repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   * Your plan allows Pages from a private repo, but the site itself is reachable by anyone with the URL. It only contains auction prices and game data, never your keys.
3. *(Optional, recommended)* **Add free Blizzard API keys** for listing depth, the neutral Blackwater AH, price history and character sync:
   1. Go to <https://develop.battle.net/access/clients> and click **Create client**. Any name works; leave the redirect URL empty or use `http://localhost`.
   2. Repo **Settings → Secrets and variables → Actions → Secrets**: add `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET`.
   3. *(Optional)* On the **Variables** tab of the same page, add `WOWAH_CHARACTERS` = `yourname-yoursurname,altname-altsurname`. Forever characters have a first name and a surname. They show up once they are level 10 and have logged out.
4. **Start the first run:** **Actions → Update prices → Run workflow**. Afterwards it runs every hour at :23.
5. Open the site at `https://<your-user>.github.io/wow_auction/`. The URL is also shown in **Settings → Pages**.

Each run takes about 1 Actions minute, so roughly 750 minutes a month. Your plan's included minutes cover that.

## Option B: run it on your PC

You need Python 3.10 or newer. Nothing else gets installed.

```bash
python wowah.py run
```

This fetches the latest prices and opens <http://localhost:8000>. Run `python wowah.py fetch` again whenever you want fresh prices.

To use Blizzard API keys locally, copy `secrets.example.json` to `secrets.json` (it is git-ignored) and fill in your keys.

## Your characters and known recipes

* **Easiest:** in the app, go to **Characters → Add a character by hand** and type your profession skill levels. Every trainer recipe up to that skill then counts as craftable.
* **Exact known recipes, via the addon:**
  1. Copy `addon/WowAuctionHelper` into `World of Warcraft/_forever_/Interface/AddOns/`.
     * If the game calls it out of date, tick "Load out of date AddOns".
  2. In game, open each profession window once, then type `/wah`.
  3. Press **Ctrl+C**, then paste into **Characters → Import**.
  4. Alternatively, upload `WTF/Account/<ACCOUNT>/SavedVariables/WowAuctionHelper.lua`. It holds all your characters.
* **Automatic, via the Blizzard API:** set `WOWAH_CHARACTERS` (Option A) or `"characters"` in `config.json` (Option B). This gives professions and skill levels without the addon.

Characters, settings and price overrides are saved in your browser (localStorage).

## Configuration (optional)

Copy `config.example.json` to `config.json`. Defaults: EU, Forever, Normal ruleset, auction houses `111` (Alliance), `114` (Horde) and `117` (Blackwater).

Blizzard does not label which auction house belongs to which ruleset; the mapping comes from the community. With API keys, run this to verify it:

```bash
python wowah.py houses --check
```

## Updating the recipe database after a game patch

The recipe and item database (`web/data/static/`) is built from the WoW Forever client data:

```bash
python wowah.py build-db
```

Or on GitHub: **Actions → Rebuild recipe database → Run workflow**. It commits the result.

## How to read the numbers

* All prices are per unit and in copper, displayed as g/s/c.
* **Sells for (net)** is the price after the AH cut: 5% at faction houses, 15% at Blackwater. Both cuts can be changed in **Settings**.
* **Sold/day, Sale rate, Avg sale** come from TSM and are EU-wide across all Forever rulesets. They are a liquidity signal, not your exact market.
  * **Exp. profit** = profit × sale rate. Use it as your default sort.
* Without Blizzard keys, quantities and "buy up to" prices are unknown and totals are per unit. The app shows a notice when that is the case.
* The flip, resale and cross-AH tabs sell at the conservative price by default: the lowest of market, latest, historical and average sale price. You can change this in **Settings**.
* About 100 recipes have an estimated "learn" skill level, because trainer data is incomplete for Forever.

## Development

```bash
node --test tests/*.mjs                      # profit engine, importer, Lua parser
python3 -m unittest discover -s tests        # pipeline
python wowah.py serve                        # UI against existing data
```

No build step or dependencies are involved: the UI is plain ES modules and the pipeline uses only the Python standard library.

## Credits and data

* Prices: [TradeSkillMaster public data](https://tradeskillmaster.com/public-data) and the Blizzard Battle.net API.
* Game data: [wago.tools](https://wago.tools) DB2 exports of the WoW Forever client.
* Vendors: [QuestieDB](https://github.com/Questie/QuestieDB) (GPLv3).
* Trainer and limited-stock data: [cmangos classic-db](https://github.com/cmangos/classic-db).
* Forever API notes: <https://blizzard.pinta.land/forever/>

This is a personal tool and is not affiliated with Blizzard Entertainment or TradeSkillMaster.
