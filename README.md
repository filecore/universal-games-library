# Universal Games Library

A unified, filterable view of game ownership across multiple stores and platforms (Steam, PSN, Epic, Blizzard, Ubisoft, BoardGameGeek). Self-hosted on the homelab server; the site itself is public read-only. Ingestion endpoints can be locked behind an optional shared token.

## What it does

- Pulls Steam library via the official Web API.
- Pulls BoardGameGeek collection via XMLAPI2 (with the standard 202-retry).
- Accepts manual CSV/JSON uploads for any other store (PSN, Epic, Ubisoft, Blizzard).
- Enriches each title via the IGDB API: player count, multiplayer modes (local/online coop, local/online vs), genres, tags, cover art.
- Dedupes cross-store ownership via IGDB ID + normalised title match. A game owned on Steam *and* Ubisoft Connect shows as one card with two badges.
- Frontend with filters for store, platform, player count, multiplayer modes, genres, physical/digital, and free-text title search.

Live: https://games.togneri.net (public)

## Stack

- FastAPI + SQLAlchemy + Postgres 16
- Vanilla HTML/JS frontend served by FastAPI
- Docker Compose on the homelab server, Traefik (no auth middleware)

## Local layout

```
docker-compose.yml            postgres + app
docker-compose.override.yml   Traefik + TinyAuth labels
.env.example                  template (do not commit .env)
app/
  Dockerfile
  requirements.txt
  main.py                     FastAPI app
  db.py                       SQLAlchemy engine + session
  models.py                   Game, Ownership, IngestionRun
  igdb.py                     IGDB OAuth + search + enrichment
  connectors/
    steam.py                  IPlayerService/GetOwnedGames
    bgg.py                    BGG XMLAPI2 with 202-retry
    manual.py                 CSV/JSON upload handler
web/
  templates/index.html
  static/{styles.css,app.js}
data/
  blizzard.json.example
  ubisoft.csv.example
  psn.csv.example
  epic.csv.example
```

## Setup (homelab server)

1. SSH to the homelab server: `ssh deploy@your-server`
2. Clone: `git clone git@github.com:filecore/universal-games-library.git ~/universal-games-library`
3. `cd ~/universal-games-library`
4. Copy env template and fill in: `cp .env.example .env`, then edit:
   - `POSTGRES_PASSWORD` (pick something random)
   - `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET` from https://dev.twitch.tv/console
   - `STEAM_API_KEY` from https://steamcommunity.com/dev/apikey
   - `STEAM_ID` (SteamID64, find via https://steamid.io)
   - `BGG_USERNAME` (your BGG username)
5. `docker compose up -d --build`
6. Cloudflare Companion will auto-create the DNS record for `games.togneri.net`. Verify resolution after a minute.
7. Hit https://games.togneri.net, click Steam and BGG to do the first ingestion. Upload manual CSV/JSON for Epic / PSN / Ubisoft / Blizzard.

### Locking the ingest endpoints (optional)

Set `INGEST_TOKEN=<random-string>` in `.env`. The frontend will then prompt for the token the first time you click an ingest button, store it in `localStorage`, and send it as `X-Ingest-Token`. Without this, any visitor can hit POST `/api/ingest/*` and (most damagingly) upload arbitrary manual CSV.

## Deploy from laptop

```
./deploy.sh
```

This SSHes to the homelab server, pulls the latest from the filecore GitHub remote, and runs `docker compose up -d --build`. The `.env` file on the homelab server is left alone (it is gitignored).

## API

| Method | Path                                | Notes                                       |
| ------ | ----------------------------------- | ------------------------------------------- |
| GET    | `/healthz`                          | Liveness                                    |
| GET    | `/api/games`                        | Full library, JSON                          |
| GET    | `/api/runs`                         | Last 50 ingestion runs                      |
| POST   | `/api/ingest/steam`                 | Trigger Steam ingestion                     |
| POST   | `/api/ingest/bgg`                   | Trigger BGG ingestion                       |
| POST   | `/api/ingest/manual?store=<store>`  | Multipart upload of CSV/JSON                |

## CSV / JSON formats for manual import

CSV columns (all optional except `title`):
- `title` (required)
- `platform` (defaults per store: `pc`, `ps5`, `board`)
- `year`
- `external_id`
- `is_physical` (true/false)

JSON: a list of objects with the same keys, or `{"games": [...]}`.

## Why no PSN / Epic auto-ingestion?

Both are possible (psnawp for PSN, Legendary for Epic) but require periodic token refresh and unofficial API maintenance. Since the user's library changes infrequently (mostly the PS5 picks up a new game now and then), manual CSV import is the pragmatic choice. The connector hooks are there if automation becomes worth the upkeep.
