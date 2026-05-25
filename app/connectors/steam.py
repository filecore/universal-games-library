import logging
import os
from datetime import datetime

import httpx

from db import get_session
from igdb import find_or_create_game
from models import IngestionRun, Ownership

log = logging.getLogger("games.steam")

STEAM_API_KEY = os.environ.get("STEAM_API_KEY", "")
STEAM_ID = os.environ.get("STEAM_ID", "")


def run():
    if not STEAM_API_KEY or not STEAM_ID:
        return _record("steam", False, "STEAM_API_KEY or STEAM_ID not set")

    url = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/"
    params = {
        "key": STEAM_API_KEY,
        "steamid": STEAM_ID,
        "include_appinfo": "true",
        "include_played_free_games": "true",
        "format": "json",
    }
    r = httpx.get(url, params=params, timeout=30)
    if r.status_code != 200:
        return _record("steam", False, f"HTTP {r.status_code}: {r.text[:200]}")

    games = r.json().get("response", {}).get("games", [])
    added, existing_count = 0, 0
    with get_session() as s:
        for entry in games:
            name = entry.get("name")
            if not name:
                continue
            game = find_or_create_game(s, name)
            already = (
                s.query(Ownership)
                .filter_by(
                    game_id=game.id,
                    store="steam",
                    external_id=str(entry["appid"]),
                )
                .first()
            )
            if already:
                existing_count += 1
                continue
            s.add(
                Ownership(
                    game_id=game.id,
                    store="steam",
                    platform="pc",
                    external_id=str(entry["appid"]),
                    is_physical=False,
                    raw=entry,
                )
            )
            added += 1

    return _record(
        "steam",
        True,
        f"Steam: {added} new, {existing_count} existing, {len(games)} total owned",
    )


def _record(source: str, success: bool, message: str):
    with get_session() as s:
        s.add(
            IngestionRun(
                source=source,
                ran_at=datetime.utcnow(),
                success=success,
                message=message,
            )
        )
    return {"source": source, "success": success, "message": message}
