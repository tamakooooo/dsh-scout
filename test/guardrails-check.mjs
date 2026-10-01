/**
 * Guardrail checks — run with any Node 22+: `node test/guardrails-check.mjs`.
 *
 * Two halves. The deterministic half exercises the pacing policy directly. The live
 * half proves the two stops that protect an account actually fire: a risk page halts
 * the run before any decision is even requested, and a consequential target is
 * reported instead of clicked until the caller authorizes it.
 *
 * The live half needs COMMANDCODE_API_KEY and a Chromium-family browser.
 */

import './isolate.mjs';
import { fileURLToPath } from 'node:url';

import { Sessions } from '../lib/sessions.js';
import { resolveConfig } from '../index.js';
import { navigate, snapshot } from '../lib/page.js';
import { runGoal } from '../lib/act.js';
import { Pacing } from '../lib/pacing.js';

const fixture = (name) => `file://${fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))}`;
const problems = [];
const check = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${condition || !detail ? '' : ` — ${detail}`}`);
  if (!condition) problems.push(label);
};

// ── deterministic half ──────────────────────────────────────────────────────
console.log('=== pacing policy ===');
const policy = new Pacing(resolveConfig({ minActionDelayMs: 5, maxActionDelayMs: 10, maxActionsPerSession: 2, cooldownEveryActions: 0 }));

check('greeting a candidate is consequential', policy.isConsequential('徐先生 · 打招呼'));
check('a phone reveal is consequential', policy.isConsequential('周先生 · 打电话'));
check('plain paging is not', !policy.isConsequential('下一页'));
check('a bare link is not', !policy.isConsequential('Help'));
check('the label is what decides, not the action', policy.isConsequential('立即沟通') && !policy.isConsequential('查看简历'));

check('a captcha page is a risk page', policy.riskSignal({ title: '安全验证', text: '请完成验证后继续' }) === '安全验证');
check('a rate-limit notice is a risk page', policy.riskSignal({ title: '', text: '您的操作过于频繁，请稍后再试' }) === '操作过于频繁');
check('a clean page is not', policy.riskSignal({ title: '推荐人才', text: '徐先生 31岁 9年' }) === null);

const counters = Pacing.counters({});
check('budget allows the first action', policy.checkBudget(counters).allowed);
await policy.afterAction(counters, true);
check('one action consumed one unit', counters.actionsTaken === 1, String(counters.actionsTaken));
await policy.afterAction(counters, false);
check('a non-mutating action costs nothing', counters.actionsTaken === 1, String(counters.actionsTaken));
await policy.afterAction(counters, true);
const spent = policy.checkBudget(counters);
check('budget refuses past the limit', !spent.allowed, spent.reason);

const cooldownPolicy = new Pacing(resolveConfig({ minActionDelayMs: 1, maxActionDelayMs: 2, maxActionsPerSession: 0, cooldownEveryActions: 2, cooldownMs: 1 }));
const cooldownCounters = Pacing.counters({});
await cooldownPolicy.afterAction(cooldownCounters, true);
check('no cooldown before the interval', cooldownCounters.cooldowns === 0);
await cooldownPolicy.afterAction(cooldownCounters, true);
check('cooldown taken on the interval', cooldownCounters.cooldowns === 1);
check('maxActionsPerSession 0 means unlimited', cooldownPolicy.checkBudget({ actionsTaken: 5000 }).allowed);

// ── live half ───────────────────────────────────────────────────────────────
const config = resolveConfig({
  headless: true,
  minActionDelayMs: 30,
  maxActionDelayMs: 60,
  cooldownEveryActions: 0,
  maxActionsPerSession: 20,
  maxSteps: 4,
  maxStateChars: 2500,
});
const sessions = new Sessions(config);
const ctx = { get: () => undefined };
const signal = new AbortController().signal;

try {
  console.log('\n=== a risk page halts before any decision ===');
  const risky = await sessions.ensure('risk', { headless: true });
  await navigate(risky.cdp, risky.sessionId, fixture('risk.html'));
  const riskReport = await runGoal({ ctx, config, session: risky, goal: '继续操作', signal });
  check('stopped with risk_page_detected', riskReport.status === 'risk_page_detected', riskReport.status);
  check('no step was decided (no Jev call, no click)', riskReport.steps_taken === 0, String(riskReport.steps_taken));
  check('the note names the signal', /安全验证|验证码/.test(riskReport.note), riskReport.note);

  console.log('\n=== a consequential target needs authorization ===');
  const cards = await sessions.ensure('cards', { headless: true });
  await navigate(cards.cdp, cards.sessionId, fixture('cards.html'));
  const goal = '向徐先生打招呼（点击他那张卡片上的打招呼按钮）';

  const gated = await runGoal({ ctx, config, session: cards, goal, signal });
  check('stopped with needs_confirmation', gated.status === 'needs_confirmation', gated.status);
  check('the note names the target', /打招呼/.test(gated.note), gated.note);
  check('nothing was executed', cards.actionsTaken === 0 || cards.actionsTaken === undefined, String(cards.actionsTaken));
  const after = await snapshot(cards.cdp, cards.sessionId, { maxElements: 30, maxStateChars: 400 });
  check('the page was left untouched', after.url === fixture('cards.html') && after.elements.length === 19, `${after.elements.length} elements`);

  console.log('\n=== the same goal proceeds once authorized ===');
  const authorized = await runGoal({ ctx, config, session: cards, goal, text: undefined, maxSteps: 1, confirm: true, signal });
  check('it executed a step', authorized.steps_taken >= 1 && (cards.actionsTaken ?? 0) >= 1, `actions=${cards.actionsTaken}`);
  check('it did not stop for confirmation again', authorized.status !== 'needs_confirmation', authorized.status);
  console.log(`  (authorized run ended as ${authorized.status})`);
} catch (error) {
  problems.push(`harness threw: ${error?.message ?? error}`);
  console.error(error);
} finally {
  await sessions.closeAll().catch(() => {});
}

console.log(`\n===== ${problems.length} problem(s) =====`);
for (const problem of problems) console.log('  !! ' + problem);
process.exitCode = problems.length === 0 ? 0 : 1;
