/**
 * Telling the four platforms apart.
 *
 * The point of this suite is the boundary, not the happy path: a domain match by substring would
 * accept `notzhaopin.com` and `zhaopin.com.evil.tld` as 智联, and an authorisation for 智联 would
 * then act on someone else's page. Those cases are asserted first.
 *
 * Run: node test/platform-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';

const {
  PLATFORMS, PLATFORM_IDS, platformById, requirePlatform, platformName, platformOf,
  belongsToPlatform, assertOnPlatform, platformFile, platformOfFile, hostOf, hostBelongsTo,
  describePlatforms,
} = await import('../lib/platforms.js');

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

await verify('the four platforms are the four the workbench shows', async () => {
  assert.deepEqual(PLATFORM_IDS, ['zhaopin', 'zhipin', '51job', 'liepin']);
  assert.deepEqual(PLATFORMS.map((p) => p.name), ['智联招聘', 'BOSS直聘', '前程无忧', '猎聘']);
});

await verify('a console page resolves to its platform', async () => {
  assert.equal(platformOf('https://rd6.zhaopin.com/app/recommend?jobNumber=CC1')?.id, 'zhaopin');
  assert.equal(platformOf('https://www.zhipin.com/web/chat/index')?.id, 'zhipin');
  assert.equal(platformOf('https://ehire.51job.com/Candidate/Search')?.id, '51job');
  assert.equal(platformOf('https://h.liepin.com/resume/search')?.id, 'liepin');
  assert.equal(platformOf('zhaopin.com')?.id, 'zhaopin');
  assert.equal(platformOf('https://www.baidu.com/s?q=zhaopin'), null, 'a search for a platform is not the platform');
  assert.equal(platformOf(''), null);
  assert.equal(platformOf(null), null);
});

await verify('a domain that merely contains the name is not the platform', async () => {
  // The case that matters: these are the shapes a suffix or substring match would accept.
  for (const host of [
    'notzhaopin.com',
    'zhaopin.com.evil.tld',
    'zhaopin.com.cn',
    'xzhaopin.com',
    'zhaopin-com.example',
    'fake-zhipin.com',
    '51job.com.evil.tld',
  ]) {
    assert.equal(platformOf(host), null, `${host} was accepted as a platform`);
  }
  assert.equal(hostBelongsTo('notzhaopin.com', 'zhaopin.com'), false);
  assert.equal(hostBelongsTo('zhaopin.com.evil.tld', 'zhaopin.com'), false);
  assert.equal(hostBelongsTo('rd6.zhaopin.com', 'zhaopin.com'), true);
  assert.equal(hostBelongsTo('zhaopin.com', 'zhaopin.com'), true);
});

await verify('the host is read out of whatever the caller has', async () => {
  assert.equal(hostOf('https://rd6.zhaopin.com/x?y=1'), 'rd6.zhaopin.com');
  assert.equal(hostOf('rd6.zhaopin.com'), 'rd6.zhaopin.com');
  assert.equal(hostOf('rd6.zhaopin.com:443/app'), 'rd6.zhaopin.com');
  assert.equal(hostOf('  RD6.ZHAOPIN.COM  '), 'rd6.zhaopin.com');
  assert.equal(hostOf(''), '');
});

await verify('an authorisation for one platform does not cover another', async () => {
  assert.equal(belongsToPlatform('zhaopin', 'https://rd6.zhaopin.com/app'), true);
  assert.equal(belongsToPlatform('zhaopin', 'https://www.zhipin.com/web'), false);
  assert.equal(assertOnPlatform('zhaopin', 'https://rd6.zhaopin.com/app'), true);
  assert.throws(() => assertOnPlatform('zhaopin', 'https://www.zhipin.com/web'), /this is BOSS直聘, not 智联招聘/);
  assert.throws(() => assertOnPlatform('zhaopin', 'https://notzhaopin.com/app'), /not a page on any known platform/);
  assert.throws(() => assertOnPlatform('mastodon', 'https://rd6.zhaopin.com'), /unknown platform/);
});

await verify('an unknown platform is refused by name', async () => {
  assert.throws(() => requirePlatform('zhaopin2'), /expected one of zhaopin, zhipin, 51job, liepin/);
  assert.throws(() => requirePlatform(undefined), /unknown platform/);
  assert.equal(platformName('51job'), '前程无忧');
  assert.equal(platformName('nope'), 'nope');
  assert.equal(platformById('liepin').domains[0], 'liepin.com');
});

await verify('files are scoped by platform, and the scope can be read back', async () => {
  assert.equal(platformFile('zhaopin', 'contacts.jsonl'), 'zhaopin--contacts.jsonl');
  assert.equal(platformOfFile('zhaopin--contacts.jsonl'), 'zhaopin');
  assert.equal(platformOfFile('51job--authorizations.jsonl'), '51job');
  // A file that names no platform is not silently attributed to one.
  assert.equal(platformOfFile('contacts.jsonl'), null);
  assert.equal(platformOfFile('zhaopin-contacts.jsonl'), null, 'a single dash was read as a scope');
  assert.equal(platformOfFile(''), null);
  assert.throws(() => platformFile('mastodon', 'x.json'), /unknown platform/);
});

await verify('the workbench gets a row per platform, in order', async () => {
  const rows = describePlatforms({ zhaopin: { contacts: 6, state: 'running' } });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.id), PLATFORM_IDS);
  assert.equal(rows[0].contacts, 6);
  assert.equal(rows[0].state, 'running');
  assert.equal(rows[1].contacts, undefined);
});

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
