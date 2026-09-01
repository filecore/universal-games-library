import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from auth import verify as verify_user, APPROVED_USERS
from connectors import bgg, manual, steam
from db import get_session, init_db
from models import Game, IngestionRun, Ownership

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("games")

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
if not SESSION_SECRET:
    raise RuntimeError(
        "SESSION_SECRET is not set. Generate one with `openssl rand -hex 32`."
    )

BUILD_ID = str(int(time.time()))
SCRIPTS_DIR = Path("scripts")
DOWNLOAD_SCRIPTS = {
    "debian": "prepare-gaming-pc-debian.sh",
    "fedora": "prepare-gaming-pc-fedora.sh",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Universal Games Library", lifespan=lifespan)
app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET,
    same_site="lax",
    https_only=True,
    max_age=60 * 60 * 24 * 30,
)
templates = Jinja2Templates(directory="web/templates")
app.mount("/static", StaticFiles(directory="web/static"), name="static")


def require_user(request: Request) -> str:
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="login required")
    return user


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    response = templates.TemplateResponse(
        "index.html",
        {"request": request, "build_id": BUILD_ID},
    )
    response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


@app.get("/api/me")
def me(request: Request):
    return {"user": request.session.get("user")}


@app.get("/api/downloads/{key}")
def download_prepare_gaming_pc(key: str, request: Request):
    require_user(request)
    filename = DOWNLOAD_SCRIPTS.get(key)
    if not filename:
        raise HTTPException(status_code=404, detail="not found")
    path = SCRIPTS_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="not found")
    return PlainTextResponse(
        path.read_text(),
        media_type="text/x-sh",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@app.post("/api/login")
def login(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
):
    ok, first_time = verify_user(username, password)
    if not ok:
        raise HTTPException(status_code=401, detail="invalid credentials")
    request.session["user"] = username
    return {"user": username, "first_time": first_time}


@app.post("/api/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/games")
def list_games():
    with get_session() as s:
        rows = s.query(Game).all()
        out = []
        for g in rows:
            owns = g.ownership
            total_pt = sum((o.playtime_minutes or 0) for o in owns)
            has_any_pt = any(o.playtime_minutes is not None for o in owns)
            out.append({
                "id": g.id,
                "title": g.title,
                "release_year": g.release_year,
                "player_count_min": g.player_count_min,
                "player_count_max": g.player_count_max,
                "has_local_coop": g.has_local_coop,
                "has_online_coop": g.has_online_coop,
                "has_local_vs": g.has_local_vs,
                "has_online_vs": g.has_online_vs,
                "has_campaign": g.has_campaign,
                "genres": g.genres or [],
                "tags": g.tags or [],
                "cover_url": g.cover_url,
                "playtime_minutes": total_pt if has_any_pt else None,
                "ownership": [
                    {
                        "store": o.store,
                        "platform": o.platform,
                        "is_physical": o.is_physical,
                        "playtime_minutes": o.playtime_minutes,
                    }
                    for o in owns
                ],
            })
        return out


@app.get("/api/status")
def status():
    from sqlalchemy import cast, distinct, func
    from sqlalchemy.dialects.postgresql import JSONB
    with get_session() as s:
        store_rows = (
            s.query(Ownership.store, func.count(distinct(Ownership.game_id)))
            .group_by(Ownership.store)
            .all()
        )
        stores = {store: count for store, count in store_rows}
        bgg_owned = (
            s.query(Ownership).filter(Ownership.store == "bgg").count()
        )
        bgg_expansions = (
            s.query(Ownership)
            .join(Game, Ownership.game_id == Game.id)
            .filter(
                Ownership.store == "bgg",
                Game.tags.cast(JSONB).contains(cast(["expansion"], JSONB)),
            )
            .count()
        )
        bgg_with_cover = (
            s.query(Ownership)
            .join(Game, Ownership.game_id == Game.id)
            .filter(Ownership.store == "bgg", Game.cover_url.isnot(None))
            .count()
        )
        steam_owned = (
            s.query(Ownership).filter(Ownership.store == "steam").count()
        )
        last_bgg_enrich = (
            s.query(IngestionRun)
            .filter(IngestionRun.source == "bgg:enrich")
            .order_by(IngestionRun.ran_at.desc())
            .first()
        )
        last_steam = (
            s.query(IngestionRun)
            .filter(IngestionRun.source == "steam")
            .order_by(IngestionRun.ran_at.desc())
            .first()
        )
        last_bgg_ingest = (
            s.query(IngestionRun)
            .filter(IngestionRun.source == "bgg")
            .order_by(IngestionRun.ran_at.desc())
            .first()
        )

        def _run(r):
            if r is None:
                return None
            return {
                "ran_at": r.ran_at.isoformat() if r.ran_at else None,
                "success": r.success,
                "message": r.message,
            }

        return {
            "stores": stores,
            "bgg": {
                "owned": bgg_owned,
                "expansions": bgg_expansions,
                "base_games": bgg_owned - bgg_expansions,
                "with_cover": bgg_with_cover,
                "without_cover": bgg_owned - bgg_with_cover,
                "last_enrich": _run(last_bgg_enrich),
                "last_ingest": _run(last_bgg_ingest),
            },
            "steam": {
                "owned": steam_owned,
                "last_ingest": _run(last_steam),
            },
        }


@app.post("/api/ingest/steam")
def ingest_steam(request: Request):
    require_user(request)
    return steam.run()


@app.post("/api/ingest/bgg")
def ingest_bgg(request: Request):
    require_user(request)
    return bgg.run()


@app.post("/api/enrich/bgg-images")
def enrich_bgg_images(request: Request):
    require_user(request)
    return bgg.enrich_images()


@app.post("/api/ingest/manual")
async def ingest_manual(
    request: Request,
    store: str,
    file: UploadFile = File(...),
):
    require_user(request)
    content = await file.read()
    return manual.run(store, file.filename or "upload", content)


@app.patch("/api/games/{game_id}")
def update_game(game_id: int, request: Request, payload: dict = Body(...)):
    require_user(request)
    bool_fields = {
        "has_local_coop",
        "has_online_coop",
        "has_local_vs",
        "has_online_vs",
        "has_campaign",
    }
    scalar_fields = {
        "title",
        "release_year",
        "cover_url",
        "igdb_id",
        "player_count_min",
        "player_count_max",
    }
    list_fields = {"genres", "tags"}
    updates = {}
    for k, v in payload.items():
        if k in bool_fields:
            updates[k] = bool(v)
        elif k in scalar_fields:
            if v == "" or v is None:
                updates[k] = None
            elif k in ("release_year", "igdb_id", "player_count_min", "player_count_max"):
                try:
                    updates[k] = int(v)
                except (TypeError, ValueError):
                    raise HTTPException(status_code=400, detail=f"{k} must be int")
            else:
                updates[k] = str(v)
        elif k in list_fields:
            if isinstance(v, list):
                updates[k] = [str(x).strip() for x in v if str(x).strip()]
            elif isinstance(v, str):
                updates[k] = [s.strip() for s in v.split(",") if s.strip()]
    if not updates:
        raise HTTPException(status_code=400, detail="no valid fields")
    with get_session() as s:
        game = s.get(Game, game_id)
        if not game:
            raise HTTPException(status_code=404, detail="not found")
        # Title change implies title_normalised change
        if "title" in updates and updates["title"]:
            from igdb import normalise_title
            game.title_normalised = normalise_title(updates["title"])
        for k, v in updates.items():
            setattr(game, k, v)
    return {"ok": True, "updated": list(updates.keys())}


@app.get("/api/games/{game_id}/raw")
def game_raw(game_id: int, request: Request):
    require_user(request)
    with get_session() as s:
        game = s.get(Game, game_id)
        if not game:
            raise HTTPException(status_code=404, detail="not found")
        return {
            "id": game.id,
            "title": game.title,
            "title_normalised": game.title_normalised,
            "igdb_id": game.igdb_id,
            "release_year": game.release_year,
            "cover_url": game.cover_url,
            "player_count_min": game.player_count_min,
            "player_count_max": game.player_count_max,
            "has_local_coop": game.has_local_coop,
            "has_online_coop": game.has_online_coop,
            "has_local_vs": game.has_local_vs,
            "has_online_vs": game.has_online_vs,
            "has_campaign": game.has_campaign,
            "genres": game.genres,
            "tags": game.tags,
            "igdb_raw": game.igdb_raw,
            "created_at": game.created_at.isoformat() if game.created_at else None,
            "updated_at": game.updated_at.isoformat() if game.updated_at else None,
            "ownership": [
                {
                    "id": o.id,
                    "store": o.store,
                    "platform": o.platform,
                    "external_id": o.external_id,
                    "is_physical": o.is_physical,
                    "playtime_minutes": o.playtime_minutes,
                    "raw": o.raw,
                }
                for o in game.ownership
            ],
        }


@app.post("/api/games/{game_id}/refetch-igdb")
def refetch_igdb(game_id: int, request: Request):
    """Re-pull the IGDB record for the game's stored igdb_id and apply
    every derived field (cover, year, genres, tags, multiplayer flags).
    Keeps the canonical title as-is unless title field is blank."""
    require_user(request)
    import httpx
    from igdb import _get_token, IGDB_CLIENT_ID, to_game_fields, normalise_title

    with get_session() as s:
        game = s.get(Game, game_id)
        if not game:
            raise HTTPException(status_code=404, detail="not found")
        if not game.igdb_id:
            raise HTTPException(status_code=400, detail="no igdb_id set")
        igdb_id = game.igdb_id

    headers = {
        "Client-ID": IGDB_CLIENT_ID,
        "Authorization": f"Bearer {_get_token()}",
        "Content-Type": "text/plain",
        "Accept": "application/json",
    }
    body = (
        "fields name,first_release_date,multiplayer_modes.*,game_modes.name,"
        "genres.name,themes.name,keywords.name,cover.image_id,player_perspectives.name,"
        f"platforms.name; where id = {igdb_id};"
    )
    r = httpx.post(
        "https://api.igdb.com/v4/games", headers=headers, content=body, timeout=15
    )
    if r.status_code != 200 or not r.json():
        raise HTTPException(status_code=502, detail=f"IGDB lookup failed: {r.status_code}")
    fields = to_game_fields(r.json()[0])

    with get_session() as s:
        game = s.get(Game, game_id)
        game.title = fields["title"]
        game.title_normalised = normalise_title(fields["title"])
        if fields.get("cover_url"):
            game.cover_url = fields["cover_url"]
        if fields.get("release_year"):
            game.release_year = fields["release_year"]
        if fields.get("player_count_max") and fields["player_count_max"] > 1:
            game.player_count_min = fields.get("player_count_min", 1)
            game.player_count_max = fields["player_count_max"]
        for flag in (
            "has_local_coop",
            "has_online_coop",
            "has_local_vs",
            "has_online_vs",
            "has_campaign",
        ):
            setattr(game, flag, fields.get(flag, False))
        if fields.get("genres"):
            game.genres = fields["genres"]

    return {"ok": True, "title": fields["title"]}


@app.get("/api/runs")
def runs():
    with get_session() as s:
        rows = (
            s.query(IngestionRun)
            .order_by(IngestionRun.ran_at.desc())
            .limit(50)
            .all()
        )
        return [
            {
                "source": r.source,
                "ran_at": r.ran_at.isoformat() if r.ran_at else None,
                "success": r.success,
                "message": r.message,
            }
            for r in rows
        ]
