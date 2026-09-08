#!/bin/zsh
# Daily pipeline, chained: find new leads, then classify/filter/enrich them.
#
# If you're scheduling this with launchd/cron, note that both run with a
# bare environment (no shell profile sourced), so `python3`/`node` on your
# normal PATH may not be visible. Uncomment and adjust the PATH line below
# if the scheduled run can't find them, or hardcode full binary paths.

# export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO" || exit 1

python3 find-listings.py
node classify-new-leads.mjs
