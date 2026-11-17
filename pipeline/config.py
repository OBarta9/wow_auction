"""Configuration loading.

Settings come from (later wins):
  1. built-in defaults below (WoW Forever, EU, Normal ruleset)
  2. config.json in the repo root (copy config.example.json)
  3. environment variables (WOWAH_*), used by GitHub Actions

Credentials are never stored in config.json. They come from the
BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET environment variables or from a
git-ignored `secrets.json` file ({"client_id": "...", "client_secret": "..."}).
Blizzard credentials are optional: without them only TSM public data is used.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
STATIC_DIR = WEB_DIR / "data" / "static"
DEFAULT_LIVE_DIR = WEB_DIR / "data" / "live"
DEFAULT_STATE_DIR = ROOT / "state"

# Community-verified mapping (Nov 2026). The API does not label which of its
# 15 houses belong to which ruleset; `python wowah.py houses --check` verifies
# the mapping against TSM data.
DEFAULT_HOUSES = {
    "normal": {"alliance": 111, "horde": 114, "neutral": 117},
    "pvp": {"alliance": 110, "horde": 113, "neutral": 116},
    "rp": {"alliance": 119, "horde": 120, "neutral": 121},
    "rp-pvp": {"alliance": 123, "horde": 124, "neutral": 125},
}
RULESET_IDS = {"pvp": 1, "normal": 2, "rp": 3, "rp-pvp": 15}


@dataclass
class Config:
    region: str = "eu"
    game: str = "forever"                 # TSM path segment and API namespace suffix
    ruleset: str = "normal"               # normal | pvp | rp | rp-pvp
    ruleset_id: int | None = None         # defaults from RULESET_IDS
    houses: dict = field(default_factory=dict)  # {"alliance": 111, ...}; defaults from DEFAULT_HOUSES
    use_tsm: bool = True
    use_blizzard: str = "auto"            # "auto" (if credentials exist) | true | false
    characters: list = field(default_factory=list)  # ["name-surname", ...] for the profile API
    history_days: int = 21
    locale: str = "en_GB"
    live_dir: Path = DEFAULT_LIVE_DIR
    state_dir: Path = DEFAULT_STATE_DIR
    client_id: str | None = None
    client_secret: str | None = None

    @property
    def dynamic_ns(self) -> str:
        return f"dynamic-{self.game}-{self.region}"

    @property
    def static_ns(self) -> str:
        return f"static-{self.game}-{self.region}"

    @property
    def profile_ns(self) -> str:
        return f"profile-{self.game}-{self.region}"

    @property
    def blizzard_enabled(self) -> bool:
        if self.use_blizzard in (False, "false", "no", "off"):
            return False
        has_creds = bool(self.client_id and self.client_secret)
        if self.use_blizzard in (True, "true", "yes", "on") and not has_creds:
            raise SystemExit("use_blizzard is on but BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET are missing.")
        return has_creds


def _env(name: str):
    v = os.environ.get(name)
    return v if v not in (None, "") else None


def load_config(path: Path | None = None) -> Config:
    cfg = Config()
    path = path or ROOT / "config.json"
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        for k, v in data.items():
            if k.startswith("_"):
                continue
            if not hasattr(cfg, k):
                raise SystemExit(f"config.json: unknown setting '{k}'")
            if k in ("live_dir", "state_dir") and v:
                v = (ROOT / v).resolve()
            setattr(cfg, k, v)

    env_map = {
        "WOWAH_REGION": "region",
        "WOWAH_GAME": "game",
        "WOWAH_RULESET": "ruleset",
        "WOWAH_CHARACTERS": "characters",
        "WOWAH_HOUSES": "houses",
        "WOWAH_HISTORY_DAYS": "history_days",
        "WOWAH_USE_BLIZZARD": "use_blizzard",
        "WOWAH_LIVE_DIR": "live_dir",
        "WOWAH_STATE_DIR": "state_dir",
    }
    for env_name, attr in env_map.items():
        v = _env(env_name)
        if v is None:
            continue
        if attr == "history_days":
            v = int(v)
        elif attr == "characters":
            v = [c.strip() for c in v.split(",") if c.strip()]
        elif attr == "houses":  # "alliance=111,horde=114,neutral=117"
            pairs = [h.split("=", 1) for h in v.split(",") if "=" in h]
            v = {k.strip().lower(): int(n) for k, n in pairs if n.strip().isdigit()}
        elif attr in ("live_dir", "state_dir"):
            v = Path(v).resolve()
        setattr(cfg, attr, v)

    cfg.ruleset = cfg.ruleset.lower()
    if cfg.ruleset_id is None:
        cfg.ruleset_id = RULESET_IDS.get(cfg.ruleset, 2)
    if not cfg.houses:
        cfg.houses = dict(DEFAULT_HOUSES.get(cfg.ruleset, DEFAULT_HOUSES["normal"]))

    cfg.client_id = _env("BLIZZARD_CLIENT_ID")
    cfg.client_secret = _env("BLIZZARD_CLIENT_SECRET")
    secrets = ROOT / "secrets.json"
    if (not cfg.client_id or not cfg.client_secret) and secrets.exists():
        s = json.loads(secrets.read_text(encoding="utf-8"))
        cfg.client_id = cfg.client_id or s.get("client_id")
        cfg.client_secret = cfg.client_secret or s.get("client_secret")
    return cfg
