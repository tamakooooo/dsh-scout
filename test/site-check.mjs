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
const { navigate, perform, evaluate } = await import('../lib/page.js');
const { validateConfig, check, readCandidates, resolveTarget, configFileName, loadConfig, saveConfig, USABLE_HIT_RATE, ACTION_TYPES } = await import('../lib/site.js');
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
    assert.equal(report.cards[0].identity, 'C-1001', `identity was ${report.cards[0].identity}`);
    assert.equal(report.cards[0].fields.city.value, '广州');
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
    // Counted as cards, not as (card, action) pairs: two unsettled actions on one card is
    // still one unsafe record.
    assert.equal(report.ambiguous, 6, `ambiguous was ${report.ambiguous}`);

    const doubled = JSON.parse(JSON.stringify(config));
    doubled.actions.also = { scope: 'card', type: 'read', locator: { tag: 'button' } };
    doubled.actions.also.locator = { tag: 'span', text: { contains: '先生' } };
    const two = await at(doubled);
    assert.equal(two.ambiguous, 6, `two unsettled actions per card counted ${two.ambiguous}`);
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

  await verify('the read path returns records with their provenance', async () => {
    const read = await readCandidates(session.cdp, session.sessionId, { config: good });
    assert.equal(read.count, 6);
    assert.equal(read.verdict, 'usable');
    assert.deepEqual(read.candidates[0].fields, { name: '徐先生', city: '广州' });
    assert.deepEqual(read.candidates[0].unknown, [], 'a field that resolved was reported unknown');
    assert.equal(read.candidates[0].actions.greet, true, 'the action did not resolve uniquely');
    assert.deepEqual(read.candidates.map((c) => c.identity), ['C-1001', 'C-1002', 'C-1003', 'C-1004', 'C-1005', 'C-1006']);
  });

  await verify('a missing field reads as unknown, never as an invented value', async () => {
    const config = JSON.parse(JSON.stringify(good));
    config.fields.email = { locator: { tag: 'span', attr: [{ name: 'class', equals: 'em' }] } };
    const read = await readCandidates(session.cdp, session.sessionId, { config });
    assert.equal(read.candidates[0].fields.email, null);
    assert.deepEqual(read.candidates[0].unknown, ['email']);
    assert.equal(read.canSend, false, 'an incomplete read was still allowed to send');
  });

  await verify('a stale configuration reads nothing at all', async () => {
    const config = JSON.parse(JSON.stringify(good));
    config.markers = [{ kind: 'exists', locator: { tag: 'ul', attr: [{ name: 'id', equals: 'not-here' }] } }];
    const read = await readCandidates(session.cdp, session.sessionId, { config });
    assert.equal(read.count, 0, 'records were read from a page the rules do not describe');
    assert.equal(read.verdict, 'stale');
  });

  await verify('the action vocabulary names only what the executor implements', async () => {
    // `select` is absent on purpose: naming an action nothing implements invites a
    // configuration to declare a step that quietly does nothing.
    assert.deepEqual(ACTION_TYPES, ['read', 'click', 'type', 'scroll', 'wait']);
  });

  await verify('a target resolves to exactly one element and is stamped for the action path', async () => {
    const target = await resolveTarget(session.cdp, session.sessionId, { config: good, identity: 'C-1002', action: 'greet' });
    assert.equal(target.ok, true, `${target.code}: ${target.message}`);
    assert.equal(target.ref, 'cfg-1');
    assert.equal(target.label, '打招呼');
  });

  await verify('the resolved target really is actionable', async () => {
    // The point of the stamp: the existing action path acts through it, so pointer and typing
    // semantics live in one place rather than drifting between two implementations.
    const target = await resolveTarget(session.cdp, session.sessionId, { config: good, identity: 'C-1002', action: 'greet' });
    const outcome = await perform(session.cdp, session.sessionId, 'click', target.ref);
    assert.equal(outcome.ok, true, outcome.message);
    const text = await evaluate(session.cdp, session.sessionId,
      'document.querySelector("[data-candidate-id=\'C-1002\'] button").textContent');
    assert.equal(text, '已打招呼', 'the click did not reach the card the configuration named');
  });

  await verify('every refusal names its cause', async () => {
    const cases = [
      [{ identity: 'C-nope', action: 'greet' }, 'identity_not_found'],
      [{ identity: 'C-1001', action: 'nope' }, 'no_such_action'],
      [{ identity: 'C-1001', action: 'peer' }, 'read_only'],
      [{ identity: '', action: 'greet' }, 'no_identity'],
    ];
    for (const [selection, code] of cases) {
      // `peer` is declared as a read-only action, so resolving it as a target must refuse.
      const config = JSON.parse(JSON.stringify(good));
      config.actions.peer = { scope: 'card', type: 'read', locator: { tag: 'span' } };
      const target = await resolveTarget(session.cdp, session.sessionId, { config, ...selection });
      assert.equal(target.ok, false, `${JSON.stringify(selection)} resolved`);
      assert.equal(target.code, code, `expected ${code}, got ${target.code}: ${target.message}`);
    }
  });

  await verify('an action that matches more than one element is refused, not guessed', async () => {
    const config = JSON.parse(JSON.stringify(good));
    config.actions.readEverything = { scope: 'card', type: 'click', locator: { tag: 'span' } };
    const target = await resolveTarget(session.cdp, session.sessionId, { config, identity: 'C-1001', action: 'readEverything' });
    assert.equal(target.ok, false);
    assert.equal(target.code, 'target_ambiguous');
    assert.match(target.message, /refusing to guess/);
  });

  await verify('two cards claiming one identity are refused', async () => {
    const config = JSON.parse(JSON.stringify(good));
    config.cards.identity = { from: 'text' };
    const target = await resolveTarget(session.cdp, session.sessionId, { config, identity: '徐先生 广州 打招呼', action: 'greet' });
    // The whole card's text is the identity here, so more than one card can claim it only if
    // the page really repeats one; either way the resolver must not act on a guess.
    assert.ok(target.code === 'identity_ambiguous' || target.code === 'identity_not_found', `got ${target.code}`);
  });

  await verify('a responsive action resolves to the displayed variant only', async () => {
    // Found on the real page: the greeting exists twice, once for large screens and once for
    // small, and only one is displayed. The resolver originally matched both and refused every
    // greeting as ambiguous — on the real site, every one of them.
    const responsive = await readFile(new URL('./fixtures/cards-responsive.html', import.meta.url), 'utf8');
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html;charset=utf-8');
      res.end(responsive);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/list`;
      await navigate(session.cdp, session.sessionId, url);
      const config = {
        version: 1,
        domain: '127.0.0.1',
        page: 'responsive',
        cards: {
          locator: { tag: 'div', attr: [{ name: 'class', contains: 'recommend-item' }] },
          identity: { from: 'attr:data-index' },
        },
        fields: { name: { locator: { attr: [{ name: 'class', contains: 'talent-basic-info__title' }] } } },
        actions: { greet: { scope: 'card', type: 'click', effect: 'quota', locator: { tag: 'button', text: { equals: '打招呼' } } } },
      };
      const report = await check(session.cdp, session.sessionId, { config });
      assert.equal(report.matched, 2, `matched ${report.matched}`);
      // The page carries an element whose class looks generated. That must not make a condition
      // that matched a stable element look unstable: the warning fires on what matched, not on
      // what happened to be scanned on the way past.
      assert.deepEqual(report.unstableConditions, [], 'a stable condition was reported as unstable because of an unrelated element');
      assert.equal(report.ambiguous, 0, 'the hidden responsive variant was counted as an action target');
      assert.equal(report.canSend, true, JSON.stringify(report));

      const target = await resolveTarget(session.cdp, session.sessionId, { config, identity: '0', action: 'greet' });
      assert.equal(target.ok, true, `${target.code}: ${target.message}`);
      const visible = await evaluate(session.cdp, session.sessionId,
        `(() => { const el = document.querySelector('[data-dsh-jev-ref="cfg-1"]'); return el ? el.className : ''; })()`);
      assert.match(String(visible), /large-screen-btn/, `resolved the wrong variant: ${visible}`);
    } finally {
      server.close();
    }
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
  // The fixture server stays up for the tool section below, which opens the same URL.
}

// ── the tool the agent actually calls ────────────────────────────────────────
// The blocks above drive lib/site.js directly. This one goes through the registered tool, so
// the parameter mapping, the output shape, the renderer and the file it writes are exercised —
// the places a schema mismatch or a wrong path hides until a model request fails.
console.log('\n=== browser_site_config as a tool ===');
{
  const { apply } = await import('../index.js');
  const { readFile: read } = await import('node:fs/promises');
  const definitions = [];
  const ctx = {
    tools: { register: (definition) => definitions.push(definition) },
    effect: () => {},
    logger: { debug() {} },
    get: () => undefined,
    inject: () => () => {},
  };
  const toolProfile = join(tmpdir(), `jev-site-tool-${process.pid}`);
  apply(ctx, { headless: true, viewer: false, profileDir: toolProfile });
  const signal = new AbortController().signal;
  const tool = (name) => definitions.find((definition) => definition.name === name);
  const call = (args) => tool('browser_site_config').execute({ session: 'default', ...args }, { signal });
  const asText = (config) => JSON.stringify(config);

  try {
    await verify('the tool set includes browser_site_config', async () => {
      const names = definitions.map((d) => d.name);
      assert.ok(tool('browser_site_config'), `registered: ${names.join(', ')}`);
      for (const required of ['browser_inspect', 'browser_site_config', 'browser_open', 'browser_close']) {
        assert.ok(names.includes(required), `${required} is not registered: ${names.join(', ')}`);
      }
    });

    await tool('browser_open').execute({ url: `http://127.0.0.1:${server.address().port}/list` }, { signal });

    await verify('check reports a usable configuration', async () => {
      const value = await call({ action: 'check', config: asText(good) });
      for (const key of tool('browser_site_config').output.schema.required) {
        assert.ok(key in value, `the tool omitted a required field: ${key}`);
      }
      assert.equal(value.status, 'ok');
      assert.equal(value.can_send, true);
      assert.equal(value.matched, 6);
      assert.equal(value.hit_rate, 1);
    });

    await verify('check reports needs_adaptation for rules that no longer fit', async () => {
      const stale = JSON.parse(JSON.stringify(good));
      stale.cards.locator = { tag: 'li', attr: [{ name: 'class', equals: 'gone' }] };
      const value = await call({ action: 'check', config: asText(stale) });
      assert.equal(value.status, 'needs_adaptation');
      assert.equal(value.can_send, false);
      assert.equal(value.verdict, 'stale');
    });

    await verify('save refuses a stale configuration rather than storing it', async () => {
      const stale = JSON.parse(JSON.stringify(good));
      stale.page = 'gone';
      stale.cards.locator = { tag: 'li', attr: [{ name: 'class', equals: 'gone' }] };
      const before = (await call({ action: 'list' })).config_files.length;
      const value = await call({ action: 'save', config: asText(stale) });
      assert.equal(value.status, 'refused');
      assert.equal(value.saved_to, '');
      assert.equal((await call({ action: 'list' })).config_files.length, before, 'a stale configuration was written anyway');
    });

    await verify('save writes the configuration under the local root', async () => {
      const value = await call({ action: 'save', config: asText(good) });
      assert.equal(value.status, 'ok', value.note);
      assert.ok(value.saved_to.startsWith(localDir('sites')), `saved outside the local root: ${value.saved_to}`);
      const stored = JSON.parse(await read(value.saved_to, 'utf8'));
      assert.equal(stored.version, 1);
      assert.ok(stored.validated, 'the saved file carries no evidence of the check that allowed it');
      assert.equal(stored.validated.cards, 6);
      assert.match(value.note, /confirmation gate/, 'the note does not say the first send is still gated');
    });

    await verify('list and load read back what was saved', async () => {
      const listed = await call({ action: 'list' });
      assert.ok(listed.config_files.includes('127-0-0-1--candidate-list.json'), JSON.stringify(listed.config_files));
      const loaded = await call({ action: 'load', domain: good.domain, page: good.page });
      assert.equal(loaded.status, 'ok');
      assert.equal(JSON.parse(loaded.config).actions.greet.type, 'click');
      const absent = await call({ action: 'load', domain: good.domain, page: 'never-saved' });
      assert.equal(absent.status, 'missing');
    });

    await verify('the tool reports a malformed configuration instead of resolving nothing', async () => {
      await assert.rejects(() => call({ action: 'check', config: '{ not json' }), /not valid JSON/);
      await assert.rejects(() => call({ action: 'check', config: asText({ version: 1, domain: 'd', page: 'p', cards: { locator: { ref: 'e3' } }, actions: { a: { scope: 'card', type: 'read', locator: { tag: 'b' } } } }) }), /invalid site configuration at/);
      await assert.rejects(() => call({ action: 'nonsense' }), /unknown action/);
      await assert.rejects(() => call({ action: 'check' }), /required for action/);
    });

    await verify('the renderer produces text, not raw JSON', async () => {
      const value = await call({ action: 'check', config: asText(good) });
      const blocks = tool('browser_site_config').output.render({ action: 'check' }, value);
      assert.ok(Array.isArray(blocks) && blocks.length > 0 && typeof blocks[0].text === 'string');
      assert.match(blocks[0].text, /verdict: usable/);
      assert.match(blocks[0].text, /can send: yes/);
    });
  } finally {
    await tool('browser_close')?.execute({ all: true }, { signal }).catch(() => {});
    await rm(toolProfile, { recursive: true, force: true }).catch(() => {});
  }
}

server.close();

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
