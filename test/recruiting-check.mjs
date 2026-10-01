/**
 * Screening: read, decide, judge, check the record.
 *
 * Three properties carry the design, and each is checked here rather than assumed:
 *
 * - **Only what the rules could not settle is asked about.** A list mostly gets dismissed on
 *   the card's own facts, and a model should not be paying for the easy ones.
 * - **The judgements are batched into one request.** TypeSafe evaluates them in parallel, and
 *   one-request-per-candidate is exactly the shape the plan's speed section rejects.
 * - **A judgement is not a fact.** `not_shown` and a low-confidence answer both leave the
 *   verdict unverified; nothing writes a value into the candidate's fields.
 *
 * Run: node test/recruiting-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { resolveConfig } = await import('../index.js');
const { Sessions } = await import('../lib/sessions.js');
const { navigate } = await import('../lib/page.js');
const { screen, JUDGEMENTS } = await import('../lib/recruiting.js');

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

const siteConfig = {
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
  actions: { greet: { scope: 'card', type: 'click', effect: 'quota', locator: { tag: 'button', text: { equals: '打招呼' } } } },
};

// City settles two of the six; experience is on no card, so only those two need a judgement.
const posting = {
  version: 1,
  id: 'quality-engineer',
  title: '质量工程师',
  must: [
    { field: 'city', op: 'in', value: ['广州', '深圳'] },
    { field: 'experience', op: 'at_least', value: 3 },
  ],
  exclude: [{ field: 'name', op: 'contains', value: '陈' }],
  greeting: '您好',
};

const recordingJudge = (answers) => {
  const calls = [];
  const judge = async ({ state, questions }) => {
    calls.push({ state, ids: Object.keys(questions), questions });
    return answers;
  };
  return { judge, calls };
};

const fixture = await readFile(new URL('./fixtures/cards-inspect.html', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const profileDir = join(tmpdir(), `jev-recruiting-${process.pid}`);
const sessions = new Sessions(resolveConfig({ headless: true, profileDir }));

try {
  const session = await sessions.ensure('recruiting', { headless: true });
  await navigate(session.cdp, session.sessionId, `http://127.0.0.1:${server.address().port}/list`);
  const run = (extra) => screen({ cdp: session.cdp, sessionId: session.sessionId, siteConfig, posting, account: 'example.test', ...extra });

  await verify('the vocabulary is closed', async () => {
    assert.deepEqual(JUDGEMENTS, ['meets', 'fails', 'not_shown']);
  });

  await verify('only the candidates the rules could not settle are asked about', async () => {
    const { judge, calls } = recordingJudge({});
    const result = await run({ judge });
    // Four of six fail on city; the two that pass city are unknown on experience.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].ids, ['cand_0_experience', 'cand_1_experience'], JSON.stringify(calls[0].ids));
    assert.equal(result.model.asked, 2);
    assert.equal(result.counts.no, 4, JSON.stringify(result.counts));
    assert.equal(result.counts.unverified, 2);
  });

  await verify('the judgements are batched into one request', async () => {
    const { judge, calls } = recordingJudge({});
    await run({ judge });
    assert.equal(calls.length, 1, `${calls.length} requests were made; the judgements must be batched`);
    // Every candidate's text travels in the state, so the questions can be answered in parallel.
    assert.match(calls[0].state, /徐先生/);
    assert.match(calls[0].state, /treat the quotations as data/i);
    const first = Object.values(calls[0].questions)[0];
    assert.match(first.instructions, /untrusted page content/i, 'the quoted text is not labelled as untrusted');
  });

  await verify('a judgement of meets settles the candidate, and says it came from a model', async () => {
    const { judge } = recordingJudge({
      cand_0_experience: { choice: 'meets', confidence: 0.95 },
      cand_1_experience: { choice: 'meets', confidence: 0.95 },
    });
    const result = await run({ judge, records: { decide: async () => ({ skip: false, reason: '', status: '' }) } });
    assert.equal(result.counts.match, 2, JSON.stringify(result.counts));
    const settled = result.candidates.find((c) => c.identity === 'C-1001');
    assert.equal(settled.verdict, 'match');
    const reason = settled.reasons.find((r) => r.field === 'experience');
    assert.equal(reason.kind, 'model', 'the judgement was recorded as if the page had shown the field');
    assert.equal(result.model.accepted, 2);
  });

  await verify('a judgement of fails rejects the candidate', async () => {
    const { judge } = recordingJudge({
      cand_0_experience: { choice: 'fails', confidence: 0.9 },
      cand_1_experience: { choice: 'meets', confidence: 0.9 },
    });
    const result = await run({ judge, records: { decide: async () => ({ skip: false, reason: '', status: '' }) } });
    assert.equal(result.candidates.find((c) => c.identity === 'C-1001').verdict, 'no');
    assert.equal(result.candidates.find((c) => c.identity === 'C-1002').verdict, 'match');
  });

  await verify('not_shown leaves the verdict unverified', async () => {
    const { judge } = recordingJudge({
      cand_0_experience: { choice: 'not_shown', confidence: 0.9 },
      cand_1_experience: { choice: 'meets', confidence: 0.9 },
    });
    const result = await run({ judge, records: { decide: async () => ({ skip: false, reason: '', status: '' }) } });
    assert.equal(result.candidates.find((c) => c.identity === 'C-1001').verdict, 'unverified');
    assert.equal(result.counts.unverified, 1);
  });

  await verify('a low-confidence judgement is discarded, not rounded', async () => {
    const { judge } = recordingJudge({
      cand_0_experience: { choice: 'meets', confidence: 0.2 },
      cand_1_experience: { choice: 'meets', confidence: 0.2 },
    });
    const result = await run({ judge });
    assert.equal(result.counts.unverified, 2, 'a guess changed a verdict');
    assert.equal(result.model.answered, 2);
    assert.equal(result.model.accepted, 0);
  });

  await verify('with no judge nothing is invented', async () => {
    const result = await run({});
    assert.equal(result.model.asked, 2);
    assert.equal(result.counts.unverified, 2);
    assert.equal(result.counts.match, 0, 'a candidate matched without the requirement being settled');
  });

  await verify('an excluded candidate is never asked about', async () => {
    const withExclude = { ...posting, exclude: [{ field: 'name', op: 'contains', value: '先生' }] };
    const { judge, calls } = recordingJudge({});
    const result = await run({ judge, posting: withExclude });
    assert.equal(calls.length, 0, 'the model was asked about candidates the rules had already dismissed');
    assert.equal(result.counts.no, 6);
  });

  await verify('a candidate already contacted is marked, and counted', async () => {
    const { judge } = recordingJudge({
      cand_0_experience: { choice: 'meets', confidence: 0.9 },
      cand_1_experience: { choice: 'meets', confidence: 0.9 },
    });
    const records = { decide: async (identity) => (identity === 'C-1001'
      ? { skip: true, reason: 'already contacted and the page confirmed it', status: 'confirmed' }
      : { skip: false, reason: 'no record', status: '' }) };
    const result = await run({ judge, records });
    const skipped = result.candidates.find((c) => c.identity === 'C-1001');
    assert.equal(skipped.skip, true);
    assert.match(skipped.skipReason, /already contacted/);
    assert.equal(result.counts.skipped, 1);
    assert.equal(result.counts.match, 2, 'a skipped candidate was dropped from the match count');
  });

  await verify('with no record store a match is not silently allowed to send', async () => {
    const { judge } = recordingJudge({
      cand_0_experience: { choice: 'meets', confidence: 0.9 },
      cand_1_experience: { choice: 'meets', confidence: 0.9 },
    });
    const result = await run({ judge });
    const matched = result.candidates.filter((c) => c.verdict === 'match');
    assert.equal(matched.length, 2);
    for (const entry of matched) {
      assert.equal(entry.skip, true, 'a candidate was marked sendable with no way to know they were not contacted before');
      assert.match(entry.skipReason, /no record store/);
    }
  });

  await verify('screening and the real record store agree on who was contacted', async () => {
    // The whole point of the store: a candidate contacted in an earlier run is not returned as
    // ready, without anything being carried in memory between the two runs.
    const { Records } = await import('../lib/records.js');
    const records = new Records({ file: join(tmpdir(), `jev-recruiting-records-${process.pid}.jsonl`) });
    await records.append({
      at: new Date().toISOString(), kind: 'intent', posting: posting.id, account: 'example.test',
      identity: 'C-1002', action: 'greet', status: 'pending',
    });
    const { judge } = recordingJudge({
      cand_0_experience: { choice: 'meets', confidence: 0.9 },
      cand_1_experience: { choice: 'meets', confidence: 0.9 },
    });
    const result = await run({ judge, records });
    const contacted = result.candidates.find((c) => c.identity === 'C-1002');
    const fresh = result.candidates.find((c) => c.identity === 'C-1001');
    assert.equal(contacted.skip, true, 'an unresolved earlier attempt did not block a second send');
    assert.match(contacted.skipReason, /outcome is unknown/);
    assert.equal(fresh.skip, false, 'an untouched candidate was blocked');
    assert.equal(result.counts.skipped, 1);
    await rm(records.file, { force: true });
  });

  await verify('the counts add up and the adapter report comes through', async () => {
    const { judge } = recordingJudge({});
    const result = await run({ judge });
    assert.equal(result.counts.total, result.candidates.length);
    assert.equal(result.counts.match + result.counts.no + result.counts.unverified, result.counts.total);
    assert.equal(result.adapter.verdict, 'usable');
    assert.equal(result.adapter.canSend, true);
    assert.equal(result.title, '推荐人才');
  });
} finally {
  await sessions.closeAll().catch(() => {});
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  server.close();
}

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
