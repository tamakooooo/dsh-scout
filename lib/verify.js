/**
 * Did the action actually change the page the way it was supposed to?
 *
 * An action reporting `ok` only means the events were dispatched. It says nothing about
 * whether the site accepted them, and the two failure modes are expensive in opposite
 * directions: treating a silent failure as success walks away from work that never
 * happened, and treating an unreadable success as failure retries it — and a retry spends
 * the account's quota again. On a recruiting console "打招呼" is a finite resource.
 *
 * Three verdicts, and the third is the point:
 *
 * - `verified`    — evidence says the page reached the intended state.
 * - `refuted`     — evidence says it did not (an error, a limit, "已打过招呼").
 * - `unconfirmed` — there is nothing to go on either way.
 *
 * `unconfirmed` is never folded into success. The caller stops and hands the decision to a
 * person, which is the only option that cannot spend quota twice.
 *
 * Evidence is gathered deterministically first and only then offered to the decision model,
 * so the common cases cost no tokens at all.
 *
 * @module @local/dsh-jev-browser/lib/verify
 */

import { snapshot } from './page.js';
import { systemOne, readNoul } from './jev.js';

/** Phrases that mean the site accepted the action. */
export const DEFAULT_SUCCESS_PATTERNS = [
  '已打招呼',
  '已沟通',
  '已联系',
  '打招呼成功',
  '发送成功',
  '投递成功',
  '已投递',
  '收藏成功',
  '已收藏',
  '操作成功',
  '提交成功',
  '设置成功',
  '保存成功',
  '关注成功',
];

/** Phrases that mean it did not, or must not be repeated. */
export const DEFAULT_FAILURE_PATTERNS = [
  '操作失败',
  '提交失败',
  '发送失败',
  '投递失败',
  '请稍后重试',
  '系统繁忙',
  '网络异常',
  '已达上限',
  '次数已用完',
  '额度不足',
  '余额不足',
  '没有权限',
  '无权限',
  '不能重复',
  '请勿重复',
  '已打过招呼',
  '已经打过招呼',
];

/** A limit or an error, phrased so a human reading the basis understands it. */
const decode = (text) => String(text == null ? '' : text).trim();

/**
 * Deterministic evidence from the before/after pair.
 *
 * @returns `{ verdict, basis, idempotent }` or null when nothing was conclusive.
 */
function mechanicalEvidence({ before, after, targetLabel, successPatterns, failurePatterns }) {
  const beforeText = `${before?.text ?? ''}\n${before?.title ?? ''}`;
  const afterText = `${after?.text ?? ''}\n${after?.title ?? ''}`;

  // A limit or an outright failure is the strongest signal there is, so it is checked first:
  // "已打过招呼" means the end state already holds, which is a reason never to click again.
  for (const phrase of failurePatterns) {
    if (afterText.toLowerCase().includes(phrase.toLowerCase()) && !beforeText.toLowerCase().includes(phrase.toLowerCase())) {
      const idempotent = /已打过招呼|已经打过招呼|不能重复|请勿重复/.test(phrase);
      return {
        verdict: idempotent ? 'verified' : 'refuted',
        basis: idempotent
          ? `页面显示「${phrase}」——目标状态已成立，不要再点`
          : `页面新增「${phrase}」，说明这次动作没有被接受`,
        idempotent,
      };
    }
  }

  // The target's own label changing is the most specific evidence available: the console
  // swaps 打招呼 for 已打招呼 on the very control that was pressed.
  const recordPrefix = String(targetLabel ?? '').split(' · ')[0];
  const afterLabels = (after?.elements ?? []).map((element) => element.label);
  const changed = afterLabels.find(
    (label) => recordPrefix !== '' && label.includes(recordPrefix) && label !== targetLabel &&
      successPatterns.some((phrase) => label.includes(phrase)),
  );
  if (changed) return { verdict: 'verified', basis: `目标标签变为「${changed}」`, idempotent: false };

  // A success phrase that was not there before, anywhere on the page.
  for (const phrase of successPatterns) {
    if (afterText.toLowerCase().includes(phrase.toLowerCase()) && !beforeText.toLowerCase().includes(phrase.toLowerCase())) {
      return { verdict: 'verified', basis: `页面新增「${phrase}」`, idempotent: false };
    }
  }

  return null;
}

/**
 * Verify one action's effect.
 *
 * @param input - the before/after snapshots, what was done, and the decision credential.
 * @returns `{ verdict, basis, via }` where verdict is verified | refuted | unconfirmed.
 */
export async function verifyAction({
  ctx,
  config,
  action,
  targetLabel,
  text,
  before,
  after,
  signal,
  allowModel = true,
  judge = judgeByModel,
}) {
  const successPatterns = config.successPatterns ?? DEFAULT_SUCCESS_PATTERNS;
  const failurePatterns = config.failurePatterns ?? DEFAULT_FAILURE_PATTERNS;

  const mechanical = mechanicalEvidence({ before, after, targetLabel, successPatterns, failurePatterns });
  if (mechanical) return { ...mechanical, via: 'evidence' };

  // Nothing conclusive on the page, so the decision model gets an explicit success
  // condition to judge — a `noul` over one yes/no statement, which is the cheapest thing
  // that can still be wrong in a useful way.
  const changeSummary = describeChange(before, after);
  if (changeSummary === '') {
    return { verdict: 'unconfirmed', basis: '动作前后页面没有任何可读变化', via: 'none', idempotent: false };
  }

  // A benign click does not get to spend tokens on this: the page's own evidence was
  // already checked, and an inconclusive reading of a panel that simply did not announce
  // itself is not worth a model call — nor worth stopping the run over.
  if (!allowModel) {
    return { verdict: 'unconfirmed', basis: `页面变化不能确定结果（${changeSummary.split('\n')[0].slice(0, 80)}）`, via: 'none', idempotent: false };
  }

  // Whatever the judge does — throw, hang past its timeout, return junk — the result is
  // `unconfirmed`, never an exception and never a silent success. A verification that
  // cannot be made must not take the run down with it, and must not be mistaken for an
  // action that worked.
  try {
    const verdict = await judge({ ctx, config, action, targetLabel, text, changeSummary, signal });
    if (verdict && (verdict.verdict === 'verified' || verdict.verdict === 'refuted' || verdict.verdict === 'unconfirmed')) {
      return verdict;
    }
    return { verdict: 'unconfirmed', basis: '验证未能给出可用的结论', via: 'error', idempotent: false };
  } catch (error) {
    return { verdict: 'unconfirmed', basis: `无法验证：${error?.message ?? error}`, via: 'error', idempotent: false };
  }
}

/**
 * Ask the decision model whether the action achieved its effect.
 *
 * The `noul` question is deliberately narrow — "did this action achieve its intended
 * effect, according to the change above" — because a broad "is the task done" is a
 * different question and belongs to the goal check, not here.
 */
async function judgeByModel({ ctx, config, action, targetLabel, text, changeSummary, signal }) {
  try {
    const { value: apiKey } = await resolveKey(ctx, config);
    const response = await systemOne({
      baseUrl: config.baseUrl,
      apiKey,
      model: config.model,
      state: [
        `ACTION JUST TAKEN: ${action}${targetLabel ? ` on "${targetLabel}"` : ''}${text ? ` with text "${text}"` : ''}`,
        '',
        'WHAT CHANGED ON THE PAGE',
        changeSummary,
        '',
        'QUESTION: judged only by what the page now shows, did that action achieve its intended effect?',
      ].join('\n'),
      questions: {
        satisfied: {
          type: 'noul',
          instructions: `Did the action "${action}"${targetLabel ? ` on "${targetLabel}"` : ''} achieve its intended effect, according to the page change above? Answer no when the page still offers the same action, shows an error, or shows nothing that indicates it was accepted.`,
        },
      },
      timeoutMs: config.requestTimeoutMs,
      signal,
    });
    const probability = readNoul(response.answers, 'satisfied');
    if (typeof probability !== 'number') {
      return { verdict: 'unconfirmed', basis: '判定模型没有给出可用的答案', via: 'jev', idempotent: false };
    }
    const floor = config.verificationFloor ?? 0.6;
    if (probability >= floor) {
      return { verdict: 'verified', basis: `判定模型 noul=${probability.toFixed(2)} 认为已达到预期`, via: 'jev', idempotent: false };
    }
    if (probability <= 1 - floor) {
      return { verdict: 'refuted', basis: `判定模型 noul=${probability.toFixed(2)} 认为未达到预期`, via: 'jev', idempotent: false };
    }
    return {
      verdict: 'unconfirmed',
      basis: `判定模型不确定（noul=${probability.toFixed(2)}），无法确认结果`,
      via: 'jev',
      idempotent: false,
    };
  } catch (error) {
    return { verdict: 'unconfirmed', basis: `无法验证：${error?.message ?? error}`, via: 'error', idempotent: false };
  }
}

/** A short account of what differs, for both the model and the board. */
function describeChange(before, after) {
  const lines = [];
  const beforeText = decode(before?.text);
  const afterText = decode(after?.text);
  if (before?.url !== after?.url) lines.push(`url: ${before?.url ?? ''} -> ${after?.url ?? ''}`);
  if (beforeText !== afterText) {
    lines.push(`text before: ${beforeText.slice(0, 500) || '(empty)'}`);
    lines.push(`text after: ${afterText.slice(0, 500) || '(empty)'}`);
  }
  const beforeLabels = new Set((before?.elements ?? []).map((element) => element.label));
  const appeared = (after?.elements ?? []).map((element) => element.label).filter((label) => !beforeLabels.has(label));
  const afterLabels = new Set((after?.elements ?? []).map((element) => element.label));
  const vanished = (before?.elements ?? []).map((element) => element.label).filter((label) => !afterLabels.has(label));
  if (appeared.length > 0) lines.push(`controls appeared: ${appeared.slice(0, 8).join(' | ')}`);
  if (vanished.length > 0) lines.push(`controls gone: ${vanished.slice(0, 8).join(' | ')}`);
  if (before?.digest !== undefined && before.digest === after?.digest) return '';
  return lines.join('\n');
}

/** Resolve the credential through the same path the act loop uses. */
async function resolveKey(ctx, config) {
  const { resolveApiKey } = await import('./jev.js');
  return resolveApiKey(ctx, config.apiKeyEnv);
}

/**
 * Take the post-action reading.
 *
 * @returns the snapshot to judge against, or null when it could not be taken.
 */
export async function readAfterState(session, config, pacing) {
  try {
    return await snapshot(session.cdp, session.sessionId, {
      maxElements: config.maxElements,
      maxStateChars: config.maxStateChars,
      riskPatternSource: pacing?.riskPatternSource ?? '',
    });
  } catch {
    return null;
  }
}
