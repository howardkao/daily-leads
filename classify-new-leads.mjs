#!/usr/bin/env node
// Runs after find-listings.py. For every ledger row not yet classified:
//   1. Fetch the real JD via each ATS's public JSON API (not scraped HTML --
//      these pages render client-side, so a plain fetch gets an empty shell).
//   2. Free, zero-cost location check first (structured on Lever; a
//      best-effort keyword heuristic on Greenhouse/Ashby's free-text
//      location strings -- imperfect, biased toward under- not
//      over-flagging, so it misses some rather than wrongly rejecting a
//      real US/remote role).
//   3. Only if that doesn't already resolve it, one LLM call (thinking
//      enabled at a small budget -- this needs real judgment, not just
//      pattern-matching) judges the posting against criteria.md.
// Auto-passes are written with a distinct auto_* reason so they're always
// separable from your own manual decisions in the review app and
// auditable later.
// Every surviving lead also gets its snippet replaced with a real JD
// excerpt -- the search snippet alone usually isn't enough to judge from.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(SCRIPT_DIR, "config.json");
const CRITERIA_FILE = join(SCRIPT_DIR, "criteria.md");
const SEEN_COLUMNS = ["fingerprint", "first_seen", "last_seen", "company", "title", "url", "snippet", "posted_at", "location", "classified_at"];
const DECISION_COLUMNS = ["fingerprint", "decided_at", "decision", "reason", "note", "company"];

const DEFAULT_FOREIGN_MARKERS = [
  "india", "bangalore", "mumbai", "delhi", "hyderabad", "pune",
  "united kingdom", " uk", "london", "canada", "toronto", "vancouver",
  "germany", "berlin", "munich", "france", "paris", "singapore",
  "australia", "sydney", "melbourne", "brazil", "mexico", "netherlands",
  "amsterdam", "spain", "madrid", "israel", "tel aviv", "ireland",
  "dublin", "poland", "portugal", "lisbon", "philippines", "manila",
  "japan", "tokyo", "china", "pakistan", "nigeria", "south africa",
  "uae", "dubai", "argentina", "colombia", "chile", "italy", "milan",
];

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    console.error(`Missing ${CONFIG_FILE} -- copy config.example.json to config.json and edit it.`);
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  config.model ??= "claude-haiku-4-5-20251001";
  config.dataDir ??= "data";
  config.locationFilter ??= { enabled: true, allowedCountry: "US" };
  return config;
}

function loadCriteria() {
  if (!existsSync(CRITERIA_FILE)) {
    console.error(`Missing ${CRITERIA_FILE} -- copy criteria.example.md to criteria.md and describe what you're not looking for.`);
    process.exit(1);
  }
  return readFileSync(CRITERIA_FILE, "utf8").trim();
}

// dataDir is relative to this script, so the same code works whether the
// ledger lives in a sibling data/ dir or somewhere else entirely.
function resolvePaths(config) {
  const dataDir = resolve(SCRIPT_DIR, config.dataDir);
  return {
    dataDir,
    seen: join(dataDir, "leads-seen.tsv"),
    decisions: join(dataDir, "lead-decisions.tsv"),
  };
}

function readTsv(path, columns) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const cols = line.split("\t");
      const row = {};
      columns.forEach((c, i) => (row[c] = cols[i] ?? ""));
      return row;
    });
}

function writeTsv(path, columns, rows) {
  const lines = [columns.join("\t")];
  for (const r of rows) lines.push(columns.map((c) => String(r[c] ?? "").replace(/\t|\n/g, " ")).join("\t"));
  writeFileSync(path, lines.join("\n") + "\n");
}

function appendDecision(decisionsFile, fingerprint, company, decision, reason, note) {
  if (!existsSync(decisionsFile)) writeFileSync(decisionsFile, DECISION_COLUMNS.join("\t") + "\n");
  appendFileSync(
    decisionsFile,
    [fingerprint, new Date().toISOString(), decision, reason, note || "", company].join("\t") + "\n"
  );
}

function decodeEntities(text) {
  return (text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g, "&"); // last -- decoding the others can't introduce a literal "&"
}

function stripHtml(html) {
  // Some JDs (e.g. pasted from another tool's rendered output) contain
  // HTML-encoded markup as literal text, not real tags -- decode first so
  // those tags become real and get stripped too, then decode once more for
  // any entities the strip step exposed or that were outside tags.
  let text = decodeEntities(html);
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  return text.replace(/\s+/g, " ").trim();
}

async function fetchJd(url, locationFilter) {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const markers = locationFilter.foreignMarkers || DEFAULT_FOREIGN_MARKERS;
  const allowed = (locationFilter.allowedCountry || "US").toUpperCase();

  if (u.hostname.includes("lever.co")) {
    const [company, id] = parts;
    const d = await (await fetch(`https://api.lever.co/v0/postings/${company}/${id}`)).json();
    if (d.ok === false) return null;
    return {
      text: d.descriptionPlain || stripHtml(d.description),
      location: `${d.country || "?"} (${d.workplaceType || "?"})`,
      isForeign: !!d.country && d.country.toUpperCase() !== allowed && d.workplaceType !== "remote",
    };
  }
  if (u.hostname.includes("greenhouse.io")) {
    const company = parts[0];
    const id = parts[parts.length - 1];
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${id}?content=true`);
    if (!res.ok) return null;
    const d = await res.json();
    const loc = (d.location?.name || "").toLowerCase();
    return {
      text: stripHtml(d.content),
      location: d.location?.name || "",
      isForeign: !loc.includes("remote") && markers.some((m) => loc.includes(m)),
    };
  }
  if (u.hostname.includes("ashbyhq.com")) {
    const company = parts[0];
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${company}`);
    if (!res.ok) return null;
    const d = await res.json();
    const job = d.jobs?.find((j) => u.pathname.includes(j.jobUrl.split("/").pop())) || null;
    if (!job) return null;
    const loc = (job.location || "").toLowerCase();
    return {
      text: job.descriptionPlain,
      location: `${job.location || ""} (${job.workplaceType || "?"})`,
      // isRemote is unreliable -- Ashby marks hybrid roles isRemote:true too
      // (e.g. a Milan, Italy hybrid posting). workplaceType is the real signal.
      isForeign: job.workplaceType?.toLowerCase() !== "remote" && markers.some((m) => loc.includes(m)),
    };
  }
  return null;
}

async function classifyFit(jdText, criteria, model) {
  const prompt = `${criteria}

Read the job posting text below and answer with ONLY one JSON object, no other text:
{"verdict": "mismatch" | "not_obviously_mismatched", "reason": "<one sentence citing what the role actually centers on>"}

Job posting text:
${jdText.slice(0, 6000)}`;

  let resultMessage = null;
  for await (const message of query({
    prompt,
    options: { model, allowedTools: [], maxTurns: 1, thinking: { type: "enabled", budgetTokens: 1024 } },
  })) {
    if (message.type === "result") resultMessage = message;
  }
  if (resultMessage?.subtype !== "success") return null;
  try {
    const match = resultMessage.result.match(/\{[\s\S]*\}/);
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function main() {
  const limit = Number(process.argv[2]) || Infinity;
  const config = loadConfig();
  const criteria = loadCriteria();
  const paths = resolvePaths(config);
  mkdirSync(paths.dataDir, { recursive: true });

  const rows = readTsv(paths.seen, SEEN_COLUMNS);
  const decided = new Set(readTsv(paths.decisions, DECISION_COLUMNS).map((d) => d.fingerprint));
  const todo = rows.filter((r) => !r.classified_at && !decided.has(r.fingerprint)).slice(0, limit);

  console.log(`${todo.length} lead(s) to classify`);
  let fetchFailed = 0, locationRejected = 0, criteriaRejected = 0, enriched = 0, llmCalls = 0, done = 0;

  for (const row of todo) {
    const now = new Date().toISOString();
    let jd;
    try {
      jd = await fetchJd(row.url, config.locationFilter);
    } catch (e) {
      jd = null;
    }

    let outcome;
    if (!jd || !jd.text) {
      fetchFailed++;
      row.classified_at = now;
      outcome = "fetch failed";
    } else {
      row.snippet = jd.text.slice(0, 800);
      row.location = jd.location;
      row.classified_at = now;
      enriched++;

      if (config.locationFilter.enabled && jd.isForeign) {
        appendDecision(paths.decisions, row.fingerprint, row.company, "pass", "auto_location_mismatch", `location: ${jd.location}`);
        locationRejected++;
        outcome = "location mismatch";
      } else {
        llmCalls++;
        const verdict = await classifyFit(jd.text, criteria, config.model);
        if (verdict?.verdict === "mismatch") {
          appendDecision(paths.decisions, row.fingerprint, row.company, "pass", "auto_criteria_mismatch", verdict.reason);
          criteriaRejected++;
        }
        outcome = verdict?.verdict || "classification failed";
      }
    }

    // Write after every lead, not just at the end -- a killed/crashed run
    // must not lose enrichment progress. Decisions (appendDecision, above)
    // are already durable independently of this.
    writeTsv(paths.seen, SEEN_COLUMNS, rows);
    done++;
    console.log(`[${done}/${todo.length}] ${row.company}: ${outcome}`);
  }

  writeTsv(paths.seen, SEEN_COLUMNS, rows);

  console.log(`Enriched with real JD/location: ${enriched}`);
  console.log(`Fetch failed (left as-is): ${fetchFailed}`);
  console.log(`Auto-passed, location: ${locationRejected}`);
  console.log(`LLM calls made: ${llmCalls}`);
  console.log(`Auto-passed, criteria mismatch: ${criteriaRejected}`);
  console.log(`Remaining for your review: ${enriched - locationRejected - criteriaRejected}`);
}

main();
