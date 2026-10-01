/**
 * Windows and their shared queue.
 *
 * `WorkQueue` is tested for the one property that matters — a candidate is never handed out
 * twice, including when claims interleave — because that is what two windows working a list
 * can get wrong, and getting it wrong greets someone twice.
 *
 * `Windows` is tested against real Chrome, because "the windows are independent" is a claim
 * about sessions and targets that a stub cannot settle: two workers are pointed at different
 * pages and each must still see its own.
 *
 * Run: node test/workers-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { resolveConfig } = await import('../index.js');
const { Sessions } = await import('../lib/sessions.js');
const { navigate, snapshot } = await import('../lib/page.js');
const { Control } = await import('../lib/control.js');
const { WorkQueue, Windows, WINDOW_STATES } = await import('../lib/workers.js');

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

const items = (n) => Array.from({ length: n }, (_, i) => ({ identity: `C-${1000 + i}`, name: `候选人${i}` }));

console.log('=== the queue never hands out the same person twice ===');
{
  await verify('the vocabulary is closed', async () => {
    assert.deepEqual(WINDOW_STATES, ['idle', 'working', 'paused', 'takeover', 'stopped', 'failed']);
  });

  await verify('claims go out in order, one at a time', async () => {
    const queue = new WorkQueue(items(4));
    assert.equal(queue.claim('w1').identity, 'C-1000');
    assert.equal(queue.claim('w2').identity, 'C-1001');
    assert.equal(queue.claim('w1').identity, 'C-1002');
    assert.deepEqual(queue.claims.map((c) => [c.identity, c.worker]), [['C-1000', 'w1'], ['C-1001', 'w2'], ['C-1002', 'w1']]);
  });

  await verify('interleaved claims from two workers never duplicate', async () => {
    const queue = new WorkQueue(items(200));
    const seen = [];
    // Two workers pulling without waiting on each other, exactly as the run does.
    const pull = (worker) => {
      for (;;) {
        const item = queue.claim(worker);
        if (!item) return;
        seen.push(item.identity);
      }
    };
    await Promise.all([Promise.resolve().then(() => pull('w1')), Promise.resolve().then(() => pull('w2'))]);
    assert.equal(seen.length, 200, `${seen.length} of 200 were handed out`);
    assert.equal(new Set(seen).size, 200, 'the same candidate was handed out twice');
    assert.equal(queue.stats.pending, 0);
    assert.equal(queue.stats.claimed, 200);
  });

  await verify('an item with no identity is skipped, with the reason', async () => {
    const queue = new WorkQueue([{ name: '匿名' }, { identity: 'C-1' }]);
    const claimed = queue.claim('w1');
    assert.equal(claimed.identity, 'C-1', 'an unidentifiable item was handed out');
    assert.equal(queue.skipped.length, 1);
    assert.match(queue.skipped[0].reason, /no stable identity/);
  });

  await verify('settling and releasing do what they say', async () => {
    const queue = new WorkQueue(items(2));
    const first = queue.claim('w1');
    assert.equal(queue.settle(first.identity), true);
    assert.equal(queue.settle('C-9999'), false);
    const second = queue.claim('w1');
    assert.equal(queue.release(second.identity), true);
    // Released work comes back rather than being lost, so a failure is retryable.
    assert.equal(queue.claim('w2').identity, second.identity);
    assert.deepEqual(queue.stats, { pending: 0, claimed: 1, settled: 1, skipped: 0 });
  });

  await verify('an empty queue yields nothing rather than throwing', async () => {
    assert.equal(new WorkQueue([]).claim('w1'), null);
  });
}

// ── real windows ─────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(`<!doctype html><title>${req.url === '/two' ? 'second' : 'first'}</title><p>${req.url}</p>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const profileDir = join(tmpdir(), `jev-workers-${process.pid}`);
const sessions = new Sessions(resolveConfig({ headless: true, profileDir }));

console.log('\n=== real windows ===');
try {
  const control = new Control();
  const windows = new Windows({ sessions, control, count: 2 });
  const opened = await windows.open({ headless: true });

  await verify('both windows open, on distinct targets', async () => {
    assert.equal(opened.filter((entry) => entry.ok).length, 2, JSON.stringify(opened));
    const targets = opened.map((entry) => entry.targetId);
    assert.equal(new Set(targets).size, 2, `the windows share a target: ${JSON.stringify(targets)}`);
    assert.deepEqual(windows.names, ['w1', 'w2']);
  });

  await verify('each window sees its own page', async () => {
    await navigate(windows.sessionFor('w1').cdp, windows.sessionFor('w1').sessionId, `${base}/one`);
    await navigate(windows.sessionFor('w2').cdp, windows.sessionFor('w2').sessionId, `${base}/two`);
    const one = await snapshot(windows.sessionFor('w1').cdp, windows.sessionFor('w1').sessionId);
    const two = await snapshot(windows.sessionFor('w2').cdp, windows.sessionFor('w2').sessionId);
    assert.equal(one.title, 'first');
    assert.equal(two.title, 'second', 'a window read the other window\'s page');
  });

  await verify('the windows really overlap in time', async () => {
    const started = Date.now();
    await windows.each(() => new Promise((resolve) => setTimeout(resolve, 300)));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 550, `two windows of 300ms took ${elapsed}ms, so they ran in sequence`);
  });

  await verify('one window failing does not end the other', async () => {
    const results = await windows.each((name) => {
      if (name === 'w1') throw new Error('this window broke');
      return 'finished';
    });
    assert.equal(results.find((entry) => entry.name === 'w1').ok, false);
    assert.equal(results.find((entry) => entry.name === 'w2').ok, true, 'a failure in one window stopped the other');
    assert.equal(windows.workers.find((w) => w.name === 'w1').state, 'failed');
  });

  await verify('the board reflects a halt, not what the window was doing', async () => {
    windows.setState('w1', 'working', 'C-1001');
    assert.equal(windows.workers.find((w) => w.name === 'w1').state, 'working');
    control.pause('w1', '等待确认');
    const paused = windows.workers.find((w) => w.name === 'w1');
    assert.equal(paused.state, 'paused', 'a paused window still reported itself as working');
    assert.ok(paused.candidate === 'C-1001', 'the paused window lost what it was on');
    assert.throws(() => windows.throwIfHalted('w1'), /等待确认/);
    windows.throwIfHalted('w2');
    control.resume('w1');
    assert.equal(windows.workers.find((w) => w.name === 'w1').state, 'working');
  });

  await verify('a stopped run says stopped for every window', async () => {
    control.stop('operator');
    for (const worker of windows.workers) assert.equal(worker.state, 'stopped', `${worker.name} did not report the stop`);
  });

  await verify('closing a window leaves the other one usable', async () => {
    // The plan is explicit that closing a worker must not end the shared browser.
    await sessions.close('w1').catch(() => {});
    const two = await snapshot(windows.sessionFor('w2').cdp, windows.sessionFor('w2').sessionId).catch((error) => ({ error: error.message }));
    assert.equal(two.title, 'second', `the other window stopped working: ${two.error ?? ''}`);
  });

  await windows.close();
} finally {
  await sessions.closeAll().catch(() => {});
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  server.close();
}

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
