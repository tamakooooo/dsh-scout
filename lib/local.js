/**
 * The local data root: everything that is the user's, and nothing that is the repo's.
 *
 * This plugin keeps two kinds of state in two kinds of place, and the split is the whole
 * point of this module:
 *
 * - **Mechanism** — code, schemas, synthetic fixtures — belongs in the repository, which is
 *   public. It must run for a stranger who clones it, with no local data at all.
 * - **Data** — the logged-in Chrome profile, learned site rules, job configuration, candidate
 *   records — belongs under one local root that is never committed.
 *
 * The split has to be enforced, not documented, because the failure is silent and
 * irreversible: a real candidate name or a live quota number committed once cannot be
 * un-published. Two guards do that work here:
 *
 * - {@link safeJoin} refuses names that escape their directory. Those names can come from a
 *   model or from page content, so traversal is a real input, not a hypothetical one.
 * - {@link assertOutsideRepo} refuses to place data inside the plugin's own tree. Pointing
 *   `DSH_SCOUT_HOME` at the repository would otherwise put the user's data exactly where it
 *   gets published.
 *
 * There is deliberately no escape hatch on the second one. A test that needs a writable root
 * uses a temporary directory, which is what {@link localRoot}'s override is for.
 *
 * @module @local/dsh-jev-browser/lib/local
 */

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expandHome } from './paths.js';

/** The plugin's own tree — the part that is published, and so the part data must avoid. */
export const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * The directories under the local root. Each one holds a different kind of the user's data,
 * which is what makes "delete my records but keep my login" a statement anyone can act on.
 */
export const KINDS = ['profile', 'postings', 'sites', 'records', 'samples'];

/** Where the framework keeps per-user state, following the convention `lib/managed.js` uses. */
function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return configured === '' ? join(homedir(), '.dsh') : expandHome(configured);
}

/**
 * The local root.
 *
 * `DSH_SCOUT_HOME` wins so a test or a second profile can redirect the whole tree in one
 * variable; otherwise it sits under the harness home, beside every other plugin's data.
 */
export function localRoot() {
  const override = typeof process.env.DSH_SCOUT_HOME === 'string' ? process.env.DSH_SCOUT_HOME.trim() : '';
  return override === '' ? join(dshHome(), 'dsh-scout') : expandHome(override);
}

/** True when `child` is `parent` or sits beneath it. Both sides are resolved first. */
export function isInside(child, parent) {
  const from = resolve(parent);
  const to = resolve(child);
  if (from === to) return true;
  const step = relative(from, to);
  return step !== '' && !step.startsWith('..') && !isAbsolute(step);
}

/**
 * Refuse a name that would escape its directory.
 *
 * Rejects absolute paths, any `..` segment, an empty name, and a NUL byte. The returned value
 * is the single path segment, unchanged.
 */
export function safeName(name) {
  const value = String(name ?? '');
  if (value.trim() === '') throw new Error('a local data name must not be empty');
  if (value.includes('\0')) throw new Error('a local data name must not contain a NUL byte');
  if (isAbsolute(value)) throw new Error(`a local data name must be relative, not ${value}`);
  if (value.split(/[/\\]/).includes('..')) throw new Error(`a local data name must not traverse upwards: ${value}`);
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`a local data name must be a single path segment, not ${value}`);
  }
  return value;
}

/** One of the kind directories. Throws on an unknown kind rather than inventing a new one. */
export function localDir(kind) {
  if (!KINDS.includes(kind)) throw new Error(`unknown local data kind ${JSON.stringify(kind)}; expected one of ${KINDS.join(', ')}`);
  return join(localRoot(), kind);
}

/**
 * Refuse to place data inside the plugin's own tree.
 *
 * This is the guard that makes the mechanism/data split enforced rather than advisory.
 */
export function assertOutsideRepo(target) {
  if (isInside(target, PLUGIN_ROOT)) {
    throw new Error(
      `refusing to keep data at ${target}: it is inside the plugin tree (${PLUGIN_ROOT}), which is what gets published. ` +
        'Point DSH_SCOUT_HOME somewhere else.',
    );
  }
  return target;
}

/** A path for a named file inside one kind directory. */
export function localPath(kind, name) {
  return assertOutsideRepo(join(localDir(kind), safeName(name)));
}

/** A path for a file directly in the local root, such as the privacy denylist. */
export function localFile(name) {
  return assertOutsideRepo(join(localRoot(), safeName(name)));
}

/** The file that names this user's own identifiers, so a public check can still look for them. */
export const DENYLIST_FILE = 'privacy-denylist.txt';

/** Read the local denylist, one token per line. An absent file is not an error. */
export async function readDenylist() {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(localFile(DENYLIST_FILE), 'utf8').catch(() => '');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** True when `target` is safe to write as local data. Exposed for callers that already have one. */
export function isLocalDataPath(target) {
  return !isInside(target, PLUGIN_ROOT);
}

/** The path separator, re-exported so callers need not import `node:path` for one constant. */
export { sep };
