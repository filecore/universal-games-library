import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from connectors import bgg, manual, steam
from db import get_session, init_db
from models import Game, IngestionRun

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("games")

INGEST_TOKEN = os.environ.get("INGEST_TOKEN", "")


def require_ingest_token(token: str | None):
    if not INGEST_TOKEN:
        return
    if token != INGEST_TOKEN:
        raise HTTPException(status_code=401, detail="ingest token required")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Universal Games Library", lifespan=lifespan)
templates = Jinja2Templates(directory="web/templates")
app.mount("/static", StaticFiles(directory="web/static"), name="static")


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/games")
def list_games():
    with get_session() as s:
        rows = s.query(Game).all()
        out = []
        for g in rows:
            out.append(
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
            )
        return out


@app.post("/api/ingest/steam")
def ingest_steam(x_ingest_token: str | None = Header(default=None)):
    require_ingest_token(x_ingest_token)
    return steam.run()


@app.post("/api/ingest/bgg")
def ingest_bgg(x_ingest_token: str | None = Header(default=None)):
    require_ingest_token(x_ingest_token)
    return bgg.run()


@app.post("/api/enrich/bgg-images")
def enrich_bgg_images(x_ingest_token: str | None = Header(default=None)):
    require_ingest_token(x_ingest_token)
    return bgg.enrich_images()


@app.post("/api/ingest/manual")
async def ingest_manual(
    store: str,
    file: UploadFile = File(...),
    x_ingest_token: str | None = Header(default=None),
):
    require_ingest_token(x_ingest_token)
    content = await file.read()
    return manual.run(store, file.filename or "upload", content)


@app.get("/api/config")
def config():
    return {"ingest_protected": bool(INGEST_TOKEN)}


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
                "next_refresh_due_at": (
                    r.next_refresh_due_at.isoformat()
                    if r.next_refresh_due_at
                    else None
                ),
            }
            for r in rows
        ]
