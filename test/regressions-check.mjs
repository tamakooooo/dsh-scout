/** Offline regression checks: real headless Chrome, deterministic Jev responses. */
import './isolate.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const { resolveConfig } = await import('../index.js');
const { Sessions } = await import('../lib/sessions.js');
const { launchChrome } = await import('../lib/browser.js');
const { navigate, snapshot, evaluate, perform, normalizeUrl, waitForReady } = await import('../lib/page.js');
const { runGoal } = await import('../lib/act.js');
const { Pacing } = await import('../lib/pacing.js');
const { createMonitor } = await import('../lib/monitor.js');
const { Viewer } = await import('../lib/viewer.js');
const { Journal } = await import('../lib/journal.js');

let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}

const config = resolveConfig({
  headless: true, baseUrl: 'http://jev.test', minActionDelayMs: 0,
  maxActionDelayMs: 0, cooldownEveryActions: 0, maxActionsPerSession: 20,
});
const scope = {
  session: 'default', tab: 'tab-a', url: 'https://example.test/', goal: 'greet A',
  action: 'click', target: 'A · 打招呼', href: '', textHash: '',
};

await check('host:port URLs retain supported schemes and gain the right protocol', () => {
  for (const [input, expected] of [
    ['localhost:3000', 'http://localhost:3000'],
    ['localhost:3000?q=1', 'http://localhost:3000?q=1'],
    ['127.0.0.1:8080/path', 'http://127.0.0.1:8080/path'],
    ['[::1]:8080#top', 'http://[::1]:8080#top'],
    ['example.com:8080/path', 'https://example.com:8080/path'],
    ['intranet:8080', 'https://intranet:8080'],
    ['example.com', 'https://example.com'],
    ['https://example.com:8080', 'https://example.com:8080'],
    ['file:///tmp/a.html', 'file:///tmp/a.html'],
    ['about:blank', 'about:blank'],
    ['data:text/html,hello', 'data:text/html,hello'],
  ]) assert.equal(normalizeUrl(input), expected);
});

await check('confidence floors use the reachable 0–3 rating scale', () => {
  assert.equal(resolveConfig({ confidenceFloor: 4 }).confidenceFloor, 3);
  assert.equal(resolveConfig({ confidenceFloor: -1 }).confidenceFloor, 0);
  assert.equal(resolveConfig({ confidenceFloor: 0.8 }).confidenceFloor, 0.8);
});

await check('an approval is scoped to one action and consumed once', () => {
  const policy = new Pacing(config);
  policy.setPending(scope);
  assert.equal(policy.grant(scope.target), true);
  for (const field of ['session', 'tab', 'url', 'goal', 'action', 'target', 'href', 'textHash']) {
    assert.equal(policy.consumeGrant({ ...scope, [field]: 'different' }), false, field);
  }
  assert.equal(policy.consumeGrant(scope), true);
  assert.equal(policy.consumeGrant(scope), false);
  assert.equal(policy.pending, null);
});

await check('deny, replacement, stale panel replies and expiry revoke authorization', () => {
  const policy = new Pacing(config);
  policy.setPending(scope);
  const oldId = policy.pending.id;
  assert.equal(policy.grant(scope.target, 900000, oldId), true);
  assert.equal(policy.deny(scope.target, oldId), true);
  assert.equal(policy.consumeGrant(scope), false);
  assert.equal(policy.confirmPending(scope), false);

  policy.setPending(scope);
  assert.equal(policy.grant(scope.target, 900000, oldId), false);
  assert.equal(policy.deny(scope.target, oldId), false);
  assert.equal(policy.confirmPending({ ...scope, goal: 'other goal' }), false);
  assert.equal(policy.confirmPending({ ...scope, session: 'other session' }), false);
  assert.equal(policy.confirmPending({ ...scope, tab: 'other tab' }), false);
  assert.equal(policy.grant(scope.target, 0), true);
  assert.equal(policy.consumeGrant(scope), false);
  policy.grant(scope.target);
  policy.setPending({ ...scope, action: 'type' });
  assert.equal(policy.consumeGrant(scope), false);
});

// The buttons confirm the greeting the way a real console does — the control becomes 已打招呼.
// Without that, a consequential click here would (correctly) read as unverifiable and stop the
// run, which is a different test's subject.
const authPage = `<!doctype html><meta charset="utf-8"><title>Authorization</title>
<button onclick="window.sentA=(window.sentA||0)+1;this.textContent='A · 已打招呼'">A · 打招呼</button>
<button onclick="window.sentB=(window.sentB||0)+1;this.textContent='B · 已打招呼'">B · 打招呼</button>`;
const routes = new Map([
  ['/auth', authPage],
  ['/form', `<!doctype html><title>Form</title>
    <form onsubmit="window.submissions=(window.submissions||0)+1;event.preventDefault()">
      <input name="q" aria-label="Search query" onkeydown="window.trustedKey=event.isTrusted">
      <button>Search</button>
    </form>`],
  ['/start', '<!doctype html><title>Start</title><a href="/end">Continue</a>'],
  ['/hash', '<!doctype html><title>Hash</title><a href="#anchor">Jump</a><div id="anchor">Destination</div>'],
  ['/end', '<!doctype html><title>End</title>Arrived'],
  ['/popup', '<!doctype html><title>Popup</title><button>Popup button</button>'],
  ['/long', '<!doctype html><title>Long</title>' + Array.from({ length: 650 }, (_, i) =>
    `<button style="display:block;margin-bottom:30px">button ${i + 1}</button>`).join('')],
  ['/text', `<!doctype html><title>Viewport text</title>
    <p>TOP_CONTEXT</p><div style="height:3000px"></div>
    <p>BOTTOM_CONTEXT</p><button>Bottom action</button>
    <p style="display:none">HIDDEN_CONTEXT</p><div aria-hidden="true">ARIA_HIDDEN_CONTEXT</div>`],
  ['/paragraph', '<!doctype html><title>Paragraph</title><p style="width:150px">' +
    'PARAGRAPH_START ' + '长段落内容'.repeat(1000) + ' PARAGRAPH_END</p>'],
  ['/inner-scroll', `<!doctype html><title>Inner scroll</title>
    <div id="pane" style="height:100px;overflow:auto">
      <p>INNER_TOP</p><button>Inner top action</button><div style="height:300px"></div>
      <p>INNER_BOTTOM</p><button>Inner bottom action</button>
    </div>`],
  ['/risk', '<!doctype html><meta charset="utf-8"><title>安全验证</title>请完成验证后继续'],
  // Two ways a greeting can go: the console swaps the control for 已打招呼, or the click is
  // accepted and nothing at all happens. The second is the dangerous one.
  ['/greet-ok', `<!doctype html><meta charset="utf-8"><title>推荐人才</title>
    <div><span>饶先生</span><button id="b">饶先生 · 打招呼</button></div>
    <script>
      window.clicks = 0;
      document.getElementById('b').onclick = function () {
        window.clicks++;
        this.textContent = '饶先生 · 已打招呼';
      };
    </script>`],
  ['/greet-fail', `<!doctype html><meta charset="utf-8"><title>推荐人才</title>
    <div><span>饶先生</span><button id="b">饶先生 · 打招呼</button></div>
    <script>
      window.clicks = 0;
      document.getElementById('b').onclick = function () {
        window.clicks++;
        var note = document.createElement('div');
        note.textContent = '操作失败，请稍后重试';
        document.body.appendChild(note);
      };
    </script>`],
  ['/greet-silent', `<!doctype html><meta charset="utf-8"><title>推荐人才</title>
    <div><span>饶先生</span><button id="b">饶先生 · 打招呼</button></div>
    <script>
      window.clicks = 0;
      document.getElementById('b').onclick = function () { window.clicks++; };
    </script>`],
  // The same wall, but appended after a body long enough that the rendered text budget
  // truncates before reaching it. A Host-side match over `page.text` cannot see this; only
  // a match that runs in the page over the whole document can.
  ['/risk-tail', `<!doctype html><meta charset="utf-8"><title>正常页面</title>
    <div id="long"></div><div id="wall"></div>
    <script>
      document.getElementById('long').textContent = '正文填充。'.repeat(2000);
      document.getElementById('wall').textContent = '请完成验证以继续';
    </script>`],
]);
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  const send = () => res.end(routes.get(req.url) ?? 'missing route');
  // A delayed commit catches readers that mistake the outgoing document for the end state.
  if (req.url === '/end') setTimeout(send, 700);
  else send();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const ctx = { get: (name) => name === 'credentials' ? {
  resolve: async () => ({ value: 'offline-test-key', source: 'mock' }),
} : undefined };

const realFetch = globalThis.fetch;
let decisions = [];
let decisionRequests = [];
// What the judge answers when the page itself is inconclusive. 0.5 means "unsure", which
// must surface as `unconfirmed` rather than as either answer.
let verificationProbability = 0.5;
let currentDecision;
globalThis.fetch = async (url, options) => {
  if (String(url) !== `${config.baseUrl}/systemone`) return realFetch(url, options);
  const request = JSON.parse(options.body);
  decisionRequests.push(request);
  let answers;
  if (request.questions.next_action) {
    assert.ok(decisions.length, 'unexpected decision request');
    currentDecision = decisions.shift();
    const { label, target: override } = currentDecision;
    answers = {
      page_status: { type: 'choice', choice: 'ready' },
      goal_reached: { type: 'noul', noul: currentDecision.reached ?? 0 },
      next_action: { type: 'choice', choice: currentDecision.action ?? 'click' },
    };
    // The target question for EVERY targeted action arrives in this same request, and the
    // chosen action decides which of those answers is used. The plugin must be able to name
    // the element whenever it actually intends to act; on a step that ends at `goal_reached`
    // it never reads them, so an option set that no longer matches is answered `none` rather
    // than failed — the fan-out carries what might be needed, not what is.
    const willAct = (currentDecision.reached ?? 0) < 0.6;
    const needsTarget = willAct && ['click', 'type', 'press_enter'].includes(currentDecision.action ?? 'click');
    for (const id of Object.keys(request.questions)) {
      if (!id.startsWith('target_')) continue;
      const choice = override ?? (label ? Object.entries(request.questions[id].criteria).find(([, description]) =>
        description.includes(`"${label}"`))?.[0] : undefined);
      // Only the chosen action's answer is used, so only that one has to be answerable. The
      // others are the speculative half of the fan-out and may legitimately have nothing to
      // name — an untargeted action, or a step that ends before any target is read.
      if (needsTarget && id === `target_${currentDecision.action ?? 'click'}`) {
        assert.ok(choice, `missing target ${label}; criteria were ${JSON.stringify(Object.values(request.questions[id].criteria ?? {}))}`);
      }
      answers[id] = { type: 'choice', choice: choice ?? 'none' };
    }
    // An extraneous answer must not be able to steer the run: the plugin reads the id that
    // belongs to the action it chose, and ignores the rest.
    answers.target = { type: 'choice', choice: 'e999' };
  } else if (request.questions.satisfied) {
    answers = { satisfied: { type: 'noul', noul: verificationProbability } };
  } else {
    assert.deepEqual(Object.keys(request.questions), ['confidence']);
    answers = currentDecision.missingRating ? {} : { confidence: {
      type: 'score', score: currentDecision.score ?? 3,
    } };
  }
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 7, output_tokens: 1 } }));
};

let chrome;
const sessions = new Sessions(config);
let session;
async function open(path) {
  decisions = [];
  decisionRequests = [];
  verificationProbability = 0.5;
  await navigate(session.cdp, session.sessionId, base + path);
  session.actionsTaken = 0;
}
const sent = () => evaluate(session.cdp, session.sessionId, '({A:window.sentA||0,B:window.sentB||0})');

/**
 * Run once to raise the confirmation gate, then again with the human's approval.
 *
 * "打招呼" is in the consequential list — that is *why* it is the action whose result must be
 * verified — so a check about its verification has to get past the gate first.
 */
async function runApproved(goal, maxSteps, planned) {
  const pacing = new Pacing(config);
  decisions = [planned[0]];
  const gated = await runGoal({ ctx, config, session, goal, maxSteps: 1, pacing });
  assert.equal(gated.status, 'needs_confirmation', 'expected the gate to stop the first run');
  decisions = planned.slice();
  return runGoal({ ctx, config, session, goal, maxSteps, confirm: true, pacing });
}

try {
  chrome = await launchChrome({ headless: true });
  session = await sessions.ensure('default', { cdp: chrome.wsUrl });

  await check('target and rating requests see the selected action, input and target', async () => {
    await open('/form');
    decisions = [{ action: 'type', label: 'Search query' }];
    const report = await runGoal({ ctx, config, session, goal: 'fill search', text: 'literal query', maxSteps: 1 });
    assert.equal(report.trace[0].ok, true);
    // Two requests per step: every question the state can answer in one, then the rating of
    // the exact action/target/input in the next. It used to be three — the target question
    // was a request of its own, re-sending the whole state to add one line.
    assert.equal(decisionRequests.length, 2);
    assert.deepEqual(Object.keys(decisionRequests[0].questions), [
      'page_status', 'goal_reached', 'next_action', 'text_instructions',
      'target_click', 'target_type', 'target_press_enter',
    ]);
    // The chosen action's target is answered inside the same request, so the caller never has
    // to name the action before the target can be asked about.
    assert.match(decisionRequests[0].questions.target_type.instructions, /"type"/);
    assert.equal(decisionRequests[0].questions.target_type.criteria[report.trace[0].target].includes('textbox'), true);
    assert.match(decisionRequests[1].state, /SELECTED ACTION: type/);
    assert.match(decisionRequests[1].state, /LITERAL TEXT: "literal query"/);
    assert.match(decisionRequests[1].state, new RegExp(`SELECTED TARGET: ${report.trace[0].target} textbox`));
    assert.equal(await evaluate(session.cdp, session.sessionId, 'document.querySelector("input").value'), 'literal query');
    // A fingerprint of the request shape: one batched request plus one rating request.
    assert.deepEqual(report.usage, { input_tokens: 14, output_tokens: 2 });
  });

  await check('invalid targets and absent or invalid ratings never execute an action', async () => {
    for (const variant of [
      { target: 'e999' }, { missingRating: true }, { score: -1 }, { score: 4 }, { score: 0.1 },
    ]) {
      await open('/auth');
      decisions = [{ label: 'A · 打招呼', ...variant }];
      const report = await runGoal({ ctx, config: { ...config, requireConfirmation: false }, session, goal: 'greet', maxSteps: 1 });
      assert.equal(report.status, variant.target ? 'no_target' : 'low_confidence');
      assert.deepEqual(await sent(), { A: 0, B: 0 });
    }
  });

  await check('untargeted and terminal actions omit dependent requests they do not need', async () => {
    for (const [action, requests] of [['scroll_down', 2], ['wait', 1], ['finish', 1], ['give_up', 1]]) {
      await open('/long');
      decisions = [{ action }];
      const report = await runGoal({ ctx, config, session, goal: 'read', maxSteps: 1 });
      assert.equal(decisionRequests.length, requests);
      assert.equal(report.trace[0].target, null);
      assert.equal(report.trace[0].ok, true);
    }
  });

  await check('confirm approves the preceding target, then gates the next target', async () => {
    await open('/auth');
    const pacing = new Pacing(config);
    // Verification is a precondition here, not the subject: the page is taken to confirm the
    // approved action, so this still exercises the gate on the *next* target.
    verificationProbability = 0.95;
    const goal = '向 A 打招呼';
    decisions = [{ label: 'A · 打招呼' }];
    assert.equal((await runGoal({ ctx, config, session, goal, maxSteps: 1, pacing })).status, 'needs_confirmation');
    decisions = [{ label: 'A · 打招呼' }, { label: 'B · 打招呼' }];
    const report = await runGoal({ ctx, config, session, goal, maxSteps: 2, confirm: true, pacing });
    assert.equal(report.status, 'needs_confirmation');
    assert.equal(pacing.pending.target, 'B · 打招呼');
    assert.deepEqual(await sent(), { A: 1, B: 0 });
    assert.equal(decisions.length, 0);
  });

  await check('confirm without a preceding stop grants no permission', async () => {
    await open('/auth');
    decisions = [{ label: 'A · 打招呼' }];
    const report = await runGoal({ ctx, config, session, goal: 'greet', maxSteps: 1, confirm: true, pacing: new Pacing(config) });
    assert.equal(report.status, 'needs_confirmation');
    assert.deepEqual(await sent(), { A: 0, B: 0 });
  });

  await check('a panel grant followed by deny leaves the page untouched', async () => {
    await open('/auth');
    const pacing = new Pacing(config);
    decisions = [{ label: 'A · 打招呼' }];
    await runGoal({ ctx, config, session, goal: 'greet', maxSteps: 1, pacing });
    const pending = pacing.pending;
    assert.equal(pacing.grant(pending.target, 900000, pending.id), true);
    assert.equal(pacing.deny(pending.target, pending.id), true);
    decisions = [{ label: 'A · 打招呼' }];
    assert.equal((await runGoal({ ctx, config, session, goal: 'greet', maxSteps: 1, pacing })).status, 'needs_confirmation');
    assert.deepEqual(await sent(), { A: 0, B: 0 });
  });

  await check('direct runGoal callers retain their confirmation across calls', async () => {
    await open('/auth');
    decisions = [{ label: 'A · 打招呼' }];
    assert.equal((await runGoal({ ctx, config, session, goal: 'direct', maxSteps: 1 })).status, 'needs_confirmation');
    decisions = [{ label: 'A · 打招呼' }];
    await runGoal({ ctx, config, session, goal: 'direct', maxSteps: 1, confirm: true });
    assert.deepEqual(await sent(), { A: 1, B: 0 });
  });

  await check('risk pages stop before requesting a decision', async () => {
    await open('/risk');
    const report = await runGoal({ ctx, config, session, goal: 'continue' });
    assert.equal(report.status, 'risk_page_detected');
    assert.equal(report.steps_taken, 0);
  });

  await check('a verification wall past the text budget still stops the run', async () => {
    await open('/risk-tail');
    const sampled = await snapshot(session.cdp, session.sessionId, {
      riskPatternSource: new Pacing(config).riskPatternSource,
    });
    // The premise has to hold, or the check proves nothing: the rendered text really does
    // not contain the wall, because it is below the fold and the snapshot only reports what
    // is rendered. (The snapshot is viewport-filtered, so this is not about the character
    // budget — which is exactly why a Host-side match over the text cannot be relied on.)
    assert.doesNotMatch(sampled.text, /请完成验证/);
    assert.equal(sampled.riskSignal, '请完成验证');
    const report = await runGoal({ ctx, config, session, goal: 'continue' });
    assert.equal(report.status, 'risk_page_detected');
    assert.equal(report.steps_taken, 0);
  });

  await check('a confirmed action is verified and the run continues', async () => {
    await open('/greet-ok');
    verificationProbability = 0.5; // ignored: the swapped control is the evidence
    const report = await runApproved('greet the candidate', 3, [
      { label: '饶先生 · 打招呼', action: 'click', reached: 0 },
      { label: '饶先生 · 打招呼', action: 'click', reached: 1 },
    ]);
    assert.equal(report.status, 'done');
    assert.equal(report.trace[0].verified, 'verified');
    assert.match(report.trace[0].basis, /已打招呼/);
    assert.equal(await evaluate(session.cdp, session.sessionId, 'window.clicks'), 1);
  });

  await check('an action with no visible effect stops the run instead of retrying', async () => {
    await open('/greet-silent');
    verificationProbability = 0.5; // the judge is unsure and the page is silent
    // The second decision is a retry, queued and deliberately left unconsumed: spending the
    // quota a second time is the exact failure this check exists to prevent.
    const report = await runApproved('greet the candidate', 3, [
      { label: '饶先生 · 打招呼', action: 'click', reached: 0 },
      { label: '饶先生 · 打招呼', action: 'click', reached: 1 },
    ]);
    assert.equal(report.status, 'result_unconfirmed');
    assert.equal(report.steps_taken, 1);
    assert.equal(report.trace[0].verified, 'unconfirmed');
    assert.equal(await evaluate(session.cdp, session.sessionId, 'window.clicks'), 1);
    assert.equal(decisions.length, 1, 'the queued retry was consumed');
  });

  await check('a page that contradicts the action is reported as a failure', async () => {
    await open('/greet-fail');
    // No model call is needed: the error text on the page refutes the action on its own.
    verificationProbability = 0.95;
    const report = await runApproved('greet the candidate', 3, [
      { label: '饶先生 · 打招呼', action: 'click', reached: 0 },
    ]);
    assert.equal(report.status, 'action_failed');
    assert.equal(report.trace[0].verified, 'refuted');
    assert.match(report.trace[0].basis, /操作失败/);
    assert.equal(await evaluate(session.cdp, session.sessionId, 'window.clicks'), 1);
  });

  await check('Enter submits a native form once using trusted input', async () => {
    await open('/form');
    const page = await snapshot(session.cdp, session.sessionId);
    const field = page.elements.find((element) => element.role === 'textbox');
    assert.equal((await perform(session.cdp, session.sessionId, 'type', field.ref, 'query')).ok, true);
    assert.equal((await perform(session.cdp, session.sessionId, 'press_enter', field.ref)).ok, true);
    assert.equal(await evaluate(session.cdp, session.sessionId, 'window.submissions'), 1);
    assert.equal(await evaluate(session.cdp, session.sessionId, 'window.trustedKey'), true);
    assert.equal((await perform(session.cdp, session.sessionId, 'press_enter', 'e999')).ok, false);
    assert.equal(await evaluate(session.cdp, session.sessionId, 'window.submissions'), 1);
  });

  await check('scrolling exposes targets beyond the old scan limit', async () => {
    await open('/long');
    const before = await snapshot(session.cdp, session.sessionId, { maxElements: 3 });
    await evaluate(session.cdp, session.sessionId, 'window.scrollTo(0,document.documentElement.scrollHeight)');
    const after = await snapshot(session.cdp, session.sessionId, { maxElements: 3 });
    assert.equal(before.elements[0].label, 'button 1');
    assert.ok(after.elements.length > 0);
    assert.ok(after.elements.every((element) => Number(element.label.match(/\d+/)[0]) > 600));
    assert.equal(after.elementsTruncated, true);
  });

  await check('scrolling replaces page-head text with the visible bottom text', async () => {
    await open('/text');
    const before = await snapshot(session.cdp, session.sessionId, { maxStateChars: 80 });
    assert.match(before.text, /TOP_CONTEXT/);
    assert.doesNotMatch(before.text, /BOTTOM_CONTEXT/);
    await evaluate(session.cdp, session.sessionId, 'window.scrollTo(0,document.documentElement.scrollHeight)');
    const after = await snapshot(session.cdp, session.sessionId, { maxStateChars: 80 });
    assert.match(after.text, /BOTTOM_CONTEXT/);
    assert.doesNotMatch(after.text, /TOP_CONTEXT|HIDDEN_CONTEXT/);
    assert.equal(after.elements[0].label, 'Bottom action');
  });

  await check('a long single text node reveals its visible suffix after scrolling', async () => {
    await open('/paragraph');
    assert.match((await snapshot(session.cdp, session.sessionId, { maxStateChars: 200 })).text, /PARAGRAPH_START/);
    await evaluate(session.cdp, session.sessionId, 'window.scrollTo(0,document.documentElement.scrollHeight)');
    const bottom = await snapshot(session.cdp, session.sessionId, { maxStateChars: 2000 });
    assert.doesNotMatch(bottom.text, /PARAGRAPH_START/);
    assert.match(bottom.text, /PARAGRAPH_END/);
  });

  await check('an inner scrolling container clips off-screen text and controls', async () => {
    await open('/inner-scroll');
    const before = await snapshot(session.cdp, session.sessionId);
    assert.match(before.text, /INNER_TOP/);
    assert.doesNotMatch(before.text, /INNER_BOTTOM/);
    assert.deepEqual(before.elements.map((element) => element.label), ['Inner top action']);
    await evaluate(session.cdp, session.sessionId, 'document.querySelector("#pane").scrollTop=9999');
    const after = await snapshot(session.cdp, session.sessionId);
    assert.match(after.text, /INNER_BOTTOM/);
    assert.doesNotMatch(after.text, /INNER_TOP/);
    assert.deepEqual(after.elements.map((element) => element.label), ['Inner bottom action']);
  });

  await check('a last-step delayed navigation reports its destination', async () => {
    await open('/start');
    // Likewise: this asserts where a navigating click ends up, so the destination is taken
    // as confirming the click.
    verificationProbability = 0.95;
    decisions = [{ label: 'Continue' }];
    const report = await runGoal({ ctx, config, session, goal: 'open destination', maxSteps: 1 });
    assert.equal(report.status, 'max_steps');
    assert.equal(report.final_url, base + '/end');
    assert.equal(report.final_title, 'End');
    assert.equal(report.page.url, base + '/end');
    assert.equal(session.lastUrl, base + '/end');
  });

  await check('fragment navigation and history back settle without a new document', async () => {
    await open('/hash');
    const page = await snapshot(session.cdp, session.sessionId);
    assert.equal((await perform(session.cdp, session.sessionId, 'click', page.elements[0].ref)).ok, true);
    assert.equal(await evaluate(session.cdp, session.sessionId, 'location.href'), base + '/hash#anchor');
    assert.equal((await perform(session.cdp, session.sessionId, 'back')).ok, true);
    assert.equal(await evaluate(session.cdp, session.sessionId, 'location.href'), base + '/hash');
  });

  await check('the board handles named sessions, accurate idle time, selection and failed frames', async () => {
    await open('/auth');
    const namedSessions = new Sessions(config);
    const captures = [];
    const policy = new Pacing(config);
    const monitor = createMonitor({ sessions: namedSessions, pacing: policy, journal: new Journal() });
    let failCapture = false;
    const viewer = new Viewer({ ...monitor, capture: async (name) => {
      captures.push(name);
      return failCapture ? null : monitor.capture(name);
    }, decide: () => false });
    let viewerTarget;
    let viewerSessionId;
    try {
      const named = await namedSessions.ensure('招聘工作台', { cdp: chrome.wsUrl });
      named.lastActionAt = Date.now() - 5000;
      const url = await viewer.listen();
      let state = await (await fetch(url + 'state.json')).json();
      assert.equal(state.live, true);
      assert.equal(state.selectedSession, '招聘工作台');
      assert.equal(state.url, base + '/auth');
      assert.ok(state.sessions[0].idleMs >= 5000 && state.sessions[0].idleMs < 6000);
      assert.equal((await fetch(url + 'frame.png?session=' + encodeURIComponent('招聘工作台'))).status, 200);
      assert.equal(captures.at(-1), '招聘工作台');

      ({ targetId: viewerTarget } = await session.cdp.send('Target.createTarget', { url }));
      ({ sessionId: viewerSessionId } = await session.cdp.send('Target.attachToTarget', { targetId: viewerTarget, flatten: true }));
      await session.cdp.send('Page.enable', {}, viewerSessionId);
      await waitForReady(session.cdp, viewerSessionId);
      async function waitForBoard(expression) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (await evaluate(session.cdp, viewerSessionId, expression)) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.fail(`board did not settle: ${expression}`);
      }
      await waitForBoard('document.querySelector("#session").value === "招聘工作台" && /空闲 [5-9]s/.test(document.querySelector("#sessions").textContent)');
      const other = await namedSessions.ensure('other', { cdp: chrome.wsUrl });
      other.actionsTaken = 3;
      await waitForBoard('document.querySelectorAll("#session option").length === 2');
      await evaluate(session.cdp, viewerSessionId, 'document.querySelector("#session").value="other";document.querySelector("#session").dispatchEvent(new Event("change"))');
      await waitForBoard('document.querySelector("#health").textContent.includes("会话 other")');
      state = await (await fetch(url + 'state.json?session=other')).json();
      assert.equal(state.selectedSession, 'other');
      assert.match(state.pacing, /3/);
      await fetch(url + 'frame.png?session=other');
      assert.equal(captures.at(-1), 'other');
      failCapture = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal((await fetch(url + 'frame.png?session=other')).status, 204);
      await waitForBoard('!document.querySelector("#frame").hasAttribute("src")');
      await namedSessions.close('other');
      state = await (await fetch(url + 'state.json?session=other')).json();
      assert.equal(state.selectedSession, '招聘工作台');
    } finally {
      if (viewerSessionId) await session.cdp.send('Target.detachFromTarget', { sessionId: viewerSessionId }).catch(() => {});
      if (viewerTarget) await session.cdp.send('Target.closeTarget', { targetId: viewerTarget }).catch(() => {});
      await viewer.close();
      await namedSessions.closeAll();
    }
  });

  await check('closing the active tab attaches an unselected popup before use', async () => {
    const active = session.targetId;
    const { targetId } = await session.cdp.send('Target.createTarget', { url: base + '/popup' });
    await sessions.page('default');
    assert.equal(session.pages.get(targetId).sessionId, null);
    await session.cdp.send('Target.closeTarget', { targetId: active });
    // Adoption happens on the next reconcile, and the browser may take a moment to settle after
    // a tab disappears. Waiting for it under a deadline keeps the assertion — a *wrong* target
    // is still wrong — while removing the assumption that it happens within one call. This was
    // flaky once in a full-suite run and never reproduced alone; the assumption was the only
    // thing that could have made it so.
    const settle = async (predicate, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        ({ session } = await sessions.page('default'));
        if (await predicate()) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const adopted = await settle(() => session.targetId === targetId && typeof session.sessionId === 'string');
    assert.equal(
      session.targetId,
      targetId,
      `the session adopted ${session.targetId} instead of the unselected popup ${targetId} after ${adopted ? 0 : 8000}ms`,
    );
    assert.equal(typeof session.sessionId, 'string');
    await waitForReady(session.cdp, session.sessionId);
    await settle(async () => (await snapshot(session.cdp, session.sessionId)).title === 'Popup');
    assert.equal((await snapshot(session.cdp, session.sessionId)).title, 'Popup');
  });

  await check('the live view hands back a fresh capture, so a board can stream it', async () => {
    // The workbench page polls this to show what the browser is doing right now. A view that
    // returns the same bytes for a changed page looks live and is not, so the property under
    // test is that a second capture of a changed page differs from the first.
    //
    // A session of its own: navigating the shared one would destroy page state the checks
    // around it depend on, which is a real hazard of a suite that reuses one tab.
    const { createMonitor } = await import('../lib/monitor.js');
    const { Journal } = await import('../lib/journal.js');
    const monitor = createMonitor({ sessions, pacing: new Pacing(config), journal: new Journal() });
    const name = 'viewer';
    let watchedTarget = '';
    try {
      const watched = await sessions.ensure(name, { cdp: chrome.wsUrl });
      watchedTarget = watched.targetId;
      await navigate(watched.cdp, watched.sessionId, `${base}/start`);

      const first = await monitor.capture(name);
      assert.ok(first && first.length > 0, 'no frame was captured');
      assert.equal(first.subarray(1, 4).toString('ascii'), 'PNG', 'the frame is not a PNG, so an <img> cannot show it');

      await evaluate(watched.cdp, watched.sessionId, 'document.body.insertAdjacentHTML("beforeend","<div style=\'height:400px;background:#c00\'>changed</div>")');
      const second = await monitor.capture(name);
      assert.ok(second && second.length > 0, 'the second capture was empty');
      assert.equal(first.equals(second), false, 'the second capture was byte-identical — the view is not live');
    } finally {
      // Closing a session detaches its connection; it does not close the tab. Left behind, an
      // unclaimed page is exactly what a later reattach adopts instead of its own — which made
      // this check order-dependent until it cleaned up after itself.
      await sessions.close(name).catch(() => {});
      if (watchedTarget) {
        const cdp = await (await import('../lib/browser.js')).Cdp.connect(chrome.wsUrl).catch(() => null);
        if (cdp) {
          await cdp.send('Target.closeTarget', { targetId: watchedTarget }, undefined, 5000).catch(() => {});
          cdp.close();
        }
      }
    }
  });

  await check('four sessions opened at the same instant all come up', async () => {
    // The probe and the launch are not atomic. Without serialization all four callers see a
    // free profile and all four launch, and Chrome starts one process per caller on the same
    // `--user-data-dir` — four browsers on one profile, each with its own debugging port,
    // none of them the one the others believe they are using. Measured before the lock: four
    // distinct pids, no error raised. The invariant is therefore one browser, four tabs.
    const profileDir = join(tmpdir(), `jev-race-${process.pid}`);
    const racers = new Sessions({ ...config, profileDir });
    try {
      const names = ['r1', 'r2', 'r3', 'r4'];
      const settled = await Promise.allSettled(names.map((name) => racers.ensure(name, { headless: true })));
      const rejected = settled.filter((outcome) => outcome.status === 'rejected');
      assert.equal(
        rejected.length,
        0,
        `lost the launch race: ${rejected.map((outcome) => outcome.reason?.message).join(' | ')}`,
      );
      const pids = names.map((name) => racers.raw(name)?.pid);
      assert.equal(new Set(pids).size, 1, `sessions landed on ${new Set(pids).size} browsers: ${pids.join(', ')}`);
      const targets = names.map((name) => racers.raw(name)?.targetId);
      assert.equal(targets.filter(Boolean).length, 4, 'every session needs a target');
      assert.equal(new Set(targets).size, 4, `sessions shared a target: ${targets.join(', ')}`);
    } finally {
      await racers.closeAll().catch(() => {});
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  await check('named sessions get their own tab, never a shared page', async () => {
    // Regression: `#adoptOrCreatePage` used to consider every page target, including ones a
    // live session already drove. Because this connection is flattened, a second attach to
    // an already-attached target succeeds, so a second session silently adopted the first
    // session's tab — two goals, two budgets, one document. Measured before the fix: four
    // sessions landed on two targets.
    const extra = [];
    try {
      for (const name of ['tab-a', 'tab-b', 'tab-c']) {
        await sessions.ensure(name, { cdp: chrome.wsUrl });
        extra.push(name);
      }
      const owned = ['default', ...extra].map((name) => sessions.raw(name)?.targetId);
      assert.equal(owned.filter(Boolean).length, owned.length, 'every session needs a target');
      assert.equal(new Set(owned).size, owned.length, `sessions shared a target: ${owned.join(', ')}`);
    } finally {
      for (const name of extra) await sessions.close(name).catch(() => {});
    }
  });

  await check('reconnecting preserves the exhausted budget and pacing state', async () => {
    session.actionsTaken = 2;
    session.cooldowns = 1;
    session.lastActionAt = Date.now() - 1000;
    const { startedAt, lastActionAt, port, pacingPolicy } = session;
    const policy = new Pacing({ ...config, maxActionsPerSession: 2 });
    assert.equal(policy.checkBudget(session).allowed, false);
    session.cdp.close();
    ({ session } = await sessions.page('default'));
    assert.equal(session.port, port);
    assert.equal(session.actionsTaken, 2);
    assert.equal(session.cooldowns, 1);
    assert.equal(session.lastActionAt, lastActionAt);
    assert.equal(session.startedAt, startedAt);
    assert.equal(session.pacingPolicy, pacingPolicy);
    assert.equal(policy.checkBudget(session).allowed, false);
    assert.equal((await snapshot(session.cdp, session.sessionId)).title, 'Popup');
  });

  await check('a browser test never reads or rewrites its inherited Host registry', async () => {
    const hostProfile = `${process.env.DSH_PROFILE}-host`;
    const registry = join(tmpdir(), `dsh-jev-browser-launched-${hostProfile}.json`);
    const original = JSON.stringify({ version: 1, sessions: {
      labels: { pid: 0, port: 0, lastUrl: 'https://user-session.test/' },
    } });
    await writeFile(registry, original);
    try {
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./labels-check.mjs', import.meta.url))], {
        env: { ...process.env, DSH_PROFILE: hostProfile }, timeout: 45000,
      });
      assert.equal(await readFile(registry, 'utf8'), original);
    } finally {
      await rm(registry, { force: true });
    }
  });
} finally {
  globalThis.fetch = realFetch;
  await sessions.closeAll();
  await chrome?.kill();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
