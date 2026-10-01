/**
 * Site configurations: what the format refuses, and what a check against the page reports.
 *
 * The refusals matter as much as the acceptances. A configuration is data the plugin
 * interprets, so "no raw CSS", "no stored ref" and "no agent-authored JavaScript" are only
 * true if the format actually rejects them — otherwise they are sentences in a document.
 *
 * Run: node test/site-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { resolveConfig } = await import('../index.js');
const { Sessions } = await import('../lib/sessions.js');
const { navigate } = await import('../lib/page.js');
const { validateConfig, check, configFileName, loadConfig, saveConfig, USABLE_HIT_RATE } = await import('../lib/site.js');
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

const good = {
  version: 1,
  domain: '127.0.0.1',
  page: 'candidate-list',
  markers: [{ kind: 'exists', locator: { tag: 'ul', attr: [{ name: 'id', equals: 'list' }] } }],
  cards: {
    locator: { tag: 'li', attr: [{ name: 'data-candidate-id', matches: '^C-' }] },
    identity: { from: 'attr:data-candidate-id' },
  },
  fields: {
    name: { locator: { tag: 'span', attr: [{ name: 'class', equals: 'nm' }] } },
    city: { locator: { tag: 'span', attr: [{ name: 'class', equals: 'ct' }] } },
  },
  actions: {
    greet: { scope: 'card', type: 'click', effect: 'quota', locator: { tag: 'button', text: { equals: '打招呼' } } },
  },
};

const expectRefusal = (label, mutate) => {
  const config = JSON.parse(JSON.stringify(good));
  mutate(config);
  return verify(label, async () => {
    let threw = null;
    try { validateConfig(config); } catch (error) { threw = error.message; }
    assert.ok(threw, 'the configuration was accepted');
    assert.match(threw, /invalid site configuration at /, `the message does not name the place: ${threw}`);
  });
};

console.log('=== the format refuses what it should ===');
await verify('a well-formed configuration is accepted', async () => {
  validateConfig(good);
});
await expectRefusal('an unknown top-level key', (c) => { c.selector = 'div.card'; });
await expectRefusal('a stored ref', (c) => { c.actions.greet.locator.ref = 'e3'; });
await expectRefusal('a raw CSS string in a locator', (c) => { c.actions.greet.locator.css = 'div.card > button'; });
await expectRefusal('an unknown action type', (c) => { c.actions.greet.type = 'evaluate'; });
await expectRefusal('an unknown effect', (c) => { c.actions.greet.effect = 'harmless'; });
await expectRefusal('an action without a scope', (c) => { delete c.actions.greet.scope; });
await expectRefusal('a text condition with no operator', (c) => { c.actions.greet.locator.text = {}; });
await expectRefusal('an invalid regular expression', (c) => { c.fields.name.locator = { text: { matches: '(' } }; });
await expectRefusal('a negative nth', (c) => { c.actions.greet.locator.nth = -1; });
await expectRefusal('a marker of an unknown kind', (c) => { c.markers = [{ kind: 'looks-fine', locator: { tag: 'ul' } }]; });
await expectRefusal('no actions at all', (c) => { c.actions = {}; });
await expectRefusal('an identity from nowhere', (c) => { c.cards.identity = { from: 'vibes' }; });
await expectRefusal('an unnamed attribute condition', (c) => { c.fields.name.locator = { attr: [{ equals: 'nm' }] }; });

await verify('the file name is derived and safe', async () => {
  assert.equal(configFileName(good), '127-0-0-1--candidate-list.json');
  assert.equal(configFileName({ domain: '../../etc', page: 'pass wd' }), 'etc--pass-wd.json');
  assert.ok(!configFileName({ domain: '../../etc', page: 'pass wd' }).includes('..'), 'a traversing name survived');
});

// ── against the page ─────────────────────────────────────────────────────────
const fixture = await readFile(new URL('./fixtures/cards-inspect.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const profileDir = join(tmpdir(), `jev-site-${process.pid}`);
const sessions = new Sessions(resolveConfig({ headless: true, profileDir }));

console.log('\n=== a check against the page ===');
try {
  const session = await sessions.ensure('site', { headless: true });
  await navigate(session.cdp, session.sessionId, `http://127.0.0.1:${server.address().port}/list`);
  const at = (config) => check(session.cdp, session.sessionId, { config });

  await verify('a correct configuration reports usable and may send', async () => {
    const report = await at(good);
    assert.equal(report.matched, 6, `matched ${report.matched} cards`);
    assert.equal(report.hitRate, 1, `hit rate ${report.hitRate}`);
    assert.equal(report.ambiguous, 0);
    assert.equal(report.missing, 0);
    assert.equal(report.verdict, 'usable', JSON.stringify(report.markerFailures));
    assert.equal(report.canSend, true, 'a usable configuration was refused');
    assert.equal(report.samples[0].identity, 'C-1001', `identity was ${report.samples[0].identity}`);
    assert.equal(report.samples[0].fields.city.value, '广州');
  });

  await verify('a card locator that matches nothing is stale, not best-effort', async () => {
    const config = JSON.parse(JSON.stringify(good));
    config.cards.locator = { tag: 'li', attr: [{ name: 'class', equals: 'no-such-card' }] };
    const report = await at(config);
    assert.equal(report.matched, 0);
    assert.equal(report.verdict, 'stale');
    assert.equal(report.canSend, false, 'a configuration with no cards was allowed to send');
  });

  await verify('a failing marker names itself and stops the check', async () => {
    const config = JSON.parse(JSON.stringify(good));
    config.markers = [{ kind: 'text', locator: { tag: 'ul', attr: [{ name: 'id', equals: 'list' }] }, contains: '并不存在的文案' }];
    const report = await at(config);
    assert.equal(report.verdict, 'stale');
    assert.equal(report.markerFailures.length, 1, JSON.stringify(report.markerFailures));
    assert.match(report.markerFailures[0], /markers\[0\]/);
    assert.equal(report.canSend, false);
    assert.equal(report.matched, 0, 'cards were resolved even though a marker failed');
  });

  await verify('card-relative ambiguity is counted and blocks sending', async () => {
    const config = JSON.parse(JSON.stringify(good));
    // Two spans per card, so the card-level action cannot resolve to exactly one.
    config.actions.probe = { scope: 'card', type: 'read', locator: { tag: 'span' } };
    const report = await at(config);
    assert.equal(report.ambiguous, 6, `ambiguous was ${report.ambiguous}`);
    assert.equal(report.verdict, 'degraded');
    assert.equal(report.canSend, false, 'ambiguity did not block sending');
  });

  await verify('a missing field lowers the hit rate below the usable threshold', async () => {
    const config = JSON.parse(JSON.stringify(good));
    config.fields.email = { locator: { tag: 'span', attr: [{ name: 'class', equals: 'em' }] } };
    const report = await at(config);
    assert.equal(report.missing, 6, `missing was ${report.missing}`);
    assert.ok(report.hitRate < USABLE_HIT_RATE, `hit rate ${report.hitRate}`);
    assert.equal(report.canSend, false);
  });

  await verify('a condition resting on a generated class is reported', async () => {
    const config = JSON.parse(JSON.stringify(good));
    config.cards.locator = { tag: 'li', attr: [{ name: 'class', contains: 'km_card__item--a1b2c3d4' }] };
    const report = await at(config);
    assert.equal(report.matched, 6);
    assert.ok(report.unstableConditions.includes('cards.locator.attr[class]'),
      `unstable conditions: ${JSON.stringify(report.unstableConditions)}`);
  });

  await verify('a saved configuration round-trips through the local root', async () => {
    const path = await saveConfig(good);
    assert.ok(path.startsWith(localDir('sites')), `saved outside the local root: ${path}`);
    const loaded = await loadConfig(good);
    assert.equal(loaded.cards.locator.tag, 'li');
    assert.equal(loaded.version, 1);
  });

  await verify('a corrupt saved configuration throws instead of re-learning silently', async () => {
    const path = join(localDir('sites'), configFileName(good));
    await writeFile(path, '{ this is not json', 'utf8');
    await assert.rejects(() => loadConfig(good), /not valid JSON/);
  });

  await verify('no saved configuration reads as absent, not as an error', async () => {
    const other = { ...good, page: 'never-saved' };
    assert.equal(await loadConfig(other), null);
  });
} finally {
  await sessions.closeAll().catch(() => {});
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  server.close();
}

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
