/**
 * The recruiting tools.
 *
 * The property that matters most here is not that a run works. It is that **the agent cannot
 * approve its own authorisation**: the tool offers a request and nothing else, and approval
 * comes from the board. A tool that could grant a standing permission would make the whole
 * "authorise once, then act within the range" model decorative, so the enum is asserted to have
 * no approving action and `start` is asserted to refuse until a person has granted one.
 *
 * Run: node test/recruit-tools-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply } = await import('../index.js');
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

const posting = {
  version: 1,
  id: 'quality-engineer',
  platform: 'zhaopin',
  title: '质量工程师',
  must: [{ field: 'name', op: 'exists' }],
  greeting: '您好',
  limits: { contacts: 6, windows: 2 },
};
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

const html = await readFile(new URL('./fixtures/cards-inspect.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/list`;

const definitions = [];
const ctx = {
  tools: { register: (definition) => definitions.push(definition) },
  effect: () => {},
  logger: { debug() {} },
  get: () => undefined,
  inject: () => () => {},
};
const handle = apply(ctx, { headless: true, viewer: true, viewerPort: 0, profileDir: join(tmpdir(), `jev-recruit-tools-${process.pid}`), minActionDelayMs: 120, maxActionDelayMs: 120, cooldownEveryActions: 0 });
const tool = (name) => definitions.find((definition) => definition.name === name);
const signal = new AbortController().signal;
const call = (name, args) => tool(name).execute(args, { signal });

try {
  await verify('the plugin offers the recruiting tools', async () => {
    const names = definitions.map((definition) => definition.name);
    for (const required of ['browser_posting', 'browser_recruit', 'browser_site_config', 'browser_inspect']) {
      assert.ok(names.includes(required), `${required} is not registered: ${names.join(', ')}`);
    }
  });

  await verify('no action of browser_recruit approves an authorisation', async () => {
    const actions = tool('browser_recruit').parameters.properties.action.enum;
    assert.ok(actions.includes('request_authorization'));
    for (const forbidden of ['approve', 'authorize', 'grant', 'allow']) {
      assert.ok(!actions.includes(forbidden), `the agent can grant its own permission via ${forbidden}`);
    }
    // The output says who to ask, and that no tool can do it.
    assert.match(tool('browser_recruit').description, /only the operator approves/);
  });

  await verify('a posting round-trips through the tool', async () => {
    const saved = await call('browser_posting', { action: 'save', posting: JSON.stringify(posting) });
    assert.equal(saved.status, 'ok', saved.note);
    assert.ok(saved.saved_to.includes('postings'), saved.saved_to);
    const loaded = await call('browser_posting', { action: 'load', id: posting.id, platform: 'zhaopin' });
    assert.equal(JSON.parse(loaded.posting).title, '质量工程师');
    const listed = await call('browser_posting', { action: 'list' });
    // The listing names the platform, because the same job id exists on more than one of them.
    assert.ok(listed.postings.some((entry) => entry === 'zhaopin/quality-engineer  质量工程师'), JSON.stringify(listed.postings));
    const onZhipin = await call('browser_posting', { action: 'list', platform: 'zhipin' });
    assert.equal(onZhipin.postings.length, 0, `another platform listed this posting: ${JSON.stringify(onZhipin.postings)}`);
  });

  await verify('a malformed posting is refused with the path that failed', async () => {
    await assert.rejects(() => call('browser_posting', { action: 'save', posting: JSON.stringify({ ...posting, must: [] }) }), /invalid posting at must/);
    await assert.rejects(() => call('browser_posting', { action: 'save', posting: '{ not json' }), /not valid JSON/);
  });

  await verify('an authorisation request is a request, and grants nothing', async () => {
    const requested = await call('browser_recruit', { action: 'request_authorization', platform: 'zhaopin', account: 'example.test', posting: posting.id, limit: 6, actions: ['greet'] });
    assert.equal(requested.status, 'needs_confirmation');
    assert.equal(requested.requested, true);
    assert.match(requested.requested_summary, /up to 6 contact/);
    assert.match(requested.note, /等待|operator/);
    // Nothing has been recorded yet: the request is not a grant.
    const recorded = await readAuthorizations().catch(() => []);
    assert.equal(recorded.length, 0, 'a request was written to the audit file as if it were an approval');
  });

  await verify('starting before approval is refused, and says why', async () => {
    const refused = await call('browser_recruit', { action: 'start', platform: 'zhaopin', account: 'example.test', posting: posting.id, site_config: JSON.stringify(siteConfig), url });
    assert.equal(refused.status, 'refused');
    assert.match(refused.note, /no authorisation/);
    assert.equal(refused.state, 'idle', 'a refused start left the task running');
  });

  await verify('after the operator approves, a run starts and reports itself', async () => {
    // The board calls this; no tool does. Reaching the same task the tools use is the point:
    // approving a different object would be a grant nothing consults.
    const { authorization } = await handle.task.approveAuthorization({ by: 'test operator' });
    assert.ok(authorization.id.startsWith('auth-'));
    const started = await call('browser_recruit', { action: 'start', platform: 'zhaopin', account: 'example.test', posting: posting.id, site_config: JSON.stringify(siteConfig), url, windows: 2, limit: 6 });
    assert.equal(started.status, 'running', `${started.status}: ${started.note}`);
    assert.equal(started.spend_limit, 6);
    assert.equal(started.windows.length, 2);

    const status = await call('browser_recruit', { action: 'status' });
    assert.ok(['running', 'finished'].includes(status.state));
    assert.ok(status.authorization_id, 'the status does not name the authorisation in force');
    const done = await waitUntilSettled(handle);
    assert.equal(done.state, 'finished', done.error);
    assert.equal(done.sent, 6, `${done.sent} sent: ${done.note}`);
    const recorded = await readAuthorizations();
    assert.equal(recorded.length, 1, 'the approval was not written to the audit file');
  });

  await verify('the board sees the task, and the request waiting on a person', async () => {
    // The board reads the same object the tools read, through the same monitor, so this is the
    // path the page actually takes rather than a second implementation of it.
    const viewerUrl = handle.viewer.url;
    assert.ok(viewerUrl, 'the viewer did not listen, so the board has nothing to read');
    const state = await (await fetch(new URL('state.json', viewerUrl))).json();
    assert.ok(state.task, 'state.json carries no task');
    assert.equal(state.task.windows.length, 2, JSON.stringify(state.task.windows));
    assert.equal(state.task.spend.limit, 6);
    assert.ok(state.task.startedAt, 'the board cannot say when the run began');
  });

  await verify('the board can approve the request, and the refusal is not a fault', async () => {
    // A fresh request, to prove the route reaches the same task rather than only the tools.
    const asked = await call('browser_recruit', { action: 'request_authorization', platform: 'zhaopin', account: 'example.test', posting: posting.id, limit: 3 });
    assert.equal(asked.requested, true);
    const viewerUrl = handle.viewer.url;
    const before = await (await fetch(new URL('state.json', viewerUrl))).json();
    assert.ok(before.task.requestedAuthorization, 'the pending request is not on the board');
    const id = before.task.requestedAuthorization.id;
    assert.ok(id, 'the request has no id, so the board cannot answer it');
    const response = await fetch(new URL('decide', viewerUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: '', verdict: 'grant', id }),
    });
    assert.equal(response.status, 200, `the board's approval was refused: ${await response.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await (await fetch(new URL('state.json', viewerUrl))).json();
    assert.equal(after.task.requestedAuthorization, null, 'the request is still pending after approval');
    assert.equal(after.task.authorization.limit, 3, 'the approval did not come into force');
    const recorded = await readAuthorizations();
    assert.equal(recorded.length, 2, 'the board approval was not written to the audit file');
  });

  await verify('the board can stop the task', async () => {
    const viewerUrl = handle.viewer.url;
    // Start a run first: stopping one that has already finished proves nothing about stopping.
    const started = await call('browser_recruit', { action: 'start', platform: 'zhaopin', account: 'example.test', posting: posting.id, site_config: JSON.stringify(siteConfig), url, windows: 2, limit: 6 });
    assert.equal(started.status, 'running', started.note);
    const response = await fetch(new URL('control', viewerUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop', reason: 'board stop' }),
    });
    assert.equal(response.status, 200, `the stop was refused: ${await response.text()}`);
    const state = await (await fetch(new URL('state.json', viewerUrl))).json();
    assert.equal(state.task.state, 'stopped', `state was ${state.task.state}`);
  });

  await verify('an unknown control action is refused rather than ignored', async () => {
    const response = await fetch(new URL('control', handle.viewer.url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'explode' }),
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /unknown control action/);
  });

  await verify('stopping is reported as a state, not as a failure', async () => {
    const stopped = await call('browser_recruit', { action: 'stop', reason: 'test' });
    assert.ok(['stopped', 'finished'].includes(stopped.state), `${stopped.state}: ${stopped.note}`);
    assert.equal(stopped.status, 'ok');
  });
} finally {
  await handle?.task?.close?.().catch(() => {});
  await rm(join(tmpdir(), `jev-recruit-tools-${process.pid}`), { recursive: true, force: true }).catch(() => {});
  server.close();
}

async function waitUntilSettled(handle) {
  // The board reads the same object the tools do, so this is the same path.
  for (let i = 0; i < 200; i += 1) {
    const status = await call('browser_recruit', { action: 'status' });
    if (['finished', 'failed', 'stopped'].includes(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the run never settled');
}

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
