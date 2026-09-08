let state = { leads: [], reasonLabels: {}, recent: [], pendingTriage: 0, triageQueue: [], topReasons: [] };

async function load() {
  const res = await fetch("/api/leads");
  state = await res.json();
  render();
}

async function decide(fingerprint, company, decision, reason, note) {
  await fetch("/api/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint, company, decision, reason, note }),
  });
  await load();
}

async function companyAction(company, action) {
  await fetch("/api/company-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ company, action }),
  });
  await load();
}

async function undo(fingerprint) {
  await fetch("/api/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint }),
  });
  await load();
}

async function markTriageDone(fingerprint) {
  await fetch("/api/triage-done", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint }),
  });
  await load();
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Computed fresh every render from an absolute timestamp, so it's never
// stale no matter how long a lead has sat unreviewed (unlike Serper's raw
// "3 hours ago" string, which is only accurate at the moment it was fetched).
function timeAgo(isoString) {
  if (!isoString) return "";
  const ms = Date.now() - new Date(isoString).getTime();
  if (Number.isNaN(ms)) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function card(lead) {
  const known = lead.known ? `<span class="known">⚠ already in PIPELINE.md</span>` : "";
  const posted = lead.posted_at ? `posted ${escapeHtml(timeAgo(lead.posted_at))}` : "";
  const location = lead.location ? ` · ${escapeHtml(lead.location)}` : "";
  const snippet = lead.snippet
    ? `<div class="snippet">${escapeHtml(lead.snippet)}</div>`
    : `<div class="snippet empty">(no preview available — open the posting)</div>`;

  const quickReasons = (state.topReasons || [])
    .map((key) => `<button data-reason="${key}" class="reason-btn quick-btn">Pass: ${state.reasonLabels[key]}</button>`)
    .join("");

  const reasonButtons = Object.entries(state.reasonLabels)
    .filter(([key]) => !state.topReasons?.includes(key))
    .map(([key, label]) =>
      key === "other"
        ? `<button data-reason="other" class="reason-btn other-btn">${label}…</button>`
        : `<button data-reason="${key}" class="reason-btn">${label}</button>`
    )
    .join("");

  return `
    <div class="card" data-fp="${escapeHtml(lead.fingerprint)}" data-company="${escapeHtml(lead.company)}">
      <h3>${escapeHtml(lead.title)}</h3>
      <div class="meta">${escapeHtml(lead.company)} ${posted ? "· " + posted : ""}${location} ${known}</div>
      ${snippet}
      <a class="open-link" href="${escapeHtml(lead.url)}" target="_blank" rel="noopener">Open posting ↗</a>
      <div class="actions">
        <button class="triage" data-action="triage">Triage</button>
        ${quickReasons}
        <div class="pass-group">
          <button data-action="pass-toggle">More reasons ▾</button>
          <div class="pass-menu">${reasonButtons}</div>
        </div>
        <button class="blacklist" data-action="blacklist">Blacklist company</button>
        <button class="watch" data-action="watch">Watch company</button>
      </div>
      <div class="other-input"><input type="text" placeholder="Reason…" /><button data-action="submit-other">Submit</button></div>
      <textarea class="note" rows="1" placeholder="Optional note…"></textarea>
    </div>
  `;
}

function render() {
  document.getElementById("count").textContent = `${state.leads.length} unreviewed lead${state.leads.length === 1 ? "" : "s"}`;

  const banner = document.getElementById("triage-banner");
  if (state.pendingTriage > 0) {
    banner.hidden = false;
    banner.textContent = `⏳ ${state.pendingTriage} waiting for you to ask Claude to run /triage — see Triage queue below`;
  } else {
    banner.hidden = true;
  }

  const tq = state.triageQueue || [];
  document.getElementById("triage-queue").hidden = tq.length === 0;
  document.getElementById("triage-queue-count").textContent = tq.length;

  const tqList = document.getElementById("triage-queue-list");
  tqList.innerHTML = tq
    .map(
      (t) => `
      <div class="card triage-card">
        <h3>${escapeHtml(t.title)}</h3>
        <div class="meta">${escapeHtml(t.company)}</div>
        ${t.note ? `<div class="snippet">Note: ${escapeHtml(t.note)}</div>` : ""}
        <a class="open-link" href="${escapeHtml(t.url)}" target="_blank" rel="noopener">Open posting ↗</a>
        <div class="triage-path"><code>${escapeHtml(t.path)}</code><button data-copy="${escapeHtml(t.path)}">Copy path</button></div>
        <div class="actions">
          <button data-done="${escapeHtml(t.fingerprint)}">Mark done</button>
        </div>
      </div>`
    )
    .join("");

  const filterVal = document.getElementById("filter").value.toLowerCase();
  const filtered = state.leads.filter(
    (l) => !filterVal || l.title.toLowerCase().includes(filterVal) || l.company.toLowerCase().includes(filterVal)
  );

  const list = document.getElementById("list");
  list.innerHTML = filtered.length ? filtered.map(card).join("") : `<div class="empty-state">Nothing to review.</div>`;

  const recentList = document.getElementById("recent-list");
  recentList.innerHTML = state.recent
    .map((d) => {
      const label =
        d.decision === "pass"
          ? `Passed: ${escapeHtml(d.title)} (${escapeHtml(d.reason)})`
          : d.decision === "triage"
          ? `Triage: ${escapeHtml(d.title)}`
          : `${escapeHtml(d.decision)}: ${escapeHtml(d.company)}`;
      const pathRow = d.triageFile
        ? `<div class="triage-path"><code>${escapeHtml(d.triageFile)}</code><button data-copy="${escapeHtml(d.triageFile)}">Copy path</button></div>`
        : "";
      return `
      <div class="recent-row">
        <div>
          <span>${label}</span>
          ${pathRow}
        </div>
        <button data-undo="${escapeHtml(d.fingerprint)}">Undo</button>
      </div>`;
    })
    .join("");
}

document.getElementById("filter").addEventListener("input", render);

document.addEventListener("click", (e) => {
  const undoFp = e.target.getAttribute("data-undo");
  if (undoFp) return undo(undoFp);

  const doneFp = e.target.getAttribute("data-done");
  if (doneFp) return markTriageDone(doneFp);

  const copyPath = e.target.getAttribute("data-copy");
  if (copyPath) {
    navigator.clipboard?.writeText(copyPath);
    const original = e.target.textContent;
    e.target.textContent = "Copied!";
    setTimeout(() => (e.target.textContent = original), 1200);
    return;
  }

  const cardEl = e.target.closest(".card");
  if (!cardEl) return;
  const fingerprint = cardEl.dataset.fp;
  const company = cardEl.dataset.company;
  const note = cardEl.querySelector(".note").value;

  const action = e.target.getAttribute("data-action");
  if (action === "triage") return decide(fingerprint, company, "triage", "", note);
  if (action === "blacklist") return companyAction(company, "blacklist");
  if (action === "watch") return companyAction(company, "watch");
  if (action === "pass-toggle") {
    cardEl.querySelector(".pass-menu").classList.toggle("open");
    return;
  }

  const reason = e.target.getAttribute("data-reason");
  if (reason === "other") {
    cardEl.querySelector(".other-input").classList.add("open");
    cardEl.querySelector(".pass-menu").classList.remove("open");
    return;
  }
  if (reason) return decide(fingerprint, company, "pass", reason, note);

  if (action === "submit-other") {
    const text = cardEl.querySelector(".other-input input").value;
    return decide(fingerprint, company, "pass", "other", text || note);
  }
});

load();
setInterval(load, 60000);
