import csv
import io
import json
import logging
from datetime import datetime

from db import get_session
from igdb import find_or_create_game
from models import IngestionRun, Ownership

log = logging.getLogger("games.manual")

VALID_STORES = {"steam", "psn", "epic", "blizzard", "ubisoft", "bgg"}
DEFAULT_PLATFORM = {
    "steam": "pc",
    "psn": "ps5",
    "epic": "pc",
    "blizzard": "pc",
    "ubisoft": "pc",
    "bgg": "board",
}


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

    added, existing_count, skipped = 0, 0, 0
    with get_session() as s:
        for row in rows:
            title = (row.get("title") or row.get("name") or "").strip()
            if not title:
                skipped += 1
                continue
            platform = (row.get("platform") or DEFAULT_PLATFORM[store]).strip()
            try:
                year = int(row["year"]) if row.get("year") else None
            except (ValueError, TypeError):
                year = None
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
                    raw=row if isinstance(row, dict) else None,
                )
            )
            added += 1

    return _record(
        f"manual:{store}",
        True,
        f"{store}: {added} new, {existing_count} existing, {skipped} skipped",
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
