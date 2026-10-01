/**
 * The record of who was contacted, and what is known about how it went.
 *
 * Two things make this more than a log.
 *
 * **It prevents a second greeting.** A record is written *before* the action runs, as an
 * intent, and updated after it with what the page showed. A candidate whose latest record is
 * an unresolved intent, a confirmed send, or an executed-but-unverified one is therefore
 * skipped by the next pass — including after a restart, which is exactly when an in-memory
 * guard would have forgotten. Only an explicit failure leaves the candidate retryable.
 *
 * **It distinguishes "done" from "believed done".** A click that landed is not a conversation
 * that started, so the status is one of four, and the plan's rule that an unresolved result is
 * never re-sent hangs off that distinction rather than off a boolean.
 *
 * The store is append-only JSONL under the local data root, which keeps three properties that
 * matter here: a partial write costs one line rather than the file, the history of what was
 * believed at the time survives a later correction, and nobody needs a schema migration to add
 * a field.
 *
 * @module @local/dsh-jev-browser/lib/records
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { platformFile } from './platforms.js';
import { dirname, join } from 'node:path';
import { localDir } from './local.js';

/** What is known about a contact attempt. */
export const RECORD_STATUSES = ['pending', 'executed_unverified', 'confirmed', 'failed'];

/** Kinds of line in the file: an intention, or the outcome of one. */
export const RECORD_KINDS = ['intent', 'result'];

/** Fields every line carries. */
const REQUIRED = ['at', 'kind', 'posting', 'account', 'identity', 'action', 'status'];

/** Fields a line may carry. Closed, because a typo here silently stops matching. */
const ALLOWED = [...REQUIRED, 'name', 'url', 'greetingVersion', 'evidence', 'window'];

/** A status that means the next pass must not send to this candidate again. */
const SETTLED = new Set(['pending', 'executed_unverified', 'confirmed']);

function fail(message) {
  throw new Error(`invalid record entry: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate one line, or explain why it cannot be written. */
export function validateEntry(entry) {
  if (!isRecord(entry)) fail('must be an object');
  for (const key of Object.keys(entry)) {
    if (!ALLOWED.includes(key)) fail(`unknown key ${JSON.stringify(key)}; expected one of ${ALLOWED.join(', ')}`);
  }
  for (const key of REQUIRED) {
    if (typeof entry[key] !== 'string' || entry[key].trim() === '') fail(`${key} must be a non-empty string`);
  }
  if (Number.isNaN(Date.parse(entry.at))) fail('at must be an ISO 8601 timestamp');
  if (!RECORD_KINDS.includes(entry.kind)) fail(`kind must be one of ${RECORD_KINDS.join(', ')}`);
  if (!RECORD_STATUSES.includes(entry.status)) fail(`status must be one of ${RECORD_STATUSES.join(', ')}`);
  // An intention cannot be written as already done: that is how a crash between the intent and
  // the action would turn into a silent claim that the action happened.
  if (entry.kind === 'intent' && entry.status !== 'pending') {
    fail(`an intent must be pending, not ${entry.status}`);
  }
  if (entry.kind === 'result' && entry.status === 'pending') {
    fail('a result cannot be pending; an unresolved outcome stays an intent until it settles');
  }
  return entry;
}

/**
 * Where a record lives, and the single writer that keeps concurrent appends from interleaving.
 *
 * The chain matters because several windows write here at once. A line is small enough that
 * `O_APPEND` makes one write atomic on POSIX, but two `appendFile` calls racing on the same
 * handle is not something to leave to chance when the line decides whether someone gets
 * greeted twice.
 */
export class Records {
  #file;
  #chain = Promise.resolve();

  constructor({ file, platform } = {}) {
    if (file) {
      this.#file = file;
    } else {
      // No shared bucket: the same person on two platforms is two contacts, and one platform's
      // history is not evidence about another's.
      if (typeof platform !== 'string' || platform.trim() === '') {
        throw new Error('a records store must be scoped to a platform: pass platform, or an explicit file');
      }
      this.#file = join(localDir('records'), platformFile(platform, 'contacts.jsonl'));
    }
  }

  get file() {
    return this.#file;
  }

  /** Append one line, after everything already queued. */
  async append(entry) {
    validateEntry(entry);
    const line = `${JSON.stringify(entry)}\n`;
    this.#chain = this.#chain.then(async () => {
      await mkdir(dirname(this.#file), { recursive: true });
      // A write failure must surface: the caller has to stop the action it was about to take,
      // not proceed with a record that is not there.
      await appendFile(this.#file, line, 'utf8');
    });
    return this.#chain;
  }

  /**
   * Every line, in order.
   *
   * @throws on a line that will not parse, naming it. Silently skipping one would make a
   *   candidate look never-contacted, which is the failure this store exists to prevent.
   */
  async readAll() {
    const raw = await readFile(this.#file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const entries = [];
    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === '') continue;
      try {
        entries.push(JSON.parse(line));
      } catch (error) {
        throw new Error(`the record file ${this.#file} has an unreadable line ${index + 1}: ${error.message}`);
      }
    }
    return entries;
  }

  /**
   * The one table the board shows: the latest known state of each candidate.
   *
   * Keyed by `account` and `identity`, because the same person approached on two accounts is
   * two conversations, and an identity alone can collide across sites.
   */
  async summarise() {
    const entries = await this.readAll();
    const byKey = new Map();
    for (const entry of entries) {
      const key = `${entry.account}\u0000${entry.identity}`;
      const current = byKey.get(key);
      if (!current) {
        byKey.set(key, { ...entry, attempts: 1, firstAt: entry.at, lastAt: entry.at });
        continue;
      }
      current.attempts += 1;
      current.lastAt = entry.at;
      // The newest line wins for status, but nothing that was ever known is cleared: a name
      // seen once stays, so a later line that omits it does not erase the record.
      for (const field of ALLOWED) {
        if (entry[field] !== undefined && entry[field] !== '') current[field] = entry[field];
      }
    }
    return [...byKey.values()].sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));
  }

  /**
   * Whether the next pass may contact this candidate.
   *
   * @returns `{ skip, reason, status }`. A settled status skips; anything else may proceed.
   *   This is the rule that survives a restart, and the reason the intent is written first.
   */
  async decide(identity, { account, action } = {}) {
    if (typeof identity !== 'string' || identity.trim() === '') {
      // An empty identity cannot be deduplicated. Sending anyway is how the same person is
      // greeted twice, so the answer is no and the caller is told why.
      return { skip: true, reason: 'the candidate has no stable identity, so a repeat cannot be ruled out', status: '' };
    }
    const relevant = (await this.summarise()).filter(
      (entry) => entry.identity === identity && (account === undefined || entry.account === account) && (action === undefined || entry.action === action),
    );
    if (relevant.length === 0) return { skip: false, reason: 'no record for this candidate', status: '' };
    const latest = relevant[relevant.length - 1];
    if (SETTLED.has(latest.status)) {
      const reason =
        latest.status === 'confirmed'
          ? 'already contacted and the page confirmed it'
          : latest.status === 'executed_unverified'
            ? 'already contacted and the result was never confirmed; not re-sent automatically'
            : 'an earlier attempt was recorded but its outcome is unknown; resolve it before sending again';
      return { skip: true, reason, status: latest.status };
    }
    return { skip: false, reason: `the last attempt is recorded as ${latest.status}`, status: latest.status };
  }
}
