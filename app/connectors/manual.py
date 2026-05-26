import csv
import io
import json
import logging
from datetime import datetime

from db import get_session
from igdb import find_or_create_game, normalise_title
from models import Game, IngestionRun, Ownership

log = logging.getLogger("games.manual")

VALID_STORES = {
    "steam", "psn", "epic", "blizzard", "ubisoft", "bgg",
    "meta-quest", "play-store", "humble",
}
DEFAULT_PLATFORM = {
    "steam": "pc",
    "psn": "ps5",
    "epic": "pc",
    "blizzard": "pc",
    "ubisoft": "pc",
    "bgg": "board",
    "meta-quest": "quest2",
    "play-store": "android",
    "humble": "pc",
}


def _int_or_none(v):
    try:
        if v in (None, "", "N/A"):
            return None
        return int(float(v))
    except (ValueError, TypeError):
        return None


def _is_expansion(row: dict) -> bool:
    itemtype = (row.get("itemtype") or "").strip().lower()
    subtype = (row.get("subtype") or "").strip().lower()
    objecttype = (row.get("objecttype") or "").strip().lower()
    return (
        itemtype == "expansion"
        or subtype == "boardgameexpansion"
        or objecttype == "expansion"
    )


def _bgg_find_or_create(session, row: dict):
    """Resolve a BGG CSV row to a canonical Game without calling IGDB
    (boardgames aren't in IGDB). For existing games, opportunistically
    backfill missing fields (cover_url, player counts, expansion tag)
    when the row carries them. Returns (game, was_enriched_bool)."""
    title = (row.get("objectname") or row.get("title") or row.get("name") or "").strip()
    if not title:
        return None, False
    year = _int_or_none(row.get("yearpublished") or row.get("year"))
    pmin = _int_or_none(row.get("minplayers"))
    pmax = _int_or_none(row.get("maxplayers"))
    cover = (row.get("image") or row.get("thumbnail") or "").strip() or None
    is_exp = _is_expansion(row)

    existing = (
        session.query(Game)
        .filter(Game.title_normalised == normalise_title(title))
        .first()
    )
    if existing:
        enriched = False
        if cover and not existing.cover_url:
            existing.cover_url = cover
            enriched = True
        if pmin and (not existing.player_count_min or existing.player_count_min == 1):
            existing.player_count_min = pmin
            enriched = True
        if pmax and (not existing.player_count_max or existing.player_count_max < pmax):
            existing.player_count_max = pmax
            enriched = True
        if year and not existing.release_year:
            existing.release_year = year
            enriched = True
        tags = list(existing.tags or [])
        if is_exp and "expansion" not in tags:
            tags.append("expansion")
            existing.tags = tags
            enriched = True
        elif not is_exp and "expansion" in tags:
            tags = [t for t in tags if t != "expansion"]
            existing.tags = tags
            enriched = True
        return existing, enriched

    tags = ["boardgame"]
    if is_exp:
        tags.append("expansion")

    game = Game(
        title=title,
        title_normalised=normalise_title(title),
        release_year=year,
        player_count_min=pmin or 1,
        player_count_max=pmax or 1,
        has_local_coop=False,
        has_local_vs=(pmax or 1) > 1,
        tags=tags,
        cover_url=cover,
    )
    session.add(game)
    session.flush()
    return game, True


def run(store: str, filename: str, content: bytes):
    if store not in VALID_STORES:
        return _record(f"manual:{store}", False, f"unknown store '{store}'")

    if filename.lower().endswith(".json"):
        try:
            data = json.loads(content)
        except Exception as e:
            return _record(f"manual:{store}", False, f"invalid JSON: {e}")
        rows = data if isinstance(data, list) else data.get("games", [])
    else:
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = content.decode("latin-1")
        reader = csv.DictReader(io.StringIO(text))
        rows = list(reader)

    added, existing_count, skipped, enriched = 0, 0, 0, 0
    with get_session() as s:
        for row in rows:
            if not isinstance(row, dict):
                skipped += 1
                continue

            if store == "bgg":
                if (row.get("own") or "").strip() == "0":
                    skipped += 1
                    continue
                game, was_enriched = _bgg_find_or_create(s, row)
                if game is not None and "expansion" in (game.tags or []):
                    # still create the ownership row so users can opt in to
                    # showing expansions; the filter excludes them by tag
                    pass
                if game is None:
                    skipped += 1
                    continue
                if was_enriched:
                    enriched += 1
                external_id = (
                    str(row.get("objectid") or row.get("external_id") or row.get("id") or "").strip()
                    or None
                )
                platform = (row.get("platform") or "board").strip()
                is_physical = True
            else:
                title = (row.get("title") or row.get("name") or "").strip()
                if not title:
                    skipped += 1
                    continue
                platform = (row.get("platform") or DEFAULT_PLATFORM[store]).strip()
                year = _int_or_none(row.get("year"))
                external_id = (
                    str(row.get("external_id") or row.get("id") or "").strip() or None
                )
                is_physical = str(row.get("is_physical") or "").lower() in (
                    "true",
                    "1",
                    "yes",
                    "y",
                )
                game = find_or_create_game(s, title, year_hint=year)

            already = (
                s.query(Ownership)
                .filter_by(game_id=game.id, store=store, external_id=external_id)
                .first()
            )
            if already:
                existing_count += 1
                continue
            s.add(
                Ownership(
                    game_id=game.id,
                    store=store,
                    platform=platform,
                    external_id=external_id,
                    is_physical=is_physical,
                    raw=row,
                )
            )
            added += 1

    parts = [f"{added} new", f"{existing_count} existing"]
    if enriched:
        parts.append(f"{enriched} enriched")
    if skipped:
        parts.append(f"{skipped} skipped")
    return _record(f"manual:{store}", True, f"{store}: " + ", ".join(parts))


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
