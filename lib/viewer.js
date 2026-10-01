/**
 * A loopback live view of the browser this plugin drives, plus the controls that belong
 * next to it.
 *
 * Why a second HTTP server rather than a route on the harness carrier: the shipped
 * Sidebar browser refuses to load the application's own origin on purpose (a sandboxed
 * iframe inside the UI must not be able to load the UI), so serving the view from the
 * harness port would be exactly the request it is designed to reject. A different
 * loopback port is a different origin, `http:` is on the browser's allowed protocol list,
 * and the app sends no CSP — so this page opens *inside* the sidebar browser with no web
 * build and no client plugin.
 *
 * Bound to 127.0.0.1 and gated by a random path token, because a local page that can
 * authorize consequential actions is not something another local process should reach by
 * guessing a port.
 *
 * @module @local/dsh-jev-browser/lib/viewer
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** How long one captured frame is reused, so several viewers share one capture. */
const FRAME_TTL_MS = 250;
/** A decision body is a target label and a verdict; anything larger is not one. */
const MAX_BODY_BYTES = 4096;
/** Where the path token lives, so one bookmark keeps working across restarts. */
const TOKEN_FILE = join(homedir(), '.dsh', 'jev-browser-viewer.token');

/**
 * Read the durable path token, creating it on first use.
 *
 * A fresh random token each start would change the URL every restart, which defeats the
 * point of parking the page in a Sidebar tab. The token is still unguessable; it just
 * outlives one process. Written 0600 because it is the only thing guarding a page that
 * can authorize actions in a logged-in browser.
 *
 * @returns the token.
 */
async function durableToken() {
  try {
    const existing = (await readFile(TOKEN_FILE, 'utf8')).trim();
    if (/^[0-9a-f]{32}$/.test(existing)) return existing;
  } catch {
    /* first run, or unreadable */
  }
  const token = randomBytes(16).toString('hex');
  try {
    await mkdir(join(homedir(), '.dsh'), { recursive: true });
    await writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  } catch {
    /* an unwritable home still gets a working, if per-process, token */
  }
  return token;
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>jev-browser 监控看板</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#232b36;
          --ink:#e6edf3; --dim:#8b949e; --hot:#f0c674; --ok:#3fb950; --bad:#f85149; --accent:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; font:12px/1.55 system-ui,-apple-system,"PingFang SC",sans-serif;
         background:var(--bg); color:var(--ink); }
  header { display:flex; gap:8px; align-items:center; padding:9px 11px; border-bottom:1px solid var(--line);
           position:sticky; top:0; background:var(--bg); z-index:5; }
  header .url { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dim); }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--ok); flex:none; }
  .dot.off { background:var(--hot); }
  section { border-bottom:1px solid var(--line); padding:9px 11px; }
  h2 { margin:0 0 7px; font-size:10px; letter-spacing:.09em; text-transform:uppercase;
       color:var(--dim); font-weight:700; display:flex; justify-content:space-between; }
  h2 .badge { color:var(--accent); letter-spacing:0; text-transform:none; font-weight:600; }
  #stage { background:#000; line-height:0; position:relative; }
  #stage img { width:100%; max-height:38vh; object-fit:contain; object-position:top center; display:block; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(84px,1fr)); gap:6px; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:7px; padding:6px 8px; }
  .stat b { display:block; font-size:15px; font-weight:700; font-variant-numeric:tabular-nums; }
  .stat span { color:var(--dim); font-size:10px; }
  .stat.bad b { color:var(--bad); } .stat.hot b { color:var(--hot); } .stat.ok b { color:var(--ok); }
  .row { display:flex; gap:7px; padding:2px 0; align-items:baseline; }
  .row .k { color:var(--dim); flex:none; min-width:58px; }
  .row .v { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tab { display:flex; gap:7px; padding:3px 0; color:#b9c0d0; }
  .tab.now { color:var(--accent); font-weight:600; }
  .tab .n { color:var(--dim); flex:none; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { text-align:left; color:var(--dim); font-weight:600; padding:2px 5px 4px 0; white-space:nowrap; }
  td { padding:3px 5px 3px 0; border-top:1px solid var(--line); vertical-align:top; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .tag { display:inline-block; padding:0 5px; border-radius:4px; font-size:10px; font-weight:600;
         background:#21262d; color:var(--dim); }
  .tag.ok { background:#0f2417; color:var(--ok); }
  .tag.bad { background:#2d0f11; color:var(--bad); }
  .tag.hot { background:#2a1f0a; color:var(--hot); }
  .tag.acc { background:#0d2240; color:var(--accent); }
  #feed div { padding:3px 0; border-top:1px solid var(--line); display:flex; gap:7px; }
  #feed .t { color:var(--dim); flex:none; font-variant-numeric:tabular-nums; }
  #feed .x { overflow:hidden; text-overflow:ellipsis; }
  #pending { margin:9px 11px; border:1px solid #6b4a12; background:#2a1f0a; border-radius:8px; padding:10px; }
  #pending.granted { border-color:#1f6f3d; background:#0f2417; }
  #pending .target { font-weight:700; color:var(--hot); margin:2px 0 6px; word-break:break-all; }
  #pending.granted .target { color:var(--ok); }
  button { font:inherit; padding:6px 11px; border-radius:6px; cursor:pointer;
           border:1px solid #30363d; background:#21262d; color:var(--ink); }
  button.ok { background:#1f6f3d; border-color:#2ea043; }
  button.no { margin-left:6px; }
  button:disabled { opacity:.45; cursor:default; }
  select { max-width:140px; font:inherit; color:var(--ink); background:var(--panel); border:1px solid var(--line); }
  .dim { color:var(--dim); }
  footer { padding:9px 11px 16px; color:#5d6678; }
</style></head>
<body>
<header><span class="dot" id="dot"></span><select id="session" aria-label="查看会话"></select><span class="url" id="url">连接中…</span></header>
<div id="pending" hidden></div>
<div id="stage"><img id="frame" alt="实时画面"></div>
<section><h2>状态<span class="badge" id="health"></span></h2><div id="status"></div></section>
<section><h2>累计</h2><div class="grid" id="totals"></div></section>
<section><h2>会话<span class="badge" id="nsess"></span></h2><div id="sessions"></div></section>
<section><h2>标签页<span class="badge" id="ntab"></span></h2><div id="tabs"></div></section>
<section><h2>最近运行</h2><table id="runs"></table></section>
<section><h2>活动轨迹<span class="badge" id="nfeed"></span></h2><div id="feed"></div></section>
<footer id="foot"></footer>
<script>
(function () {
  var TOKEN = location.pathname.split('/').filter(Boolean)[0] || '';
  var base = '/' + TOKEN;
  var frame = document.getElementById('frame');
  var selector = document.getElementById('session');
  var selected = new URLSearchParams(location.search).get('session') || '';
  function selectionQuery() { return '&session=' + encodeURIComponent(selected); }
  selector.onchange = function () {
    selected = selector.value;
    frame.removeAttribute('src');
    tick();
    loadFrame();
  };

  function loadFrame() {
    // A fresh img each tick, so a slow capture can never queue behind the next request.
    var next = new Image();
    var requested = selected;
    next.onload = function () { if (selected === requested) frame.src = next.src; };
    next.onerror = function () { if (selected === requested) frame.removeAttribute('src'); };
    next.src = base + '/frame.png?t=' + Date.now() + selectionQuery();
  }
  loadFrame();
  setInterval(loadFrame, 800);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function clock(ms) {
    var d = new Date(ms);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function ago(ms) {
    return duration(Date.now() - ms);
  }
  function duration(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return Math.round(s / 3600) + 'h';
  }
  function n(v) { return Number(v || 0).toLocaleString('en-US'); }

  var STATUS_TAG = {
    done: 'ok', gave_up: 'hot', low_confidence: 'hot', stalled: 'hot', no_target: 'hot',
    needs_text: 'hot', needs_confirmation: 'hot', action_budget_exhausted: 'hot',
    risk_page_detected: 'bad', action_failed: 'bad', error: 'bad', max_steps: 'hot', aborted: 'hot'
  };

  function stat(label, value, cls) {
    return '<div class="stat ' + (cls || '') + '"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
  }

  function render(s) {
    var changed = selected !== (s.selectedSession || '');
    selected = s.selectedSession || '';
    selector.innerHTML = (s.sessions || []).map(function (x) {
      return '<option value="' + esc(x.name) + '">' + esc(x.name) + '</option>';
    }).join('');
    selector.value = selected;
    if (changed) { frame.removeAttribute('src'); loadFrame(); }
    document.getElementById('dot').className = 'dot' + (s.live ? '' : ' off');
    document.getElementById('url').textContent = s.url || '(无页面)';
    document.getElementById('health').textContent = s.health || '';
    document.getElementById('status').innerHTML =
      '<div class="row"><span class="k">状态</span><span class="v">' + esc(s.status || '—') + '</span></div>' +
      '<div class="row"><span class="k">节奏</span><span class="v">' + esc(s.pacing || '—') + '</span></div>' +
      '<div class="row"><span class="k">当前</span><span class="v">' + esc(s.url || '—') + '</span></div>';

    var t = s.totals || {};
    document.getElementById('totals').innerHTML =
      stat('运行次数', n(t.runs)) +
      stat('动作成功', n(t.actionsOk), 'ok') +
      stat('动作失败', n(t.actionsFailed), t.actionsFailed ? 'bad' : '') +
      stat('风控停手', n(t.riskStops), t.riskStops ? 'bad' : '') +
      stat('已验证', n(t.verified), t.verified ? 'ok' : '') +
      stat('结果未确认', n(t.unconfirmed), t.unconfirmed ? 'hot' : '') +
      stat('页面否定', n(t.refused), t.refused ? 'bad' : '') +
      stat('待批/已批', n(t.confirmations) + ' / ' + n(t.grants), t.confirmations && !t.grants ? 'hot' : '') +
      stat('决策 token', n(t.tokensIn + t.tokensOut));

    var sess = s.sessions || [];
    document.getElementById('nsess').textContent = sess.length ? sess.length + ' 个' : '';
    document.getElementById('sessions').innerHTML = sess.length
      ? sess.map(function (x) {
          return '<div class="row"><span class="k">' + esc(x.name) + '</span><span class="v">' +
                 '<span class="tag acc">' + esc(x.origin) + '</span> ' +
                 'pid ' + esc(x.pid || '?') + ' · ' + esc(x.tabs) + ' 标签页 · 动作 ' + esc(x.actions) +
                 (x.cooldowns ? ' · 冷却 ' + esc(x.cooldowns) : '') +
                 (x.idleMs == null ? '' : ' · 空闲 ' + duration(x.idleMs)) + '</span></div>';
        }).join('')
      : '<div class="dim">没有活动会话</div>';

    var tabs = s.tabs || [];
    document.getElementById('ntab').textContent = tabs.length ? tabs.length + ' 个' : '';
    document.getElementById('tabs').innerHTML = tabs.length
      ? tabs.map(function (x) {
          return '<div class="tab' + (x.active ? ' now' : '') + '"><span class="n">' + x.index + '</span><span>' +
                 esc(x.title || x.url || '(无标题)') + '</span></div>';
        }).join('')
      : '<div class="dim">—</div>';

    var runs = s.runs || [];
    document.getElementById('runs').innerHTML = runs.length
      ? '<tr><th>时间</th><th>目标</th><th>结果</th><th class="num">步</th><th class="num">token</th></tr>' +
        runs.map(function (r) {
          return '<tr><td class="num dim">' + clock(r.at) + '</td>' +
                 '<td>' + esc(String(r.goal || '').slice(0, 60)) + '</td>' +
                 '<td><span class="tag ' + (STATUS_TAG[r.status] || '') + '">' + esc(r.status) + '</span></td>' +
                 '<td class="num">' + esc(r.steps) + '</td>' +
                 '<td class="num dim">' + n((r.tokensIn || 0) + (r.tokensOut || 0)) + '</td></tr>';
        }).join('')
      : '<tr><td class="dim">还没有运行记录</td></tr>';

    var events = s.events || [];
    document.getElementById('nfeed').textContent = events.length ? '最近 ' + events.length + ' 条' : '';
    document.getElementById('feed').innerHTML = events.length
      ? events.map(function (e) {
          var cls = e.kind === 'risk' || e.kind === 'error' ? 'bad'
                  : e.kind === 'grant' ? 'ok'
                  : (e.kind === 'action'
                      ? (e.verified === 'verified' ? 'ok'
                        : e.verified === 'unconfirmed' ? 'hot'
                        : e.verified === 'refuted' || !e.ok ? 'bad' : '')
                      : (e.kind === 'confirm' || e.kind === 'deny' ? 'hot' : 'acc'));
          var text = e.kind;
          if (e.kind === 'action') {
            var verdict = e.verified === 'verified' ? ' ✓已验证'
                        : e.verified === 'unconfirmed' ? ' ⚠结果未确认'
                        : e.verified === 'refuted' ? ' ✗页面否定' : '';
            text = e.action + ' → ' + (e.target || '?') + (e.ok ? '' : ' 失败: ' + (e.message || '')) + verdict +
                   (e.basis ? ' — ' + e.basis : '');
          }
          else if (e.kind === 'risk') text = '风控信号: ' + e.signal;
          else if (e.kind === 'confirm') text = '等待批准: ' + e.target;
          else if (e.kind === 'grant') text = '已批准: ' + e.target;
          else if (e.kind === 'deny') text = '已拒绝: ' + e.target;
          else if (e.kind === 'session') text = e.text || 'session';
          return '<div><span class="t">' + clock(e.at) + '</span>' +
                 '<span class="tag ' + cls + '">' + esc(e.kind) + '</span>' +
                 '<span class="x">' + esc(text) + '</span></div>';
        }).join('')
      : '<div class="dim">还没有活动</div>';

    var box = document.getElementById('pending');
    var p = s.pending;
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    box.className = p.authorized ? 'granted' : '';
    box.innerHTML =
      '<h2>' + (p.authorized ? '已批准，等待 agent 继续' : '待批准') +
      '<span class="badge">' + ago(p.at) + ' 前</span></h2>' +
      '<div class="target">' + esc(p.target) + '</div>' +
      '<div class="dim">' + esc(p.goal || '') + '</div>' +
      '<div style="margin-top:8px"><button class="ok" id="yes"' + (p.authorized ? ' disabled' : '') +
      '>批准这一步</button><button class="no" id="no">拒绝</button></div>';
    var yes = document.getElementById('yes');
    var no = document.getElementById('no');
    if (yes) yes.onclick = function () { decide(p.target, 'grant', p.id); };
    if (no) no.onclick = function () { decide(p.target, 'deny', p.id); };
  }

  function decide(target, verdict, id) {
    fetch(base + '/decide', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: target, verdict: verdict, id: id })
    }).then(tick);
  }

  function tick() {
    var requested = selected;
    fetch(base + '/state.json?t=' + Date.now() + selectionQuery())
      .then(function (r) { return r.json(); })
      .then(function (s) { if (selected === requested) { render(s); document.getElementById('foot').textContent = ''; } })
      .catch(function () {
        document.getElementById('foot').textContent = '与插件的连接中断';
        document.getElementById('dot').className = 'dot off';
      });
  }
  tick();
  setInterval(tick, 1000);
})();
</script>
</body></html>
`;

export class Viewer {
  #capture;
  #readState;
  #decide;
  #control;
  #chat;
  #log;
  #server = null;
  #port = 0;
  #token = '';
  #frames = new Map();

  /**
   * @param options - `capture(session)` returns a PNG buffer for that session (or null),
   *   `readState(session)` returns the JSON the page renders, `decide` receives one human verdict.
   */
  constructor({ capture, readState, decide, control, chat, log }) {
    this.#capture = capture;
    this.#readState = readState;
    this.#decide = decide;
    // Stop, pause and resume, answered by the same handler the tools use. The board is a
    // second way in, not a second implementation.
    this.#control = typeof control === 'function' ? control : null;
    // The workbench's chat box. It sends into a conversation; the answer renders there.
    this.#chat = typeof chat === 'function' ? chat : null;
    this.#log = typeof log === 'function' ? log : () => {};
  }

  /** The page to open. Empty until {@link listen} resolves. */
  get url() {
    return this.#port === 0 ? '' : `http://127.0.0.1:${this.#port}/${this.#token}/`;
  }

  /**
   * Bind the loopback listener.
   *
   * A fixed port makes the page bookmarkable, but a taken port must not cost the feature:
   * the configured port is tried first and a free one is taken as the fallback, so the
   * URL only moves when something else already owns the default.
   *
   * @param options - `port` 0 asks the OS for a free one.
   * @returns the page URL, or an empty string when nothing could be bound.
   */
  async listen({ port = 0 } = {}) {
    this.#token = await durableToken();
    if (await this.#bind(port)) return this.url;
    if (port !== 0 && (await this.#bind(0))) {
      this.#log(`viewer port ${port} is taken; listening on ${this.#port} instead`);
      return this.url;
    }
    return '';
  }

  /** Try one bind; `true` when the listener is up. */
  async #bind(port) {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.#log(`viewer request failed: ${error?.message ?? error}`);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('viewer error');
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        // Loopback only: this page can authorize actions in a logged-in browser.
        server.listen(port, '127.0.0.1', resolve);
      });
    } catch (error) {
      server.close();
      this.#log(`viewer could not bind ${port}: ${error?.message ?? error}`);
      return false;
    }
    this.#server = server;
    this.#port = server.address().port;
    return true;
  }

  /** Stop listening. Safe to call twice. */
  async close() {
    const server = this.#server;
    this.#server = null;
    this.#port = 0;
    this.#frames.clear();
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
  }

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    // The token is the whole access control story; anything without it is not found.
    if (parts[0] !== this.#token) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    return this.dispatch(req, res, parts.slice(1), url.searchParams);
  }

  /**
   * Answer one request against the board's routes, with no access check of its own.
   *
   * Split out from the loopback handler so the same routes can also be mounted on the
   * application's own server (`ctx.webServer`). The page the plugin renders lives inside
   * the app, so it is already same-origin and already behind the session — it can neither
   * carry this server's loopback token nor should it need a second origin. The token check
   * stays with the loopback carrier, which is the one that faces a browser directly.
   *
   * @param segments - path segments after the mount point; `segments[0]` is the route.
   */
  async dispatch(req, res, segments, searchParams) {
    const route = segments[0] ?? '';
    if (route === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (route === 'state.json') {
      const state = await this.#readState(searchParams.get('session') || undefined);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(state));
      return;
    }
    if (route === 'frame.png') {
      const body = await this.#frameBody(searchParams.get('session') || undefined);
      if (!body) {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (route === 'chat' && req.method === 'POST') {
      if (!this.#chat) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('this viewer cannot send a message');
        return;
      }
      let message;
      try {
        message = JSON.parse(await readBody(req));
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad body');
        return;
      }
      try {
        const sent = await this.#chat(message ?? {});
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...sent }));
        return;
      } catch (error) {
        // A message that could not be sent says why. A chat box that reports success for a
        // message that never arrived is worse than one that reports the failure.
        res.writeHead(409, { 'content-type': 'text/plain' });
        res.end(error.message);
        return;
      }
    }

    if (route === 'control' && req.method === 'POST') {
      if (!this.#control) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('this viewer cannot control a task');
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad body');
        return;
      }
      if (!body || typeof body.action !== 'string' || body.action === '') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('an action is required');
        return;
      }
      try {
        const state = await this.#control(body.action, body.worker, body.reason);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state }));
        return;
      } catch (error) {
        // An unknown action, or one that does not apply, is the caller's mistake rather than
        // the server's, so it is a 409 with the reason rather than a 500.
        res.writeHead(409, { 'content-type': 'text/plain' });
        res.end(error.message);
        return;
      }
    }

    if (route === 'decide' && req.method === 'POST') {
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad body');
        return;
      }
      const target = String(parsed?.target ?? '');
      const verdict = String(parsed?.verdict ?? '');
      const id = String(parsed?.id ?? '');
      // The route checks the shape and the handler checks the meaning. Requiring a target here
      // would refuse an authorisation request, which has an id and no target label — and the
      // viewer has no business knowing what a target is in the first place. An id that names
      // nothing makes the handler return false, which is the 409 below.
      if (id === '' || (verdict !== 'grant' && verdict !== 'deny')) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad decision');
        return;
      }
      if (this.#decide(target, verdict, id) === false) {
        res.writeHead(409, { 'content-type': 'text/plain' });
        res.end('this decision is no longer pending');
        return;
      }
      this.#frames.clear();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  /** One capture, shared by every viewer for a moment. */
  async #frameBody(session) {
    const now = Date.now();
    const frame = this.#frames.get(session);
    if (frame && now - frame.at < FRAME_TTL_MS) return frame.body;
    const body = await this.#capture(session).catch(() => null);
    if (body) {
      // Bound the cache even if a caller supplies arbitrary query strings.
      if (this.#frames.size >= 16) this.#frames.delete(this.#frames.keys().next().value);
      this.#frames.set(session, { at: now, body });
    } else this.#frames.delete(session);
    return body;
  }
}

/** Read a bounded request body. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
