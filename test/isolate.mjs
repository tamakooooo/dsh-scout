/** Import before plugin modules: registry paths are resolved during module loading. */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_PROFILE = `jev-browser-test-${randomUUID()}`;
const registry = join(tmpdir(), `dsh-jev-browser-launched-${process.env.DSH_PROFILE}.json`);
process.once('exit', () => rmSync(registry, { force: true }));
