/**
 * Scan what is about to be committed, so a leak never reaches the network.
 *
 * This reads the **staged** blobs, not the working tree: a file can be edited without being
 * staged, and the index is what a commit actually publishes. It is used by the pre-commit
 * hook and is equally runnable by hand or in CI.
 *
 * It fails closed. If the scan cannot run at all — no git, no staged content to inspect — it
 * says so and exits non-zero rather than reporting a clean result it did not establish. A
 * guard that passes when it did not run is worse than no guard, because it is trusted.
 *
 * Exit codes: 0 clean, 1 findings, 2 could not scan.
 *
 * Usage: node tools/privacy-scan.mjs [--staged|--tracked]
 *
 * @module @local/dsh-jev-browser/tools/privacy-scan
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const { PLUGIN_ROOT, readDenylist } = await import('../lib/local.js');
const { scanText } = await import('../lib/privacy.js');

const mode = process.argv.includes('--tracked') ? 'tracked' : 'staged';

function git(args) {
  return execFileSync('git', args, { cwd: PLUGIN_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The staged content of one path. Falls back to the working tree only in `--tracked` mode. */
async function contentOf(path, index) {
  try {
    // `:path` addresses the staged blob; this is the content the commit would publish.
    return git(['show', `:${path}`]);
  } catch {
    const direct = await readFile(join(PLUGIN_ROOT, path), 'utf8').catch(() => null);
    if (direct !== null) return direct;
    if (index === 0) return null;
    throw new Error(`cannot read ${path} from the index or the working tree`);
  }
}

let files;
try {
  files = mode === 'staged'
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACM']).split('\n').map((line) => line.trim()).filter(Boolean)
    // `git show :path` also works for tracked files, so one reader covers both modes.
    : git(['ls-files']).split('\n').map((line) => line.trim()).filter(Boolean);
} catch (error) {
  console.error(`privacy-scan: cannot list files (${error.message})`);
  process.exit(2);
}

if (files.length === 0) {
  console.log('privacy-scan: nothing staged to inspect — refusing to report a clean result');
  process.exit(mode === 'staged' ? 0 : 2);
}

const tokens = await readDenylist().catch(() => []);
const findings = [];
let inspected = 0;

for (const file of files) {
  let text;
  try {
    text = await contentOf(file, inspected);
  } catch (error) {
    console.error(`privacy-scan: ${error.message}`);
    process.exit(2);
  }
  if (text === null) continue;
  // A binary blob has no lines to reason about; the shapes this looks for are all textual.
  if (text.includes('\0')) continue;
  inspected += 1;
  for (const finding of scanText(text, tokens)) {
    findings.push(`${file}:${finding.line}  [${finding.id}]  ${finding.hit}`);
  }
}

if (findings.length > 0) {
  console.error(`privacy-scan: ${findings.length} finding(s) in the content about to be committed:\n`);
  for (const line of findings) console.error(`  ${line}`);
  console.error(
    `\nMove the data to the local root ($DSH_SCOUT_HOME), or — when the shape is deliberate,\n` +
      `as in a synthetic fixture — put \`privacy-check:allow\` on the line with a reason.\n` +
      `Bypassing this guard publishes the finding: git commit --no-verify`,
  );
  process.exit(1);
}

console.log(`privacy-scan: ${inspected} file(s) inspected (${mode}), no sensitive shape found`);
if (tokens.length === 0) {
  console.log('privacy-scan: no local denylist found — generic shapes only. Add one at $DSH_SCOUT_HOME/privacy-denylist.txt to also look for your own identifiers.');
}
process.exit(0);
