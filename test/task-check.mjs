/**
 * The task object: start, watch, stop.
 *
 * The measurement that matters is the second check. A run takes minutes, so `start` must
 * return while the work continues — not merely document that it does. The pacing is given a
 * real per-action delay so the run cannot possibly finish first, and the call is timed.
 *
 * The other half is that the picture is live: the windows and the allowance come from the run
 * itself, so the board and a `status` call cannot drift into describing different runs.
 *
 * Run: node test/task-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { resolveConfig } = await import('../index.js');
const { Sessions } = await import('../lib/sessions.js');
const { navigate } = await import('../lib/page.js');
const { Records } = await import('../lib/records.js');
const { Pacing } = await import('../lib/pacing.js');
const { Task, TASK_STATES } = await import('../lib/task.js');
const { readAuthorizations } = await import('../lib/authorize.js');

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
  // The config names the platform's page. The fixture is served from loopback, but the
  // configuration describes where this page lives on the real site, and the run checks the two
  // agree — there is no loopback escape in the guard itself.
  domain: 'rd6.zhaopin.com',
  page: 'candidate-list',
  markers: [{ kind: 'exists', locator: { tag: 'ul', attr: [{ name: 'id', equals: 'list' }] } }],
  cards: {
    locator: { tag: 'li', attr: [{ name: 'data-candidate-id', matches: '^C-' }] },
    identity: { from: 'attr:data-candidate-id' },
  },
  fields: { name: { locator: { tag: 'span', attr: [{ name: 'class', equals: 'nm' }] } } },
  actions: { greet: { scope: 'card', type: 'click', effect: 'quota', locator: { tag: 'button', text: { equals: '打招呼' } } } },
};
const posting = { version: 1, id: 'quality-engineer', platform: 'zhaopin', title: '质量工程师', must: [{ field: 'name', op: 'exists' }], greeting: '您好', limits: { contacts: 10, windows: 2 } };
const account = 'example.test';

const html = await readFile(new URL('./fixtures/cards-inspect.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const profileDir = join(tmpdir(), `jev-task-${process.pid}`);
const sessions = new Sessions(resolveConfig({ headless: true, profileDir }));
// A real delay between greetings, so a run cannot finish before it can be observed.
const config = resolveConfig({ minActionDelayMs: 250, maxActionDelayMs: 250, cooldownEveryActions: 0 });
let seq = 0;
const newTask = () => new Task({
  config,
  sessions,
  records: new Records({ file: join(tmpdir(), `jev-task-records-${process.pid}-${seq++}.jsonl`) }),
  pacing: new Pacing(config),
});
const authorizationFor = (task, limit = 6) => task.authorize({
  platform: 'zhaopin', account, posting: posting.id, postingVersion: posting.version, siteVersion: 1,
  actions: ['greet'], greetingVersion: posting.greeting, limit,
});

try {
  await verify('the vocabulary is closed', async () => {
    assert.deepEqual(TASK_STATES, ['idle', 'running', 'finished', 'stopped', 'failed']);
  });

  await verify('an authorisation is on file before any run uses it', async () => {
    const task = newTask();
    assert.equal(task.state, 'idle');
    const { authorization, file } = await authorizationFor(task);
    assert.equal(authorization.limit, 6);
    assert.match(file, /authorizations\.jsonl$/);
    const recorded = await readAuthorizations();
    assert.ok(recorded.some((entry) => entry.id === authorization.id), 'the authorisation was not written to the audit file');
    assert.equal(task.status.authorization.limit, 6);
  });

  await verify('starting without an authorisation is refused', async () => {
    await assert.rejects(() => newTask().start({ siteConfig, posting, account }), /no authorisation/);
  });

  await verify('start returns while the run is still going', async () => {
    const task = newTask();
    await authorizationFor(task);
    const started = Date.now();
    const status = await task.start({ siteConfig, posting, account, url: base, windows: 2, headless: true, waitTimeoutMs: 4000 });
    const elapsed = Date.now() - started;
    assert.equal(status.state, 'running', `the call waited for the run: ${status.state}`);
    assert.ok(elapsed < 2000, `start took ${elapsed}ms`);
    assert.equal(status.windows.length, 2);
    assert.equal(status.posting, posting.id);
    assert.equal(status.spend.limit, 6);
    const finished = await task.settled({ timeoutMs: 60000 });
    assert.equal(finished.state, 'finished', JSON.stringify(finished.error));
    assert.equal(finished.summary.totals.sent, 6, JSON.stringify(finished.summary.totals));
    await task.close();
  });

  await verify('the status is live, not a snapshot from the end', async () => {
    const task = newTask();
    await authorizationFor(task);
    await task.start({ siteConfig, posting, account, url: base, windows: 2, headless: true, waitTimeoutMs: 4000 });
    // Wait until the *progress* shows a send, not merely until the quota moved: the allowance
    // is taken before the action, so polling on it reads the picture in the window between the
    // reserve and the tick, which is a race and not a measurement.
    // Generous, because the whole suite runs browser suites back to back and the machine is
    // busy; and the failure names the state it ended in, so a future failure says whether the
    // progress never moved or the run had already finished before it could be seen.
    const deadline = Date.now() + 45000;
    while ((task.status.progress?.totals?.sent ?? 0) === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok((task.status.progress?.totals?.sent ?? 0) > 0,
      `nothing was spent while the run was going (state ${task.status.state}, progress ${JSON.stringify(task.status.progress?.totals ?? null)})`);
    const live = task.status;
    assert.ok(live.spend.spent > 0, 'nothing was spent while the run was going');
    assert.ok(['running', 'finished'].includes(live.state));
    assert.ok(live.windows.some((window) => window.targetId !== ''), 'the windows are not reported');
    assert.ok(live.progress, 'no progress was reported');
    assert.equal(live.progress.totals.sent > 0, true, JSON.stringify(live.progress.totals));
    await task.settled({ timeoutMs: 60000 });
    await task.close();
  });

  await verify('a second start while one is running is refused', async () => {
    const task = newTask();
    await authorizationFor(task);
    await task.start({ siteConfig, posting, account, url: base, windows: 2, headless: true, waitTimeoutMs: 4000 });
    await assert.rejects(() => task.start({ siteConfig, posting, account }), /already running/);
    await task.settled({ timeoutMs: 60000 });
    await task.close();
  });

  await verify('a stop ends the run and stops the sending', async () => {
    const task = newTask();
    await authorizationFor(task);
    await task.start({ siteConfig, posting, account, url: base, windows: 2, headless: true, waitTimeoutMs: 4000 });
    const deadline = Date.now() + 10000;
    while (task.status.spend.spent === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
    const stopped = task.stop('the operator pressed stop');
    assert.equal(stopped.state, 'stopped');
    const done = await task.settled({ timeoutMs: 60000 });
    const sent = done.summary ? done.summary.totals.sent : 0;
    assert.ok(sent < 6, `the run kept going after a stop: ${sent} of 6 were sent`);
    assert.ok(sent >= 1, 'nothing was sent before the stop, so the check proved nothing');
    await task.close();
  });

  await verify('a pause holds one window and is visible in the status', async () => {
    const task = newTask();
    await authorizationFor(task);
    await task.start({ siteConfig, posting, account, url: base, windows: 2, headless: true, waitTimeoutMs: 1500 });
    task.pause('w2', '等待确认');
    const paused = task.status.windows.find((window) => window.name === 'w2');
    assert.equal(paused.state, 'paused', JSON.stringify(task.status.windows));
    assert.ok(task.status.windows.some((window) => window.name === 'w1' && window.state !== 'paused'), 'the pause spread to the other window');
    await task.settled({ timeoutMs: 60000 });
    await task.close();
  });

  await verify('the lower of the posting ceiling and the authorisation wins', async () => {
    const task = newTask();
    await authorizationFor(task, 20);
    const capped = { ...posting, limits: { contacts: 2, windows: 2 } };
    const status = await task.start({ siteConfig, posting: capped, account, url: base, windows: 2, headless: true, waitTimeoutMs: 4000 });
    assert.equal(status.spend.limit, 2, 'the posting ceiling was ignored');
    const done = await task.settled({ timeoutMs: 60000 });
    assert.equal(done.summary.totals.sent, 2, JSON.stringify(done.summary.totals));
    assert.equal(done.summary.totals.refused, 4, JSON.stringify(done.summary.windows));
    await task.close();
  });
} finally {
  await sessions.closeAll().catch(() => {});
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  server.close();
}

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
