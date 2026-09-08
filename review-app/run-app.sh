#!/bin/zsh
# Local interface wrapper for launchd. See run-daily.sh's note about PATH --
# launchd runs with a bare environment.

# export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1

exec node server.mjs >> "$REPO/server.log" 2>&1
