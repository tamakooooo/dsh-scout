/**
 * Politeness policy — the part of "don't get flagged" that is actually under a
 * client's control.
 *
 * What a site's risk control actually measures is behaviour: how fast actions arrive,
 * how many there are, whether they look like a person reading a page. It does not
 * measure which Chrome binary is running. So this module owns the behaviour:
 *
 * - randomized inter-action delay, so no two actions land on a metronome;
 * - a per-session budget of state-changing actions, with a forced cooldown every N;
 * - detection of a risk or verification page, which stops the run immediately;
 * - a stop-and-ask gate in front of actions that have real consequences, matched on
 *   the target's own label rather than on the action kind — clicking "下一页" and
 *   clicking "打招呼" are the same `click` to the decision layer but not to the user.
 *
 * What it deliberately does not do is hide that a browser is automated: fingerprint
 * spoofing, `navigator.webdriver` patching, captcha solving, and proxy rotation are
 * detection evasion, they break constantly, and a plugin has no business shipping them.
 * The reliable way to look like a person is to go at a person's pace.
 *
 * @module @local/dsh-jev-browser/lib/pacing
 */

import { randomUUID } from 'node:crypto';

import { sleep } from './browser.js';

/** Labels are only unique within a page; approvals also name the call and action. */
const approvalKey = (info) => JSON.stringify(
  ['session', 'tab', 'url', 'goal', 'action', 'target', 'href', 'textHash'].map((field) => String(info?.[field] ?? '')),
);

/** Labels whose click spends money, sends a message, or commits a decision. */
export const DEFAULT_CONSEQUENTIAL_PATTERNS = [
  '打招呼',
  '立即沟通',
  '发起沟通',
  '拨打电话',
  '打电话',
  '拨打',
  '发送',
  '发送消息',
  '投递',
  '邀请',
  '邀约',
  '面试',
  '录用',
  '确认',
  '确认提交',
  '提交',
  '保存并提交',
  '支付',
  '付款',
  '购买',
  '充值',
  '删除',
  '注销',
  '解绑',
  '退出登录',
];

/** Text that means the site has already pushed back. */
export const DEFAULT_RISK_SIGNALS = [
  '验证码',
  '安全验证',
  '请完成验证',
  '人机验证',
  '拖动滑块',
  '滑块验证',
  '操作过于频繁',
  '操作频繁',
  '访问受限',
  '账号异常',
  '账号被限制',
  '系统检测到',
  '请稍后再试',
  'captcha',
  'verify you are human',
  'unusual traffic',
  'too many requests',
];

/** Build one case-insensitive alternation over literal patterns. */
function toRegExp(patterns) {
  const escaped = (Array.isArray(patterns) ? patterns : [])
    .filter((pattern) => typeof pattern === 'string' && pattern.trim() !== '')
    .map((pattern) => pattern.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return null;
  return new RegExp(escaped.join('|'), 'i');
}

export class Pacing {
  #config;
  #consequential;
  #risk;
  /**
   * Scoped actions a human authorized out of band, each with an expiry.
   *
   * The gate exists so a person decides before quota is spent, and it should not matter
   * *where* that person is. Without this the only place to answer was the conversation,
   * which made the confirmation a conversation-shaped thing rather than a decision. A
   * grant is consumed by the action it authorizes, so approving once authorizes once.
   */
  #grants = new Map();
  /**
   * The actions awaiting a human decision, one per session.
   *
   * One slot per session, not one slot overall. With several named sessions working at once,
   * a single slot meant the second stop silently replaced the first: its grant could then
   * never be issued, because granting requires a pending decision that matches, so the first
   * session waited forever behind a decision nobody could still see. Keying by session keeps
   * every stop addressable; the decision id is what routes an answer to the right one.
   */
  #pendings = new Map();
  /** Serializes quota-bearing actions across sessions; see {@link withQuotaLock}. */
  #quotaChain = Promise.resolve();
  /**
   * Monotonic order for pending decisions.
   *
   * `at` alone cannot order two stops raised in the same millisecond, and "the newest" is
   * what a single-decision caller reads, so it has to be well defined rather than an
   * accident of Map insertion order.
   */
  #pendingSeq = 0;

  /** @param config - the resolved plugin config. */
  constructor(config) {
    this.#config = config;
    this.#consequential = toRegExp(config.consequentialPatterns);
    this.#risk = toRegExp(config.riskSignals);
  }

  /** The pending decision for one session, or null. */
  pendingFor(session) {
    const found = this.#pendings.get(String(session ?? ''));
    return found ? { ...found } : null;
  }

  /** Every pending decision, newest first, so a board can render all of them. */
  get pendings() {
    return [...this.#pendings.values()]
      .sort((a, b) => b.seq - a.seq)
      .map((entry) => ({ ...entry }));
  }

  /** Find one pending decision by its id, which is what an answer carries. */
  #byId(id) {
    if (id === undefined || id === null || id === '') return null;
    for (const entry of this.#pendings.values()) if (entry.id === id) return entry;
    return null;
  }

  /**
   * Authorize one action on `label`, once.
   * @param label - the exact target label the gate reported.
   * @param ttlMs - how long the authorization stays usable.
   * @param id - pending decision id, so a stale panel cannot approve a replacement.
   */
  grant(label, ttlMs = 900000, id) {
    // The id names the decision; without one, fall back to the label so a caller that only
    // knows the target (an older panel, a test) still works when exactly one matches.
    const pending = this.#byId(id) ?? [...this.#pendings.values()].find((entry) => entry.target === String(label));
    if (!pending || pending.target !== String(label) || (id !== undefined && id !== '' && pending.id !== id)) return false;
    this.#grants.set(approvalKey(pending), Date.now() + ttlMs);
    pending.authorized = true;
    return true;
  }

  /** A conversation reply can approve only the preceding stop in this same call context. */
  confirmPending({ session, tab, goal }) {
    const pending = this.#pendings.get(String(session ?? ''));
    if (!pending || pending.session !== session || pending.tab !== tab || pending.goal !== goal) return false;
    if (Date.now() - pending.at >= 900000) return false;
    return this.grant(pending.target, 900000, pending.id);
  }

  /** Rejecting an approved step also revokes its unused grant. */
  deny(label, id) {
    const pending = this.#byId(id) ?? [...this.#pendings.values()].find((entry) => entry.target === String(label));
    if (!pending || pending.target !== String(label) || (id !== undefined && id !== '' && pending.id !== id)) return false;
    this.clearPending(pending.session);
    return true;
  }

  /**
   * Spend a grant for the full action context, if one is live.
   *
   * One-shot on purpose: an authorization names one action on one target, so a stale
   * click must not quietly become standing permission for every later greeting.
   *
   * @returns whether the grant existed and was consumed.
   */
  consumeGrant(info) {
    const key = approvalKey(info);
    const expiry = this.#grants.get(key);
    if (expiry === undefined) return false;
    this.#grants.delete(key);
    if (expiry <= Date.now()) return false;
    if (this.#pendings.has(String(info?.session ?? '')) && approvalKey(this.#pendings.get(String(info.session))) === key) {
      this.clearPending(info.session);
    }
    return true;
  }

  /** Record what the gate is waiting on, so a viewer can render the decision. */
  setPending(info) {
    if (info === null || info === undefined) return;
    // Replace only this session's stop. Another session's stop is a different decision with
    // its own id, and clearing it is what used to make a grant unissuable.
    this.clearPending(info.session);
    this.#pendings.set(String(info.session ?? ''), { ...info, id: randomUUID(), at: Date.now(), seq: ++this.#pendingSeq });
  }

  /**
   * The most recently raised pending decision, or null.
   *
   * Kept for callers that show a single decision; with several sessions there can be more
   * than one, so anything rendering a list should read {@link pendings}.
   */
  get pending() {
    return this.pendings[0] ?? null;
  }

  /** Forget one session's pending decision, or all of them. */
  clearPending(session) {
    if (session === undefined) {
      for (const entry of this.#pendings.values()) this.#grants.delete(approvalKey(entry));
      this.#pendings.clear();
      return;
    }
    const key = String(session ?? '');
    const entry = this.#pendings.get(key);
    if (entry) this.#grants.delete(approvalKey(entry));
    this.#pendings.delete(key);
  }

  /**
   * Run one quota-bearing action to completion before another session may start one.
   *
   * Four sessions reading in parallel is the point of named sessions. Four sessions greeting
   * at once is not: the account's finite chat quota is one resource, and a burst from four
   * tabs at the same instant is exactly the shape a site's risk control watches for. Reads
   * stay parallel; the actions that spend something take turns.
   *
   * FIFO, and the queue is bounded by the operation's own CDP timeouts — a wedged action
   * delays the ones behind it, it does not deadlock them.
   */
  async withQuotaLock(operation) {
    const previous = this.#quotaChain;
    let release;
    this.#quotaChain = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Create the per-session counters on first use. */
  static counters(session) {
    if (!Number.isInteger(session.actionsTaken)) session.actionsTaken = 0;
    if (!Number.isInteger(session.cooldowns)) session.cooldowns = 0;
    return session;
  }

  /**
   * Whether the session may still change server state.
   * @returns `{ allowed, reason }`.
   */
  checkBudget(session) {
    Pacing.counters(session);
    const limit = this.#config.maxActionsPerSession;
    if (limit > 0 && session.actionsTaken >= limit) {
      return {
        allowed: false,
        reason: `this session has already performed ${session.actionsTaken} state-changing actions, its configured limit of ${limit}`,
      };
    }
    return { allowed: true, reason: '' };
  }

  /**
   * The risk pattern's source, so the match can run inside the page over its whole text
   * instead of in the Host over the truncated copy.
   */
  get riskPatternSource() {
    return this.#risk ? this.#risk.source : '';
  }

  /**
   * The risk or verification signal present on this page.
   * @returns the matched phrase, or `null`.
   */
  riskSignal(page) {
    if (!this.#config.stopOnRiskPage || !this.#risk) return null;
    // The page matches its own *whole* text and reports what it found; the text handed to
    // the decision layer is truncated to a budget, and a verification wall appended to the
    // end of a long page falls outside it. Matching here is the fallback, so a page object
    // built by hand — tests, older callers — keeps working.
    if (typeof page?.riskSignal === 'string' && page.riskSignal !== '') return page.riskSignal;
    const haystack = `${page?.title ?? ''}\n${page?.text ?? ''}`;
    const match = this.#risk.exec(haystack);
    return match ? match[0] : null;
  }

  /**
   * Whether acting on this label needs explicit human authorization.
   * @param label - the target element's label, as the snapshot rendered it.
   */
  isConsequential(label) {
    if (!this.#config.requireConfirmation || !this.#consequential) return false;
    return this.#consequential.test(String(label ?? ''));
  }

  /**
   * Wait the randomized inter-action delay, and the periodic cooldown.
   * @param session - the session whose counters advance.
   * @param mutating - whether this action changed state worth budgeting.
   */
  async afterAction(session, mutating) {
    Pacing.counters(session);
    // Stamped even for a non-mutating step: the board's "idle" figure is about when this
    // session last *did* anything, not only when it last spent budget.
    session.lastActionAt = Date.now();
    const min = this.#config.minActionDelayMs;
    const max = Math.max(min, this.#config.maxActionDelayMs);
    await sleep(Math.round(min + Math.random() * (max - min)));
    if (!mutating) return;
    session.actionsTaken += 1;
    const every = this.#config.cooldownEveryActions;
    if (every > 0 && session.actionsTaken % every === 0) {
      session.cooldowns += 1;
      await sleep(this.#config.cooldownMs);
    }
  }

  /** Human-readable summary of this session's budget use, for the run report. */
  describe(session) {
    Pacing.counters(session);
    const limit = this.#config.maxActionsPerSession;
    return `${session.actionsTaken}${limit > 0 ? `/${limit}` : ''} state-changing actions, ${session.cooldowns} cooldown(s) taken`;
  }
}
