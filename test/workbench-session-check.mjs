/**
 * The workbench's own conversation.
 *
 * The property is that the right-hand panel is one session with a stable identity, not whichever
 * conversation happened to be active. So the assertions are about adoption: the first call creates
 * and writes the identity down, every later call adopts the same one — and a Host that hands back
 * no identity is refused rather than being recorded as an empty session.
 *
 * The id is never invented here: `SessionId` is a branded value the platform validates, so the
 * test uses ids the "platform" chose and asserts that they are what comes back.
 *
 * Run: node test/workbench-session-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

const {
  ensureWorkbenchSession, readWorkbenchSession, writeWorkbenchSession, workbenchSessionFile,
} = await import('../lib/workbench-session.js');

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

/** A Host stub that records what it was asked and hands back the id it was told to. */
function host({ mintedId = 'session-minted-by-host', adoptAs = null } = {}) {
  const calls = [];
  return {
    calls,
    sessionController: {
      async create(request) {
        calls.push(request);
        if (request.sessionId) return { sessionId: adoptAs ?? request.sessionId };
        return { sessionId: mintedId };
      },
    },
  };
}

await rm(workbenchSessionFile(), { force: true }).catch(() => {});

await verify('the first call creates a session and writes its identity down', async () => {
  const ctx = host({ mintedId: 'session-first' });
  const result = await ensureWorkbenchSession(ctx);
  assert.equal(result.sessionId, 'session-first');
  assert.equal(result.created, true);
  // Nothing was prescribed: the platform chose the identity, because a made-up one may not be
  // one the platform accepts.
  assert.deepEqual(ctx.calls, [{}]);
  assert.equal((await readWorkbenchSession()).sessionId, 'session-first');
  assert.match(workbenchSessionFile(), /workbench[/\\]session\.json$/);
});

await verify('every later call adopts that same session', async () => {
  const ctx = host({ adoptAs: 'session-first' });
  const result = await ensureWorkbenchSession(ctx);
  assert.equal(result.sessionId, 'session-first');
  assert.equal(result.created, false, 'an existing session was treated as new');
  assert.deepEqual(ctx.calls, [{ sessionId: 'session-first' }]);
  // And it did not rewrite the file with a second identity.
  assert.equal((await readWorkbenchSession()).sessionId, 'session-first');
});

await verify('a Host that reports no identity is refused, not recorded', async () => {
  await rm(workbenchSessionFile(), { force: true });
  const broken = { sessionController: { async create() { return {}; } } };
  await assert.rejects(() => ensureWorkbenchSession(broken), /reported no identity/);
  assert.equal(await readWorkbenchSession(), null, 'an empty identity was written down as if it were one');
});

await verify('a Host with no session controller is refused by name', async () => {
  await rm(workbenchSessionFile(), { force: true });
  await assert.rejects(() => ensureWorkbenchSession({}), /no session controller/);
  await assert.rejects(() => ensureWorkbenchSession({ sessionController: {} }), /cannot create a session/);
});

await verify('a corrupt stored identity throws rather than silently starting a new conversation', async () => {
  await writeWorkbenchSession({ sessionId: 'session-good' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(workbenchSessionFile(), '{ not json', 'utf8');
  await assert.rejects(() => readWorkbenchSession(), /not valid JSON/);
  await assert.rejects(() => ensureWorkbenchSession(host()), /not valid JSON/);
  // A file that parses but names nothing is refused too: adopting "" would create a second
  // conversation while looking like it reused the first.
  await writeFile(workbenchSessionFile(), JSON.stringify({ agentPreset: 'x' }), 'utf8');
  await assert.rejects(() => readWorkbenchSession(), /names no session/);
  await rm(workbenchSessionFile(), { force: true });
});

await verify('writing refuses an empty identity', async () => {
  await assert.rejects(() => writeWorkbenchSession({ sessionId: '   ' }), /non-empty/);
  await assert.rejects(() => writeWorkbenchSession({}), /non-empty/);
  assert.equal(await readWorkbenchSession(), null);
});

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
