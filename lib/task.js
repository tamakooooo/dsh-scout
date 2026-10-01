/**
 * One recruiting task, as something a tool call can start, watch, and stop.
 *
 * A run takes minutes — twenty candidates, an account cadence between greetings — and a tool
 * call that blocked for that long would be useless to the caller and fragile against a
 * timeout. So `start` returns immediately and the work continues, and `status` is how anyone
 * finds out what happened. The board reads the same status object, which is what keeps the
 * page and the conversation describing the same run.
 *
 * The task owns the things that belong to a *run* rather than to the process: the control
 * (stop, pause, takeover), the windows, and the allowance. The record store and the pacing
 * module belong to the plugin and are shared, because they are what survives a run.
 *
 * An authorisation is required before starting, and it is written to the audit file at the
 * moment it is created rather than when the run begins, so what a person agreed to is on
 * record even if the run never starts.
 *
 * @module @local/dsh-jev-browser/lib/task
 */

import { Control } from './control.js';
import { platformById, assertOnPlatform, PLATFORM_IDS } from './platforms.js';
import { Windows } from './workers.js';
import { Spend, createAuthorization, recordAuthorization } from './authorize.js';
import { runTask } from './run.js';

/** The states a task reports. */
export const TASK_STATES = ['idle', 'running', 'finished', 'stopped', 'failed'];

export class Task {
  #config;
  #sessions;
  #recordsFor;
  #pacing;
  #control = null;
  #windows = null;
  #spend = null;
  #authorization = null;
  #run = null;
  #summary = null;
  #progress = null;
  #error = '';
  #startedAt = '';
  #finishedAt = '';
  #account = '';
  #posting = null;
  #requested = null;
  #requestNote = '';

  constructor({ config, sessions, records, recordsFor, pacing } = {}) {
    // Either a store, or a function that resolves one per platform. The plugin passes the
    // function, because a store is per platform and there is no shared bucket any more.
    const resolve = typeof recordsFor === 'function' ? recordsFor : (records ? () => records : null);
    if (!config || !sessions || !resolve) throw new Error('a task needs the plugin config, the session manager and a record store');
    this.#config = config;
    this.#sessions = sessions;
    this.#recordsFor = resolve;
    this.#pacing = pacing ?? null;
  }

  /** Whether a run is in flight. */
  get running() {
    return this.#run !== null && this.#finishedAt === '';
  }

  get state() {
    if (this.#run === null) return 'idle';
    if (this.#error) return 'failed';
    if (this.#finishedAt !== '') return 'finished';
    // A stop ends the windows, but the run is not over until they have unwound.
    if (this.#control?.stopped) return 'stopped';
    return 'running';
  }

  /**
   * The live picture: what the run is doing, what it has spent, and what each window is on.
   *
   * Everything the board needs is here, and nothing is inferred from what the run last said —
   * the window states come from the windows themselves.
   */
  get status() {
    return {
      state: this.state,
      startedAt: this.#startedAt,
      finishedAt: this.#finishedAt,
      error: this.#error,
      account: this.#account,
      posting: this.#posting?.id ?? '',
      authorization: this.#authorization
        ? { id: this.#authorization.id, at: this.#authorization.at, limit: this.#authorization.limit, expiresAt: this.#authorization.expiresAt ?? '' }
        : null,
      // A request waiting for a person, shown by the board. The agent can see it is pending;
      // it cannot approve it.
      requestedAuthorization: this.#requested
        ? {
          // The id is what the board posts back to approve or refuse it.
          id: this.#requested.id,
          account: this.#requested.account, posting: this.#requested.posting, actions: this.#requested.actions,
          limit: this.#requested.limit, expiresAt: this.#requested.expiresAt ?? '', note: this.#requestNote,
        }
        : null,
      spend: { limit: this.#spend?.limit ?? 0, spent: this.#spend?.spent ?? 0, remaining: this.#spend?.remaining ?? 0 },
      windows: this.#windows ? this.#windows.workers.map((worker) => ({
        name: worker.name,
        state: worker.state,
        candidate: worker.candidate ?? '',
        done: worker.done ?? 0,
        failed: worker.failed ?? 0,
        targetId: worker.targetId ?? '',
      })) : [],
      progress: this.#progress,
      summary: this.#summary,
    };
  }

  /**
   * Put an authorisation to the operator.
   *
   * This is deliberately a *request*. The agent can describe what it wants to do and for how
   * long, but it cannot grant it: a tool that could approve its own standing permission would
   * make the whole model of "authorise once, then act within the range" meaningless. Approval
   * comes from the board, through {@link Task#approveAuthorization}, which no tool calls.
   */
  requestAuthorization(input = {}) {
    // Validate now rather than at approval time, so a malformed request never reaches a person
    // who would have to guess what was meant.
    const candidate = createAuthorization({ ...input, id: input.id ?? undefined });
    this.#requested = candidate;
    this.#requestNote = input.note ?? '';
    return this.#requested;
  }

  /** The request waiting for a person, or null. */
  get requestedAuthorization() {
    return this.#requested;
  }

  /**
   * Approve the request, recording it. Called by the board, never by a tool.
   *
   * @returns the recorded authorisation.
   */
  async approveAuthorization({ by = 'operator' } = {}) {
    if (!this.#requested) throw new Error('no authorisation has been requested');
    const authorization = createAuthorization({ ...this.#requested, id: undefined, at: undefined, note: this.#requestNote || this.#requested.note });
    const file = await recordAuthorization(authorization);
    this.#authorization = authorization;
    this.#requested = null;
    return { authorization, file, by };
  }

  /** Refuse the request. Nothing is recorded but the refusal itself, to the journal. */
  denyAuthorization(reason = 'refused by the operator') {
    const denied = this.#requested;
    this.#requested = null;
    return { denied, reason };
  }

  /** Record an authorisation directly, for a test or an operator acting out of band. */
  async authorize(input = {}) {
    const authorization = createAuthorization(input);
    this.#authorization = authorization;
    const file = await recordAuthorization(authorization);
    return { authorization, file };
  }

  /** The authorisation currently held, for a caller that needs to show it. */
  get authorization() {
    return this.#authorization;
  }

  /**
   * Start a run.
   *
   * @returns the status immediately; the work continues in the background, and `status`,
   *   `pause`, `resume` and `stop` act on it from there.
   */
  async start({ siteConfig, posting, account, judge, limit, windows = 2, headless, waitTimeoutMs, url } = {}) {
    if (this.running) throw new Error('a task is already running; stop it or wait for it to finish');
    if (!posting || !siteConfig) throw new Error('a run needs a posting and a site configuration');
    // One platform, three independent statements of it, all checked against each other: the
    // posting says which pool, the site configuration says which page, and the authorisation
    // says what was granted. A run that mixed two of them would be acting on a page nobody
    // authorised, on behalf of a posting that does not describe it.
    const platform = posting.platform;
    if (!platformById(platform)) {
      throw new Error(`the posting does not name a platform; expected one of ${PLATFORM_IDS.join(', ')}`);
    }
    assertOnPlatform(platform, siteConfig.domain);
    if (this.#authorization && this.#authorization.platform !== platform) {
      throw new Error(`the authorisation is for ${this.#authorization.platform}, not ${platform}; request one for this platform`);
    }
    if (!this.#authorization) {
      // Starting without one would mean the run decides for itself what it may spend.
      throw new Error('no authorisation has been granted; call authorize first, naming the account, the posting, the action kinds and the limit');
    }
    if (typeof account !== 'string' || account.trim() === '') throw new Error('a run needs the account it acts on');

    this.#error = '';
    this.#summary = null;
    this.#progress = null;
    this.#finishedAt = '';
    this.#startedAt = new Date().toISOString();
    this.#account = account;
    this.#posting = posting;

    this.#control = new Control();
    this.#windows = new Windows({ sessions: this.#sessions, control: this.#control, count: windows });
    const opened = await this.#windows.open({ headless });
    const usable = opened.filter((entry) => entry.ok);
    if (usable.length === 0) {
      this.#error = `no window could be opened: ${opened.map((entry) => `${entry.name}: ${entry.error}`).join('; ')}`;
      this.#finishedAt = new Date().toISOString();
      return this.status;
    }

    // A run has to know which page to work on. Without it every window sits on about:blank and
    // the read yields nothing — which is a silent no-op rather than an error, so the URL is
    // navigated explicitly and every window gets the same list to work from.
    if (typeof url === 'string' && url.trim() !== '') {
      const { navigate } = await import('./page.js');
      for (const name of this.#windows.names) {
        if (!opened.find((entry) => entry.name === name && entry.ok)) continue;
        const session = this.#windows.sessionFor(name);
        await navigate(session.cdp, session.sessionId, url).catch(() => {});
      }
    }

    // The posting's own ceiling and the authorisation's limit both apply; the lower wins.
    const postingLimit = posting.limits?.contacts;
    const requested = limit ?? this.#authorization.limit;
    const ceiling = typeof postingLimit === 'number' ? Math.min(requested, postingLimit) : requested;
    this.#spend = new Spend({ limit: ceiling });

    this.#run = runTask({
      ctx: null,
      config: this.#config,
      windows: this.#windows,
      control: this.#control,
      records: this.#recordsFor(platform),
      spend: this.#spend,
      authorization: this.#authorization,
      pacing: this.#pacing,
      siteConfig,
      posting,
      account,
      judge,
      // The read limit is not the spend ceiling: reading more candidates than the account may
      // contact is the point, so the refusals can be reported rather than silently not queued.
      readLimit: 200,
      waitTimeoutMs,
      onTick: (progress) => { this.#progress = JSON.parse(JSON.stringify(progress)); },
    })
      .then((summary) => {
        this.#summary = summary;
        this.#progress = summary.progress ?? this.#progress;
      })
      .catch((error) => {
        this.#error = error.message;
      })
      .finally(() => {
        this.#finishedAt = new Date().toISOString();
      });

    return this.status;
  }

  /** Hold one window. The rest keep going, which is the difference from stopping. */
  pause(worker, reason = 'paused by request') {
    if (!this.#control) throw new Error('no task has been started');
    this.#control.pause(worker, reason);
    return this.status;
  }

  resume(worker) {
    if (!this.#control) throw new Error('no task has been started');
    this.#control.resume(worker);
    return this.status;
  }

  /** A person has taken a window; continuing begins by re-reading the page. */
  takeover(worker, reason = 'a person is using the browser') {
    if (!this.#control) throw new Error('no task has been started');
    this.#control.takeover(worker, reason);
    return this.status;
  }

  release(worker) {
    if (!this.#control) throw new Error('no task has been started');
    this.#control.release(worker);
    return this.status;
  }

  /**
   * End the run.
   *
   * The windows finish unwinding asynchronously, so this returns before the run is over; the
   * status reports `stopped` in the meantime and `finished` once they are done.
   */
  stop(reason = 'stopped by request') {
    if (!this.#control) throw new Error('no task has been started');
    this.#control.stop(reason);
    return this.status;
  }

  /** Wait for the run to settle, for a caller that wants the outcome rather than the status. */
  async settled({ timeoutMs = 600000 } = {}) {
    if (!this.#run) return this.status;
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return this.status;
  }

  /** Close the windows this task opened. The browser is left running. */
  async close() {
    return this.#windows ? this.#windows.close() : [];
  }
}
