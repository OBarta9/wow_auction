"""Character professions from the Blizzard profile API (WoW Forever).

Forever characters are realmless and addressed as "name-surname". They only
appear once they reached level 10 and logged out; the data is a snapshot from
the last logout.
"""
from __future__ import annotations

from .blizzard import ApiError, BlizzardClient
from .config import Config

# Profession skill line ids -> app keys
SKILL_LINES = {
    171: "alchemy", 164: "blacksmithing", 333: "enchanting", 202: "engineering",
    165: "leatherworking", 197: "tailoring", 186: "mining", 185: "cooking",
    129: "firstaid", 182: "herbalism", 393: "skinning", 356: "fishing",
}
NAMES = {v.replace("firstaid", "first aid"): v for v in SKILL_LINES.values()}


def _key(prof: dict) -> str | None:
    pid = prof.get("id")
    if pid in SKILL_LINES:
        return SKILL_LINES[pid]
    name = (prof.get("name") or "").lower()
    return NAMES.get(name)


def parse_professions(data: dict) -> tuple[dict, dict]:
    professions: dict = {}
    known: dict = {}
    for entry in (data.get("primaries") or []) + (data.get("secondaries") or []):
        prof = entry.get("profession") or {}
        k = _key(prof)
        if not k:
            continue
        tiers = entry.get("tiers") or []
        rank = entry.get("skill_points")
        mx = entry.get("max_skill_points")
        recipes = list(entry.get("known_recipes") or [])
        for t in tiers:
            rank = t.get("skill_points", rank)
            mx = t.get("max_skill_points", mx)
            recipes += t.get("known_recipes") or []
        professions[k] = {"rank": rank or 0, "max": mx or 0}
        if entry.get("specialization"):
            professions[k]["spec"] = (entry["specialization"] or {}).get("name")
        if recipes:
            known[k] = [{"id": r.get("id"), "n": r.get("name")} for r in recipes]
    return professions, known


def fetch_characters(cfg: Config, client: BlizzardClient) -> list[dict]:
    out = []
    for slug in cfg.characters:
        slug = slug.strip().lower()
        try:
            prof = client.character_professions(cfg.profile_ns, slug)
        except ApiError as e:
            print(f"! character {slug}: HTTP {e.status} (characters appear from level 10 after logging out)")
            continue
        try:
            profile = client.character_profile(cfg.profile_ns, slug)
        except ApiError:
            profile = {}
        professions, known = parse_professions(prof)
        faction = ((profile.get("faction") or {}).get("type") or "").lower()
        out.append(
            {
                "id": slug,
                "name": profile.get("name") or slug.split("-")[0].title(),
                "surname": profile.get("surname"),
                "faction": faction,
                "level": profile.get("level"),
                "cls": ((profile.get("character_class") or {}).get("name")),
                "professions": professions,
                "knownApi": known,  # [{id, n}] API recipe ids + names; resolved in the browser
                "source": "blizzard-profile",
            }
        )
        summary = ", ".join("%s %s" % (k, v["rank"]) for k, v in professions.items()) or "no professions"
        print(f"Character {slug}: {summary}")
    return out
