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
