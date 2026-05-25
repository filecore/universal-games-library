#!/bin/bash
set -euo pipefail

REMOTE="deploy@your-server"
REMOTE_PATH="~/universal-games-library"

cd "$(dirname "$0")"

# Make sure local changes are pushed before deploying — the canonical source is GitHub.
git push origin main

ssh "$REMOTE" "
    set -e
    if [ ! -d $REMOTE_PATH/.git ]; then
        git clone git@github.com:filecore/universal-games-library.git $REMOTE_PATH
    fi
    cd $REMOTE_PATH
    git fetch
    git reset --hard origin/main
    if [ ! -f .env ]; then
        echo 'ERROR: .env not present on the homelab server at $REMOTE_PATH'
        echo 'Copy .env.example and fill it in, then re-run deploy.sh'
        exit 1
    fi
    docker compose up -d --build
    docker compose ps
"

echo
echo 'Deploy complete. Site: https://games.togneri.net'
