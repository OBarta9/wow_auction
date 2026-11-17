"""Minimal Blizzard Battle.net API client (stdlib only).

Uses the OAuth client-credentials flow; create a free client at
https://develop.battle.net/access/clients.
"""
from __future__ import annotations

import base64
import gzip
import json
import time
import urllib.error
import urllib.parse
import urllib.request

TOKEN_URL = "https://oauth.battle.net/token"
USER_AGENT = "wow-auction-helper/1.0 (personal use)"


class ApiError(RuntimeError):
    def __init__(self, status: int, url: str, body: str = ""):
        super().__init__(f"HTTP {status} for {url} {body[:300]}")
        self.status = status
        self.url = url


def _request(req: urllib.request.Request, retries: int = 4, timeout: int = 120) -> bytes:
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return data
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace") if e.fp else ""
            # 429 / 5xx are retryable, everything else is final.
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(delay)
                delay *= 2
                continue
            raise ApiError(e.code, req.full_url, body) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt < retries:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    raise AssertionError("unreachable")


class BlizzardClient:
    def __init__(self, client_id: str, client_secret: str, region: str = "eu", locale: str = "en_GB"):
        if not client_id or not client_secret:
            raise SystemExit(
                "Missing Blizzard API credentials. Set BLIZZARD_CLIENT_ID and "
                "BLIZZARD_CLIENT_SECRET (or create secrets.json). "
                "Get them free at https://develop.battle.net/access/clients"
            )
        self.client_id = client_id
        self.client_secret = client_secret
        self.region = region
        self.locale = locale
        self.host = f"https://{region}.api.blizzard.com"
        self._token: str | None = None
        self._token_expiry = 0.0

    # -- auth -------------------------------------------------------------
    def token(self) -> str:
        if self._token and time.time() < self._token_expiry - 60:
            return self._token
        basic = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        req = urllib.request.Request(
            TOKEN_URL,
            data=urllib.parse.urlencode({"grant_type": "client_credentials"}).encode(),
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": USER_AGENT,
            },
            method="POST",
        )
        payload = json.loads(_request(req))
        self._token = payload["access_token"]
        self._token_expiry = time.time() + int(payload.get("expires_in", 3600))
        return self._token

    # -- generic GET ------------------------------------------------------
    def get(self, path_or_url: str, namespace: str, **params) -> dict:
        if path_or_url.startswith("http"):
            url = path_or_url
        else:
            url = self.host + path_or_url
        q = {"namespace": namespace, "locale": self.locale, **params}
        parsed = urllib.parse.urlsplit(url)
        existing = dict(urllib.parse.parse_qsl(parsed.query))
        existing.update(q)
        url = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(existing)))
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {self.token()}",
                "Accept-Encoding": "gzip",
                "User-Agent": USER_AGENT,
            },
        )
        return json.loads(_request(req))

    # -- WoW Forever endpoints ------------------------------------------------
    # Forever is realmless: rulesets replace (connected) realms.
    def rulesets(self, namespace: str) -> list[dict]:
        data = self.get("/data/wow/ruleset/index", namespace)
        return [{"id": r.get("id"), "name": _name(r.get("name"))} for r in data.get("rulesets", [])]

    def auction_houses(self, namespace: str, ruleset_id: int) -> list[dict]:
        """[{id, name}] - note the trailing slash, the API requires it."""
        data = self.get(f"/data/wow/ruleset/{ruleset_id}/auctions/", namespace)
        return [{"id": a["id"], "name": _name(a.get("name"))} for a in data.get("auctions", [])]

    def auctions(self, namespace: str, ruleset_id: int, house_id: int) -> list[dict]:
        """Item auctions + commodity auctions of one house, as one list."""
        base = f"/data/wow/ruleset/{ruleset_id}/auctions/{house_id}"
        items = self.get(base, namespace).get("auctions", []) or []
        try:
            commodities = self.get(base + "/commodities", namespace).get("auctions", []) or []
        except ApiError as e:
            if e.status != 404:
                raise
            commodities = []
        return items + commodities

    def character_professions(self, namespace: str, slug: str) -> dict:
        """slug = "name-surname" in lowercase (Forever characters are realmless)."""
        quoted = urllib.parse.quote(slug.lower())
        return self.get(f"/profile/wow/character/{quoted}/professions", namespace)

    def character_profile(self, namespace: str, slug: str) -> dict:
        quoted = urllib.parse.quote(slug.lower())
        return self.get(f"/profile/wow/character/{quoted}", namespace)


def _name(v):
    """API names are either a plain string (when locale is set) or a locale dict."""
    if isinstance(v, dict):
        return v.get("en_GB") or v.get("en_US") or next(iter(v.values()), None)
    return v
