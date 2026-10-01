/**
 * Path helpers shared by the browser layer and the managed-browser installer.
 *
 * This exists as its own module to keep the dependency graph acyclic: the installer
 * needs `~` expansion, and the browser layer needs the installer to find a managed
 * binary, so the shared helper cannot live in either one.
 *
 * @module @local/dsh-jev-browser/lib/paths
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Expand a leading `~` so a configured path can be written the usual way. */
export function expandHome(input) {
  const value = String(input ?? '').trim();
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}
