/**
 * Running one task across the windows.
 *
 * What is checked here is the shape the plan asks for: reading and judging happen once, the
 * sending is serialised, and a window that cannot act does not take the others with it. The
 * last one is the reason `waitTimeoutMs` exists — a paused window must be shown not to block
 * the rest, and a test that waited the production timeout would never finish.
 *
 * The fixture's greeting button changes its own text when clicked, so "six greetings were
 * sent" is also visible in the page, not just in the tally.
 *
 * Run: node test/run-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { resolveConfig } = await import('../index.js');
const { Sessions } = await import('../lib/sessions.js');
const { navigate, evaluate } = await import('../lib/page.js');
const { Records } = await import('../lib/records.js');
const { Control } = await import('../lib/control.js');
const { Spend, createAuthorization } = await import('../lib/authorize.js');
const { Windows } = await import('../lib/workers.js');
const { Pacing } = await import('../lib/pacing.js');
const { runTask } = await import('../lib/run.js');

let failures = 0;
async function verify(name, run) {
  try {
    await run();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${error.message}`);
  }
}

const siteConfig = {
  version: 1,
  domain: '127.0.0.1',
  page: 'candidate-list',
  markers: [{ kind: 'exists', locator: { tag: 'ul', attr: [{ name: 'id', equals: 'list' }] } }],
  cards: {
    locator: { tag: 'li', attr: [{ name: 'data-candidate-id', matches: '^C-' }] },
    identity: { from: 'attr:data-candidate-id' },
  },
  fields: { name: { locator: { tag: 'span', attr: [{ name: 'class', equals: 'nm' }] } } },
  actions: { greet: { scope: 'card', type: 'click', effect: 'quota', locator: { tag: 'button', text: { equals: '打招呼' } } } },
};
const account = 'example.test';
const mustAll = { version: 2, id: 'quality-engineer', title: '质量工程师', must: [{ field: 'name', op: 'exists' }], greeting: '您好' };

const html = await readFile(new URL('./fixtures/cards-inspect.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const profileDir = join(tmpdir(), `jev-run-${process.pid}`);
const sessions = new Sessions(resolveConfig({ headless: true, profileDir }));
const config = resolveConfig({ minActionDelayMs: 0, maxActionDelayMs: 0, cooldownEveryActions: 0 });
const pacingFor = () => new Pacing(config);

let storeSeq = 0;
const newStore = () => new Records({ file: join(tmpdir(), `jev-run-records-${process.pid}-${storeSeq++}.jsonl`) });
const authorizationFor = (limit) => createAuthorization({
  account, posting: mustAll.id, postingVersion: mustAll.version, siteVersion: 1,
  actions: ['greet'], greetingVersion: mustAll.greeting, limit,
});

try {
  const control = new Control();
  const windows = new Windows({ sessions, control, count: 2 });
  const opened = await windows.open({ headless: true });
  await navigate(windows.sessionFor('w1').cdp, windows.sessionFor('w1').sessionId, base);
  await navigate(windows.sessionFor('w2').cdp, windows.sessionFor('w2').sessionId, base);

  await verify('both windows opened on their own target', async () => {
    assert.equal(opened.filter((entry) => entry.ok).length, 2, JSON.stringify(opened));
    assert.equal(new Set(opened.map((entry) => entry.targetId)).size, 2);
  });

  await verify('one task greets everyone eligible, across both windows', async () => {
    await navigate(windows.sessionFor('w1').cdp, windows.sessionFor('w1').sessionId, base);
    await navigate(windows.sessionFor('w2').cdp, windows.sessionFor('w2').sessionId, base);
    const store = newStore();
    const spend = new Spend({ limit: 6 });
    const summary = await runTask({
      ctx: {}, config, windows, control, records: store, spend, authorization: authorizationFor(6),
      pacing: pacingFor(), siteConfig, posting: mustAll, account, allowModel: false, waitTimeoutMs: 5000,
    });
    assert.equal(summary.screened.total, 6);
    assert.equal(summary.eligible, 6);
    assert.equal(summary.totals.sent, 6, JSON.stringify(summary.totals));
    assert.equal(summary.totals.refused, 0, JSON.stringify(summary.windows));
    assert.equal(summary.queue.settled, 6);
    assert.equal(summary.spend.spent, 6);
    // Both windows did real work: the reading is shared, the sending is parallel.
    const senders = summary.windows.filter((entry) => entry.sent > 0).length;
    assert.equal(senders, 2, `only ${senders} window sent anything: ${JSON.stringify(summary.windows)}`);
    const entries = await store.readAll();
    assert.equal(entries.filter((e) => e.kind === 'intent').length, 6);
    assert.equal(entries.filter((e) => e.kind === 'result' && e.status === 'confirmed').length, 6);
  });

  await verify('each window changed its own page, and the pages are separate', async () => {
    // Counted across both windows on purpose. Each window acts on its own tab, so a single-page
    // count is a share of the work rather than the total — and a per-window count of zero would
    // mean a window was acting on the other's page.
    const count = async (name) => evaluate(
      windows.sessionFor(name).cdp, windows.sessionFor(name).sessionId,
      'Array.from(document.querySelectorAll("[data-candidate-id] button")).filter((b) => b.textContent === "已打招呼").length',
    );
    const one = await count('w1');
    const two = await count('w2');
    assert.equal(one + two, 6, `w1 greeted ${one}, w2 greeted ${two}`);
    assert.ok(one > 0 && two > 0, `a window did nothing: w1=${one}, w2=${two}`);
  });

  await verify('the account limit stops the rest, and they are reported', async () => {
    await navigate(windows.sessionFor('w1').cdp, windows.sessionFor('w1').sessionId, base);
    await navigate(windows.sessionFor('w2').cdp, windows.sessionFor('w2').sessionId, base);
    const spend = new Spend({ limit: 2 });
    const summary = await runTask({
      ctx: {}, config, windows, control, records: newStore(), spend, authorization: authorizationFor(2),
      pacing: pacingFor(), siteConfig, posting: mustAll, account, allowModel: false, waitTimeoutMs: 5000,
    });
    assert.equal(summary.totals.sent, 2, JSON.stringify(summary.totals));
    assert.equal(summary.totals.refused, 4, JSON.stringify(summary.windows));
    assert.ok(summary.windows.some((entry) => entry.reasons.some((reason) => /limit of 2/.test(reason))),
      `the refusal does not name the limit: ${JSON.stringify(summary.windows.map((w) => w.reasons))}`);
  });

  await verify('a requirement the page does not show is left alone, and named', async () => {
    await navigate(windows.sessionFor('w1').cdp, windows.sessionFor('w1').sessionId, base);
    const unverifiable = { ...mustAll, id: 'needs-experience', must: [{ field: 'experience', op: 'at_least', value: 3 }] };
    const spend = new Spend({ limit: 6 });
    const summary = await runTask({
      ctx: {}, config, windows, control, records: newStore(), spend, authorization: authorizationFor(6),
      pacing: pacingFor(), siteConfig, posting: unverifiable, account, allowModel: false, waitTimeoutMs: 5000,
    });
    assert.equal(summary.eligible, 0, 'a candidate was queued without settling the requirement');
    assert.equal(summary.totals.sent, 0);
    assert.equal(summary.left.length, 6);
    assert.equal(summary.left[0].verdict, 'unverified');
    assert.match(summary.left[0].reason, /experience/);
  });

  await verify('an already contacted candidate is left out and said so', async () => {
    await navigate(windows.sessionFor('w1').cdp, windows.sessionFor('w1').sessionId, base);
    await navigate(windows.sessionFor('w2').cdp, windows.sessionFor('w2').sessionId, base);
    const store = newStore();
    await store.append({
      at: new Date().toISOString(), kind: 'intent', posting: mustAll.id, account,
      identity: 'C-1001', action: 'greet', status: 'pending', window: 'earlier run',
    });
    const spend = new Spend({ limit: 6 });
    const summary = await runTask({
      ctx: {}, config, windows, control, records: store, spend, authorization: authorizationFor(6),
      pacing: pacingFor(), siteConfig, posting: mustAll, account, allowModel: false, waitTimeoutMs: 5000,
    });
    assert.equal(summary.eligible, 5, `queued ${summary.eligible}`);
    assert.equal(summary.totals.sent, 5);
    const left = summary.left.find((entry) => entry.identity === 'C-1001');
    assert.ok(left, 'the contacted candidate was not reported as left');
    assert.match(left.reason, /outcome is unknown/);
  });

  await verify('a stop before the run sends nothing at all', async () => {
    await navigate(windows.sessionFor('w1').cdp, windows.sessionFor('w1').sessionId, base);
    const stopped = new Control();
    const stoppedWindows = new Windows({ sessions, control: stopped, count: 2 });
    await stoppedWindows.open({ headless: true });
    stopped.stop('operator');
    const spend = new Spend({ limit: 6 });
    const summary = await runTask({
      ctx: {}, config, windows: stoppedWindows, control: stopped, records: newStore(), spend,
      authorization: authorizationFor(6), pacing: pacingFor(), siteConfig, posting: mustAll, account,
      allowModel: false, waitTimeoutMs: 1000,
    });
    assert.equal(summary.totals.sent, 0);
    assert.equal(spend.spent, 0, 'a stopped run consumed quota');
    assert.ok(summary.windows.every((entry) => entry.ok === false), JSON.stringify(summary.windows));
  });

  await verify('a paused window does not hold up the others', async () => {
    await navigate(windows.sessionFor('w1').cdp, windows.sessionFor('w1').sessionId, base);
    await navigate(windows.sessionFor('w2').cdp, windows.sessionFor('w2').sessionId, base);
    const held = new Control();
    const heldWindows = new Windows({ sessions, control: held, count: 2 });
    await heldWindows.open({ headless: true });
    await navigate(heldWindows.sessionFor('w1').cdp, heldWindows.sessionFor('w1').sessionId, base);
    await navigate(heldWindows.sessionFor('w2').cdp, heldWindows.sessionFor('w2').sessionId, base);
    held.pause('w2', '等待确认');
    const spend = new Spend({ limit: 6 });
    const summary = await runTask({
      ctx: {}, config, windows: heldWindows, control: held, records: newStore(), spend,
      authorization: authorizationFor(6), pacing: pacingFor(), siteConfig, posting: mustAll, account,
      allowModel: false, waitTimeoutMs: 400,
    });
    const w1 = summary.windows.find((entry) => entry.name === 'w1');
    const w2 = summary.windows.find((entry) => entry.name === 'w2');
    assert.ok(w1.sent > 0, `the unpaused window sent nothing: ${JSON.stringify(summary.windows)}`);
    assert.equal(w2.ok, false, 'the paused window ran anyway');
    assert.match(w2.error, /did not become runnable/);
    assert.ok(summary.totals.sent >= 1, 'nothing was sent while a window was paused');
    await heldWindows.close();
  });
} finally {
  await sessions.closeAll().catch(() => {});
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  server.close();
}

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
