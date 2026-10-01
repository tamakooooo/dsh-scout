/**
 * Four sessions working at once: the properties that only exist under real concurrency.
 *
 * Everything here is offline and deterministic — a local fixture server, a stubbed decision
 * endpoint, and a real headless Chrome. The single-session suites cannot reach these
 * behaviours, because they never have two runs in flight at the same time.
 *
 * The fixture's click handler blocks the dispatch itself for 120ms. That models a site doing
 * work while the click lands, and it is what makes overlap measurable: each tab records the
 * interval its handler occupied, in its own DOM, and the intervals are compared afterwards
 * against the shared machine clock.
 *
 * Run: node test/concurrency-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { resolveConfig } = await import('../index.js');
const { Sessions } = await import('../lib/sessions.js');
const { Pacing } = await import('../lib/pacing.js');
const { runGoal } = await import('../lib/act.js');
const { navigate, evaluate, snapshot } = await import('../lib/page.js');

let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${error.message}`);
  }
}

/** One session's page: a greeting that occupies the click, and a benign next-page button. */
function pageFor(name) {
  return `<!doctype html><meta charset="utf-8"><title>${name}</title>
  <div>${name}</div>
  <button id="greet" onclick="
    window.jevLog = window.jevLog || [];
    var s = Date.now(); var until = s + 120; while (Date.now() < until) {}
    window.jevLog.push({ what: 'greet', start: s, end: Date.now() });
    this.textContent = '${name} · 已打招呼';
  ">${name} · 打招呼</button>
  <button id="next" onclick="
    window.jevLog = window.jevLog || [];
    window.jevLog.push({ what: 'next', start: Date.now(), end: Date.now() });
  ">${name} · 下一页</button>`;
}

const NAMES = ['w1', 'w2', 'w3', 'w4'];
const routes = new Map(NAMES.map((name) => [`/${name}`, pageFor(name)]));
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(routes.get(req.url) ?? 'missing route');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const profileDir = join(tmpdir(), `jev-concurrency-${process.pid}`);
const config = resolveConfig({
  headless: true,
  baseUrl: 'http://jev.test',
  minActionDelayMs: 0,
  maxActionDelayMs: 0,
  cooldownEveryActions: 0,
  maxActionsPerSession: 50,
  maxSessions: 4,
  newWindow: true,
  profileDir,
});

// ── the decision endpoint, routed per session ────────────────────────────────
// Four runs are in flight, so a single queue of canned decisions would hand w2 the answer
// meant for w1. The goal in the state text is what identifies the caller.
const realFetch = globalThis.fetch;
let decisionCalls = 0;
globalThis.fetch = async (url, options) => {
  if (String(url) !== `${config.baseUrl}/systemone`) return realFetch(url, options);
  decisionCalls += 1;
  const request = JSON.parse(options.body);
  const goal = (/GOAL: (.*)/.exec(String(request.state ?? ''))?.[1] ?? '').trim();
  const [name, kind] = goal.split(/\s+/);
  const label = `${name} · ${kind === 'next' ? '下一页' : '打招呼'}`;

  let answers;
  if (request.questions.next_action) {
    answers = {
      page_status: { type: 'choice', choice: 'ready' },
      goal_reached: { type: 'noul', noul: 0 },
      next_action: { type: 'choice', choice: 'click' },
    };
    // Every targeted action's option set rides in this one request; the chosen action picks
    // which answer is used. Prefer the control this goal asked for, and fall back to any
    // control of this session's page, because a run that keeps going after its click sees
    // the swapped label.
    for (const id of Object.keys(request.questions)) {
      if (!id.startsWith('target_')) continue;
      const criteria = Object.entries(request.questions[id].criteria ?? {});
      const preferred = criteria.find(([, description]) => String(description).includes(`"${label}"`));
      const fallback = criteria.find(([, description]) => String(description).includes(`"${name} · `));
      const found = preferred ?? fallback;
      assert.ok(found, `${goal}: no criterion names a ${name} control — criteria were ${JSON.stringify(Object.values(request.questions[id].criteria ?? {})).slice(0, 300)}`);
      answers[id] = { type: 'choice', choice: found[0] };
    }
  } else if (request.questions.confidence) {
    answers = { confidence: { type: 'score', score: 3 } };
  } else {
    answers = { confidence: { type: 'score', score: 3 } };
  }
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 5, output_tokens: 1 } }));
};

// An offline credential, so this suite needs no real key and no network: every decision
// request is answered by the stub below.
const ctx = {
  get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'offline-test-key', source: 'mock' }) } : undefined),
};

const sessions = new Sessions(config);
const pacing = new Pacing(config);
let chrome;

/** The click intervals one tab recorded, which is how overlap is measured. */
const logOf = (name) => evaluate(sessions.raw(name).cdp, sessions.raw(name).sessionId, 'window.jevLog || []');

try {
  // ── four sessions, four windows, one browser ───────────────────────────────
  await check('four sessions open as four windows of one browser', async () => {
    const settled = await Promise.allSettled(NAMES.map((name) => sessions.ensure(name, { headless: true })));
    const rejected = settled.filter((outcome) => outcome.status === 'rejected');
    assert.equal(rejected.length, 0, `a session failed to open: ${rejected.map((o) => o.reason?.message).join(' | ')}`);
    const pids = NAMES.map((name) => sessions.raw(name)?.pid);
    assert.equal(new Set(pids).size, 1, `sessions landed on ${new Set(pids).size} browsers`);

    const targets = NAMES.map((name) => sessions.raw(name)?.targetId);
    assert.equal(new Set(targets).size, 4, `sessions shared a tab: ${targets.join(', ')}`);

    const windows = [];
    for (const name of NAMES) {
      const raw = sessions.raw(name);
      await navigate(raw.cdp, raw.sessionId, `${base}/${name}`);
      const { windowId } = await raw.cdp.send('Browser.getWindowForTarget', { targetId: raw.targetId }, undefined, 8000);
      windows.push(windowId);
    }
    assert.equal(new Set(windows).size, 4, `expected four windows, got ${new Set(windows).size}`);
  });

  // ── four stops at once, each addressable ───────────────────────────────────
  await check('four sessions can be waiting for a decision at the same time', async () => {
    // Each run reaches the gate and stops. With one pending slot the later three would have
    // replaced the first, and the replaced session could never be granted: granting needs a
    // pending decision to match.
    const runs = NAMES.map((name) => runGoal({
      ctx, config, session: sessions.raw(name), goal: `${name} greet`, maxSteps: 1, signal: undefined, pacing,
    }));
    const reports = await Promise.all(runs);
    assert.deepEqual(reports.map((report) => report.status), NAMES.map(() => 'needs_confirmation'));
    assert.equal(pacing.pendings.length, 4, `expected four stops, got ${pacing.pendings.length}`);

    // Answer them in reverse, purely to show the order does not matter.
    for (const name of [...NAMES].reverse()) {
      const stop = pacing.pendingFor(name);
      assert.ok(stop, `${name} has no pending stop`);
      assert.equal(pacing.grant(stop.target, 900000, stop.id), true, `${name} could not be granted`);
    }
    for (const name of NAMES) assert.equal(pacing.pendingFor(name)?.authorized, true, `${name} was not marked authorized`);
  });

  // ── the greetings take turns ───────────────────────────────────────────────
  await check('greetings across sessions never overlap', async () => {
    const reports = await Promise.all(NAMES.map((name) => runGoal({
      ctx, config, session: sessions.raw(name), goal: `${name} greet`, maxSteps: 1, confirm: true, pacing,
    })));
    for (const report of reports) {
      assert.equal(report.trace[0].verified, 'verified', `not verified: ${report.status} — ${report.trace[0].basis}`);
    }

    const intervals = [];
    for (const name of NAMES) {
      for (const entry of await logOf(name)) if (entry.what === 'greet') intervals.push({ name, ...entry });
    }
    assert.equal(intervals.length, 4, `expected four greetings, saw ${intervals.length}`);
    intervals.sort((a, b) => a.start - b.start);
    for (let i = 1; i < intervals.length; i += 1) {
      assert.ok(
        intervals[i].start >= intervals[i - 1].end,
        `${intervals[i - 1].name} [${intervals[i - 1].start},${intervals[i - 1].end}] overlapped ${intervals[i].name} [${intervals[i].start},${intervals[i].end}]`,
      );
    }
  });

  // ── reading still runs alongside spending ──────────────────────────────────
  await check('a benign action does not queue behind a greeting', async () => {
    // Long enough to outlast any single benign run. A run costs roughly 300ms of deliberate
    // settle waits (`waitForReady` sleeps 150ms after the document is already complete, once
    // per step and once more for verification), and those sleeps are outside the lock, so
    // they overlap across sessions. This measures *ordering*, not speed.
    let holding = true;
    const hold = pacing.withQuotaLock(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      holding = false;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const t0 = Date.now();
    const report = await runGoal({
      ctx, config, session: sessions.raw('w3'), goal: 'w3 next', maxSteps: 1, signal: undefined, pacing,
    });
    console.log(`        (benign run took ${Date.now() - t0}ms; lock still held: ${holding}; status ${report.status})`);
    assert.equal(holding, true, 'the benign action waited for the quota lock');
    assert.equal(report.trace[0].action, 'click', `the benign run did not act: ${report.status}`);
    const clicked = (await logOf('w3')).some((entry) => entry.what === 'next');
    assert.equal(clicked, true, 'the benign click never happened');
    await hold;
  });

  await check('a read is unaffected by a held quota lock', async () => {
    const release = pacing.withQuotaLock(() => new Promise((resolve) => setTimeout(resolve, 300)));
    const started = Date.now();
    const page = await snapshot(sessions.raw('w4').cdp, sessions.raw('w4').sessionId);
    const elapsed = Date.now() - started;
    assert.ok(page && page.elements.length > 0, 'the snapshot returned nothing');
    assert.ok(elapsed < 250, `a read waited ${elapsed}ms behind the lock`);
    await release;
  });
} finally {
  await sessions.closeAll().catch(() => {});
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  server.close();
  globalThis.fetch = realFetch;
  if (chrome) await chrome.kill().catch(() => {});
}

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
