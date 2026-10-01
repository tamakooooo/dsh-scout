/**
 * Result verification: did the action actually change the page the way it was meant to?
 *
 * Offline and deterministic — the page states are fabricated, and the model judge is
 * injected, so nothing here touches the network or a browser. What is being tested is the
 * decision logic, which is the part that decides whether quota gets spent twice.
 *
 * Run: node test/verify-check.mjs
 */

import { verifyAction, DEFAULT_SUCCESS_PATTERNS, DEFAULT_FAILURE_PATTERNS } from '../lib/verify.js';

const problems = [];
const check = (label, passed, detail = '') => {
  if (passed) console.log(`  PASS  ${label}`);
  else {
    problems.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const config = {
  successPatterns: DEFAULT_SUCCESS_PATTERNS,
  failurePatterns: DEFAULT_FAILURE_PATTERNS,
  verificationFloor: 0.6,
};

const page = (over = {}) => ({
  url: 'https://example.test/list',
  title: '推荐人才',
  text: '饶先生 质量工程师 打招呼',
  elements: [{ ref: 'e1', role: 'button', label: '饶先生 · 打招呼', value: '', href: '' }],
  ...over,
});

// The stub honours `verificationFloor` from the config it is handed, because that is part
// of the judge's contract — otherwise the threshold assertions below would pass or fail for
// reasons that have nothing to do with the code under test.
const judge = (probability) => async ({ config: given }) => {
  const floor = given?.verificationFloor ?? 0.6;
  return {
    verdict: probability >= floor ? 'verified' : probability <= 1 - floor ? 'refuted' : 'unconfirmed',
    basis: `stub noul=${probability}`,
    via: 'jev',
    idempotent: false,
  };
};

const verify = (before, after, options = {}) =>
  verifyAction({ config, action: 'click', targetLabel: '饶先生 · 打招呼', before, after, ...options });

// ── deterministic evidence, no model call ────────────────────────────────────
console.log('=== evidence decides without spending tokens ===');
{
  const labelChanged = await verify(
    page(),
    page({ text: '饶先生 质量工程师 已打招呼', elements: [{ ref: 'e1', role: 'button', label: '饶先生 · 已打招呼', value: '', href: '' }] }),
    { judge: () => { throw new Error('the model must not be consulted'); } },
  );
  check('a swapped control proves the action landed', labelChanged.verdict === 'verified', JSON.stringify(labelChanged));
  check('and the basis names the label', labelChanged.basis.includes('已打招呼'), labelChanged.basis);
  check('via evidence, not the model', labelChanged.via === 'evidence');

  const toast = await verify(
    page(),
    page({ text: '饶先生 质量工程师 打招呼 打招呼成功', elements: [] }),
    { judge: () => { throw new Error('the model must not be consulted'); } },
  );
  check('a new success phrase proves it too', toast.verdict === 'verified', JSON.stringify(toast));
  check('and the basis quotes it', toast.basis.includes('打招呼成功'), toast.basis);

  const failed = await verify(
    page(),
    page({ text: '饶先生 质量工程师 打招呼 操作失败，请稍后重试' }),
    { judge: () => { throw new Error('the model must not be consulted'); } },
  );
  check('an error phrase refutes it', failed.verdict === 'refuted', JSON.stringify(failed));
  check('and the basis quotes the error', failed.basis.includes('操作失败'), failed.basis);
}

// ── the case that must never be clicked twice ────────────────────────────────
console.log('\n=== an already-handled target ===');
{
  const done = await verify(
    page(),
    page({ text: '饶先生 质量工程师 已打过招呼' }),
    { judge: () => { throw new Error('the model must not be consulted'); } },
  );
  check('"已打过招呼" counts as the end state, not a failure', done.verdict === 'verified', JSON.stringify(done));
  check('and is flagged so the caller never clicks it again', done.idempotent === true);
  check('the basis says so plainly', done.basis.includes('不要再点'), done.basis);

  // A phrase already present before the action is not evidence of this action.
  const preexisting = await verify(
    page({ text: '页面说明：已打过招呼的候选人不再显示按钮' }),
    page({ text: '页面说明：已打过招呼的候选人不再显示按钮 其他内容变了' }),
    { judge: judge(0.9) },
  );
  check('a phrase that was already there is not evidence', preexisting.via !== 'evidence', JSON.stringify(preexisting));
}

// ── nothing on the page either way ───────────────────────────────────────────
console.log('\n=== nothing to go on ===');
{
  const unchanged = await verify(page(), page(), { judge: () => { throw new Error('nothing changed; the model cannot help'); } });
  check('an unchanged page is unconfirmed', unchanged.verdict === 'unconfirmed', JSON.stringify(unchanged));
  check('and says why', unchanged.basis.includes('没有任何可读变化'), unchanged.basis);

  const unsure = await verify(page(), page({ text: '饶先生 质量工程师 打招呼 处理中' }), { judge: judge(0.5) });
  check('a model that is unsure stays unconfirmed', unsure.verdict === 'unconfirmed', JSON.stringify(unsure));
  check('so it is not quietly treated as success', unsure.verdict !== 'verified');

  const high = await verify(page(), page({ text: '饶先生 质量工程师 打招呼 处理中' }), { judge: judge(0.9) });
  check('a confident model verifies', high.verdict === 'verified', JSON.stringify(high));
  check('and the basis is the judge\'s own account', high.via === 'jev' && high.basis.length > 0, high.basis);

  const low = await verify(page(), page({ text: '饶先生 质量工程师 打招呼 处理中' }), { judge: judge(0.1) });
  check('a confident model refutes', low.verdict === 'refuted', JSON.stringify(low));

  const broken = await verify(page(), page({ text: '饶先生 质量工程师 打招呼 处理中' }), {
    judge: () => { throw new Error('socket closed'); },
  });
  check('a judge that throws degrades to unconfirmed rather than success', broken.verdict === 'unconfirmed', JSON.stringify(broken));

  const unreadable = await verify(page(), null);
  check('an unreadable page is unconfirmed', unreadable.verdict === 'unconfirmed', JSON.stringify(unreadable));
}

// ── the floor is configurable ────────────────────────────────────────────────
console.log('\n=== the threshold ===');
{
  const strict = await verify(page(), page({ text: '饶先生 打招呼 处理中' }), { config: { ...config, verificationFloor: 0.95 }, judge: judge(0.9) });
  check('raising the floor can downgrade a verdict to unconfirmed', strict.verdict === 'unconfirmed', JSON.stringify(strict));
  const loose = await verify(page(), page({ text: '饶先生 打招呼 处理中' }), { config: { ...config, verificationFloor: 0.5 }, judge: judge(0.9) });
  check('and it still verifies what it should', loose.verdict === 'verified', JSON.stringify(loose));
}

console.log(`\n===== ${problems.length} problem(s) =====`);
for (const problem of problems) console.log(`  !! ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
