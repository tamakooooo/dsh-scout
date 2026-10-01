/**
 * Windows, and the queue they share.
 *
 * Two windows working a list have exactly one hard problem: not doing the same person twice.
 * Everything else here exists to keep that true while the work runs concurrently.
 *
 * - The **claim is synchronous** and happens before any await. A claim taken across an await
 *   is a race by construction, and the plan asks for claiming, reserving quota and writing the
 *   intent to be one uncrossable operation; in a single process, a synchronous step is
 *   uncrossable.
 * - A **claim is not the guard**. The in-memory claim stops two windows in this process from
 *   colliding, and the record stops a second run — including after a restart — from greeting
 *   someone again. Neither substitutes for the other, so both are kept.
 * - Each **window owns its session**. A worker reads and acts only through its own session, so
 *   one window switching tabs or recovering a closed tab cannot move the other's page.
 *
 * Two workers is the default in the plan, not a limit: the parameter is exposed, and the
 * measured advice is to raise it only after real-site testing shows a gain.
 *
 * @module @local/dsh-jev-browser/lib/workers
 */

import { HaltedError } from './control.js';

/** The states the board shows for a window. */
export const WINDOW_STATES = ['idle', 'working', 'paused', 'takeover', 'stopped', 'failed'];

/**
 * The shared list.
 *
 * Items are keyed by identity, because identity is what deduplication keys on everywhere else.
 * An item without one cannot be claimed: there would be no way to tell whether it had already
 * been handed out.
 */
export class WorkQueue {
  #pending = [];
  #claims = new Map();
  #settled = [];
  #skipped = [];

  constructor(items = []) {
    this.#pending = items.map((item, index) => ({ item, index }));
  }

  get size() {
    return this.#pending.length + this.#claims.size;
  }

  get stats() {
    return {
      pending: this.#pending.length,
      claimed: this.#claims.size,
      settled: this.#settled.length,
      skipped: this.#skipped.length,
    };
  }

  /** Who holds what, for the board and for a post-mortem. */
  get claims() {
    return [...this.#claims.entries()].map(([identity, claim]) => ({ identity, ...claim }));
  }

  /**
   * Take the next item for a worker.
   *
   * Synchronous on purpose: the claim and the bookkeeping that makes it exclusive are one
   * step, so no other worker can observe the item as free in between.
   *
   * @returns the item, or `null` when nothing is left. An item that cannot be identified is
   *   skipped and reported rather than claimed, because handing it out would risk repeating it.
   */
  claim(worker) {
    while (this.#pending.length > 0) {
      const next = this.#pending.shift();
      const identity = next.item?.identity;
      if (typeof identity !== 'string' || identity.trim() === '') {
        this.#skipped.push({ index: next.index, reason: 'the item has no stable identity, so a repeat cannot be ruled out' });
        continue;
      }
      if (this.#claims.has(identity)) continue; // already out; should not happen, but never hand it out twice
      this.#claims.set(identity, { worker, at: new Date().toISOString() });
      return next.item;
    }
    return null;
  }

  /** The worker is done with this item; it will not be handed out again. */
  settle(identity) {
    const claim = this.#claims.get(identity);
    if (!claim) return false;
    this.#claims.delete(identity);
    this.#settled.push({ identity, worker: claim.worker, at: new Date().toISOString() });
    return true;
  }

  /** Give the item back, for a case that could not be completed and should be retried. */
  release(identity) {
    const claim = this.#claims.get(identity);
    if (!claim) return false;
    this.#claims.delete(identity);
    this.#pending.push({ item: { identity }, index: -1 });
    return true;
  }

  /** Items that were never claimable, with the reason. */
  get skipped() {
    return [...this.#skipped];
  }
}

/**
 * The windows a run uses, each with a session of its own.
 *
 * Names are fixed (`w1`, `w2`, …) so a window keeps its identity across a pause or a recovery;
 * a run that minted new sessions on every step would never be able to say "window 2 is on this
 * candidate".
 */
export class Windows {
  #sessions;
  #control;
  #workers = new Map();
  #failed = new Map();

  constructor({ sessions, control, count = 2 } = {}) {
    if (!sessions) throw new Error('windows need a session manager');
    if (!Number.isInteger(count) || count < 1) throw new Error('a run needs at least one window');
    this.#sessions = sessions;
    this.#control = control ?? null;
    this.names = Array.from({ length: count }, (_, i) => `w${i + 1}`);
  }

  /** Open every window, or report which one could not be opened. */
  async open({ headless } = {}) {
    const results = [];
    for (const name of this.names) {
      try {
        const session = await this.#sessions.ensure(name, { headless });
        this.#workers.set(name, { name, session, targetId: session.targetId, state: 'idle', candidate: '', done: 0, failed: 0 });
        results.push({ name, ok: true, targetId: session.targetId });
      } catch (error) {
        this.#failed.set(name, error.message);
        results.push({ name, ok: false, error: error.message });
      }
    }
    return results;
  }

  get workers() {
    return this.names.map((name) => {
      const worker = this.#workers.get(name);
      if (worker) {
        // A halt outranks whatever the worker was doing, so the board never says "working"
        // about a window that is stopped or being driven by a person.
        const halt = this.#control ? this.#control.stateOf(name) : 'running';
        const state = halt === 'running' ? worker.state : halt;
        return { ...worker, session: undefined, state };
      }
      return { name, state: 'failed', error: this.#failed.get(name) ?? 'not opened', done: 0, failed: 0, candidate: '', targetId: '' };
    });
  }

  /** The worker record for one name, for the code that drives it. */
  get(name) {
    const worker = this.#workers.get(name);
    if (!worker) throw new Error(`window ${name} is not open`);
    return worker;
  }

  /** The session this window uses. Throws rather than falling back to another window's. */
  sessionFor(name) {
    return this.get(name).session;
  }

  /** Record what a window is doing, so the board can show it. */
  setState(name, state, candidate = undefined) {
    const worker = this.get(name);
    if (!WINDOW_STATES.includes(state)) throw new Error(`unknown window state ${JSON.stringify(state)}`);
    worker.state = state;
    if (candidate !== undefined) worker.candidate = candidate;
    return worker;
  }

  /** Refuse to start another unit of work on a window that may not run. */
  throwIfHalted(name) {
    if (this.#control) this.#control.throwIfHalted(name);
    return this;
  }

  /**
   * Run one function per window, concurrently.
   *
   * The whole point of the module: the windows overlap in time. A failure in one is recorded
   * against that window and does not end the others, which is what the plan asks for when it
   * says closing one window must not end another.
   */
  async each(fn) {
    return Promise.all(
      this.names.map(async (name) => {
        if (!this.#workers.has(name)) return { name, ok: false, error: this.#failed.get(name) ?? 'not opened' };
        try {
          const value = await fn(name, this.get(name));
          return { name, ok: true, value };
        } catch (error) {
          const worker = this.get(name);
          worker.state = error instanceof HaltedError ? this.#control?.stateOf(name) ?? 'paused' : 'failed';
          worker.failed += 1;
          return { name, ok: false, error: error.message, halted: error instanceof HaltedError };
        }
      }),
    );
  }

  /**
   * Close the windows this run opened.
   *
   * A window that ends must not end the shared browser, which the plan says explicitly: the
   * other windows, and the person who is logged in, are still using it.
   */
  async close() {
    const closed = [];
    for (const name of this.names) {
      if (!this.#workers.has(name)) continue;
      await this.#sessions.close(name).catch(() => {});
      closed.push(name);
    }
    return closed;
  }
}
