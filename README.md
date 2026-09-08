# daily-leads

Finds job postings on Ashby, Lever, and Greenhouse company boards that
don't show up on aggregator sites, filters out ones that don't fit your
criteria, and gives you a local web UI to review what's left.

## How it works

1. **`find-listings.py`** runs `site:`-scoped Google searches (via
   [Serper](https://serper.dev)) across your target job titles, restricted
   to postings from the last day, and appends anything new to
   `data/leads-seen.tsv`.
2. **`classify-new-leads.mjs`** fetches the real job description for each
   new lead (via each ATS's public API, not scraped HTML), applies a free
   location filter, then uses an LLM to judge the rest against
   `criteria.md` — auto-filtering clear mismatches with the model's
   reasoning saved for audit, and leaving everything else for you.
3. **`review-app/`** is a local Node server + single-page UI
   (`http://127.0.0.1:3211`) where you review what's left: pass with a
   reason, flag for deeper research, blacklist a company, or watch one.

Everything is flat TSV/markdown files under `data/` — no database, easy to
inspect or edit by hand.

## Setup

1. **Serper**: sign up at [serper.dev](https://serper.dev) (free tier,
   2,500 queries), copy your API key.
2. **Claude**: this uses `@anthropic-ai/claude-agent-sdk`, authenticated
   through your existing Claude Code / Claude subscription login — no
   separate API key needed. Run `npm install` first.
3. Copy `.env.example` to `.env` and fill in `SERPER_API_KEY`.
4. Copy `config.example.json` to `config.json` and edit your target titles
   and ATS sites.
5. Copy `criteria.example.md` to `criteria.md` and describe what you're
   *not* looking for — this drives the auto-filter. Be specific; the
   example in the file explains why.

## Running

Manually:

```sh
./run-daily.sh              # find + classify
node review-app/server.mjs  # review UI at http://127.0.0.1:3211
```

To run automatically every day, `launchd/*.plist.example` has templates
for macOS (one for the daily find+classify job, one to keep the review
app running persistently). Copy them to `~/Library/LaunchAgents/`, edit
the `/path/to/daily-leads` placeholders, and `launchctl load -w` each one.
On Linux, a cron entry calling `run-daily.sh` and a systemd user service
for the review app would do the same job — not included here, but the
scripts don't assume macOS.

## Cost

Each classification call is small (thinking capped at 1024 tokens) and
runs against your Claude subscription's usage, not separate API billing.
At the default 8 titles × 3 sites (24 searches/day), expect roughly
10–40 new leads/day depending on your titles, most of which get resolved
by the free location filter before ever reaching the LLM.

## Customizing

Everything user-specific lives in two gitignored files, so you can pull
updates without ever hitting a merge conflict on your own settings:

- **`config.json`** — target titles, ATS sites, model, target country (or
  turn the location filter off), pass-reason labels, and `dataDir` (where
  your ledger lives — handy if you want this checked out inside a larger
  repo with data kept elsewhere).
- **`criteria.md`** — free text, read verbatim by the classifier alongside
  each JD. This is the auto-filter's whole judgment.

## License

MIT
