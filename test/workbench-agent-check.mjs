/**
 * The workbench assistant: the preset that names it, and the role that directs it.
 *
 * Two things are asserted here and they are asserted separately on purpose. The preset is only a
 * name — it cannot narrow the tool set, because the platform's own built-in preset is `plugins: []`
 * and a preset therefore adds rather than replaces. The role is what actually directs the agent,
 * and it goes on that agent's own context so it shadows nothing else.
 *
 * Run: node test/workbench-agent-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';

const {
  WORKBENCH_PRESET, WORKBENCH_PRESET_ID, WORKBENCH_SECTION, WORKBENCH_SECTION_ORDER,
  workbenchRoleText, validatePresetDefinition, registerWorkbenchPreset,
  installWorkbenchRole, forgetWorkbenchRole, workbenchAgent,
} = await import('../lib/workbench-agent.js');

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

/** An agent whose context carries a recording system-prompt service. */
function fakeAgent() {
  const sections = [];
  return {
    sections,
    ctx: {
      get: (name) => (name === 'systemPrompt' ? {
        section: (section) => { sections.push(section); return () => {}; },
      } : undefined),
    },
  };
}

await verify('the preset is a name and adds nothing', async () => {
  validatePresetDefinition(WORKBENCH_PRESET);
  assert.equal(WORKBENCH_PRESET.id, WORKBENCH_PRESET_ID);
  assert.equal(WORKBENCH_PRESET.name, '招聘工作台助手');
  // An empty plugin list is the point: it takes nothing away and adds nothing. A preset carrying
  // only this plugin would not remove bash or read, so claiming a narrowed tool set would be a
  // promise the mechanism does not keep.
  assert.deepEqual(WORKBENCH_PRESET.plugins, []);
  assert.ok(WORKBENCH_PRESET.description.includes('招聘工作台'));
});

await verify('a malformed preset is refused where it is written', async () => {
  await assert.rejects(async () => validatePresetDefinition(null), /must be an object/);
  await assert.rejects(async () => validatePresetDefinition({ plugins: [] }), /id must be a non-empty string/);
  await assert.rejects(async () => validatePresetDefinition({ id: 'x' }), /plugins must be an array/);
  await assert.rejects(async () => validatePresetDefinition({ id: 'x', plugins: [null] }), /plugin entry must be an object/);
  await assert.rejects(async () => validatePresetDefinition({ id: 'x', plugins: [], order: Number.NaN }), /order must be a number/);
  validatePresetDefinition({ id: 'x', plugins: [{ name: '@local/dsh-jev-browser' }] });
});

await verify('registering goes through the registry and reports its absence', async () => {
  const registered = [];
  const ctx = { agentPresets: { register: async (definition) => { registered.push(definition); return () => {}; } } };
  await registerWorkbenchPreset(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, WORKBENCH_PRESET_ID);
  await assert.rejects(() => registerWorkbenchPreset({}), /no preset registry/);
  await assert.rejects(() => registerWorkbenchPreset({ agentPresets: {} }), /cannot register/);
});

await verify('the role says the things an agent would otherwise get wrong', async () => {
  const text = workbenchRoleText();
  // The four platforms and the rule that separates them.
  for (const name of ['zhaopin', 'zhipin', '51job', 'liepin']) assert.ok(text.includes(name), `the role never names ${name}`);
  assert.match(text, /not a licence on another/);
  // And the plugin's own honesty rules, said to the agent that will be acting on them.
  assert.match(text, /unverified\. It is never a yes/);
  assert.match(text, /Never greet without an authorisation/);
  assert.match(text, /do not retry/);
});

await verify('the role is registered on the agent own context, once', async () => {
  const agent = fakeAgent();
  forgetWorkbenchRole('s-1');
  const first = installWorkbenchRole('s-1', agent);
  assert.equal(first.installed, true);
  assert.equal(agent.sections.length, 1);
  assert.equal(agent.sections[0].name, WORKBENCH_SECTION);
  assert.equal(agent.sections[0].order, WORKBENCH_SECTION_ORDER);
  // In the gap the platform leaves between the persona prefix and its own policy sections.
  assert.ok(agent.sections[0].order > 0 && agent.sections[0].order < 500, `order ${agent.sections[0].order} is outside the gap`);
  assert.match(agent.sections[0].text, /recruiting workbench/);
  // Registering the same name twice in one scope throws, so the second call must not try.
  const second = installWorkbenchRole('s-1', agent);
  assert.equal(second.installed, false);
  assert.equal(second.reason, 'already installed');
  assert.equal(agent.sections.length, 1, 'the role was registered twice');
  forgetWorkbenchRole('s-1');
});

await verify('an agent with no prompt service is reported, not called installed', async () => {
  forgetWorkbenchRole('s-2');
  const bare = { ctx: {} };
  const result = installWorkbenchRole('s-2', bare);
  assert.equal(result.installed, false);
  assert.match(result.reason, /no system prompt/);
  assert.equal(installWorkbenchRole('', bare).installed, false);
});

await verify('the workbench agent adopts the session and installs the role when there is one', async () => {
  forgetWorkbenchRole('session-live');
  const agent = fakeAgent();
  const ctx = {
    sessionController: {
      async create() { return { sessionId: 'session-live' }; },
      async resolveAgent(id) { assert.equal(id, 'session-live'); return { agent }; },
    },
  };
  const result = await workbenchAgent(ctx, { ensureSession: async () => ({ sessionId: 'session-live', created: true }) });
  assert.equal(result.sessionId, 'session-live');
  assert.equal(result.agent, agent);
  assert.equal(result.role.installed, true);
  forgetWorkbenchRole('session-live');
});

await verify('a session that cannot be resolved yet still yields a usable id', async () => {
  forgetWorkbenchRole('session-early');
  const ctx = {
    sessionController: {
      async create() { return { sessionId: 'session-early' }; },
      async resolveAgent() { throw new Error('not started yet'); },
    },
  };
  const result = await workbenchAgent(ctx, { ensureSession: async () => ({ sessionId: 'session-early', created: true }) });
  // The panel can still read and write through the id; only the role has to wait.
  assert.equal(result.sessionId, 'session-early');
  assert.equal(result.agent, null);
  assert.equal(result.role.installed, false);
  assert.match(result.role.reason, /no live agent/);
  // And a Host that reports an error rather than throwing is handled the same way.
  const erroring = { sessionController: { async resolveAgent() { return { error: { code: 'not-attached' } }; } } };
  const second = await workbenchAgent(erroring, { sessionId: 'session-early' });
  assert.equal(second.agent, null);
});

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
