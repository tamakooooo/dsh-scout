/**
 * One task: screen once, then send from a shared queue across the windows.
 *
 * The shape comes from the plan's speed section and its authorisation section at the same
 * time:
 *
 * - **Reading and judging happen once**, by the owning window, because they are the expensive
 *   part and every window would otherwise repeat them. The judgement is batched into a single
 *   request inside `screen`.
 * - **Sending is serialised across windows** through the pacing module's quota lock. Reading
 *   and matching genuinely overlap; the account's greetings do not, because the account is one
 *   resource and its cadence is what the site is watching.
 * - **A window that cannot act stops, and the others continue.** A stop ends every window; a
 *   pause holds one; an exhausted budget ends that window only. This is the difference the
 *   plan draws between pausing a window and stopping the task.
 *
 * Only candidates the rules (or a surviving judgement) call a match are queued. An
 * `unverified` candidate is reported and left alone: a requirement the page did not show is
 * not a requirement that was met, and no greeting is sent on a maybe.
 *
 * @module @local/dsh-jev-browser/lib/run
 */

import { screen } from './recruiting.js';
import { sendGreeting } from './send.js';
import { WorkQueue } from './workers.js';

/**
 * Run one task across the windows.
 *
 * The windows must already be open: opening them is the caller's decision, because a run that
 * quietly opened browsers would be a surprise in a process that also serves other work.
 *
 * @returns a summary a person can read: what was screened, what was sent, what was left, and
 *   what each window did.
 */
export async function runTask({
  ctx,
  config,
  windows,
  control,
  records,
  spend,
  authorization,
  pacing,
  siteConfig,
  posting,
  account,
  judge,
  limit = 50,
  action = 'greet',
  text,
  waitTimeoutMs = 300000,
} = {}) {
  if (!windows) throw new Error('a task needs windows to run in');
  if (!records) throw new Error('a task needs a record store, so a repeat can be ruled out');

  // One read and one batched judgement, by the owning window. Every window would otherwise
  // repeat both, and the judgement is the part that costs a request.
  const owner = windows.names[0];
  const ownerSession = windows.sessionFor(owner);
  const screening = await screen({
    cdp: ownerSession.cdp,
    sessionId: ownerSession.sessionId,
    siteConfig,
    posting,
    records,
    account,
    action,
    limit,
    judge,
  });

  const eligible = screening.candidates.filter((candidate) => candidate.verdict === 'match' && !candidate.skip);
  const queue = new WorkQueue(eligible.map((candidate) => ({ identity: candidate.identity, name: candidate.name ?? '', candidate })));

  const perWindow = await windows.each(async (name) => {
    const session = windows.sessionFor(name);
    const tally = { sent: 0, failed: 0, unverified: 0, refused: 0, held: 0, reasons: [] };
    for (;;) {
      // A pause holds this window here rather than skipping its candidates, so continuing
      // resumes the same task; a stop throws and ends it.
      await control.waitUntilRunnable(name, { timeoutMs: waitTimeoutMs });

      if (pacing) {
        // `Pacing` works on the session object — it keeps the budget and cooldowns on it — not
        // on a window name. Passing the name set a property on a string and threw after every
        // send, which looked like the send failing.
        const budget = pacing.checkBudget(session);
        if (budget && budget.ok === false) {
          tally.held += 1;
          tally.reasons.push(budget.reason ?? 'the window reached its action budget');
          break;
        }
      }

      const item = queue.claim(name);
      if (!item) break;
      windows.setState(name, 'working', item.identity);

      const attempt = () => sendGreeting({
        ctx,
        config,
        cdp: session.cdp,
        sessionId: session.sessionId,
        siteConfig,
        posting,
        account,
        identity: item.identity,
        name: item.name,
        authorization,
        spend,
        records,
        control,
        worker: name,
        windowName: name,
        text,
        judge,
      });

      // Greetings are serialised across windows even though the reading is not: the account is
      // one resource and its cadence is what the site watches.
      const outcome = pacing ? await pacing.withQuotaLock(attempt) : await attempt();

      if (outcome.outcome === 'confirmed') tally.sent += 1;
      else if (outcome.outcome === 'executed_unverified') {
        tally.sent += 1;
        tally.unverified += 1;
        tally.reasons.push(`${item.identity}: ${outcome.reason}`);
      } else if (outcome.outcome === 'failed') tally.failed += 1;
      else if (outcome.outcome === 'held') {
        // Nothing was sent. The item goes back so a resume can pick it up, and the window stops
        // rather than spinning on a halt that is not going to clear.
        tally.held += 1;
        tally.reasons.push(`${item.identity}: ${outcome.reason}`);
        queue.release(item.identity);
        break;
      } else {
        tally.refused += 1;
        tally.reasons.push(`${item.identity}: ${outcome.reason}`);
      }

      queue.settle(item.identity);
      // A refused or failed attempt is settled rather than retried: the decision was made, and
      // retrying it in the same pass would repeat the same refusal.
      if (outcome.outcome !== 'confirmed' && outcome.outcome !== 'executed_unverified') queue.settle(item.identity);

      // The account's cadence, applied after an action that spent quota.
      if (pacing && outcome.outcome !== 'refused' && outcome.outcome !== 'held') await pacing.afterAction(session, true);

      windows.setState(name, 'working', '');
      if (control.stateOf(name) === 'stopped') break;
    }
    windows.setState(name, 'idle', '');
    return tally;
  });

  const totals = { sent: 0, failed: 0, unverified: 0, refused: 0, held: 0 };
  for (const entry of perWindow) {
    if (!entry.ok || !entry.value) continue;
    for (const key of Object.keys(totals)) totals[key] += entry.value[key] ?? 0;
  }

  return {
    url: screening.url,
    title: screening.title,
    account,
    posting: posting.id,
    screened: screening.counts,
    model: screening.model,
    adapter: screening.adapter,
    eligible: eligible.length,
    totals,
    spend: { limit: spend?.limit ?? 0, spent: spend?.spent ?? 0, remaining: spend?.remaining ?? 0 },
    queue: queue.stats,
    windows: perWindow.map((entry) => ({
      name: entry.name,
      ok: entry.ok,
      error: entry.error ?? '',
      ...(entry.value ?? {}),
    })),
    // What was looked at and not acted on, with the reason, because a person reviewing the run
    // needs to see the ones that were left alone.
    left: screening.candidates
      .filter((candidate) => candidate.verdict !== 'match' || candidate.skip)
      .map((candidate) => ({
        identity: candidate.identity,
        name: candidate.name ?? '',
        verdict: candidate.verdict,
        skipped: candidate.skip,
        // The requirements that could not be settled, which is the useful thing for a person:
        // a field the configuration declared but could not find, and one the posting needs but
        // the configuration never asked for, both end up here.
        reason: candidate.skip ? candidate.skipReason : (candidate.unknownFields ?? []).join(', '),
      })),
  };
}
