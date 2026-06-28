/**
 * The Kanban board UI, embedded as a string so it bundles into the single
 * dist/cli.mjs binary (no runtime asset-path resolution). Vanilla JS + an
 * EventSource subscription to /api/events; no build step or dependencies.
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>autoralph board</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --panel2: #1c2330; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #4f9cf9;
    --green: #3fb950; --red: #f85149; --amber: #d29922; --purple: #a371f7;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: var(--bg); color: var(--text); }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px;
    border-bottom: 1px solid var(--border); background: var(--panel); position: sticky; top: 0; z-index: 5; }
  header h1 { font-size: 18px; margin: 0; letter-spacing: 0.5px; }
  header .logo { width: 12px; height: 12px; border-radius: 3px; background: var(--accent);
    box-shadow: 0 0 12px var(--accent); }
  .conn { margin-left: auto; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
  .dot.live { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .dot.down { background: var(--red); }
  main { padding: 18px 20px 40px; }
  .runs { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; margin-bottom: 22px; }
  .run { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
  .run .top { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .run .agent { font-weight: 600; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.4px; }
  .badge.running { background: rgba(79,156,249,0.15); color: var(--accent); }
  .badge.completed { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge.stopped { background: rgba(210,153,34,0.15); color: var(--amber); }
  .badge.aborted { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge.idle { background: rgba(139,148,158,0.15); color: var(--muted); }
  .run .obj { font-size: 12.5px; color: var(--muted); margin-bottom: 10px; line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .metric { background: var(--panel2); border-radius: 7px; padding: 7px 8px; text-align: center; }
  .metric .v { font-size: 16px; font-weight: 700; }
  .metric .l { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
  .reason { margin-top: 8px; font-size: 11.5px; color: var(--muted); }
  .board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
  .col { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px; min-height: 120px; }
  .col h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted);
    margin: 0 0 10px; display: flex; justify-content: space-between; }
  .col h2 .count { background: var(--panel2); border-radius: 999px; padding: 1px 8px; color: var(--text); }
  .card { background: var(--panel2); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 8px; padding: 10px; margin-bottom: 10px; animation: pop 0.18s ease; }
  @keyframes pop { from { transform: translateY(4px); opacity: 0; } to { transform: none; opacity: 1; } }
  .card .h { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px; }
  .card .it { font-weight: 700; }
  .card .ag { color: var(--muted); }
  .card .sum { font-size: 12.5px; line-height: 1.4; }
  .card .msg { font-size: 11.5px; color: var(--muted); margin-top: 6px; font-style: italic;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .err { font-size: 11.5px; color: var(--red); margin-top: 6px; }
  .card .tok { font-size: 11px; color: var(--muted); margin-top: 6px; }
  .card.committed { border-left-color: var(--green); }
  .card.discarded { border-left-color: var(--red); }
  .card.repair { border-left-color: var(--amber); }
  .card.aborted { border-left-color: var(--red); }
  .card.running { border-left-color: var(--accent); }
  .spinner { display: inline-block; width: 9px; height: 9px; border: 2px solid var(--accent);
    border-top-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .logs { margin-top: 22px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
  .logs h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted);
    margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--border); }
  .logs .body { max-height: 200px; overflow-y: auto; padding: 8px 14px; font-family: ui-monospace, monospace; font-size: 12px; }
  .logline { padding: 2px 0; color: var(--muted); }
  .logline .lv { font-weight: 700; margin-right: 8px; }
  .logline .lv.warn { color: var(--amber); }
  .logline .lv.error { color: var(--red); }
  .logline .lv.info { color: var(--accent); }
  .empty { color: var(--muted); font-size: 12px; text-align: center; padding: 18px 0; }
</style>
</head>
<body>
<header>
  <span class="logo"></span>
  <h1>autoralph</h1>
  <span class="conn"><span id="dot" class="dot"></span><span id="connText">connecting…</span></span>
</header>
<main>
  <section class="runs" id="runs"></section>
  <section class="board" id="board"></section>
  <section class="logs">
    <h2>Event log</h2>
    <div class="body" id="logs"></div>
  </section>
</main>
<script>
${"%CLIENT_JS%"}
</script>
</body>
</html>`;

export const CLIENT_JS = `
const COLUMNS = [
  { key: "active", title: "In Progress", statuses: ["queued", "running"] },
  { key: "committed", title: "Committed", statuses: ["committed"] },
  { key: "discarded", title: "Discarded", statuses: ["discarded"] },
  { key: "blocked", title: "Repair / Aborted", statuses: ["repair", "aborted"] },
];
const runColor = (i) => ["#4f9cf9","#a371f7","#3fb950","#d29922","#f85149","#56d4dd"][i % 6];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));
const fmt = (n) => n >= 1000 ? (n/1000).toFixed(1) + "k" : String(n);

function setConn(state) {
  const dot = document.getElementById("dot");
  const text = document.getElementById("connText");
  dot.className = "dot " + (state === "live" ? "live" : state === "down" ? "down" : "");
  text.textContent = state === "live" ? "live" : state === "down" ? "disconnected" : "connecting…";
}

function renderRuns(runs) {
  const el = document.getElementById("runs");
  if (!runs.length) { el.innerHTML = '<div class="empty">Waiting for runs…</div>'; return; }
  el.innerHTML = runs.map((r, i) => {
    const tokens = (r.usage.inputTokens || 0) + (r.usage.outputTokens || 0);
    const reason = r.stopReason ? '<div class="reason">reason: ' + esc(r.stopReason) + '</div>' : "";
    return '<div class="run" style="border-top:3px solid ' + runColor(i) + '">' +
      '<div class="top"><span class="agent">' + esc(r.agent) + '</span>' +
      '<span class="badge ' + esc(r.status) + '">' + esc(r.status) + '</span></div>' +
      '<div class="obj">' + esc(r.objective) + '</div>' +
      '<div class="metrics">' +
        '<div class="metric"><div class="v">' + r.currentIteration + (r.maxIterations ? "/" + r.maxIterations : "") + '</div><div class="l">iter</div></div>' +
        '<div class="metric"><div class="v">' + r.commitCount + '</div><div class="l">commits</div></div>' +
        '<div class="metric"><div class="v">' + r.successCount + '/' + r.failCount + '</div><div class="l">ok/fail</div></div>' +
        '<div class="metric"><div class="v">' + (r.usage.estimated ? "~" : "") + fmt(tokens) + '</div><div class="l">tokens</div></div>' +
      '</div>' + reason + '</div>';
  }).join("");
}

function renderBoard(runs) {
  const cards = [];
  runs.forEach((r, i) => r.iterations.forEach((it) => cards.push({ it, color: runColor(i), agent: r.agent })));
  const board = document.getElementById("board");
  board.innerHTML = COLUMNS.map((col) => {
    const items = cards.filter((c) => col.statuses.includes(c.it.status));
    const body = items.length ? items.map((c) => card(c)).join("") : '<div class="empty">—</div>';
    return '<div class="col"><h2>' + col.title + '<span class="count">' + items.length + '</span></h2>' + body + '</div>';
  }).join("");
}

function card(c) {
  const it = c.it;
  const tokens = (it.usage.inputTokens || 0) + (it.usage.outputTokens || 0);
  const running = it.status === "running" ? '<span class="spinner"></span> ' : "";
  const sum = it.summary ? '<div class="sum">' + esc(it.summary) + '</div>' : "";
  const msg = it.message && it.status === "running" ? '<div class="msg">' + esc(it.message) + '</div>' : "";
  const err = it.error ? '<div class="err">' + esc(it.error) + '</div>' : "";
  const tok = tokens ? '<div class="tok">' + (it.usage.estimated ? "~" : "") + fmt(tokens) + ' tokens</div>' : "";
  return '<div class="card ' + esc(it.status) + '" style="border-left-color:' + c.color + '">' +
    '<div class="h"><span class="it">' + running + 'Iteration ' + it.iteration + '</span>' +
    '<span class="ag">' + esc(c.agent) + '</span></div>' + sum + msg + err + tok + '</div>';
}

function renderLogs(logs) {
  const el = document.getElementById("logs");
  el.innerHTML = logs.slice(-80).map((l) =>
    '<div class="logline"><span class="lv ' + esc(l.level) + '">' + esc(l.level.toUpperCase()) + '</span>' +
    esc(l.message) + '</div>').join("");
  el.scrollTop = el.scrollHeight;
}

function render(snap) {
  renderRuns(snap.runs);
  renderBoard(snap.runs);
  renderLogs(snap.logs);
}

function connect() {
  const source = new EventSource("/api/events");
  source.onopen = () => setConn("live");
  source.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch (_) {} };
  source.onerror = () => { setConn("down"); };
}
connect();
`;

export function renderIndexHtml(): string {
  return INDEX_HTML.replace("%CLIENT_JS%", CLIENT_JS);
}
