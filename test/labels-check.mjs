/**
 * Contextual element labelling check — run with any Node 22+: `node test/labels-check.mjs`.
 *
 * Two fixtures, on purpose. The first is a tidy synthetic page; the second reproduces
 * the structure the plugin was actually verified against on a live employer console,
 * where the tidy assumptions did not hold:
 *
 * - the name is nested inside several wrappers and **several** elements match a
 *   name-ish selector, so an "exactly one name" rule never fires;
 * - the greeting button sits three wrappers deeper than the phone button, so a shallow
 *   ancestor walk finds the name for one and not the other;
 * - a radio group carries a generated `name` that is not a label;
 * - an icon-only button has no text, no aria-label and no sprite.
 *
 * The first fixture passed while the live page failed. That is why both exist.
 */

import './isolate.mjs';
import { fileURLToPath } from 'node:url';

import { Sessions } from '../lib/sessions.js';
import { resolveConfig } from '../index.js';
import { navigate, snapshot } from '../lib/page.js';

const fixture = (name) => `file://${fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))}`;

const problems = [];
const check = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${condition || !detail ? '' : ` — ${detail}`}`);
  if (!condition) problems.push(label);
};

const config = resolveConfig({ headless: true });
const sessions = new Sessions(config);

/** Snapshot one fixture and return the labels plus timing. */
async function readFixture(session, name) {
  await navigate(session.cdp, session.sessionId, fixture(name));
  const started = Date.now();
  const page = await snapshot(session.cdp, session.sessionId, { maxElements: 60, maxStateChars: 1500 });
  const elapsed = Date.now() - started;
  console.log(`\n=== ${name} — ${page.elements.length} elements, ${elapsed}ms ===`);
  for (const element of page.elements) console.log(`  ${element.ref.padEnd(4)} ${element.role.padEnd(9)} ${element.label}`);
  if (page.selected.length > 0) console.log(`  selected: ${JSON.stringify(page.selected)}`);
  return { page, elapsed, labels: page.elements.map((element) => element.label), selected: page.selected };
}

try {
  const session = await sessions.ensure('labels', { headless: true });

  // ── the tidy card page ────────────────────────────────────────────────────
  const cards = await readFixture(session, 'cards.html');
  const labels = cards.labels;
  const matching = (needle) => labels.filter((label) => label.includes(needle));

  console.log('\n=== cards.html assertions ===');
  check('one-off controls keep their own label untouched', labels.includes('职位') && labels.includes('聊天'));
  check('every 打招呼 carries a distinct candidate', new Set(matching('打招呼')).size === 3 && matching('打招呼').every((l) => l.includes('先生')));
  check('every 打电话 carries a distinct candidate', new Set(matching('打电话')).size === 3);
  check('an SVG sprite id names its icon button', matching('phone').length === 2, matching('phone').join(' | '));
  check('a second sprite resolves too', matching('wechat').length === 1, matching('wechat').join(' | '));
  check('a descendant aria-label names its icon button', matching('收藏').length === 3);
  check('a signal-free icon button still gets its record', matching('button').length === 3, matching('button').join(' | '));
  check('no label is left dangling', !labels.includes('(no label)'));
  check('no duplicate labels remain', new Set(labels).size === labels.length);
  check('labelling stayed fast', cards.elapsed < 3000, `${cards.elapsed}ms`);

  // ── the structure that broke it ───────────────────────────────────────────
  const nested = await readFixture(session, 'cards-nested.html');
  const deep = nested.labels;
  const deepMatch = (needle) => deep.filter((label) => label.includes(needle));

  console.log('\n=== cards-nested.html assertions ===');
  check('a deeply nested greeting still finds its candidate', deep.includes('梁先生 · 打招呼'), deepMatch('打招呼').join(' | '));
  check('and the second card finds its own', deep.includes('王先生 · 打招呼'), deepMatch('打招呼').join(' | '));
  check('the shallow phone button agrees with it', deep.includes('梁先生 · 打电话') && deep.includes('王先生 · 打电话'));
  check('every button carries a record', deepMatch('button').length === 2, deepMatch('button').join(' | '));
  // The two radios genuinely carry no text, no label element and no accessible name, so
  // "(no label)" is the honest answer — what matters is that the generated `name` is not
  // dressed up as one.
  const dangling = deep.filter((label) => label === '(no label)').length;
  check('only the two text-less radios are label-less', dangling === 2, `${dangling} dangling`);
  check('a generated radio name is not used as a label', !deep.some((label) => /rg-04khvrdsa/.test(label)), deep.filter((l) => /rg-/.test(l)).join(' | '));
  check(
    'no component class became a label',
    !deep.some((label) => /resume|large-screen|km-button|is-width|cv-test|talent-basic|icon-btn/.test(label)),
    deep.filter((l) => /resume|large-screen|km-|is-width|cv-test|talent|icon-btn/.test(l)).join(' | '),
  );
  check('greetings are distinguishable per candidate', new Set(deepMatch('打招呼')).size === 2, deepMatch('打招呼').join(' | '));
  check('labelling stayed fast on the nested page', nested.elapsed < 3000, `${nested.elapsed}ms`);

  // ── labels must not depend on how many elements were sampled ──────────────
  // This is the bug that made the same greeting button carry a candidate prefix at one
  // budget and not at another: ambiguity was judged only over the collected sample, so
  // trimming the budget hid the duplicates and the survivor looked unique.
  console.log('\n=== budget independence ===');
  await navigate(session.cdp, session.sessionId, fixture('cards-nested.html'));
  const tiny = await snapshot(session.cdp, session.sessionId, { maxElements: 2, maxStateChars: 200 });
  const full = await snapshot(session.cdp, session.sessionId, { maxElements: 40, maxStateChars: 200 });
  const tinyLabels = tiny.elements.map((element) => element.label);
  const fullHead = full.elements.slice(0, tinyLabels.length).map((element) => element.label);
  check(
    'labels do not change with the element budget',
    JSON.stringify(tinyLabels) === JSON.stringify(fullHead),
    `${JSON.stringify(tinyLabels)} vs ${JSON.stringify(fullHead)}`,
  );
  check(
    'a per-record action is qualified even when alone in the sample',
    tinyLabels.length > 0 && tinyLabels.every((label) => !/^(打招呼|打电话)$/.test(label)),
    tinyLabels.join(' | '),
  );

  // ── same surname, and buttons with no signal at all ──────────────────────
  console.log('\n=== cards-collision.html ===');
  const collision = await readFixture(session, 'cards-collision.html');
  const same = collision.labels;
  const sameMatch = (needle) => same.filter((label) => label.includes(needle));

  check(
    'two candidates with one surname become two labels',
    same.includes('王先生 42岁 · 打招呼') && same.includes('王先生 37岁 · 打招呼'),
    sameMatch('打招呼').join(' | '),
  );
  check('the age distinguishes their phone buttons too', same.includes('王先生 42岁 · 打电话') && same.includes('王先生 37岁 · 打电话'));
  check('every element ends up uniquely addressable', new Set(same).size === same.length, `${new Set(same).size} unique of ${same.length}`);
  check(
    'an unsignalled icon button falls back to document order',
    same.filter((label) => /· button #\d$/.test(label)).length === 4,
    same.filter((l) => /button #/.test(l)).join(' | '),
  );

  // ── a duplicated action must not become a second, unlabelled target ──────
  console.log('\n=== nested-actions.html ===');
  const dupAction = await readFixture(session, 'nested-actions.html');
  const nestedLabels = dupAction.labels;
  check(
    'a button nested in a button is dropped',
    nestedLabels.some((label) => label.includes('打招呼')) && !nestedLabels.some((label) => /· button( #\d+)?$/.test(label)),
    nestedLabels.join(' | '),
  );
  check(
    'the surviving outer button keeps the consequential word',
    nestedLabels.some((label) => /打招呼$/.test(label)),
    nestedLabels.join(' | '),
  );
  check(
    'a button inside a link is kept, because it is a different action',
    nestedLabels.some((label) => label.includes('收藏')),
    nestedLabels.join(' | '),
  );

  // ── state that lives only in styling, and reachability that lives only in geometry ──
  console.log('\n=== state-marks.html ===');
  const marks = await readFixture(session, 'state-marks.html');
  check(
    'the selected tab is reported even though it is not an interactive element',
    marks.selected.includes('质量工程师'),
    JSON.stringify(marks.selected),
  );
  check(
    'a carousel frame marked --active is not reported as a choice',
    !marks.selected.some((text) => text.includes('500')),
    JSON.stringify(marks.selected),
  );
  check('the unselected tab is not reported', !marks.selected.includes('测试工程师'), JSON.stringify(marks.selected));
  check(
    'an element under an overlay is marked covered',
    marks.labels.some((label) => label.includes('打招呼') && label.includes('[covered]')),
    marks.labels.filter((l) => l.includes('打招呼')).join(' | '),
  );
  check(
    'an element beside the overlay is not marked covered',
    marks.labels.some((label) => label.includes('打招呼') && !label.includes('[covered]')),
    marks.labels.filter((l) => l.includes('打招呼')).join(' | '),
  );
  check(
    'a long label keeps its ordinal and its markers',
    marks.labels.every((label) => label.length <= 120),
    marks.labels.map((l) => l.length).join(','),
  );
} catch (error) {
  problems.push(`harness threw: ${error?.message ?? error}`);
  console.error(error);
} finally {
  await sessions.closeAll().catch(() => {});
}

console.log(`\n===== ${problems.length} problem(s) =====`);
for (const problem of problems) console.log('  !! ' + problem);
process.exitCode = problems.length === 0 ? 0 : 1;
