/**
 * The workbench's assistant, as an agent rather than a conversation.
 *
 * Two separate things make it dedicated, and it is worth being exact about which does what.
 *
 * The **preset** gives it a name and an identity of its own, so the platform and the session list
 * show an agent with a job instead of an anonymous session. It cannot narrow the tool set: the
 * built-in preset that everything else uses is itself `plugins: []`, so a preset adds entries
 * rather than replacing them, and a preset carrying only this plugin would not remove bash or
 * read — it would just add nothing. Claiming otherwise would be a promise the mechanism does not
 * keep.
 *
 * The **role** is what actually directs it. `systemPrompt.section()` registers "in the calling
 * context's scope", and the platform's own guidance is to register per-agent behaviour on
 * `agent.ctx`, so the section goes on that agent's own context and shadows nothing else.
 */

/** The preset id the workbench session is created with. */
export const WORKBENCH_PRESET_ID = 'scout-workbench';

/**
 * The preset. `plugins: []` deliberately: the built-in `standard` preset is also `plugins: []`,
 * which is what makes it safe — this adds nothing and takes nothing away.
 */
export const WORKBENCH_PRESET = {
  id: WORKBENCH_PRESET_ID,
  name: '招聘工作台助手',
  description: '专门用于操作招聘工作台的助手：读候选人、按岗位条件筛选、在授权的范围内打招呼。',
  order: 20,
  plugins: [],
};

/** The section name. Namespaced so it cannot collide with a section the platform owns. */
export const WORKBENCH_SECTION = 'scout:workbench-role';

/**
 * Where the section sits. The platform's own orders run DEPLOYMENT_PERSONA_PREFIX at 0 and
 * PLAN_POLICY at 500, so 100 is the gap reserved for describing what an agent is for.
 */
export const WORKBENCH_SECTION_ORDER = 100;

/**
 * What the assistant is told about itself.
 *
 * The rules are the plugin's own rules, said to the agent that drives it: an agent that does not
 * know a requirement the page never showed must stay unverified will happily turn it into a yes,
 * and one that does not know the four platforms are separate will carry an authorisation across
 * them.
 */
export function workbenchRoleText() {
  return [
    'You are the assistant for the recruiting workbench: a panel beside a real browser driven on',
    'the employer console of a Chinese recruiting site. Your job is to operate that workbench, not',
    'to chat about it.',
    '',
    'The four platforms are separate accounts with separate candidate pools, separate quotas and',
    'separate contact histories: zhaopin (智联招聘), zhipin (BOSS直聘), 51job (前程无忧) and liepin',
    '(猎聘). An authorisation for one is not a licence on another, and a contact on one is not a',
    'contact on another.',
    '',
    'When you act, keep these rules — they are the difference between a useful tool and a plausible',
    'one:',
    '- Never greet without an authorisation the operator granted, and never exceed its limit.',
    '- A requirement the page did not show is unverified. It is never a yes, and never a no.',
    '- Verified is not the same as done: a click the page did not confirm is unconfirmed.',
    '- When an outcome is unknown, do not retry it. Leave it for a person.',
    '- Report what you measured, and say plainly what you could not check.',
  ].join('\n');
}

/**
 * Whether a definition is one the registry will accept.
 *
 * Checked here so a malformed preset fails where it is written rather than at registration, which
 * happens during plugin start-up where the reason would be harder to see.
 */
export function validatePresetDefinition(definition) {
  const fail = (message) => {
    throw new Error(`invalid agent preset: ${message}`);
  };
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) fail('must be an object');
  if (typeof definition.id !== 'string' || definition.id.trim() === '') fail('id must be a non-empty string');
  if (!Array.isArray(definition.plugins)) fail('plugins must be an array');
  for (const plugin of definition.plugins) {
    if (plugin === null || typeof plugin !== 'object') fail('every plugin entry must be an object');
    if (plugin.name !== undefined && typeof plugin.name !== 'string') fail('a plugin entry name must be a string');
  }
  if (definition.name !== undefined && typeof definition.name !== 'string') fail('name must be a string');
  if (definition.description !== undefined && typeof definition.description !== 'string') fail('description must be a string');
  if (definition.order !== undefined && !Number.isFinite(definition.order)) fail('order must be a number');
  return definition;
}

/** Register the preset once. Returns the registry's disposer. */
export async function registerWorkbenchPreset(ctx) {
  const presets = ctx?.agentPresets;
  if (!presets) throw new Error('this Host exposes no preset registry, so the assistant cannot be named');
  if (typeof presets.register !== 'function') throw new Error('the preset registry cannot register a preset');
  validatePresetDefinition(WORKBENCH_PRESET);
  return presets.register(WORKBENCH_PRESET);
}

/** Which sessions already carry the role, so it is registered once each. */
const installed = new Map();

/** Forget one session's role. For a test, and for an agent that has gone away. */
export function forgetWorkbenchRole(sessionId) {
  installed.delete(sessionId);
}

/**
 * Put the role on one agent's own context.
 *
 * Registering the same name twice in one scope throws — "duplicates within one layer" — so this
 * is idempotent by session. A scope with no system-prompt service is reported rather than
 * treated as success: an assistant that was never told what it is should not look like one that
 * was.
 *
 * @returns {{ installed: boolean, reason: string, dispose?: () => void }}
 */
export function installWorkbenchRole(sessionId, agent) {
  if (typeof sessionId !== 'string' || sessionId === '') return { installed: false, reason: 'no session id' };
  if (installed.has(sessionId)) return { installed: false, reason: 'already installed' };
  const ctx = agent?.ctx;
  const systemPrompt = ctx?.get?.('systemPrompt') ?? ctx?.systemPrompt;
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    return { installed: false, reason: 'this agent scope has no system prompt' };
  }
  const dispose = systemPrompt.section({
    name: WORKBENCH_SECTION,
    order: WORKBENCH_SECTION_ORDER,
    text: workbenchRoleText(),
  });
  installed.set(sessionId, typeof dispose === 'function' ? dispose : () => {});
  return { installed: true, reason: 'registered', dispose: installed.get(sessionId) };
}

/**
 * The workbench's agent: the session adopted, the role installed, the live agent if there is one.
 *
 * @returns {{ sessionId: string, created: boolean, agent: object|null, role: object }}
 */
export async function workbenchAgent(ctx, { sessionId, signal, ensureSession } = {}) {
  const ensure = ensureSession ?? (await import('./workbench-session.js')).ensureWorkbenchSession;
  const session = await (sessionId
    ? Promise.resolve({ sessionId, created: false })
    : ensure(ctx, { signal, agentPreset: WORKBENCH_PRESET_ID }));

  let agent = null;
  try {
    const controller = ctx?.sessionController;
    const resolved = typeof controller?.resolveAgent === 'function' ? await controller.resolveAgent(session.sessionId) : null;
    agent = resolved && !resolved.error ? resolved.agent ?? null : null;
  } catch {
    // A session that cannot be resolved yet is not a failure of the workbench: the role is
    // installed when it can be, and the panel still reads and writes through the id it has.
    agent = null;
  }
  const role = agent ? installWorkbenchRole(session.sessionId, agent) : { installed: false, reason: 'no live agent yet' };
  return { sessionId: session.sessionId, created: session.created ?? false, agent, role };
}
