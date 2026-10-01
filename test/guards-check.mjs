/**
 * Regression guards for the review findings, written against the merged authorization
 * model.
 *
 * These cover behaviour that had no test at all before the review: the one-shot
 * authorization and its context binding, the live-view decision endpoint, `-0`
 * normalization, the budget clamp, the empty-pattern fallback, and the page-side risk
 * match. Several of them are the only thing between a model decision and a real action on
 * a real account.
 *
 * Run: node test/guards-check.mjs
 */

import { createServer } from 'node:http';

import { apply, resolveConfig, MOUNT } from '../index.js';
import { Pacing } from '../lib/pacing.js';
import { round, validateState } from '../lib/jev.js';
import { buildTools } from '../lib/tools.js';
import { Sessions } from '../lib/sessions.js';

const problems = [];
const check = (label, passed, detail = '') => {
  if (passed) console.log(`  PASS  ${label}`);
  else {
    problems.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** One approval context, as act.js builds it. */
const context = (over = {}) => ({
  target: '饶先生 · 打招呼',
  goal: 'greet the shortlisted candidate',
  session: 'default',
  tab: 'tab-a',
  url: 'https://example.test/list',
  action: 'click',
  href: '',
  textHash: '',
  ...over,
});

// ── the one-shot authorization ───────────────────────────────────────────────
console.log('=== one-shot authorization ===');
{
  const pacing = new Pacing(resolveConfig({}));
  check('a grant without a pending decision is refused', pacing.grant('饶先生 · 打招呼') === false);

  const first = context();
  pacing.setPending(first);
  check('the pending carries an id', typeof pacing.pending?.id === 'string' && pacing.pending.id !== '');
  check('a grant naming the pending target is accepted', pacing.grant(first.target) === true);
  check('and marks the decision as authorized', pacing.pending?.authorized === true);
  check('it is spent exactly once', pacing.consumeGrant(first) === true && pacing.consumeGrant(first) === false);

  // The binding a label alone could not provide.
  pacing.setPending(context());
  pacing.grant('饶先生 · 打招呼');
  check(
    'a grant does not transfer to the same target under a different goal',
    pacing.consumeGrant(context({ goal: 'a completely different goal' })) === false,
  );
  check('but it still authorizes its own context', pacing.consumeGrant(context()) === true);

  // A stale panel must not approve whatever replaced its decision.
  pacing.setPending(context());
  const staleId = pacing.pending.id;
  pacing.setPending(context());
  check(
    'a superseded decision id cannot approve the replacement',
    pacing.grant('饶先生 · 打招呼', 900000, staleId) === false,
  );

  // Refusal takes the authorization back.
  pacing.clearPending();
  pacing.setPending(context());
  pacing.grant('饶先生 · 打招呼');
  check('a denial is accepted', pacing.deny('饶先生 · 打招呼') === true);
  check('and the pending decision is gone', pacing.pending === null);
  check('so the action must be asked for again', pacing.consumeGrant(context()) === false);
  pacing.clearPending();

  // Expiry.
  pacing.setPending(context());
  pacing.grant('饶先生 · 打招呼', -1);
  check('an expired grant does not authorize', pacing.consumeGrant(context()) === false);

  // A conversation reply approves only the stop it belongs to.
  pacing.clearPending();
  pacing.setPending(context());
  check(
    'confirmPending refuses a different goal',
    pacing.confirmPending({ session: 'default', tab: 'tab-a', goal: 'other' }) === false,
  );
  check(
    'confirmPending accepts its own call context',
    pacing.confirmPending({ session: 'default', tab: 'tab-a', goal: context().goal }) === true,
  );
  check('and that approval is spendable once', pacing.consumeGrant(context()) === true);
}

// ── several sessions can be waiting at once ──────────────────────────────────
// One stop per session, not one stop overall. A single slot used to mean the second stop
// silently replaced the first, and the replaced session's grant could then never be issued —
// granting requires a pending decision that matches — so it waited behind a decision nobody
// could still see.
console.log('\n=== several sessions waiting at once ===');
{
  const pacing = new Pacing(resolveConfig({}));
  const first = context({ session: 'w1', target: '甲 · 打招呼' });
  const second = context({ session: 'w2', target: '乙 · 打招呼', tab: 'tab-b' });

  pacing.setPending(first);
  pacing.setPending(second);
  check('both stops are kept', pacing.pendings.length === 2, JSON.stringify(pacing.pendings.map((p) => p.session)));
  check('and neither replaced the other', pacing.pendings.map((p) => p.session).sort().join(',') === 'w1,w2');
  check('each session can read its own stop', pacing.pendingFor('w1')?.target === '甲 · 打招呼' && pacing.pendingFor('w2')?.target === '乙 · 打招呼');
  check('the unnamed read still answers with the newest', pacing.pending?.session === 'w2', String(pacing.pending?.session));

  check('one is answerable by its own id', pacing.grant('甲 · 打招呼', 900000, pacing.pendingFor('w1').id) === true);
  check('and the other is untouched by it', pacing.pendingFor('w2')?.authorized !== true);

  check('the grant is spent once', pacing.consumeGrant(first) === true && pacing.consumeGrant(first) === false);
  check('consuming it clears only its own stop', pacing.pendingFor('w1') === null && pacing.pendingFor('w2') !== null);
  check('a denial clears only its own', pacing.deny('乙 · 打招呼', pacing.pendingFor('w2').id) === true && pacing.pendings.length === 0);
}

// ── quota-bearing actions take turns ─────────────────────────────────────────
// Reading in parallel is the point of named sessions; spending in parallel is not. The
// account's chat quota is one resource, and a burst from four tabs at the same instant is
// the shape a site's risk control watches for.
console.log('\n=== the quota lock ===');
{
  const pacing = new Pacing(resolveConfig({}));
  const order = [];
  const step = (name, ms) => pacing.withQuotaLock(async () => {
    order.push(name + ':start');
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(name + ':end');
  });
  await Promise.all([step('a', 60), step('b', 10), step('c', 10)]);
  check('locked actions never overlap', order.join(' ') === 'a:start a:end b:start b:end c:start c:end', order.join(' '));

  await pacing.withQuotaLock(async () => { throw new Error('boom'); }).catch(() => {});
  const after = [];
  await pacing.withQuotaLock(async () => { after.push('ran'); });
  check('a throwing action does not wedge the queue', after.length === 1, JSON.stringify(after));
}

// ── an empty safety list is a misconfiguration, not a switch ─────────────────
console.log('\n=== empty safety lists ===');
{
  const cfg = resolveConfig({ consequentialPatterns: [], riskSignals: [] });
  check('empty patterns fall back to the defaults', cfg.consequentialPatterns.length > 5, String(cfg.consequentialPatterns.length));
  check('empty risk signals fall back too', cfg.riskSignals.length > 5, String(cfg.riskSignals.length));
  const pacing = new Pacing(cfg);
  check('so a consequential label is still gated', pacing.isConsequential('删除') === true);
  check('and a verification page is still a risk page', pacing.riskSignal({ title: '', text: '请完成人机验证' }) !== null);
}

// ── the risk match reads the whole page, not the truncated copy ──────────────
console.log('\n=== risk signal source ===');
{
  const pacing = new Pacing(resolveConfig({}));
  check(
    'a page-reported signal is used as given',
    pacing.riskSignal({ title: '', text: 'truncated text without the wall', riskSignal: '请完成验证' }) === '请完成验证',
  );
  check('and the text fallback still works', pacing.riskSignal({ title: '', text: '操作过于频繁' }) !== null);
  check('the pattern source is published for the page to run', pacing.riskPatternSource.length > 0);
}

// ── `-0` is rejected by the harness, so it must never be produced ────────────
console.log('\n=== negative zero ===');
{
  check('round normalizes -0 to 0', Object.is(round(-0.001), 0), String(round(-0.001)));
  check('round keeps a real negative value', round(-0.5) === -0.5);
  check('round passes normal values through', round(0.756) === 0.76);
  check('round refuses non-numbers', round('x') === undefined);
}

// ── the live-view decision endpoint ──────────────────────────────────────────
console.log('\n=== live view decision ===');
{
  const definitions = [];
  const ctx = {
    tools: { register: (d) => definitions.push(d) },
    effect: () => {},
    logger: { debug() {} },
    get: () => undefined,
    inject: () => () => {},
  };
  apply(ctx, { viewerPort: 0, profileDir: '' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const opened = await definitions.find((d) => d.name === 'browser_open').execute({}, { signal: new AbortController().signal });
  const url = opened.viewer;
  // The viewer URL carries a `?session=` query, so routes are resolved against it rather
  // than concatenated onto it — `url + 'state.json'` would land on `/?session=…state.json`
  // and quietly fetch the page instead.
  const at = (route) => new URL(route, url).href;
  const post = (body) =>
    fetch(at('decide'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  if (!url) {
    check('the viewer started', false, 'browser_open returned no viewer URL');
  } else {
    const pre = await post({ target: '删除', verdict: 'grant', id: 'not-a-pending-id' });
    check('a target that is not pending cannot be pre-authorized', pre.status === 409, `HTTP ${pre.status}`);
    // The route checks the shape and the handler checks the meaning. A target is no longer
    // required: an authorisation request has an id and no target label. An id that names
    // nothing is refused by the handler, which is the 409 here.
    check('an id that names nothing is refused', (await post({ target: '', verdict: 'grant', id: 'no-such-id' })).status === 409);
    check('a decision without an id is refused', (await post({ target: 'x', verdict: 'grant' })).status === 400);
    check('an unknown verdict is refused', (await post({ target: 'x', verdict: 'maybe', id: 'x' })).status === 400);
    const state = await (await fetch(at('state.json'))).json();
    check('the board reports its state', state && typeof state === 'object' && Array.isArray(state.tabs));
  }
}

// ── the same routes on the application's own server ──────────────────────────
// The sidebar page lives inside the app, so the board's data is served from the app's own
// origin instead of the loopback viewer. This exercises that carrier through a real HTTP
// server, because the interesting part is the mount: the prefix route has to slice the mount
// point off before dispatching. A page asking for `/jev-browser/state.json` must not quietly
// receive the HTML dashboard, which is what naive concatenation would hand it.
console.log('\n=== board routes on the app server ===');
{
  const definitions = [];
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; } };
  const scope = {
    webServer,
    effect: (fn) => { const off = fn(); return () => { if (typeof off === 'function') off(); }; },
  };
  const ctx = {
    tools: { register: (d) => definitions.push(d) },
    effect: () => {},
    logger: { debug() {} },
    get: (name) => (name === 'webServer' ? webServer : undefined),
    inject: (deps, callback) => { callback(scope); return () => {}; },
  };
  apply(ctx, { viewer: false, profileDir: '' });

  check('one prefix route is mounted', routes.length === 1 && routes[0].kind === 'prefix', JSON.stringify(routes.map((r) => r.kind)));
  check('at the documented mount point', routes[0]?.path === MOUNT, String(routes[0]?.path));

  if (routes.length === 1) {
    const server = createServer((req, res) => routes[0].handler(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = (body) =>
      fetch(`${origin}${MOUNT}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const response = await fetch(`${origin}${MOUNT}/state.json`);
    check('the board state is served on the app origin', response.ok, `HTTP ${response.status}`);
    const parsed = await response.json();
    check('and it is JSON state, not the dashboard page', typeof parsed === 'object' && 'totals' in parsed && 'events' in parsed);

    const pre = await post({ target: '删除', verdict: 'grant', id: 'not-a-pending-id' });
    check('the same one-shot check applies there', pre.status === 409, `HTTP ${pre.status}`);
    check('malformed decisions are still refused', (await post({ target: 'x', verdict: 'maybe', id: 'x' })).status === 400);
    check('an id that names nothing is refused here too', (await post({ target: '', verdict: 'grant', id: 'no-such-id' })).status === 409);

    await new Promise((resolve) => server.close(resolve));
  }
}

// ── the documented state shapes ──────────────────────────────────────────────
// TypeSafe documents `state` as "a string, an object, or an array", and recommends an object
// so each part has a descriptive name. This plugin sends a string today, so the relaxation is
// invisible — which is exactly why it needs a guard: a validation tightened back to
// string-only would only surface as a confusing failure the day the state becomes an object.
console.log('\n=== documented state shapes ===');
{
  const accepted = ['文本', { goal: 'x', page: { url: 'u' } }, ['a', 'b']];
  for (const value of accepted) {
    let threw = '';
    try { validateState(value); } catch (error) { threw = error.message; }
    check(`accepts ${Array.isArray(value) ? 'an array' : typeof value}`, threw === '', threw);
  }
  for (const value of ['', '   ', {}, [], null, undefined, 42]) {
    let threw = false;
    try { validateState(value); } catch { threw = true; }
    check(`refuses ${JSON.stringify(value) ?? String(value)}`, threw, 'accepted an empty or invalid state');
  }
}

// ── output contracts the harness enforces ────────────────────────────────────
console.log('\n=== output contracts ===');
{
  const sessions = new Sessions(resolveConfig({ headless: true }));
  const tools = buildTools({
    ctx: { get: () => undefined },
    config: resolveConfig({}),
    sessions,
    pacing: new Pacing(resolveConfig({})),
    viewer: null,
    journal: null,
  });
  const jev = tools.find((t) => t.name === 'browser_jev');
  const probabilities = jev.output.schema.properties.answers.items.properties.probabilities;
  check('the probability field accepts both shapes', Array.isArray(probabilities.oneOf) && probabilities.oneOf.length === 2);
  check('its map branch is an object', probabilities.oneOf.some((branch) => branch.type === 'object'));
  check(
    'its list branch is an array of numbers',
    probabilities.oneOf.some((branch) => branch.type === 'array' && branch.items?.type === 'number'),
  );
  check(
    'every tool schema keeps a string array for required',
    tools.every((tool) => !('required' in tool.output.schema) || Array.isArray(tool.output.schema.required)),
  );
  await sessions.closeAll().catch(() => {});
}

console.log(`\n===== ${problems.length} problem(s) =====`);
for (const problem of problems) console.log(`  !! ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
