/**
 * The plugin's own activity record, for the dashboard to read.
 *
 * Everything here is *observed*, never inferred: an event is appended at the moment the
 * action happened, so the board can say what this plugin did to an account and when. That
 * is the point of keeping it separate from the live frame — pixels show the current
 * moment, and a recruiter asking "what did it actually send, and to whom" needs the list.
 *
 * In memory by design. It describes what this process did, so it should not outlive the
 * process or grow without bound; a durable audit trail is a different feature with a
 * different retention question.
 *
 * @module @local/dsh-jev-browser/lib/journal
 */

/** Activity kinds, each with the fields the board renders. */
export const EVENT_KINDS = ['session', 'action', 'risk', 'confirm', 'grant', 'deny', 'error'];

export class Journal {
  #events = [];
  #runs = [];
  #eventLimit;
  #runLimit;
  #totals = {
    runs: 0,
    steps: 0,
    actionsOk: 0,
    actionsFailed: 0,
    riskStops: 0,
    confirmations: 0,
    grants: 0,
    denies: 0,
    tokensIn: 0,
    tokensOut: 0,
    // Verification outcomes. `unconfirmed` is tracked separately from both success and
    // failure on purpose: it is the state that needs a human, and counting it as either
    // would hide exactly the number this feature exists to drive to zero.
    verified: 0,
    refused: 0,
    unconfirmed: 0,
  };

  /**
   * @param options - `eventLimit` and `runLimit` bound memory; the board reads windows of them.
   */
  constructor({ eventLimit = 300, runLimit = 25 } = {}) {
    this.#eventLimit = eventLimit;
    this.#runLimit = runLimit;
  }

  /**
   * Append one observed event.
   * @param kind - one of {@link EVENT_KINDS}.
   * @param fields - what the board needs to render it.
   */
  record(kind, fields = {}) {
    this.#events.push({ at: Date.now(), kind, ...fields });
    if (this.#events.length > this.#eventLimit) this.#events.splice(0, this.#events.length - this.#eventLimit);
    if (kind === 'risk') this.#totals.riskStops += 1;
    if (kind === 'confirm') this.#totals.confirmations += 1;
    if (kind === 'grant') this.#totals.grants += 1;
    if (kind === 'deny') this.#totals.denies += 1;
  }

  /** Append one finished run. */
  run(entry) {
    this.#runs.unshift({ at: Date.now(), ...entry });
    if (this.#runs.length > this.#runLimit) this.#runs.length = this.#runLimit;
    this.#totals.runs += 1;
    this.#totals.steps += Number(entry.steps) || 0;
    this.#totals.tokensIn += Number(entry.tokensIn) || 0;
    this.#totals.tokensOut += Number(entry.tokensOut) || 0;
  }

  /** Count one verification verdict. */
  countVerification(verdict) {
    if (verdict === 'verified') this.#totals.verified += 1;
    else if (verdict === 'refuted') this.#totals.refused += 1;
    else if (verdict === 'unconfirmed') this.#totals.unconfirmed += 1;
  }

  /** Count one attempted action by whether it worked. */
  countAction(ok) {
    if (ok) this.#totals.actionsOk += 1;
    else this.#totals.actionsFailed += 1;
  }

  /**
   * A bounded window for the board.
   * @param options - `events` and `runs` are how many recent entries to include.
   */
  snapshot({ events = 60, runs = 12 } = {}) {
    return {
      events: this.#events.slice(-events).reverse(),
      runs: this.#runs.slice(0, runs),
      totals: { ...this.#totals },
    };
  }
}
