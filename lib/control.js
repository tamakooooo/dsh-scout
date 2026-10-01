/**
 * Stopping, pausing, and handing the browser back to a person.
 *
 * Every long path in this plugin eventually makes a decision that spends something — a
 * greeting, an account's quota, a candidate's patience — so a stop that only takes effect at
 * the *next* step is not a stop. The plan asks for two things that shape this module:
 *
 * - A stop takes hold within seconds, **including while waiting**. A wait that runs to
 *   completion before noticing is the difference between stopping and finishing.
 * - A stop is not a rollback. An action already handed to the browser stays where it is and is
 *   recorded as needing confirmation; nothing here claims to have undone it.
 *
 * Three halts, kept apart because they mean different things to whoever is watching:
 *
 * - `paused` — a worker is being held back deliberately, and can continue as it was.
 * - `takeover` — a person has the browser. Continuing afterwards must begin by **re-reading
 *   the page**, because a person may have navigated, filled something in, or logged out, and
 *   the refs and positions held before are no longer about anything.
 * - `stopped` — the whole run is over. This one is final: a stopped control cannot be resumed,
 *   so nothing can quietly restart work the operator ended.
 *
 * @module @local/dsh-jev-browser/lib/control
 */

/** The states a worker can be in, as the board reports them. */
export const WORKER_STATES = ['running', 'paused', 'takeover', 'stopped'];

/** Thrown at every boundary that must not be crossed while halted. */
export class HaltedError extends Error {
  constructor(state, reason) {
    super(reason || `the run is ${state}`);
    this.name = 'HaltedError';
    this.state = state;
  }
}

/** Thrown when waiting for a worker to become runnable gave up. */
export class ControlTimeoutError extends Error {
  constructor(worker, timeoutMs) {
    super(`worker ${JSON.stringify(worker)} did not become runnable within ${timeoutMs}ms`);
    this.name = 'ControlTimeoutError';
  }
}

export class Control {
  #stopped = false;
  #reason = '';
  #paused = new Map();
  #takeover = new Map();
  #stale = new Set();
  #controller = new AbortController();

  /** A signal that aborts on stop, for anything that can be cancelled. */
  get signal() {
    return this.#controller.signal;
  }

  get stopped() {
    return this.#stopped;
  }

  get reason() {
    return this.#reason;
  }

  /**
   * End the run.
   *
   * Final by design. Allowing a resume would mean a stop could be undone by whatever called
   * `resume` last, and the operator who pressed stop would have no way to tell.
   */
  stop(reason = 'stopped by the operator') {
    if (this.#stopped) return this;
    this.#stopped = true;
    this.#reason = reason;
    this.#controller.abort(new HaltedError('stopped', reason));
    return this;
  }

  /** Hold one worker back. Others keep running: pause is per window by design. */
  pause(worker, reason = 'paused') {
    if (this.#stopped) return this;
    this.#paused.set(worker, reason);
    return this;
  }

  /** Let a paused worker continue. Does nothing to a stopped run. */
  resume(worker) {
    this.#paused.delete(worker);
    return this;
  }

  /**
   * A person has taken the browser.
   *
   * Recorded separately from a pause so the board can say who is driving, and so the resume
   * path knows it must re-read the page rather than trust anything observed before.
   */
  takeover(worker, reason = 'a person is using the browser') {
    if (this.#stopped) return this;
    this.#takeover.set(worker, reason);
    return this;
  }

  /** The person has handed the browser back. The worker runs again, but owes a re-read. */
  release(worker) {
    if (this.#takeover.delete(worker)) this.#stale.add(worker);
    return this;
  }

  /** Whether this worker owes a re-read before it acts again. */
  staleFor(worker) {
    return this.#stale.has(worker);
  }

  /** Called once the page has been read again. */
  clearStale(worker) {
    this.#stale.delete(worker);
    return this;
  }

  /** The state of one worker, for the board and for the callers that must refuse. */
  stateOf(worker) {
    if (this.#stopped) return 'stopped';
    if (this.#takeover.has(worker)) return 'takeover';
    if (this.#paused.has(worker)) return 'paused';
    return 'running';
  }

  /** Every halt, with the reason, so the board can say why nothing is happening. */
  get snapshot() {
    const workers = {};
    for (const [worker, reason] of this.#paused) workers[worker] = { state: 'paused', reason };
    for (const [worker, reason] of this.#takeover) workers[worker] = { state: 'takeover', reason };
    return {
      stopped: this.#stopped,
      reason: this.#reason,
      workers,
      staleWorkers: [...this.#stale],
    };
  }

  /**
   * Refuse to go on, if this worker may not.
   *
   * Callers put this at the top of every boundary that spends something: before reading a new
   * page is cheap and harmless, but before a send it is the whole point. A stale check is
   * separate: it does not refuse, it tells the caller to re-read first, because re-reading is
   * something the caller can actually do.
   */
  throwIfHalted(worker) {
    const state = this.stateOf(worker);
    if (state === 'stopped') throw new HaltedError('stopped', this.#reason);
    if (state === 'takeover') throw new HaltedError('takeover', this.#takeover.get(worker));
    if (state === 'paused') throw new HaltedError('paused', this.#paused.get(worker));
    return this;
  }

  /**
   * Wait until this worker may run, or give up.
   *
   * Waits through a pause or a takeover, and returns as soon as the worker is runnable — this
   * is what makes "pause, then continue" work without the caller polling. A stop ends the wait
   * by throwing, so a paused worker does not sit there while the run is over.
   */
  async waitUntilRunnable(worker, { timeoutMs = 300000, pollMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = this.stateOf(worker);
      if (state === 'stopped') throw new HaltedError('stopped', this.#reason);
      if (state === 'running') return this;
      if (Date.now() >= deadline) throw new ControlTimeoutError(worker, timeoutMs);
      await this.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }

  /**
   * Sleep, but not through a stop.
   *
   * @returns `{ interrupted }`. It resolves rather than throwing so cleanup paths that sleep
   *   can finish their work; the caller is responsible for calling `throwIfHalted` at the next
   *   boundary. This is the difference between a stop that takes hold in a second and one that
   *   takes hold after the current cooldown.
   */
  async sleep(ms) {
    if (this.#stopped) return { interrupted: true };
    if (!Number.isFinite(ms) || ms <= 0) return { interrupted: false };
    return new Promise((resolve) => {
      let done = false;
      const finish = (interrupted) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#controller.signal.removeEventListener('abort', onAbort);
        resolve({ interrupted });
      };
      const onAbort = () => finish(true);
      const timer = setTimeout(() => finish(false), ms);
      this.#controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
