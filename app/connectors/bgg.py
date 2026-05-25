import logging
import os
import time
import xml.etree.ElementTree as ET
from datetime import datetime

import httpx

from db import get_session
from igdb import normalise_title
from models import Game, IngestionRun, Ownership

log = logging.getLogger("games.bgg")

BGG_USERNAME = os.environ.get("BGG_USERNAME", "")
BGG_THING_BATCH = 20
BGG_ENRICH_PER_RUN = 200


def run():
    if not BGG_USERNAME:
        return _record("bgg", False, "BGG_USERNAME not set")

    url = "https://boardgamegeek.com/xmlapi2/collection"
    params = {"username": BGG_USERNAME, "own": "1", "stats": "1"}

    r = None
    for attempt in range(6):
        r = httpx.get(url, params=params, timeout=30)
        if r.status_code == 200:
            break
        if r.status_code == 202:
            time.sleep(5 + attempt * 2)
            continue
        return _record("bgg", False, f"HTTP {r.status_code}: {r.text[:200]}")
    else:
        return _record("bgg", False, "BGG queue did not resolve after 6 attempts")

    root = ET.fromstring(r.text)
    added, existing_count = 0, 0
    with get_session() as s:
        for item in root.findall("item"):
            objid = item.get("objectid")
            name_el = item.find("name")
            name = name_el.text if name_el is not None else None
            if not name:
                continue
            year_el = item.find("yearpublished")
            try:
                year = int(year_el.text) if year_el is not None and year_el.text else None
            except ValueError:
                year = None
            stats = item.find("stats")
            pmin = pmax = None
            if stats is not None:
                try:
                    pmin = int(stats.get("minplayers")) if stats.get("minplayers") else None
                    pmax = int(stats.get("maxplayers")) if stats.get("maxplayers") else None
                except ValueError:
                    pass

            game = (
                s.query(Game)
                .filter(Game.title_normalised == normalise_title(name))
                .first()
            )
            if not game:
                game = Game(
                    title=name,
                    title_normalised=normalise_title(name),
                    release_year=year,
                    player_count_min=pmin or 1,
                    player_count_max=pmax or 1,
                    has_local_coop=False,
                    has_local_vs=(pmax or 1) > 1,
                    tags=["boardgame"],
                )
                s.add(game)
                s.flush()

            already = (
                s.query(Ownership)
                .filter_by(game_id=game.id, store="bgg", external_id=str(objid))
                .first()
            )
            if already:
                existing_count += 1
                continue
            s.add(
                Ownership(
                    game_id=game.id,
                    store="bgg",
                    platform="board",
                    external_id=str(objid),
                    is_physical=True,
                )
            )
            added += 1

    return _record("bgg", True, f"BGG: {added} new, {existing_count} existing")


def enrich_images():
    """Fetch BGG /thing metadata for games owned via BGG that have no
    cover_url yet. Populates cover_url (and refines player counts when
    present). Returns counts so the UI can display progress."""
    with get_session() as s:
        rows = (
            s.query(Game, Ownership)
            .join(Ownership, Ownership.game_id == Game.id)
            .filter(Ownership.store == "bgg", Game.cover_url.is_(None))
            .limit(BGG_ENRICH_PER_RUN)
            .all()
        )
        candidates = [(g, o) for g, o in rows if o.external_id]

    if not candidates:
        return _record("bgg:enrich", True, "Nothing to enrich")

    by_id = {o.external_id: g for g, o in candidates}
    ids = list(by_id.keys())
    updated, skipped = 0, 0
    api_failed = False
    last_error = ""

    for i in range(0, len(ids), BGG_THING_BATCH):
        batch = ids[i : i + BGG_THING_BATCH]
        url = "https://boardgamegeek.com/xmlapi2/thing"
        params = {"id": ",".join(batch), "type": "boardgame,boardgameexpansion"}
        try:
            r = httpx.get(url, params=params, timeout=30)
        except Exception as e:
            api_failed = True
            last_error = str(e)
            break
        if r.status_code != 200:
            api_failed = True
            last_error = f"HTTP {r.status_code}"
            break

        try:
            root = ET.fromstring(r.text)
        except ET.ParseError as e:
            api_failed = True
            last_error = f"parse error: {e}"
            break

        with get_session() as s:
            for item in root.findall("item"):
                bgg_id = item.get("id")
                if bgg_id not in by_id:
                    skipped += 1
                    continue
                image_el = item.find("image")
                thumb_el = item.find("thumbnail")
                cover = (image_el.text if image_el is not None else None) or (
                    thumb_el.text if thumb_el is not None else None
                )
                if not cover:
                    skipped += 1
                    continue
                g = s.get(Game, by_id[bgg_id].id)
                if g is None:
                    skipped += 1
                    continue
                g.cover_url = cover
                # Refine player count if BGG reports a wider range
                minp_el = item.find("minplayers")
                maxp_el = item.find("maxplayers")
                try:
                    minp = int(minp_el.get("value")) if minp_el is not None else None
                except (TypeError, ValueError):
                    minp = None
                try:
                    maxp = int(maxp_el.get("value")) if maxp_el is not None else None
                except (TypeError, ValueError):
                    maxp = None
                if minp and (not g.player_count_min or minp < g.player_count_min):
                    g.player_count_min = minp
                if maxp and (not g.player_count_max or maxp > g.player_count_max):
                    g.player_count_max = maxp
                updated += 1

        # Be polite to BGG
        time.sleep(1)

    if api_failed:
        return _record(
            "bgg:enrich",
            False,
            f"BGG API failed after {updated} updated: {last_error}",
        )
    return _record(
        "bgg:enrich",
        True,
        f"BGG covers: {updated} updated, {skipped} skipped of {len(candidates)} candidates",
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
