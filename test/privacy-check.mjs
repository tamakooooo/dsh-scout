/**
 * What must never be published, and the guards that keep it local.
 *
 * Two things are checked here, and they belong together because they fail the same way — a
 * real name or a live account number reaching a public repository is silent and cannot be
 * undone.
 *
 * 1. The local-data guards in `lib/local.js`: a name cannot escape its directory, and data
 *    cannot be placed inside the tree that gets published.
 * 2. A scan of every **git-tracked** file for the shapes that leak identity. The scanner is
 *    tested against synthetic leaks first, so a clean result means the scanner works rather
 *    than that it looked at nothing.
 *
 * The pattern list is public and generic; this user's own identifiers live in a local file
 * (`$DSH_SCOUT_HOME/privacy-denylist.txt`) that is read only if it exists. That split is the
 * point: the mechanism can be published, the identifiers cannot.
 *
 * Run: node test/privacy-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  KINDS, PLUGIN_ROOT, DENYLIST_FILE, localRoot, localDir, localPath, localFile,
  safeName, isInside, assertOutsideRepo, isLocalDataPath, readDenylist,
} = await import('../lib/local.js');
const { scanText, sanitizeText, ALLOW_MARKER, SHAPES } = await import('../lib/privacy.js');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`);
  }
}

// The samples are assembled at runtime rather than written literally. A file that contains the
// shapes it looks for cannot be scanned by its own scanner — which is how a real name and a real
// job title ended up published in this repository once. Parts, never literals. Module scope, so
// every section can use them.
const parts = {
  key: 'sk-' + 'a'.repeat(24),
  github: 'gho_' + 'A'.repeat(24),
  bearer: 'Bearer ' + 'x'.repeat(24),
  macHome: '/Users/' + 'someone' + '/.dsh/profile',
  linuxHome: '/home/' + 'someone' + '/data',
  email: 'recruiter' + '@' + 'example-corp.com',
  phone: '13800' + '001111',
  quota: '今日推荐人才剩：' + '聊天' + '配额 500',
};

// ── 1. the scanner must catch synthetic leaks ────────────────────────────────
console.log('=== the scanner catches what it is for ===');
{
  const planted = [
    ['provider key', `const key = "${parts.key}";`],
    ['github token', `Authorization: token ${parts.github}`],
    ['bearer token', `headers: { Authorization: "${parts.bearer}" }`],
    ['home directory path', `profileDir: "${parts.macHome}"`],
    ['linux home path', `path: "${parts.linuxHome}"`],
    ['email address', `contact: ${parts.email}`],
    ['chinese mobile number', `phone: ${parts.phone}`],
    ['console usage phrase', parts.quota],
  ];
  for (const [label, line] of planted) {
    const found = scanText(line);
    check(`catches ${label}`, found.length > 0, found.length === 0 ? 'nothing was reported' : '');
  }

  check('the pattern list covers the documented shapes', SHAPES.length >= 5);

  const clean = [
    'const dir = join(localRoot(), "records");',
    'The profile lives under the local root, never in the repository.',
    'test/fixtures/state-marks.html uses synthetic card markup.',
    'Answered in 0.83 seconds with 21 input tokens.',
  ];
  for (const line of clean) {
    check(`leaves ordinary code alone: ${line.slice(0, 34)}…`, scanText(line).length === 0, JSON.stringify(scanText(line)));
  }

  check('the allow marker exempts a line', scanText(parts.quota + ' // privacy-check:allow').length === 0);
  check('a local token is caught when supplied', scanText('候选人 张三', ['张三']).length === 1);
  check('an empty local token never matches', scanText('anything', ['']).length === 0);
}

// ── 1b. the sanitiser turns a real page into a publishable one ───────────────
console.log('\n=== the sanitiser ===');
{
  // Generic placeholders only: a denylist token in a public test file would be the leak.
  const posting = '示例岗位';
  const person = '张三';
  const real = '岗位：' + posting + ' 电话 ' + parts.phone + ' 邮箱 hr' + '@' + 'somecorp.com 路径 ' + parts.macHome;
  const { text, replacements } = sanitizeText(real, [posting, person]);
  const after = scanText(text, [posting, person]);
  check('nothing sensitive survives sanitising', after.length === 0, JSON.stringify(after));
  check('the sanitiser reports every replacement', replacements.length >= 4, JSON.stringify(replacements.map((r) => r.id)));
  check('the report names what was there', replacements.some((r) => r.id === 'chinese mobile number'));
  check('ordinary text is untouched', sanitizeText('质量工程师 5 年经验').text === '质量工程师 5 年经验');
}

// ── 2. local-data guards ─────────────────────────────────────────────────────
console.log('\n=== the local-data guards ===');
{
  check('the plugin root is a real directory', existsSync(PLUGIN_ROOT));
  check('KINDS covers the documented layout', KINDS.join(',') === 'profile,postings,sites,records,samples');

  for (const bad of ['../escape', 'a/../../b', '/etc/passwd', 'sub/dir', '', '   ', 'nul\0byte']) {
    let threw = false;
    try { safeName(bad); } catch { threw = true; }
    check(`safeName refuses ${JSON.stringify(bad)}`, threw, 'it was accepted');
  }
  check('safeName keeps an ordinary name', safeName('postings.json') === 'postings.json');

  // The guard that makes the split enforced rather than documented.
  let refused = false;
  try { assertOutsideRepo(join(PLUGIN_ROOT, 'records')); } catch { refused = true; }
  check('assertOutsideRepo refuses a path inside the plugin tree', refused, 'it was allowed');
  check('assertOutsideRepo allows a path outside it', isLocalDataPath(join(tmpdir(), 'x')));

  let refusedTraversal = false;
  try { localPath('records', '../outside.json'); } catch { refusedTraversal = true; }
  check('localPath refuses traversal', refusedTraversal, 'it was allowed');
  check('localPath nests a safe name', isInside(localPath('records', 'candidates.jsonl'), localDir('records')));

  let refusedKind = false;
  try { localDir('secrets'); } catch { refusedKind = true; }
  check('localDir refuses an unknown kind', refusedKind, 'it invented a directory');

  check('localFile sits in the root, not a kind', isInside(localFile(DENYLIST_FILE), localRoot()));
}

// ── 3. the roots are redirectable, which is what tests need ──────────────────
console.log('\n=== the roots ===');
{
  const scratch = await mkdtemp(join(tmpdir(), 'scout-privacy-'));
  const previous = process.env.DSH_SCOUT_HOME;
  try {
    process.env.DSH_SCOUT_HOME = scratch;
    check('DSH_SCOUT_HOME redirects the whole tree', localRoot() === scratch, localRoot());
    check('a kind directory follows it', localDir('sites') === join(scratch, 'sites'));
    check('an absent denylist reads as empty', (await readDenylist()).length === 0);
    await writeFile(localFile(DENYLIST_FILE), '# comment\n\n张三\npack quality\n');
    const tokens = await readDenylist();
    check('the denylist skips comments and blanks', tokens.length === 2, JSON.stringify(tokens));
  } finally {
    if (previous === undefined) delete process.env.DSH_SCOUT_HOME;
    else process.env.DSH_SCOUT_HOME = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}

// ── 4. the real repository ───────────────────────────────────────────────────
console.log('\n=== every git-tracked file ===');
{
  let files = [];
  let usedGit = true;
  try {
    files = execFileSync('git', ['ls-files'], { cwd: PLUGIN_ROOT, encoding: 'utf8' })
      .split('\n').map((line) => line.trim()).filter((line) => line !== '');
  } catch {
    usedGit = false;
  }
  check('the tracked file list is available', usedGit && files.length > 20, usedGit ? `only ${files.length} files` : 'git ls-files failed');

  const tokens = await readDenylist();
  console.log(tokens.length === 0
    ? '  note  no local denylist found — scanning with the generic shapes only'
    : `  note  local denylist contributes ${tokens.length} token(s)`);

  const reported = [];
  for (const file of files) {
    const full = join(PLUGIN_ROOT, file);
    const text = await readFile(full, 'utf8').catch(() => null);
    if (text === null) continue;
    for (const finding of scanText(text, tokens)) reported.push(`${file}:${finding.line}  [${finding.id}] ${finding.hit}`);
  }

  check(`no sensitive shape in ${files.length} tracked files`, reported.length === 0,
    reported.length === 0 ? '' : `\n      ${reported.slice(0, 10).join('\n      ')}`);
}

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
