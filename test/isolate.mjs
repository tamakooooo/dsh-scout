/** Import before plugin modules: registry paths are resolved during module loading. */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_PROFILE = `jev-browser-test-${randomUUID()}`;
// The local data root is redirected too: a test must never read or write the real one, which
// holds the logged-in profile and the user's records.
process.env.DSH_SCOUT_HOME = join(tmpdir(), `dsh-scout-test-${process.env.DSH_PROFILE}`);
const registry = join(tmpdir(), `dsh-jev-browser-launched-${process.env.DSH_PROFILE}.json`);
process.once('exit', () => rmSync(registry, { force: true }));
