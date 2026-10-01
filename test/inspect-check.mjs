/**
 * The structural sample a site configuration is learned from.
 *
 * What is checked here is mostly the **budgets**, because a bounded sample that quietly stops
 * being bounded is worse than no sample: the caller keeps trusting it while it grows into the
 * whole document. The other half is that the two signals the sample exists to carry actually
 * arrive — `repeats` and `groups`, which together answer "which siblings are the cards".
 *
 * Run: node test/inspect-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const { resolveConfig } = await import('../index.js');
const { Sessions } = await import('../lib/sessions.js');
const { navigate, inspect } = await import('../lib/page.js');

let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${error.message}`);
  }
}

const fixture = await readFile(new URL('./fixtures/cards-inspect.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/list`;

const profileDir = join(tmpdir(), `jev-inspect-${process.pid}`);
const config = resolveConfig({ headless: true, profileDir });
const sessions = new Sessions(config);

try {
  const session = await sessions.ensure('inspect', { headless: true });
  await navigate(session.cdp, session.sessionId, url);

  const sample = await inspect(session.cdp, session.sessionId);

  await check('a sample comes back with the page identity', async () => {
    assert.ok(sample, 'no sample was returned');
    assert.match(sample.url, /127\.0\.0\.1/);
    assert.equal(sample.title, '推荐人才');
    assert.ok(sample.snapshotId, 'no snapshot id');
  });

  await check('the node budget holds', async () => {
    assert.ok(sample.nodes.length <= 120, `${sample.nodes.length} nodes exceeds the 120 budget`);
    assert.ok(sample.nodes.length > 5, `only ${sample.nodes.length} nodes — the sample is too thin to learn from`);
  });

  await check('the character budget holds', async () => {
    assert.ok(sample.characters <= 12000, `${sample.characters} characters exceeds the 12000 budget`);
    assert.equal(sample.characters, sample.nodes.reduce((sum, node) => sum + JSON.stringify(node).length, 0));
  });

  await check('the depth budget holds', async () => {
    const deepest = Math.max(...sample.nodes.map((node) => node.depth));
    assert.ok(deepest <= 6, `depth ${deepest} exceeds the budget of 6`);
    assert.equal(sample.truncated, true, 'the fixture nests deeper than the budget, so truncation must be reported');
  });

  await check('generated class names are never offered as an anchor', async () => {
    for (const node of sample.nodes) {
      for (const attribute of node.attributes) {
        if (attribute.name !== 'class') continue;
        assert.ok(!/a1b2c3d4|f9e8d7c6/.test(attribute.value), `a generated class survived: ${attribute.value}`);
      }
    }
  });

  await check('a stable data attribute is kept and marked stable', async () => {
    // Both the card's greet button and the dialog's confirm button carry data-action, so the
    // assertion names the value it is after rather than taking whichever node comes first —
    // otherwise it passes or fails on document order.
    const buttons = sample.nodes.filter((node) => node.attributes.some((a) => a.name === 'data-action'));
    assert.ok(buttons.length > 0, 'data-action was not reported on any node');
    const greet = buttons.find((node) => node.attributes.some((a) => a.name === 'data-action' && a.value === 'greet'));
    assert.ok(greet, `no node carried data-action="greet": ${JSON.stringify(buttons.map((n) => n.attributes))}`);
    const attribute = greet.attributes.find((a) => a.name === 'data-action');
    assert.equal(attribute.stable, true);
  });

  await check('the repeating cards are reported as repeats and as a group', async () => {
    const repeated = sample.nodes.filter((node) => node.repeats >= 6);
    assert.ok(repeated.length > 0, 'no node reported six or more alike siblings');
    // Identified by what its members are, not by being the first with six: the fixture also
    // nests a deep chain of divs, and taking whichever group came first made this assertion
    // depend on the fixture's shape rather than on the cards being found.
    // The card element itself, not just something that wraps one. The real page nests a single
    // card inside a wrapper, so the cards are siblings of nothing — and the wrapper group alone
    // satisfies "a group whose examples look like cards", which is why this names the element.
    const cardElement = sample.groups.find((entry) => entry.signature.startsWith('li|'));
    assert.ok(cardElement, `the card element is not a group of its own: ${JSON.stringify(sample.groups.map((g) => [g.signature, g.count]))}`);
    assert.ok(cardElement.count >= 6, `the card group has ${cardElement.count} members`);
    assert.ok(cardElement.examples.some((text) => /先生/.test(text)), `its examples carry no card label: ${JSON.stringify(cardElement.examples)}`);
  });

  await check('scroll containers and dialogs are reported', async () => {
    assert.ok(sample.containers.some((c) => c.scrollHeight > c.clientHeight), `no scroll container: ${JSON.stringify(sample.containers)}`);
    assert.ok(sample.dialogs.length > 0, 'the dialog was not reported');
    assert.match(sample.dialogs[0].text, /打招呼/);
  });

  await check('a tightened budget actually bites', async () => {
    const small = await inspect(session.cdp, session.sessionId, { nodes: 5 });
    assert.ok(small.nodes.length <= 5, `${small.nodes.length} nodes with a budget of 5`);
    assert.equal(small.truncated, true, 'a budget that bit must say so');
    assert.ok(small.nodes.length < sample.nodes.length, 'the tight budget returned as much as the default');
  });

  await check('each sample is distinguishable', async () => {
    const again = await inspect(session.cdp, session.sessionId);
    assert.notEqual(again.snapshotId, sample.snapshotId, 'two samples shared a snapshot id');
  });

  await check('nothing but JSON crosses the boundary', async () => {
    assert.equal(JSON.parse(JSON.stringify(sample)).nodes.length, sample.nodes.length);
  });
} finally {
  await sessions.closeAll().catch(() => {});
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  // The fixture server stays up: the tool block below opens the same URL, and closing it here
  // left that block inspecting Chrome's new-tab page instead of the fixture.
}

// ── the tool the agent actually calls ────────────────────────────────────────
// The block above drives `inspect()` directly. This one goes through the registered tool, so
// the parameter mapping, the output shape and the renderer are all exercised — the places a
// schema mismatch hides until a model request fails.
console.log('\n=== browser_inspect as a tool ===');
{
  const { apply } = await import('../index.js');
  const definitions = [];
  const ctx = {
    tools: { register: (definition) => definitions.push(definition) },
    effect: () => {},
    logger: { debug() {} },
    get: () => undefined,
    inject: () => () => {},
  };
  const toolProfile = join(tmpdir(), `jev-inspect-tool-${process.pid}`);
  apply(ctx, { headless: true, viewer: false, profileDir: toolProfile });
  const signal = new AbortController().signal;
  const tool = (name) => definitions.find((definition) => definition.name === name);

  try {
    await check('the tool set includes browser_inspect', async () => {
      const names = definitions.map((d) => d.name);
      assert.ok(tool('browser_inspect'), `registered: ${names.join(', ')}`);
      // Names, not a count: an exact count breaks every time a tool is added, which turns a
      // meaningful check into noise nobody reads.
      for (const required of ['browser_open', 'browser_snapshot', 'browser_inspect', 'browser_act', 'browser_jev', 'browser_close']) {
        assert.ok(names.includes(required), `${required} is not registered: ${names.join(', ')}`);
      }
      assert.ok(definitions.length >= 6, `only ${definitions.length} tools registered`);
    });

    const opened = await tool('browser_open').execute({ url }, { signal });

    await check('the sample describes the page that was opened', async () => {
      const value = await tool('browser_inspect').execute({ session: 'default' }, { signal });
      assert.equal(value.url, opened.url, 'the sample is of a different page than the one opened');
      assert.equal(value.title, '推荐人才');
    });

    await check('browser_inspect returns every required field', async () => {
      const value = await tool('browser_inspect').execute({ session: 'default' }, { signal });
      for (const key of tool('browser_inspect').output.schema.required) {
        assert.ok(key in value, `the tool omitted a required field: ${key}`);
      }
      assert.ok(value.nodes.length > 5, `only ${value.nodes.length} nodes`);
      assert.ok(value.groups.some((group) => group.count >= 6), `groups: ${JSON.stringify(value.groups.map((g) => [g.signature, g.count]))}`);
      assert.ok(value.truncated === true, 'the fixture nests past the depth budget, so truncation must be reported');
    });

    await check('the tool renders readable text, not raw JSON', async () => {
      const value = await tool('browser_inspect').execute({ session: 'default' }, { signal });
      const blocks = tool('browser_inspect').output.render({}, value);
      assert.ok(Array.isArray(blocks) && blocks.length > 0 && typeof blocks[0].text === 'string');
      assert.match(blocks[0].text, /REPEATING GROUPS/);
      assert.match(blocks[0].text, /先生/);
      assert.match(blocks[0].text, /x6/, `the repeating group is not shown: ${blocks[0].text.slice(0, 400)}`);
    });

    await check('a per-call budget is clamped at both ends', async () => {
      // Below the floor the sample cannot carry structure, so a request for 5 is raised to 10
      // rather than honoured — and the applied budget is reported, so it is not silent.
      const tiny = await tool('browser_inspect').execute({ session: 'default', nodes: 5 }, { signal });
      assert.equal(tiny.node_budget, 10, `a request for 5 produced a budget of ${tiny.node_budget}`);
      assert.ok(tiny.node_count <= 10);
      const mid = await tool('browser_inspect').execute({ session: 'default', nodes: 30 }, { signal });
      assert.equal(mid.node_budget, 30, 'a legal smaller budget was not honoured');
      const greedy = await tool('browser_inspect').execute({ session: 'default', nodes: 100000 }, { signal });
      assert.equal(greedy.node_budget, config.inspectNodes, 'a huge per-call budget raised the configured limit');
    });
  } finally {
    await tool('browser_close')?.execute({ all: true }, { signal }).catch(() => {});
    await rm(toolProfile, { recursive: true, force: true }).catch(() => {});
  }
}

server.close();
console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
