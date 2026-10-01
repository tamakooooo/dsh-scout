/**
 * Job configuration and rule evaluation.
 *
 * The load-bearing rule is that "we could not tell" is never rounded to a yes or a no: a
 * field the page did not show is `unknown`, not a failure. Treating it as a failure would
 * silently drop candidates the page simply did not describe, which is the quietest way a
 * recruiting tool can be wrong.
 *
 * Run: node test/posting-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const {
  validatePosting, savePosting, loadPosting, listPostings, postingFileName,
  evaluateRule, evaluateCandidate, CONDITION_OPS,
} = await import('../lib/posting.js');
const { localDir } = await import('../lib/local.js');

let failures = 0;
async function verify(name, run) {
  try {
    await run();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${error.message}`);
  }
}

const posting = {
  version: 1,
  id: 'quality-engineer',
  platform: 'zhaopin',
  title: '质量工程师',
  description: '汽车零部件质量',
  must: [
    { field: 'city', op: 'in', value: ['广州', '深圳'] },
    { field: 'experience', op: 'at_least', value: 3 },
  ],
  prefer: [{ field: 'skills', op: 'contains', value: 'IATF' }],
  exclude: [{ field: 'title', op: 'contains', value: '实习' }],
  greeting: '您好，看到您的质量工程背景，想和您聊聊这个岗位。',
  limits: { contacts: 20, windows: 2 },
};

const candidate = (fields) => ({ identity: 'C-1', fields });

const refusal = (label, mutate) => {
  const copy = JSON.parse(JSON.stringify(posting));
  mutate(copy);
  return verify(label, async () => {
    let threw = null;
    try { validatePosting(copy); } catch (error) { threw = error.message; }
    assert.ok(threw, 'the posting was accepted');
    assert.match(threw, /invalid posting at /, `the message does not name the place: ${threw}`);
  });
};

console.log('=== the format refuses what it should ===');
await verify('a well-formed posting is accepted', async () => { validatePosting(posting); });
// `platform` used to be the example of an unknown key; it is a required field now, so the
// example is a key that is genuinely unknown and the platform rules are asserted on their own.
await refusal('an unknown top-level key', (p) => { p.contactLimit = 10; });
await refusal('a posting with no platform', (p) => { delete p.platform; });
await refusal('a posting on a platform that does not exist', (p) => { p.platform = 'mastodon'; });
await refusal('an unknown rule key', (p) => { p.must[0].required = true; });
await refusal('an unknown operator', (p) => { p.must[0].op = 'sounds-good'; });
await refusal('no requirements at all', (p) => { p.must = []; });
await refusal('a requirement without a field', (p) => { p.must[0].field = ''; });
await refusal('"in" with an empty list', (p) => { p.must[0].value = []; });
await refusal('"at_least" with a non-number', (p) => { p.must[1].value = 'three'; });
await refusal('"matches" with a broken pattern', (p) => { p.must[0].op = 'matches'; p.must[0].value = '('; });
await refusal('"exists" with a non-boolean', (p) => { p.must[0].op = 'exists'; p.must[0].value = 'yes'; });
await refusal('a missing title', (p) => { delete p.title; });
await refusal('an unknown limit', (p) => { p.limits.contacts = 20; p.limits.browsers = 4; });
await refusal('a negative limit', (p) => { p.limits.contacts = -1; });

await verify('the vocabulary is closed and the file name is derived', async () => {
  assert.deepEqual(CONDITION_OPS, ['equals', 'contains', 'in', 'not_in', 'matches', 'at_least', 'at_most', 'exists']);
  assert.equal(postingFileName(posting), 'quality-engineer.json');
  assert.equal(postingFileName({ id: 'PACK 质量/工程师' }), 'pack.json'.replace('pack', 'pack'));
});

console.log('\n=== one rule against one candidate ===');
await verify('unknown is never a failure', async () => {
  assert.equal(evaluateRule({ field: 'city', op: 'in', value: ['广州'] }, candidate({})), 'unknown');
  assert.equal(evaluateRule({ field: 'city', op: 'equals', value: '广州' }, candidate({ city: null })), 'unknown');
  assert.equal(evaluateRule({ field: 'city', op: 'contains', value: '广' }, candidate({ city: null })), 'unknown');
  assert.equal(evaluateRule({ field: 'city', op: 'not_in', value: ['广州'] }, candidate({ city: null })), 'unknown');
  assert.equal(evaluateRule({ field: 'experience', op: 'at_least', value: 3 }, candidate({ experience: '若干年' })), 'unknown');
});

await verify('the operators do what they say', async () => {
  const fields = { city: '广州', experience: '5年', title: '质量工程师', skills: 'IATF16949' };
  assert.equal(evaluateRule({ field: 'city', op: 'in', value: ['广州', '深圳'] }, candidate(fields)), 'pass');
  assert.equal(evaluateRule({ field: 'city', op: 'in', value: ['北京'] }, candidate(fields)), 'fail');
  assert.equal(evaluateRule({ field: 'city', op: 'not_in', value: ['北京'] }, candidate(fields)), 'pass');
  assert.equal(evaluateRule({ field: 'title', op: 'contains', value: '质量' }, candidate(fields)), 'pass');
  assert.equal(evaluateRule({ field: 'title', op: 'matches', value: '^质量' }, candidate(fields)), 'pass');
  assert.equal(evaluateRule({ field: 'experience', op: 'at_least', value: 5 }, candidate(fields)), 'pass');
  assert.equal(evaluateRule({ field: 'experience', op: 'at_least', value: 6 }, candidate(fields)), 'fail');
  assert.equal(evaluateRule({ field: 'experience', op: 'at_most', value: 5 }, candidate(fields)), 'pass');
  assert.equal(evaluateRule({ field: 'skills', op: 'exists' }, candidate(fields)), 'pass');
  assert.equal(evaluateRule({ field: 'skills', op: 'exists' }, candidate({})), 'fail');
  assert.equal(evaluateRule({ field: 'skills', op: 'exists', value: false }, candidate({})), 'pass');
  assert.equal(evaluateRule({ field: 'city', op: 'equals', value: '广州' }, candidate({ city: ' 广州 ' })), 'pass');
});

console.log('\n=== a candidate against a posting ===');
await verify('an excluded candidate is dismissed before anything else', async () => {
  const result = evaluateCandidate(candidate({ city: '广州', experience: '5年', title: '质量实习生' }), posting);
  assert.equal(result.verdict, 'no');
  assert.equal(result.reasons[0].kind, 'exclude');
});

await verify('a failed requirement is no', async () => {
  const result = evaluateCandidate(candidate({ city: '北京', experience: '5年' }), posting);
  assert.equal(result.verdict, 'no');
  assert.ok(result.reasons.some((r) => r.kind === 'must' && r.result === 'fail'));
});

await verify('an unevaluable requirement is unverified, naming the field', async () => {
  const result = evaluateCandidate(candidate({ city: '广州' }), posting);
  assert.equal(result.verdict, 'unverified', 'a missing field was rounded to a yes or a no');
  assert.deepEqual(result.unknownFields, ['experience']);
  assert.ok(!result.reasons.some((r) => r.kind === 'must' && r.result === 'fail'), 'an unknown requirement was recorded as failed');
});

await verify('a candidate the page did not describe is unverified, not dropped', async () => {
  const result = evaluateCandidate(candidate({}), posting);
  assert.equal(result.verdict, 'unverified');
  assert.deepEqual(result.unknownFields, ['city', 'experience']);
});

await verify('a satisfied candidate matches, with preferences as reasons only', async () => {
  const result = evaluateCandidate(candidate({ city: '广州', experience: '5年', skills: 'IATF16949' }), posting);
  assert.equal(result.verdict, 'match');
  assert.ok(result.reasons.some((r) => r.kind === 'prefer'), 'the preference was not recorded');
});

await verify('a preference never becomes a requirement', async () => {
  const without = evaluateCandidate(candidate({ city: '广州', experience: '3年' }), posting);
  assert.equal(without.verdict, 'match', 'a missing preference changed the verdict');
  assert.ok(!without.reasons.some((r) => r.kind === 'prefer'), 'an absent preference was recorded as satisfied');
});

await verify('a missing requirement is a fail, not a free pass', async () => {
  const strict = { ...posting, must: [{ field: 'city', op: 'equals', value: '广州' }] };
  assert.equal(evaluateCandidate(candidate({ city: '上海' }), strict).verdict, 'no');
});

console.log('\n=== storage in the local root ===');
await verify('a posting round-trips and appears in the list', async () => {
  const path = await savePosting(posting);
  assert.ok(path.startsWith(localDir('postings')), `saved outside the local root: ${path}`);
  const loaded = await loadPosting({ id: 'quality-engineer', platform: 'zhaopin' });
  assert.equal(loaded.title, '质量工程师');
  assert.equal(loaded.limits.contacts, 20);
  const listed = await listPostings();
  assert.ok(listed.some((entry) => entry.id === 'quality-engineer' && entry.title === '质量工程师'), JSON.stringify(listed));
});

await verify('saving the same id replaces it atomically', async () => {
  await savePosting({ ...posting, title: '质量工程师（改）' });
  assert.equal((await loadPosting({ id: 'quality-engineer', platform: 'zhaopin' })).title, '质量工程师（改）');
  const files = (await listPostings()).filter((entry) => entry.id === 'quality-engineer');
  assert.equal(files.length, 1, 'the same id produced two entries');
});

await verify('no saved posting reads as absent, not as an error', async () => {
  assert.equal(await loadPosting({ id: 'never-saved', platform: 'zhaopin' }), null);
  // Without a platform the reader refuses rather than guessing which one.
  await assert.rejects(() => loadPosting({ id: 'quality-engineer' }), /stored per platform/);
  await assert.rejects(() => loadPosting({ id: 'x', platform: 'mastodon' }), /unknown platform/);
});

await verify('a corrupt posting throws instead of reading as absent', async () => {
  await writeFile(join(localDir('postings'), 'zhaopin--broken.json'), '{ not json', 'utf8');
  await assert.rejects(() => loadPosting({ id: 'broken', platform: 'zhaopin' }), /not valid JSON/);
  const listed = await listPostings({ platform: 'zhaopin' });
  assert.ok(listed.some((entry) => entry.id === 'broken' && entry.error), 'a corrupt file was silently skipped in the list');
});

await verify('loading without an id is a programming error, not a silent miss', async () => {
  await assert.rejects(() => loadPosting({}), /id is required/);
});

await rm(localDir('postings'), { recursive: true, force: true }).catch(() => {});
// ── the same job on two platforms is two postings ────────────────────────────
console.log('\n=== postings are per platform ===');
await verify('the same id on two platforms is two files that do not see each other', async () => {
  const zhaopin = { ...posting, platform: 'zhaopin', title: '质量工程师（智联）' };
  const zhipin = { ...posting, platform: 'zhipin', title: '质量工程师（BOSS）' };
  await savePosting(zhaopin);
  await savePosting(zhipin);
  assert.equal((await loadPosting({ id: posting.id, platform: 'zhaopin' })).title, '质量工程师（智联）');
  assert.equal((await loadPosting({ id: posting.id, platform: 'zhipin' })).title, '质量工程师（BOSS）');
  const onZhaopin = await listPostings({ platform: 'zhaopin' });
  assert.ok(!onZhaopin.some((entry) => entry.title === '质量工程师（BOSS）'), 'another platform\'s posting was listed');
  const everywhere = await listPostings();
  assert.ok(everywhere.some((entry) => entry.platform === 'zhipin'), 'listing everything missed a platform');
});

await verify('a posting saved before platforms were named is reported, not hidden', async () => {
  await writeFile(join(localDir('postings'), 'legacy-job.json'), JSON.stringify({ ...posting, platform: undefined }), 'utf8');
  const listed = await listPostings();
  const legacy = listed.find((entry) => entry.id === 'legacy-job');
  assert.ok(legacy, 'an unscoped posting vanished from the list');
  assert.equal(legacy.platform, null);
  assert.match(legacy.error, /before postings named a platform/);
  // And listing one platform does not silently include it.
  const onZhaopin = await listPostings({ platform: 'zhaopin' });
  assert.ok(!onZhaopin.some((entry) => entry.id === 'legacy-job'), 'an unscoped posting was attributed to a platform');
});

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
