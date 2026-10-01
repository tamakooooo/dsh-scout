/**
 * Jev Browser — a Host bundle that gives the agent a real Chrome it can drive.
 *
 * The decision layer is TypeSafe Jev (System One) reached through CommandCode's
 * Provider API; the browser engine is raw CDP over the DevTools WebSocket. Neither
 * needs a package dependency, so this bundle installs and activates with no
 * resolution step: `node:child_process`, `node:fs`, `node:crypto`, global `fetch`,
 * and global `WebSocket` are the whole runtime surface.
 *
 * The bundle intentionally exports no `Config` schema, so the row's `config` object
 * passes through untouched (Cordis returns it verbatim when a plugin declares no
 * schema) and this module owns defaults and clamping.
 *
 * @module @local/dsh-jev-browser
 */

import { Sessions } from './lib/sessions.js';
import { buildTools } from './lib/tools.js';
import { DEFAULT_CONSEQUENTIAL_PATTERNS, DEFAULT_RISK_SIGNALS, Pacing } from './lib/pacing.js';
import { DEFAULT_SUCCESS_PATTERNS, DEFAULT_FAILURE_PATTERNS } from './lib/verify.js';
import { DEFAULT_INJECTION_PATTERNS, scanForInjectedInstructions } from './lib/injection.js';
import { Viewer } from './lib/viewer.js';
import { Journal } from './lib/journal.js';
import { Records } from './lib/records.js';
import { Task } from './lib/task.js';
import { sendChat } from './lib/chat.js';
import { createMonitor } from './lib/monitor.js';
import { CONFIDENCE_MAX_SCORE } from './lib/act.js';

/** Diagnostics name for this plugin. */
export const name = 'jev-browser';

/** The tool registry must exist before the browser tools can be registered. */
export const inject = ['tools'];

/**
 * Where the board's routes are mounted on the application's own server.
 *
 * One prefix, registered once. A prefix route keeps the page's URLs stable
 * (`/jev-browser/state.json`) and leaves the rest of the server's namespace alone.
 */
export const MOUNT = '/jev-browser';

/** Every supported setting, with its default. */
const DEFAULTS = {
  apiKeyEnv: 'COMMANDCODE_API_KEY',
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  model: 'typesafe/jev',
  chromePath: '',
  managedBrowserDir: '',
  profileDir: '',
  keepBrowserOnUnload: true,
  headless: false,
  maxSteps: 8,
  maxElements: 60,
  maxStateChars: 6000,
  // The structural sample that a site configuration is learned from. Fixed caps, not
  // "as complete as possible": a recruiting list runs to tens of thousands of tokens, and a
  // sample that quietly stops being bounded is worse than none, because callers keep trusting it.
  inspectDepth: 6,
  inspectNodes: 120,
  inspectAttributes: 5,
  inspectSamples: 20,
  inspectCharacters: 12000,
  confidenceFloor: 0.5,
  // Politeness defaults: slow enough not to look like a script, bounded enough that a
  // mistake cannot spend a whole day's quota before anyone notices.
  minActionDelayMs: 3000,
  maxActionDelayMs: 9000,
  maxActionsPerSession: 20,
  cooldownEveryActions: 8,
  cooldownMs: 45000,
  stopOnRiskPage: true,
  requireConfirmation: true,
  requestTimeoutMs: 45000,
  maxSessions: 4,
  // Tabs share one window and one place to look, which is the default. A separate window per
  // session suits watching several sessions side by side.
  newWindow: false,
  viewer: true,
  viewerPort: 19390,
  // Verifying an action's effect is what keeps a silent failure from being retried — and a
  // retry spends the account's quota again. `verificationFloor` is the noul threshold: above
  // it the page is taken to confirm the action, below `1 - floor` to contradict it, and in
  // between the result is reported as unconfirmed and handed to a human.
  verifyActions: true,
  verificationFloor: 0.6,
  // Page text reaches two models: the decision model inside its state, and the calling agent
  // inside `browser_snapshot`. Both read it as part of a prompt, and on a recruiting console
  // a candidate's self-introduction is user-generated text in the same snapshot as the job's
  // own copy. A hit from either layer stops the step and hands it to a person.
  screenInjectedText: true,
  injectionFloor: 0.7,
};

/**
 * Coerce one raw config object into the effective settings.
 *
 * Every number is clamped rather than rejected: a bad patch value must not make the
 * whole profile fail to load, and an out-of-range budget is still a working budget.
 *
 * @param raw - the row's config, as written in the patch.
 * @returns the resolved settings.
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const string = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  const integer = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.trunc(parsed), min), max);
  };
  const decimal = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  };
  const list = (value, fallback) => {
    if (!Array.isArray(value)) return fallback;
    const kept = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());
    // An explicitly empty safety list is treated as "not configured", not as "silently
    // disable this gate". Every other field here clamps or falls back so a bad value cannot
    // break the profile; an empty list was the one input that could turn the confirmation
    // gate or the risk stop off without saying so.
    return kept.length > 0 ? kept : fallback;
  };
  // `actionDelayMs` predates the randomized pacing; honour it as a fixed delay so an
  // older row keeps working instead of silently losing its setting.
  const legacyDelay = Number.isFinite(Number(input.actionDelayMs)) ? Math.trunc(Number(input.actionDelayMs)) : null;
  const minDelay = integer(input.minActionDelayMs, legacyDelay ?? DEFAULTS.minActionDelayMs, 0, 120000);
  const fallbackMax = legacyDelay !== null ? Math.max(legacyDelay, minDelay) : Math.max(DEFAULTS.maxActionDelayMs, minDelay);
  const maxDelay = integer(input.maxActionDelayMs, fallbackMax, 0, 300000);
  return {
    apiKeyEnv: string(input.apiKeyEnv, DEFAULTS.apiKeyEnv),
    baseUrl: string(input.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, ''),
    model: string(input.model, DEFAULTS.model),
    chromePath: string(input.chromePath, DEFAULTS.chromePath),
    managedBrowserDir: string(input.managedBrowserDir, DEFAULTS.managedBrowserDir),
    profileDir: string(input.profileDir, DEFAULTS.profileDir),
    keepBrowserOnUnload: input.keepBrowserOnUnload !== false,
    headless: input.headless === true,
    maxSteps: integer(input.maxSteps, DEFAULTS.maxSteps, 1, 20),
    maxElements: integer(input.maxElements, DEFAULTS.maxElements, 1, 200),
    inspectDepth: integer(input.inspectDepth, DEFAULTS.inspectDepth, 1, 10),
    inspectNodes: integer(input.inspectNodes, DEFAULTS.inspectNodes, 10, 300),
    inspectAttributes: integer(input.inspectAttributes, DEFAULTS.inspectAttributes, 1, 8),
    inspectSamples: integer(input.inspectSamples, DEFAULTS.inspectSamples, 0, 50),
    inspectCharacters: integer(input.inspectCharacters, DEFAULTS.inspectCharacters, 500, 40000),
    maxStateChars: integer(input.maxStateChars, DEFAULTS.maxStateChars, 500, 40000),
    confidenceFloor: decimal(input.confidenceFloor, DEFAULTS.confidenceFloor, 0, CONFIDENCE_MAX_SCORE),
    minActionDelayMs: minDelay,
    maxActionDelayMs: Math.max(minDelay, maxDelay),
    maxActionsPerSession: integer(input.maxActionsPerSession, DEFAULTS.maxActionsPerSession, 0, 1000),
    cooldownEveryActions: integer(input.cooldownEveryActions, DEFAULTS.cooldownEveryActions, 0, 200),
    cooldownMs: integer(input.cooldownMs, DEFAULTS.cooldownMs, 0, 600000),
    stopOnRiskPage: input.stopOnRiskPage !== false,
    requireConfirmation: input.requireConfirmation !== false,
    consequentialPatterns: list(input.consequentialPatterns, DEFAULT_CONSEQUENTIAL_PATTERNS),
    riskSignals: list(input.riskSignals, DEFAULT_RISK_SIGNALS),
    requestTimeoutMs: integer(input.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 1000, 300000),
    maxSessions: integer(input.maxSessions, DEFAULTS.maxSessions, 1, 16),
    newWindow: input.newWindow === true,
    viewer: input.viewer !== false,
    viewerPort: integer(input.viewerPort, DEFAULTS.viewerPort, 0, 65535),
    verifyActions: input.verifyActions !== false,
    verificationFloor: decimal(input.verificationFloor, DEFAULTS.verificationFloor, 0.5, 1),
    screenInjectedText: input.screenInjectedText !== false,
    injectionFloor: decimal(input.injectionFloor, DEFAULTS.injectionFloor, 0.5, 1),
    injectionPatterns: list(input.injectionPatterns, DEFAULT_INJECTION_PATTERNS),
    successPatterns: list(input.successPatterns, DEFAULT_SUCCESS_PATTERNS),
    failurePatterns: list(input.failurePatterns, DEFAULT_FAILURE_PATTERNS),
  };
}

/**
 * Register the browser tools and own the browsers they launch.
 *
 * @param ctx - the plugin context; `ctx.tools` is required and `ctx.credentials` is
 *   used when present so the decision key resolves per call.
 * @param config - the row's config object.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const sessions = new Sessions(resolved);
  // One Pacing for the whole plugin, so a decision answered in the live view is the same
  // decision the next browser_act consults. The gate itself is unchanged; only where a
  // human may answer it widens.
  const pacing = new Pacing(resolved);
  // What the monitoring board reads: events appended when they happened, and one row per
  // run. Observed, never inferred.
  const journal = new Journal();
  // What survives a run: who was contacted and what is known about how it went. One instance
  // per plugin, because the account is one account and the guard has to see every window.
  const records = new Records();
  // The run itself: stop, pause, takeover, its windows, and the allowance it spends from.
  const task = new Task({ config: resolved, sessions, records, pacing });

  const viewer = new Viewer({
    log: (message) => ctx.logger?.debug?.(`[jev-browser] ${message}`),
    ...createMonitor({ sessions, pacing, journal, task }),
    // The workbench's chat box. The text becomes a prompt in a conversation through the
    // platform's own session controller — the same call the conversation composer makes — and
    // the answer renders in that conversation rather than in this panel.
    chat: async (message) => {
      const controller = ctx.get?.('sessionController');
      if (!controller) throw new Error('this Host exposes no session controller, so there is nowhere to send');
      return sendChat({ sessionController: controller }, {
        text: typeof message?.text === 'string' ? message.text : '',
        sessionId: typeof message?.sessionId === 'string' && message.sessionId !== '' ? message.sessionId : undefined,
        mode: message?.mode === 'steer' ? 'steer' : 'queue',
        timeZone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })(),
      });
    },
    // The board's controls. They call the same task the tools call, so a stop from the page
    // and a stop from the conversation are one stop.
    control: async (action, worker, reason) => {
      const target = worker || 'w1';
      if (action === 'stop') return task.stop(reason || '看板停止');
      if (action === 'pause') return task.pause(target, reason || '看板暂停');
      if (action === 'resume') return task.resume(target);
      if (action === 'takeover') return task.takeover(target, reason || '人工接管');
      if (action === 'release') return task.release(target);
      throw new Error(`unknown control action ${JSON.stringify(action)}`);
    },
    decide: (target, verdict, id) => {
      // An authorisation request is answered here, and only here. No tool can approve one, so
      // the board is the single path by which a standing permission comes into force.
      const requested = task.requestedAuthorization;
      if (requested && id === requested.id) {
        if (verdict === 'grant') {
          void task.approveAuthorization({ by: '看板' })
            .then(() => journal.record('authorization-grant', { account: requested.account, posting: requested.posting, limit: requested.limit }))
            .catch((error) => journal.record('authorization-error', { message: error.message }));
        } else {
          const denied = task.denyAuthorization('看板拒绝了这次授权');
          journal.record('authorization-deny', { account: denied.denied?.account, posting: denied.denied?.posting, reason: denied.reason });
        }
        return true;
      }
      if (verdict === 'grant') {
        if (!pacing.grant(target, 900000, id)) return false;
        journal.record('grant', { target, via: '看板' });
      } else {
        if (!pacing.deny(target, id)) return false;
        journal.record('deny', { target, via: '看板' });
      }
      return true;
    },
  });

  for (const definition of buildTools({ ctx, config: resolved, sessions, pacing, viewer, journal, records, task })) {
    ctx.tools.register(definition);
  }

  // The listener is loopback-only and its URL carries a random token, so it is started
  // without ceremony and torn down with the plugin.
  if (resolved.viewer) {
    void viewer.listen({ port: resolved.viewerPort });
    ctx.effect(() => () => viewer.close(), 'jev-browser viewer');
  }

  // The board's own routes, mounted on the application's server.
  //
  // The page this plugin contributes lives *inside* the app, so it is already same-origin
  // and already behind the session: it can neither carry the loopback token nor should it
  // need a second origin. Serving the same routes here is what lets the sidebar page be a
  // real page instead of an iframe — an iframe document never receives the host's theme
  // tokens, light/dark switching, or locale.
  //
  // `webServer` is optional so the plugin still loads in a profile without a web carrier
  // (a CLI or headless run), where the loopback viewer remains the only surface.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'prefix',
          path: MOUNT,
          handler: (req, res) => {
            const url = new URL(req.url ?? MOUNT, 'http://127.0.0.1');
            const segments = url.pathname.startsWith(MOUNT)
              ? url.pathname.slice(MOUNT.length).split('/').filter(Boolean)
              : [];
            return viewer.dispatch(req, res, segments, url.searchParams);
          },
        }),
      'jev-browser routes',
    );
  });

  // Tool registration is disposed with the plugin's own context; browser processes are
  // not. Detaching by default keeps a browser — and whatever the user is logged into —
  // alive across a reload, with the launched-browser registry as the way back in.
  // `keepBrowserOnUnload: false` restores the tear-everything-down behaviour.
  ctx.effect(
    () => () => (resolved.keepBrowserOnUnload ? sessions.detachAll() : sessions.closeAll()),
    'jev-browser sessions',
  );

  // A handle on what this instance built. The board and the tests both need to reach the same
  // task the tools use: an authorisation approved on a different object would be a grant that
  // nothing consults, which is exactly the failure this wiring exists to prevent.
  return { sessions, pacing, journal, records, task, viewer };
}
