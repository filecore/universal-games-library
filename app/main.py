import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
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
        return [
            {
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
                "ownership": [
                    {
                        "store": o.store,
                        "platform": o.platform,
                        "is_physical": o.is_physical,
                    }
                    for o in g.ownership
                ],
            }
            for g in rows
        ]


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
    allowed = {
        "has_local_coop",
        "has_online_coop",
        "has_local_vs",
        "has_online_vs",
        "has_campaign",
    }
    updates = {k: bool(payload[k]) for k in allowed if k in payload}
    if not updates:
        raise HTTPException(status_code=400, detail="no valid fields")
    with get_session() as s:
        game = s.get(Game, game_id)
        if not game:
            raise HTTPException(status_code=404, detail="not found")
        for k, v in updates.items():
            setattr(game, k, v)
    return {"ok": True, "updated": list(updates.keys())}


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
