/**
 * Stopping, pausing, handing the browser back.
 *
 * The measurement that matters is the third check: a stop must take hold *during* a wait, not
 * after it. A stop that only applies at the next step still sends whatever the current step
 * was about to send, and the plan asks for it to land within five seconds. The assertion
 * therefore times a ten-second sleep that is interrupted, rather than trusting the code to
 * look right.
 *
 * The rest is the distinction between the three halts, because they mean different things to
 * whoever is watching: a pause continues as it was, a takeover must begin by re-reading the
 * page, and a stop is final.
 *
 * Run: node test/control-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';

const { Control, HaltedError, ControlTimeoutError, WORKER_STATES } = await import('../lib/control.js');

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

console.log('=== a stop is a stop ===');
{
  await verify('the vocabulary is closed', async () => {
    assert.deepEqual(WORKER_STATES, ['running', 'paused', 'takeover', 'stopped']);
  });

  await verify('stopping refuses every later boundary, naming the reason', async () => {
    const control = new Control();
    control.stop('the operator pressed stop');
    assert.equal(control.stopped, true);
    let thrown = null;
    try { control.throwIfHalted('w1'); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof HaltedError);
    assert.equal(thrown.state, 'stopped');
    assert.match(thrown.message, /pressed stop/);
  });

  await verify('a stop interrupts a wait instead of outlasting it', async () => {
    const control = new Control();
    const started = Date.now();
    const sleeping = control.sleep(10000);
    setTimeout(() => control.stop('stop during the wait'), 50);
    const result = await sleeping;
    const elapsed = Date.now() - started;
    assert.equal(result.interrupted, true, 'the wait ran to completion');
    assert.ok(elapsed < 2000, `the wait took ${elapsed}ms to notice a stop`);
  });

  await verify('sleeping the full duration reports that it was not interrupted', async () => {
    const result = await new Control().sleep(20);
    assert.equal(result.interrupted, false);
  });

  await verify('a stop is final: resuming does not undo it', async () => {
    const control = new Control();
    control.pause('w1');
    control.stop('done');
    control.resume('w1');
    control.release('w1');
    assert.equal(control.stateOf('w1'), 'stopped', 'the run came back after being stopped');
  });

  await verify('pausing a stopped run changes nothing', async () => {
    const control = new Control();
    control.stop('done');
    control.pause('w1');
    assert.deepEqual(control.snapshot.workers, {});
    assert.equal(control.stateOf('w1'), 'stopped');
  });

  await verify('the signal aborts, so cancellable work can use it', async () => {
    const control = new Control();
    assert.equal(control.signal.aborted, false);
    control.stop('done');
    assert.equal(control.signal.aborted, true);
  });
}

console.log('\n=== a pause is per window ===');
{
  await verify('one worker is held while another keeps running', async () => {
    const control = new Control();
    control.pause('w1', 'checking something');
    assert.equal(control.stateOf('w1'), 'paused');
    assert.equal(control.stateOf('w2'), 'running');
    assert.throws(() => control.throwIfHalted('w1'), /checking something/);
    control.throwIfHalted('w2');
  });

  await verify('waiting through a pause returns when it is resumed', async () => {
    const control = new Control();
    control.pause('w1');
    const waiting = control.waitUntilRunnable('w1', { pollMs: 20 });
    setTimeout(() => control.resume('w1'), 80);
    await waiting;
    assert.equal(control.stateOf('w1'), 'running');
  });

  await verify('a stop while paused ends the wait promptly', async () => {
    const control = new Control();
    control.pause('w1');
    const started = Date.now();
    const waiting = control.waitUntilRunnable('w1', { pollMs: 20 }).catch((error) => error);
    setTimeout(() => control.stop('stopped while waiting'), 60);
    const error = await waiting;
    assert.ok(error instanceof HaltedError, `the wait resolved with ${error}`);
    assert.equal(error.state, 'stopped');
    assert.ok(Date.now() - started < 2000, 'the wait noticed the stop too late');
  });

  await verify('waiting gives up rather than hanging forever', async () => {
    const control = new Control();
    control.pause('w1');
    const error = await control.waitUntilRunnable('w1', { timeoutMs: 120, pollMs: 20 }).catch((thrown) => thrown);
    assert.ok(error instanceof ControlTimeoutError, `the wait resolved with ${error}`);
    assert.match(error.message, /w1/);
  });

  await verify('a running worker does not wait at all', async () => {
    const started = Date.now();
    await new Control().waitUntilRunnable('w1', { timeoutMs: 5000, pollMs: 200 });
    assert.ok(Date.now() - started < 100, 'a running worker waited');
  });
}

console.log('\n=== a takeover owes a re-read ===');
{
  await verify('taking over halts the worker and is named as a takeover', async () => {
    const control = new Control();
    control.takeover('w1', '有人正在操作浏览器');
    assert.equal(control.stateOf('w1'), 'takeover');
    const snapshot = control.snapshot;
    assert.equal(snapshot.workers.w1.state, 'takeover');
    assert.match(snapshot.workers.w1.reason, /有人/);
    let thrown = null;
    try { control.throwIfHalted('w1'); } catch (error) { thrown = error; }
    assert.equal(thrown.state, 'takeover');
  });

  await verify('releasing runs again but still owes a re-read until it is done', async () => {
    const control = new Control();
    control.takeover('w1');
    control.release('w1');
    assert.equal(control.stateOf('w1'), 'running', 'the worker did not resume');
    assert.equal(control.staleFor('w1'), true, 'a person may have changed the page, so a re-read is owed');
    assert.deepEqual(control.snapshot.staleWorkers, ['w1']);
    control.clearStale('w1');
    assert.equal(control.staleFor('w1'), false);
  });

  await verify('releasing a worker that was never taken over owes nothing', async () => {
    const control = new Control();
    control.release('w1');
    assert.equal(control.staleFor('w1'), false);
  });

  await verify('the snapshot names every reason the board has to show', async () => {
    const control = new Control();
    control.pause('w1', '等待确认');
    control.takeover('w2', '人工操作中');
    const snapshot = control.snapshot;
    assert.equal(snapshot.stopped, false);
    assert.equal(snapshot.workers.w1.state, 'paused');
    assert.equal(snapshot.workers.w1.reason, '等待确认');
    assert.equal(snapshot.workers.w2.state, 'takeover');
    assert.deepEqual(Object.keys(snapshot.workers).sort(), ['w1', 'w2']);
  });
}

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
