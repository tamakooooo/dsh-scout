/**
 * One authorisation for a task, and the account total it spends from.
 *
 * This is the module that makes "authorise once, then act within the range" honest, and the
 * plan is explicit that it is a change to the safety model rather than an efficiency tweak:
 * per-action approval costs one wrong message when it is wrong, while a standing authorisation
 * costs up to its limit.
 *
 * Four things therefore have to be true, and each is a decision here rather than a convention:
 *
 * - **The range is named.** An authorisation covers one account, one posting at one version,
 *   one site configuration at one version, and a named set of action kinds. Nothing is
 *   "whatever else seems similar".
 * - **The limit is enforced before the send, not counted after.** {@link Spend#reserve} is
 *   synchronous and checks the remaining count as part of taking a slot, so two windows
 *   arriving at the last slot cannot both win. Counting afterwards would let both send and
 *   only then discover the total was exceeded.
 * - **It expires and it can be voided.** A changed posting, a changed greeting, an updated
 *   site configuration or a switched account all end it, because every one of those changes
 *   what the person actually agreed to.
 * - **It is recorded.** The authorisation itself is written to the audit file with its range
 *   and time, because "no action outside the authorisation" is not demonstrable otherwise.
 *
 * A slot is given back only for an explicit failure. A send whose outcome is unknown keeps its
 * slot: the person may have been contacted, so freeing the quota would make a repeat look
 * authorised.
 *
 * @module @local/dsh-jev-browser/lib/authorize
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { platformById, platformFile, PLATFORM_IDS } from './platforms.js';
import { dirname, join } from 'node:path';
import { localDir } from './local.js';

/** Kinds of action an authorisation can cover. */export const AUTHORISABLE_ACTIONS = ['greet', 'message', 'apply'];

/** Keys an authorisation may carry. */
export const AUTHORIZATION_KEYS = [
  'id', 'at', 'platform', 'account', 'posting', 'postingVersion', 'siteVersion', 'actions', 'limit', 'expiresAt', 'greetingVersion', 'note',
];

function fail(message) {
  throw new Error(`invalid authorisation: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate an authorisation, or explain why it is not one. */
export function validateAuthorization(authorization) {
  if (!isRecord(authorization)) fail('must be an object');
  for (const key of Object.keys(authorization)) {
    if (!AUTHORIZATION_KEYS.includes(key)) fail(`unknown key ${JSON.stringify(key)}; expected one of ${AUTHORIZATION_KEYS.join(', ')}`);
  }
  for (const key of ['id', 'at', 'platform', 'account', 'posting', 'actions']) {
    if (authorization[key] === undefined) fail(`${key} is required`);
  }
  // An authorisation is for one platform. Without this, a grant made on 智联 would read as a
  // licence on the other three, which is the whole thing the range exists to prevent.
  if (!platformById(authorization.platform)) {
    fail(`platform must be one of ${PLATFORM_IDS.join(', ')}; got ${JSON.stringify(authorization.platform)}`);
  }
  if (typeof authorization.id !== 'string' || authorization.id.trim() === '') fail('id must be a non-empty string');
  if (Number.isNaN(Date.parse(authorization.at))) fail('at must be an ISO 8601 timestamp');
  for (const key of ['account', 'posting']) {
    if (typeof authorization[key] !== 'string' || authorization[key].trim() === '') fail(`${key} must be a non-empty string`);
  }
  if (!Array.isArray(authorization.actions) || authorization.actions.length === 0) {
    fail('actions must name at least one action kind; an authorisation that covers nothing authorises nothing');
  }
  for (const action of authorization.actions) {
    if (!AUTHORISABLE_ACTIONS.includes(action)) fail(`actions contains ${JSON.stringify(action)}; expected one of ${AUTHORISABLE_ACTIONS.join(', ')}`);
  }
  if (!Number.isInteger(authorization.limit) || authorization.limit < 0) {
    fail('limit must be a non-negative integer');
  }
  if (authorization.expiresAt !== undefined && Number.isNaN(Date.parse(authorization.expiresAt))) {
    fail('expiresAt must be an ISO 8601 timestamp when present');
  }
  for (const key of ['postingVersion', 'siteVersion']) {
    const value = authorization[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) fail(`${key} must be a positive integer when present`);
  }
  return authorization;
}

/** Build an authorisation, validated, with its identity and time filled in. */
export function createAuthorization(input = {}) {
  if (!isRecord(input)) fail('the input must be an object');
  // Unknown input is refused rather than dropped. A builder that silently discards what it
  // does not recognise turns a typo into a change of meaning: `expires` instead of `expiresAt`
  // would produce an authorisation with no expiry at all while the caller believes it set one.
  for (const key of Object.keys(input)) {
    if (!AUTHORIZATION_KEYS.includes(key)) fail(`unknown key ${JSON.stringify(key)} in the authorisation being created`);
  }
  const {
    platform, account, posting, postingVersion, siteVersion, actions, limit, expiresAt, greetingVersion, note,
    id, at,
  } = input;
  const authorization = {
    id: id ?? `auth-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    at: at ?? new Date().toISOString(),
    platform,
    account,
    posting,
    postingVersion,
    siteVersion,
    actions,
    limit,
    expiresAt,
    greetingVersion,
    note,
  };
  // A key with an `undefined` value does not survive a JSON round trip, and this object is
  // written to disk and read back, so absent stays absent.
  for (const key of Object.keys(authorization)) {
    if (authorization[key] === undefined) delete authorization[key];
  }
  return validateAuthorization(authorization);
}

/**
 * Does this authorisation still cover this request?
 *
 * Every dimension is checked, and the reason names the one that failed, because "not
 * authorised" with no further detail is what makes people loosen the rule instead of fixing
 * the cause.
 */
export function authorizationCovers(authorization, request = {}, now = new Date()) {
  validateAuthorization(authorization);
  const at = now instanceof Date ? now : new Date(now);
  if (authorization.expiresAt && Date.parse(authorization.expiresAt) <= at.getTime()) {
    return { ok: false, reason: `the authorisation expired at ${authorization.expiresAt}` };
  }
  // Platform first: a request that names a different platform is not covered by this grant, and
  // saying so here keeps the caller from discovering it after the message was sent.
  if (request.platform !== undefined && request.platform !== authorization.platform) {
    return { ok: false, reason: `the authorisation is for ${authorization.platform}, not ${request.platform}` };
  }
  if (request.account !== undefined && request.account !== authorization.account) {
    return { ok: false, reason: `the authorisation is for account ${authorization.account}, not ${request.account}` };
  }
  if (request.posting !== undefined && request.posting !== authorization.posting) {
    return { ok: false, reason: `the authorisation is for posting ${authorization.posting}, not ${request.posting}` };
  }
  if (authorization.postingVersion !== undefined && request.postingVersion !== undefined && request.postingVersion !== authorization.postingVersion) {
    return { ok: false, reason: `the posting has changed since the authorisation (version ${authorization.postingVersion} → ${request.postingVersion})` };
  }
  if (authorization.siteVersion !== undefined && request.siteVersion !== undefined && request.siteVersion !== authorization.siteVersion) {
    return { ok: false, reason: `the site configuration has changed since the authorisation (version ${authorization.siteVersion} → ${request.siteVersion})` };
  }
  if (authorization.greetingVersion !== undefined && request.greetingVersion !== undefined && request.greetingVersion !== authorization.greetingVersion) {
    return { ok: false, reason: 'the greeting text has changed since the authorisation' };
  }
  if (request.action !== undefined && !authorization.actions.includes(request.action)) {
    return { ok: false, reason: `the authorisation covers ${authorization.actions.join(', ')}, not ${request.action}` };
  }
  return { ok: true, reason: '' };
}

/**
 * The account's remaining contact allowance.
 *
 * One instance per plugin, shared by every window, because the limit is the account's rather
 * than a window's. {@link Spend#reserve} is the uncrossable step the plan asks for: it checks
 * and takes a slot without yielding, so the check and the take cannot be separated by another
 * window's send.
 */
export class Spend {
  #limit;
  #spent = 0;
  #slots = new Map();

  constructor({ limit = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error('a spend limit must be a non-negative integer');
    this.#limit = limit;
  }

  get limit() {
    return this.#limit;
  }

  get spent() {
    return this.#spent;
  }

  get remaining() {
    return Math.max(0, this.#limit - this.#spent);
  }

  /** Raise the ceiling, for a person who decided to allow more. */
  setLimit(limit) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error('a spend limit must be a non-negative integer');
    this.#limit = limit;
    return this;
  }

  /**
   * Take a slot, or explain why not.
   *
   * Synchronous on purpose. Everything that could refuse the send is checked here — the
   * authorisation still covering it, and a slot still being available — and the slot is taken
   * in the same step. An async version would let two windows both pass the check and both
   * send, which is exactly the case the plan lists as "the limit reached simultaneously".
   */
  reserve(request = {}, { authorization, now } = {}) {
    if (authorization) {
      const covered = authorizationCovers(authorization, request, now);
      if (!covered.ok) return { ok: false, reason: covered.reason };
    } else {
      return { ok: false, reason: 'no authorisation covers this action' };
    }
    if (this.remaining <= 0) {
      return { ok: false, reason: `the account contact limit of ${this.#limit} has been reached` };
    }
    this.#spent += 1;
    const token = `slot-${this.#spent}`;
    this.#slots.set(token, { ...request, at: new Date().toISOString() });
    return { ok: true, reason: '', token, remaining: this.remaining };
  }

  /**
   * Give a slot back, only for an outcome that is known to have failed.
   *
   * @returns whether the slot was given back. A send whose result is unknown must keep its
   *   slot: the person may have been contacted, and freeing the quota would let the next pass
   *   re-send to someone who is already in a conversation.
   */
  release(token, { outcome } = {}) {
    if (!this.#slots.has(token)) return false;
    if (outcome !== 'failed') return false;
    this.#slots.delete(token);
    this.#spent = Math.max(0, this.#spent - 1);
    return true;
  }

  /** Slots still held, for a post-mortem and for the board. */
  get slots() {
    return [...this.#slots.entries()].map(([token, request]) => ({ token, ...request }));
  }
}

/** Where the authorisation audit lives. */
export function authorisationFile(platform) {
  if (typeof platform !== 'string' || platform.trim() === '') {
    throw new Error(`an authorisation file is per platform: name one of ${PLATFORM_IDS.join(', ')}`);
  }
  if (!platformById(platform)) throw new Error(`unknown platform ${JSON.stringify(platform)}; expected one of ${PLATFORM_IDS.join(', ')}`);
  return join(localDir('records'), platformFile(platform, 'authorizations.jsonl'));
}

/** Append an authorisation to the audit file. This is the record that makes the range provable. */
export async function recordAuthorization(authorization) {
  validateAuthorization(authorization);
  const file = authorisationFile(authorization.platform);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(authorization)}\n`, 'utf8');
  return file;
}

/** Every authorisation on file, in order. An unreadable line throws rather than being skipped. */
export async function readAuthorizations(platform) {
  const files = platform === undefined ? PLATFORM_IDS.map((id) => authorisationFile(id)) : [authorisationFile(platform)];
  const entries = [];
  for (const file of files) {
    const raw = await readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const lines = raw.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === '') continue;
      try {
        entries.push(JSON.parse(line));
      } catch (error) {
        throw new Error(`the authorisation file ${file} has an unreadable line ${index + 1}: ${error.message}`);
      }
    }
  }
  return entries;
}
