/**
 * Sending one greeting.
 *
 * The order is what is tested here, because every step's position is a decision:
 *
 * - Resolution comes first, so a locator that cannot name exactly one element ends the attempt
 *   before any quota is touched.
 * - The intent is written immediately before acting, which is what makes a crash safe, and the
 *   file is asserted to hold intent-then-result in that order.
 * - The record is settled from the verification, not from the click, so a click that landed is
 *   not mistaken for a conversation that started.
 * - A slot comes back only for a known failure. An unknown outcome keeps it, and the attempt is
 *   left unresolved on purpose rather than quietly retried.
 *
 * Run: node test/send-check.mjs
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
const { Control } = await import('../lib/control.js');
const { Spend, createAuthorization, recordAuthorization } = await import('../lib/authorize.js');
const { sendGreeting } = await import('../lib/send.js');
const { readCandidates } = await import('../lib/site.js');

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
  fields: {
    name: { locator: { tag: 'span', attr: [{ name: 'class', equals: 'nm' }] } },
    city: { locator: { tag: 'span', attr: [{ name: 'class', equals: 'ct' }] } },
  },
  actions: { greet: { scope: 'card', type: 'click', effect: 'quota', locator: { tag: 'button', text: { equals: '打招呼' } } } },
};
const posting = { version: 2, id: 'quality-engineer', platform: 'zhaopin', title: '质量工程师', must: [{ field: 'city', op: 'in', value: ['广州'] }], greeting: '您好' };
const account = 'example.test';

const ok = await readFile(new URL('./fixtures/cards-inspect.html', import.meta.url), 'utf8');
const failedPage = await readFile(new URL('./fixtures/cards-greet-failed.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  // `/empty` has to be a real page with no cards: without a route it fell through to the
  // candidate list, so the "candidate is gone after the hand-back" case was never exercised
  // and the test passed for the wrong reason.
  if (req.url === '/failed') res.end(failedPage);
  else if (req.url === '/empty') res.end('<!doctype html><title>\u6ca1\u6709\u5019\u9009\u4eba</title><ul id="list"></ul>');
  else res.end(ok);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const profileDir = join(tmpdir(), `jev-send-${process.pid}`);
const sessions = new Sessions(resolveConfig({ headless: true, profileDir }));
const config = resolveConfig({});

try {
  const session = await sessions.ensure('send', { headless: true });
  let storeCount = 0;
  const newStore = () => new Records({ file: join(tmpdir(), `jev-send-records-${process.pid}-${storeCount++}.jsonl`) });

  const attempt = async ({ store, control = new Control(), spend, authorization, extra = {} }) => sendGreeting({
    ctx: { get: () => undefined }, config, cdp: session.cdp, sessionId: session.sessionId,
    siteConfig, posting, account, identity: 'C-1001', name: '徐先生', url: `${base}/one`,
    authorization, spend, records: store, control, worker: 'w1', windowName: 'w1',
    allowModel: false, ...extra,
  });

  await verify('a greeting that the page confirms is recorded as confirmed', async () => {
    await navigate(session.cdp, session.sessionId, base);
    const store = newStore();
    const spend = new Spend({ limit: 5 });
    const authorization = createAuthorization({ platform: 'zhaopin', account, posting: posting.id, postingVersion: posting.version, siteVersion: 1, actions: ['greet'], greetingVersion: posting.greeting, limit: 5 });
    const outcome = await attempt({ store, spend, authorization });
    assert.equal(outcome.outcome, 'confirmed', `${outcome.outcome}: ${outcome.reason}`);
    assert.equal(outcome.verdict, 'verified');
    assert.equal(spend.spent, 1, 'a confirmed send did not consume the account total');
    assert.equal(spend.remaining, 4);
  });

  await verify('the intent is written before the action, and the result after it', async () => {
    await navigate(session.cdp, session.sessionId, base);
    const store = newStore();
    const spend = new Spend({ limit: 5 });
    const authorization = createAuthorization({ platform: 'zhaopin', account, posting: posting.id, postingVersion: posting.version, siteVersion: 1, actions: ['greet'], greetingVersion: posting.greeting, limit: 5 });
    await attempt({ store, spend, authorization });
    const entries = await store.readAll();
    assert.equal(entries.length, 2, JSON.stringify(entries));
    assert.equal(entries[0].kind, 'intent');
    assert.equal(entries[0].status, 'pending');
    assert.equal(entries[1].kind, 'result');
    assert.equal(entries[1].status, 'confirmed');
    assert.ok(Date.parse(entries[0].at) <= Date.parse(entries[1].at));
  });

  await verify('a page that reports failure is a failure, and the slot comes back', async () => {
    await navigate(session.cdp, session.sessionId, `${base}/failed`);
    const store = newStore();
    const spend = new Spend({ limit: 5 });
    const authorization = createAuthorization({ platform: 'zhaopin', account, posting: posting.id, postingVersion: posting.version, siteVersion: 1, actions: ['greet'], greetingVersion: posting.greeting, limit: 5 });
    const outcome = await attempt({ store, spend, authorization });
    assert.equal(outcome.outcome, 'failed', `${outcome.outcome}: ${outcome.reason}`);
    assert.equal(outcome.verdict, 'refuted');
    assert.equal(spend.remaining, 5, 'a failed send kept the quota');
    assert.equal((await store.readAll())[1].status, 'failed');
  });

  await verify('an outcome the page does not settle keeps the slot and stays unresolved', async () => {
    await navigate(session.cdp, session.sessionId, base);
    const store = newStore();
    const spend = new Spend({ limit: 5 });
    const authorization = createAuthorization({ platform: 'zhaopin', account, posting: posting.id, postingVersion: posting.version, siteVersion: 1, actions: ['greet'], greetingVersion: posting.greeting, limit: 5 });
    // A page whose success phrase never appears: the click landed, the result is unknown.
    const outcome = await attempt({ store, spend, authorization, extra: { config: { ...config, successPatterns: ['永远不会出现的文案'] } } });
    assert.equal(outcome.outcome, 'executed_unverified', `${outcome.outcome}: ${outcome.reason}`);
    assert.equal(outcome.intentUnresolved, true);
    assert.equal(spend.remaining, 4, 'an unknown outcome gave the quota back');
    assert.equal((await store.readAll())[1].status, 'executed_unverified');
  });

  await verify('a target that cannot be resolved consumes nothing and records nothing', async () => {
    await navigate(session.cdp, session.sessionId, base);
    const store = newStore();
    const spend = new Spend({ limit: 5 });
    const authorization = createAuthorization({ platform: 'zhaopin', account, posting: posting.id, postingVersion: posting.version, siteVersion: 1, actions: ['greet'], greetingVersion: posting.greeting, limit: 5 });
    const outcome = await sendGreeting({
      ctx: {}, config, cdp: session.cdp, sessionId: session.sessionId, siteConfig, posting, account,
      identity: 'C-nobody', authorization, spend, records: store, allowModel: false,
    });
    assert.equal(outcome.outcome, 'refused');
    assert.match(outcome.reason, /identity_not_found/);
    assert.equal(spend.spent, 0, 'a resolution failure consumed quota');
    assert.equal((await store.readAll()).length, 0, 'a resolution failure wrote a record');
  });

  await verify('no authorisation means nothing is sent and nothing is recorded', async () => {
    await navigate(session.cdp, session.sessionId, base);
    const store = newStore();
    const spend = new Spend({ limit: 5 });
    const outcome = await attempt({ store, spend, authorization: undefined });
    assert.equal(outcome.outcome, 'refused');
    assert.match(outcome.reason, /no authorisation/);
    assert.equal(spend.spent, 0);
    assert.equal((await store.readAll()).length, 0);
  });

  await verify('an authorisation for another account is refused', async () => {
    await navigate(session.cdp, session.sessionId, base);
    const store = newStore();
    const spend = new Spend({ limit: 5 });
    const authorization = createAuthorization({ platform: 'zhaopin', account: 'someone-else', posting: posting.id, actions: ['greet'], limit: 5 });
    const outcome = await attempt({ store, spend, authorization });
    assert.equal(outcome.outcome, 'refused');
    assert.match(outcome.reason, /account/);
    assert.equal(spend.spent, 0);
  });

  await verify('a reached limit stops the send before it happens', async () => {
    await navigate(session.cdp, session.sessionId, base);
    const store = newStore();
    const spend = new Spend({ limit: 1 });
    const authorization = createAuthorization({ platform: 'zhaopin', account, posting: posting.id, postingVersion: posting.version, siteVersion: 1, actions: ['greet'], greetingVersion: posting.greeting, limit: 1 });
    assert.equal((await attempt({ store, spend, authorization })).outcome, 'confirmed');
    // Reload first: the greeting the last attempt sent changed the button's text, so the
    // locator would no longer match and the refusal would be about resolution, not the limit.
    await navigate(session.cdp, session.sessionId, base);
    const second = await attempt({ store, spend, authorization });
    assert.equal(second.outcome, 'refused');
    assert.match(second.reason, /limit of 1/);
    assert.equal(spend.spent, 1);
  });

  await verify('a stopped window sends nothing and spends nothing', async () => {
    await navigate(session.cdp, session.sessionId, base);
    const store = newStore();
    const spend = new Spend({ limit: 5 });
    const authorization = createAuthorization({ platform: 'zhaopin', account, posting: posting.id, postingVersion: posting.version, siteVersion: 1, actions: ['greet'], greetingVersion: posting.greeting, limit: 5 });
    const control = new Control();
    control.stop('the operator pressed stop');
    const outcome = await attempt({ store, spend, authorization, control });
    assert.equal(outcome.outcome, 'held');
    assert.match(outcome.reason, /stopped/);
    assert.equal(spend.spent, 0);
    assert.equal((await store.readAll()).length, 0);
  });

  await verify('a paused window is held, and runs again after a resume', async () => {
    await navigate(session.cdp, session.sessionId, base);
    const store = newStore();
    const spend = new Spend({ limit: 5 });
    const authorization = createAuthorization({ platform: 'zhaopin', account, posting: posting.id, postingVersion: posting.version, siteVersion: 1, actions: ['greet'], greetingVersion: posting.greeting, limit: 5 });
    const control = new Control();
    control.pause('w1', '等待确认');
    assert.equal((await attempt({ store, spend, authorization, control })).outcome, 'held');
    control.resume('w1');
    assert.equal((await attempt({ store, spend, authorization, control })).outcome, 'confirmed');
  });

  await verify('after a hand-back the candidate is re-read before being acted on', async () => {
    await navigate(session.cdp, session.sessionId, base);
    const store = newStore();
    const spend = new Spend({ limit: 5 });
    const authorization = createAuthorization({ platform: 'zhaopin', account, posting: posting.id, postingVersion: posting.version, siteVersion: 1, actions: ['greet'], greetingVersion: posting.greeting, limit: 5 });
    const control = new Control();
    control.takeover('w1');
    control.release('w1');
    assert.equal(control.staleFor('w1'), true);
    const outcome = await attempt({ store, spend, authorization, control });
    assert.equal(outcome.outcome, 'confirmed', outcome.reason);
    assert.equal(control.staleFor('w1'), false, 'the re-read was not recorded');
    // And if the candidate is gone after the hand-back, nothing is sent.
    control.takeover('w1');
    control.release('w1');
    await navigate(session.cdp, session.sessionId, `${base}/empty`);
    const gone = new Spend({ limit: 5 });
    const second = await sendGreeting({
      ctx: {}, config, cdp: session.cdp, sessionId: session.sessionId, siteConfig, posting, account,
      identity: 'C-1001', authorization, spend: gone, records: newStore(), control, worker: 'w1', allowModel: false,
    });
    assert.equal(second.outcome, 'refused');
    assert.match(second.reason, /no longer on the page/);
    assert.equal(gone.spent, 0);
  });

  await verify('a second pass over the same candidates is refused by the record', async () => {
    // The store is the guard that survives a restart, so the second attempt is a new store read
    // of the same file rather than the same object in memory.
    await navigate(session.cdp, session.sessionId, base);
    const file = join(tmpdir(), `jev-send-once-${process.pid}.jsonl`);
    const spend = new Spend({ limit: 5 });
    const authorization = createAuthorization({ platform: 'zhaopin', account, posting: posting.id, postingVersion: posting.version, siteVersion: 1, actions: ['greet'], greetingVersion: posting.greeting, limit: 5 });
    const first = await attempt({ store: new Records({ file }), spend, authorization });
    assert.equal(first.outcome, 'confirmed');
    const decision = await new Records({ file }).decide('C-1001', { account, action: 'greet' });
    assert.equal(decision.skip, true, 'the record did not stop a second greeting');
    await rm(file, { force: true });
  });

  await verify('the screened candidate carries the evidence the record needs', async () => {
    await navigate(session.cdp, session.sessionId, base);
    const read = await readCandidates(session.cdp, session.sessionId, { config: siteConfig });
    const candidate = read.candidates.find((entry) => entry.identity === 'C-1001');
    assert.equal(candidate.fields.name, '徐先生');
    assert.equal(candidate.actions.greet, true);
  });
} finally {
  await sessions.closeAll().catch(() => {});
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  server.close();
}

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
