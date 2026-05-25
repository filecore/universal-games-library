import logging
import os
import re
import time
from typing import Any, Dict, List, Optional

import httpx

log = logging.getLogger("games.igdb")

IGDB_CLIENT_ID = os.environ.get("IGDB_CLIENT_ID", "")
IGDB_CLIENT_SECRET = os.environ.get("IGDB_CLIENT_SECRET", "")

_token_cache = {"token": None, "expires_at": 0}


def _get_token() -> Optional[str]:
    if not IGDB_CLIENT_ID or not IGDB_CLIENT_SECRET:
        return None
    now = time.time()
    if _token_cache["token"] and _token_cache["expires_at"] > now + 60:
        return _token_cache["token"]
    r = httpx.post(
        "https://id.twitch.tv/oauth2/token",
        params={
            "client_id": IGDB_CLIENT_ID,
            "client_secret": IGDB_CLIENT_SECRET,
            "grant_type": "client_credentials",
        },
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    _token_cache["token"] = data["access_token"]
    _token_cache["expires_at"] = now + data.get("expires_in", 3600)
    return _token_cache["token"]


def _headers():
    token = _get_token()
    if not token:
        return None
    return {
        "Client-ID": IGDB_CLIENT_ID,
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }


def normalise_title(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[™®©]", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()


def search_game(
    title: str, year_hint: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    headers = _headers()
    if not headers:
        log.info("IGDB not configured; skipping enrichment for %s", title)
        return None

    fields = (
        "fields name,first_release_date,multiplayer_modes.*,"
        "game_modes.name,genres.name,themes.name,keywords.name,"
        "cover.image_id,player_perspectives.name,platforms.name;"
    )
    safe = title.replace('"', "")
    where = f'search "{safe}";'
    body = f"{fields} {where} limit 10;"

    r = httpx.post(
        "https://api.igdb.com/v4/games",
        headers={**headers, "Content-Type": "text/plain"},
        content=body,
        timeout=15,
    )
    if r.status_code != 200:
        log.warning("IGDB search %s: %s", r.status_code, r.text[:200])
        return None
    results = r.json()
    if not results:
        return None
    if year_hint:
        for g in results:
            ts = g.get("first_release_date")
            if ts and time.gmtime(ts).tm_year == year_hint:
                return g
    return results[0]


def to_game_fields(igdb: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    out["igdb_id"] = igdb.get("id")
    out["title"] = igdb.get("name") or ""
    ts = igdb.get("first_release_date")
    if ts:
        out["release_year"] = time.gmtime(ts).tm_year

    pmin = pmax = None
    mp = igdb.get("multiplayer_modes") or []
    has_local_coop = has_online_coop = has_local_vs = has_online_vs = False
    for m in mp:
        if m.get("offlinecoop"):
            has_local_coop = True
        if m.get("onlinecoop"):
            has_online_coop = True
        if m.get("offlinemax") and m.get("offlinemax") > 1:
            has_local_vs = True
        if m.get("onlinemax") and m.get("onlinemax") > 1:
            has_online_vs = True
        for k in ("offlinecoopmax", "onlinecoopmax", "offlinemax", "onlinemax"):
            v = m.get(k)
            if v:
                pmax = max(pmax or 0, v)
        pmin = 1 if pmin is None else pmin

    out["player_count_min"] = pmin or 1
    out["player_count_max"] = pmax or 1
    out["has_local_coop"] = has_local_coop
    out["has_online_coop"] = has_online_coop
    out["has_local_vs"] = has_local_vs
    out["has_online_vs"] = has_online_vs

    gm = igdb.get("game_modes") or []
    out["has_campaign"] = any(m.get("name") == "Single player" for m in gm)
    out["genres"] = [g.get("name") for g in (igdb.get("genres") or []) if g.get("name")]

    tags: List[str] = []
    tags += [t.get("name") for t in (igdb.get("themes") or []) if t.get("name")]
    tags += [
        t.get("name") for t in (igdb.get("keywords") or [])[:20] if t.get("name")
    ]
    out["tags"] = tags

    cover = igdb.get("cover") or {}
    if cover.get("image_id"):
        out["cover_url"] = (
            "https://images.igdb.com/igdb/image/upload/"
            f"t_cover_big/{cover['image_id']}.jpg"
        )

    out["igdb_raw"] = igdb
    return out


def find_or_create_game(session, title: str, year_hint: Optional[int] = None):
    from models import Game

    norm = normalise_title(title)
    existing = (
        session.query(Game).filter(Game.title_normalised == norm).first()
    )
    if existing:
        return existing

    igdb = search_game(title, year_hint)
    if igdb:
        fields = to_game_fields(igdb)
        if fields.get("igdb_id"):
            by_igdb = (
                session.query(Game)
                .filter(Game.igdb_id == fields["igdb_id"])
                .first()
            )
            if by_igdb:
                return by_igdb
    else:
        fields = {
            "title": title,
            "player_count_min": 1,
            "player_count_max": 1,
        }
    fields["title_normalised"] = normalise_title(fields.get("title") or title)
    g = Game(**fields)
    session.add(g)
    session.flush()
    return g
