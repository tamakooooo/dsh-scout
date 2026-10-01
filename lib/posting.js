/**
 * Job configuration, and the rules that decide whether a candidate fits it.
 *
 * The plan splits configuration in two on purpose: a **site configuration** says how to read
 * and operate a page, and a **posting** says which people are wanted. Keeping them apart is
 * what lets the same posting run against a different site, and the same site rules serve a
 * different posting.
 *
 * The rules here are deliberately plain and run before any model is consulted:
 *
 * - `exclude` labels a candidate as unsuitable on an explicit condition. It runs first and
 *   costs nothing, which is the point — most of a candidate list can be dismissed by the
 *   facts on its own card.
 * - `must` is the requirement set. **A condition that cannot be evaluated is not a pass.**
 *   If the page does not show the field, the verdict is `unverified`, with the field named,
 *   and never a guess: the whole recruiting flow rests on not inventing what a candidate
 *   did not say.
 * - `prefer` records a positive signal. It appears in the reasons and never decides anything
 *   on its own, so a preference cannot quietly become a requirement.
 *
 * Deciding what to do about `unverified` — read the detail page, ask a model, or ask a person —
 * belongs to the caller, not here.
 *
 * @module @local/dsh-jev-browser/lib/posting
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localDir } from './local.js';

/** Keys a posting may carry. Anything else is a mistake. */
export const POSTING_KEYS = ['version', 'id', 'title', 'description', 'must', 'prefer', 'exclude', 'greeting', 'limits'];

/** The comparison vocabulary. Closed, so an unusable posting fails at validation, not at matching. */
export const CONDITION_OPS = ['equals', 'contains', 'in', 'not_in', 'matches', 'at_least', 'at_most', 'exists'];

/** Verdicts. `unverified` exists so that "we could not tell" is never rounded to a yes or a no. */
export const VERDICTS = ['match', 'no', 'unverified'];

const RULE_KEYS = ['field', 'op', 'value'];

function fail(path, message) {
  throw new Error(`invalid posting at ${path}: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkRule(rule, path) {
  if (!isRecord(rule)) fail(path, 'must be an object');
  for (const key of Object.keys(rule)) {
    if (!RULE_KEYS.includes(key)) fail(`${path}.${key}`, `unknown key; expected one of ${RULE_KEYS.join(', ')}`);
  }
  if (typeof rule.field !== 'string' || rule.field.trim() === '') fail(`${path}.field`, 'must be a non-empty field name');
  if (!CONDITION_OPS.includes(rule.op)) fail(`${path}.op`, `must be one of ${CONDITION_OPS.join(', ')}`);
  if (rule.op === 'exists') {
    if (rule.value !== undefined && typeof rule.value !== 'boolean') fail(`${path}.value`, 'must be a boolean for the exists operator');
    return;
  }
  if (rule.value === undefined) fail(`${path}.value`, `is required for the ${rule.op} operator`);
  if (rule.op === 'in' || rule.op === 'not_in') {
    if (!Array.isArray(rule.value) || rule.value.length === 0) fail(`${path}.value`, `must be a non-empty array for ${rule.op}`);
  } else if (rule.op === 'at_least' || rule.op === 'at_most') {
    if (typeof rule.value !== 'number' || !Number.isFinite(rule.value)) fail(`${path}.value`, `must be a finite number for ${rule.op}`);
  } else if (typeof rule.value !== 'string' || rule.value === '') {
    fail(`${path}.value`, `must be a non-empty string for ${rule.op}`);
  }
  if (rule.op === 'matches') {
    try {
      new RegExp(rule.value);
    } catch {
      fail(`${path}.value`, 'is not a valid regular expression');
    }
  }
}

/**
 * Validate a posting, or explain precisely why it is not one.
 *
 * @throws with the path that failed, because a posting is usually written by a person
 *   describing a job and the message is the only thing telling them what to change.
 */
export function validatePosting(posting) {
  if (!isRecord(posting)) fail('<root>', 'must be an object');
  for (const key of Object.keys(posting)) {
    if (!POSTING_KEYS.includes(key)) fail(key, `unknown key; expected one of ${POSTING_KEYS.join(', ')}`);
  }
  if (!Number.isInteger(posting.version) || posting.version < 1) fail('version', 'must be a positive integer');
  for (const key of ['id', 'title']) {
    if (typeof posting[key] !== 'string' || posting[key].trim() === '') fail(key, 'must be a non-empty string');
  }
  if (posting.description !== undefined && typeof posting.description !== 'string') fail('description', 'must be a string');
  if (posting.greeting !== undefined && (typeof posting.greeting !== 'string' || posting.greeting.trim() === '')) {
    fail('greeting', 'must be a non-empty string when present');
  }
  for (const key of ['must', 'prefer', 'exclude']) {
    if (posting[key] === undefined) continue;
    if (!Array.isArray(posting[key])) fail(key, 'must be an array');
    posting[key].forEach((rule, i) => checkRule(rule, `${key}[${i}]`));
  }
  if (!Array.isArray(posting.must) || posting.must.length === 0) {
    fail('must', 'must carry at least one requirement; a posting with no requirements matches everyone');
  }
  if (posting.limits !== undefined) {
    if (!isRecord(posting.limits)) fail('limits', 'must be an object');
    for (const key of Object.keys(posting.limits)) {
      if (key !== 'contacts' && key !== 'windows') fail(`limits.${key}`, 'unknown limit; expected contacts or windows');
    }
    for (const key of ['contacts', 'windows']) {
      const value = posting.limits[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0) fail(`limits.${key}`, 'must be a non-negative integer');
    }
  }
  return posting;
}

/** A file name for one posting. */
export function postingFileName(posting) {
  const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unnamed';
  return `${slug(posting.id)}.json`;
}

/** Read a saved posting, or `null` when none is saved. A malformed file throws. */
export async function loadPosting({ id } = {}) {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('a posting id is required to load a posting');
  const path = join(localDir('postings'), postingFileName({ id }));
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`the saved posting at ${path} is not valid JSON: ${error.message}`);
  }
  return validatePosting(parsed);
}

/** Write a posting, validated first, atomically. */
export async function savePosting(posting) {
  validatePosting(posting);
  const directory = localDir('postings');
  await mkdir(directory, { recursive: true });
  const path = join(directory, postingFileName(posting));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(posting, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
  return path;
}

/** Every saved posting, by id. A file that will not parse is reported rather than skipped. */
export async function listPostings() {
  const directory = localDir('postings');
  const files = await readdir(directory).catch(() => []);
  const postings = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const parsed = await loadPosting({ id: file.replace(/\.json$/, '') }).catch((error) => ({ error: error.message }));
    postings.push(parsed?.error ? { id: file.replace(/\.json$/, ''), error: parsed.error } : { id: parsed.id, title: parsed.title });
  }
  return postings;
}

/** The first number in a value, so "5年" and "5" both read as five. */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = /-?\d+(?:\.\d+)?/.exec(String(value ?? ''));
  return match ? Number(match[0]) : null;
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Evaluate one rule against one candidate.
 *
 * @returns `'pass'`, `'fail'`, or `'unknown'`. **`null` is unknown, never a fail** — a
 *   candidate whose card does not show a field has not failed the requirement, and treating
 *   it as a fail would silently drop people the page simply did not describe.
 */
export function evaluateRule(rule, candidate) {
  const fields = candidate?.fields ?? {};
  const known = Object.prototype.hasOwnProperty.call(fields, rule.field) ? fields[rule.field] : null;
  const value = known === undefined ? null : known;

  if (rule.op === 'exists') {
    const present = value !== null && value !== '';
    return present === (rule.value !== false) ? 'pass' : 'fail';
  }
  if (value === null || value === '') return 'unknown';

  const actual = normalize(value);
  switch (rule.op) {
    case 'equals':
      return actual === normalize(rule.value) ? 'pass' : 'fail';
    case 'contains':
      return actual.includes(normalize(rule.value)) ? 'pass' : 'fail';
    case 'in':
      return rule.value.some((option) => normalize(option) === actual) ? 'pass' : 'fail';
    case 'not_in':
      return rule.value.some((option) => normalize(option) === actual) ? 'fail' : 'pass';
    case 'matches':
      return new RegExp(rule.value, 'i').test(String(value)) ? 'pass' : 'fail';
    case 'at_least':
    case 'at_most': {
      const number = toNumber(value);
      if (number === null) return 'unknown';
      return rule.op === 'at_least' ? (number >= rule.value ? 'pass' : 'fail') : (number <= rule.value ? 'pass' : 'fail');
    }
    default:
      return 'unknown';
  }
}

/**
 * Decide whether a candidate fits a posting, from the rules alone.
 *
 * @param candidate - `{ identity, fields }` as `readCandidates` returns them, where a field is
 *   `null` when the page did not show it.
 * @returns `{ verdict, reasons, unknownFields }`. The caller decides what to do about an
 *   `unverified` verdict; this function never asks a model and never reads a page.
 */
export function evaluateCandidate(candidate, posting) {
  validatePosting(posting);
  const reasons = [];
  const unknownFields = [];

  // Exclusion first: it is free, and it is the reason most of a list never needs a model.
  for (const rule of posting.exclude ?? []) {
    const result = evaluateRule(rule, candidate);
    if (result === 'pass') {
      reasons.push({ kind: 'exclude', field: rule.field, op: rule.op, result: 'fail', detail: `excluded by ${rule.field}` });
      return { verdict: 'no', reasons, unknownFields };
    }
  }

  let unmet = false;
  let unverified = false;
  for (const rule of posting.must) {
    const result = evaluateRule(rule, candidate);
    if (result === 'unknown') {
      unverified = true;
      if (!unknownFields.includes(rule.field)) unknownFields.push(rule.field);
    } else if (result === 'fail') {
      unmet = true;
    }
    reasons.push({ kind: 'must', field: rule.field, op: rule.op, result, detail: `${rule.field} ${rule.op}` });
  }

  for (const rule of posting.prefer ?? []) {
    const result = evaluateRule(rule, candidate);
    if (result === 'pass') reasons.push({ kind: 'prefer', field: rule.field, op: rule.op, result, detail: `prefers ${rule.field}` });
  }

  // A failed requirement is decisive; an unevaluable one is not a failure but is not a match
  // either, so it becomes `unverified` and carries the fields that would settle it.
  if (unmet) return { verdict: 'no', reasons, unknownFields };
  if (unverified) return { verdict: 'unverified', reasons, unknownFields };
  return { verdict: 'match', reasons, unknownFields };
}
