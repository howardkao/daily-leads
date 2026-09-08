#!/usr/bin/env node
// Local review UI for leads found by ../find-listings.py. Vanilla node:http,
// no dependencies. Reads/writes the same flat files find-listings.py and
// classify-new-leads.mjs use, so nothing here needs a Claude session running.

import { createServer } from "node:http";
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(APP_DIR, "..");
const PUBLIC_DIR = join(APP_DIR, "public");
const CONFIG_FILE = join(PROJECT_DIR, "config.json");
const PORT = 3211;

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    console.error(`Missing ${CONFIG_FILE} -- copy config.example.json to config.json and edit it.`);
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  config.dataDir ??= "data";
  return config;
}

// dataDir is relative to the project dir (one level up from this app), so
// the same code serves a standalone checkout and one nested in a larger repo.
const CONFIG = loadConfig();
const DATA_DIR = resolve(PROJECT_DIR, CONFIG.dataDir);
const SEEN_FILE = join(DATA_DIR, "leads-seen.tsv");
const DECISIONS_FILE = join(DATA_DIR, "lead-decisions.tsv");
const BLACKLIST_FILE = join(DATA_DIR, "company-blacklist.md");
const WATCHLIST_FILE = join(DATA_DIR, "company-watchlist.md");
const TRIAGE_QUEUE_DIR = join(DATA_DIR, "triage-queue");
// Optional: a separate file listing companies you're already tracking, used
// only to flag them in the UI. null/absent disables the flag entirely.
const KNOWN_COMPANIES_FILE = CONFIG.knownCompaniesFile
  ? resolve(PROJECT_DIR, CONFIG.knownCompaniesFile)
  : null;

const SEEN_COLUMNS = ["fingerprint", "first_seen", "last_seen", "company", "title", "url", "snippet", "posted_at", "location", "classified_at"];
const DECISION_COLUMNS = ["fingerprint", "decided_at", "decision", "reason", "note", "company"];

const REASON_LABELS = CONFIG.reasonLabels ?? {
  pay_too_low: "Pay too low",
  location_commute: "Location / commute unreasonable",
  mission_misalignment: "Misaligned",
  not_pm_role: "Not the right role type",
  level_mismatch: "Level mismatch",
  other: "Other",
};

function getTopReasons(limit = 2) {
  // Ranked by your actual manual-pass history, not hardcoded -- adapts as
  // your patterns shift. Excludes auto_* (those aren't manual clicks) and
  // "other" (a free-text catch-all, never worth a dedicated quick button).
  const counts = {};
  for (const d of readTsv(DECISIONS_FILE, DECISION_COLUMNS)) {
    if (d.decision !== "pass" || !d.reason || d.reason.startsWith("auto_") || d.reason === "other") continue;
    counts[d.reason] = (counts[d.reason] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason]) => reason);
}

function normalize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readTsv(path, columns) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").slice(1);
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const row = {};
    columns.forEach((c, i) => (row[c] = cols[i] ?? ""));
    rows.push(row);
  }
  return rows;
}

function appendTsvRow(path, columns, row) {
  if (!existsSync(path)) writeFileSync(path, columns.join("\t") + "\n");
  const line = columns.map((c) => String(row[c] ?? "").replace(/\t|\n/g, " ")) .join("\t");
  appendFileSync(path, line + "\n");
}

function loadBulletList(path) {
  if (!existsSync(path)) return new Set();
  const names = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*-\s+(.+)$/);
    if (m) names.add(normalize(m[1]));
  }
  return names;
}

function appendBullet(path, header, name) {
  if (!existsSync(path)) writeFileSync(path, header);
  const text = readFileSync(path, "utf8");
  if (loadBulletList(path).has(normalize(name))) return false;
  const sep = text.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${sep}- ${name}\n`);
  return true;
}

function loadKnownCompanies() {
  if (!KNOWN_COMPANIES_FILE || !existsSync(KNOWN_COMPANIES_FILE)) return new Set();
  const names = new Set();
  for (const line of readFileSync(KNOWN_COMPANIES_FILE, "utf8").split("\n")) {
    const m = line.trim().match(/^-\s+\*\*([^*]+)\*\*/);
    if (m) names.add(normalize(m[1]));
  }
  return names;
}

function fuzzyContains(set, needle) {
  for (const s of set) {
    if (s && (s.includes(needle) || needle.includes(s))) return true;
  }
  return false;
}

function recencyMinutes(postedAt) {
  if (!postedAt) return Infinity;
  const t = Date.parse(postedAt);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

function slugify(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function triageFilePath(company, title) {
  return join(TRIAGE_QUEUE_DIR, `${slugify(company)}--${slugify(title)}.md`);
}

function getPendingTriageCount() {
  if (!existsSync(TRIAGE_QUEUE_DIR)) return 0;
  return readdirSync(TRIAGE_QUEUE_DIR).filter((f) => f.endsWith(".md")).length;
}

function getLeads() {
  const seen = readTsv(SEEN_FILE, SEEN_COLUMNS);
  const decided = new Set(readTsv(DECISIONS_FILE, DECISION_COLUMNS).map((d) => d.fingerprint));
  const blacklist = loadBulletList(BLACKLIST_FILE);
  const knownCompanies = loadKnownCompanies();
  const leads = seen
    .filter((row) => !decided.has(row.fingerprint))
    .filter((row) => !fuzzyContains(blacklist, normalize(row.company)))
    .map((row) => ({
      ...row,
      known: fuzzyContains(knownCompanies, normalize(row.company)),
    }));
  leads.sort((a, b) => recencyMinutes(a.posted_at) - recencyMinutes(b.posted_at));
  return leads;
}

function getTriageQueue() {
  const seenByFp = new Map(readTsv(SEEN_FILE, SEEN_COLUMNS).map((r) => [r.fingerprint, r]));
  const decisions = readTsv(DECISIONS_FILE, DECISION_COLUMNS).filter((d) => d.decision === "triage");
  const items = [];
  for (const d of decisions) {
    const row = seenByFp.get(d.fingerprint);
    if (!row) continue;
    const path = triageFilePath(row.company, row.title);
    if (!existsSync(path)) continue; // already marked done
    items.push({
      fingerprint: d.fingerprint,
      company: row.company,
      title: row.title,
      url: row.url,
      note: d.note,
      path,
      decided_at: d.decided_at,
    });
  }
  items.sort((a, b) => a.decided_at.localeCompare(b.decided_at));
  return items;
}

function getRecentDecisions(limit = 15) {
  const seenByFp = new Map(readTsv(SEEN_FILE, SEEN_COLUMNS).map((r) => [r.fingerprint, r]));
  const decisions = readTsv(DECISIONS_FILE, DECISION_COLUMNS);
  return decisions
    .slice(-limit)
    .reverse()
    .map((d) => {
      const row = seenByFp.get(d.fingerprint);
      const triageFile = d.decision === "triage" && row ? triageFilePath(row.company, row.title) : null;
      return { ...d, title: row?.title || "", triageFile };
    });
}

function undoDecision(fingerprint) {
  const allDecisions = readTsv(DECISIONS_FILE, DECISION_COLUMNS);
  const undone = allDecisions.find((d) => d.fingerprint === fingerprint);
  const rows = allDecisions.filter((d) => d.fingerprint !== fingerprint);
  const lines = [DECISION_COLUMNS.join("\t")];
  for (const r of rows) lines.push(DECISION_COLUMNS.map((c) => r[c] ?? "").join("\t"));
  writeFileSync(DECISIONS_FILE, lines.join("\n") + "\n");

  // A triage decision also wrote its own file into the queue dir -- undo
  // must remove it too, or the lead ends up back in "unreviewed" while an
  // orphaned file still sits in the queue claiming it's pending triage.
  if (undone?.decision === "triage") {
    const seenRow = readTsv(SEEN_FILE, SEEN_COLUMNS).find((r) => r.fingerprint === fingerprint);
    if (seenRow) {
      const path = triageFilePath(seenRow.company, seenRow.title);
      if (existsSync(path)) unlinkSync(path);
    }
  }
}

const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const STATIC_FILES = new Map([["/", "index.html"], ["/styles.css", "styles.css"], ["/app.js", "app.js"]]);

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && STATIC_FILES.has(req.url)) {
      const file = STATIC_FILES.get(req.url);
      const ext = extname(file);
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" });
      res.end(readFileSync(join(PUBLIC_DIR, file)));
      return;
    }

    if (req.method === "GET" && req.url === "/api/leads") {
      sendJson(res, 200, {
        leads: getLeads(),
        reasonLabels: REASON_LABELS,
        recent: getRecentDecisions(),
        pendingTriage: getPendingTriageCount(),
        triageQueue: getTriageQueue(),
        topReasons: getTopReasons(),
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/decide") {
      const body = await readBody(req);
      const { fingerprint, company, decision, reason, note } = body;
      if (!fingerprint || !decision) return sendJson(res, 400, { error: "fingerprint and decision required" });
      appendTsvRow(DECISIONS_FILE, DECISION_COLUMNS, {
        fingerprint,
        decided_at: new Date().toISOString(),
        decision,
        reason: reason || "",
        note: note || "",
        company: company || "",
      });
      let triageFile = null;
      if (decision === "triage") {
        const seenRow = readTsv(SEEN_FILE, SEEN_COLUMNS).find((r) => r.fingerprint === fingerprint);
        if (seenRow) {
          mkdirSync(TRIAGE_QUEUE_DIR, { recursive: true });
          triageFile = triageFilePath(seenRow.company, seenRow.title);
          const lines = [
            `# ${seenRow.title}`,
            "",
            `**Company:** ${seenRow.company}`,
            `**Posted:** ${seenRow.posted_at || "unknown"}`,
            `**Location:** ${seenRow.location || "unknown"}`,
            `**Link:** ${seenRow.url}`,
            "",
          ];
          if (note) lines.push(`**Note:** ${note}`, "");
          lines.push("## JD excerpt", "", seenRow.snippet || "(no excerpt captured)", "");
          writeFileSync(triageFile, lines.join("\n") + "\n");
        }
      }
      sendJson(res, 200, { ok: true, triageFile });
      return;
    }

    if (req.method === "POST" && req.url === "/api/undo") {
      const { fingerprint } = await readBody(req);
      if (!fingerprint) return sendJson(res, 400, { error: "fingerprint required" });
      undoDecision(fingerprint);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/api/triage-done") {
      // Marks a queued triage item done -- removes its file (the discussion
      // happened in a separate thread already) but keeps the "triage"
      // decision itself, so it stays correctly excluded from "unreviewed".
      const { fingerprint } = await readBody(req);
      if (!fingerprint) return sendJson(res, 400, { error: "fingerprint required" });
      const row = readTsv(SEEN_FILE, SEEN_COLUMNS).find((r) => r.fingerprint === fingerprint);
      if (row) {
        const path = triageFilePath(row.company, row.title);
        if (existsSync(path)) unlinkSync(path);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/api/company-action") {
      const { company, action } = await readBody(req);
      if (!company || !action) return sendJson(res, 400, { error: "company and action required" });
      if (action === "blacklist") {
        appendBullet(BLACKLIST_FILE, "# Company Blacklist\n\n", company);
      } else if (action === "watch") {
        appendBullet(WATCHLIST_FILE, "# Company Watchlist\n\nCompanies to check directly, independent of search results.\n\n", company);
      } else {
        return sendJson(res, 400, { error: "unknown action" });
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Leads review app on http://127.0.0.1:${PORT}/`);
});
