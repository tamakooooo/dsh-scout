/**
 * Sending one greeting, in the only order that keeps it honest.
 *
 * The sequence is the design, and each step is placed so that the expensive and the
 * irreversible parts come last and the recoverable parts come first:
 *
 * 1. **Resolve** the target from the configuration, against the live page. Free, and it can
 *    still refuse: a locator that matches nothing or matches twice ends the attempt here,
 *    before any quota is touched.
 * 2. **Reserve** an authorisation slot. From this point the person may be contacted, so from
 *    here on an unresolved state must stay unresolved rather than be retried.
 * 3. **Read** the page for comparison, so the outcome can be judged against what the page
 *    looked like beforehand.
 * 4. **Write the intent**, immediately before acting. This is the crash window: if the process
 *    dies now, the record says an attempt may have been made, and the next pass will refuse to
 *    send again rather than risk a second greeting.
 * 5. **Act**, through the existing action path.
 * 6. **Verify** against the page afterwards, so a click that landed is not mistaken for a
 *    conversation that started.
 * 7. **Settle the record**: `confirmed`, `executed_unverified` or `failed`. Only a known
 *    failure gives the slot back, because an unknown outcome may already be a contact.
 *
 * A stop is honoured at two points, and they differ. Before the intent, a stop simply ends the
 * attempt and the slot is released, because nothing happened. After the intent, the attempt is
 * left deliberately unresolved: nobody knows whether the click landed, so the candidate is
 * held for a person to settle rather than quietly retried.
 *
 * @module @local/dsh-jev-browser/lib/send
 */

import { snapshot, perform } from './page.js';
import { resolveTarget, readCandidates } from './site.js';
import { verifyAction } from './verify.js';

/** What came of an attempt. `held` and `refused` mean nothing was sent. */
export const SEND_OUTCOMES = ['confirmed', 'executed_unverified', 'failed', 'refused', 'held'];

/**
 * Send one greeting to one candidate.
 *
 * @returns `{ ok, outcome, reason, verdict, basis, token, intentUnresolved }`. It does not
 *   throw for an ordinary refusal — a candidate who may not be contacted is a normal result of
 *   a screening pass, and turning it into an exception would end the pass.
 */
export async function sendGreeting({
  ctx,
  config,
  cdp,
  sessionId,
  siteConfig,
  posting,
  account,
  identity,
  name = '',
  url = '',
  authorization,
  spend,
  records,
  control,
  worker = 'w1',
  windowName = '',
  text,
  judge,
  allowModel = true,
} = {}) {
  const result = (outcome, reason, extra = {}) => ({ ok: outcome === 'confirmed', outcome, reason, verdict: '', basis: '', token: '', intentUnresolved: false, ...extra });

  if (!cdp || !sessionId) return result('refused', 'no page is available to act on');
  if (!siteConfig || !posting) return result('refused', 'a site configuration and a posting are both required');
  if (!records) return result('refused', 'no record store was supplied, so a repeat cannot be ruled out');

  // A stop before anything is touched: end the attempt, spend nothing.
  if (control) {
    const state = control.stateOf(worker);
    if (state !== 'running') return result('held', `the window is ${state}`);
    // A takeover means a person may have navigated or typed; everything observed before it is
    // about a page that may no longer exist, so the candidate is re-read before being acted on.
    if (control.staleFor(worker)) {
      const reread = await readCandidates(cdp, sessionId, { config: siteConfig, limit: 200 });
      const still = reread.candidates.some((candidate) => candidate.identity === identity);
      control.clearStale(worker);
      if (!still) return result('refused', 'the candidate is no longer on the page after the hand-back; re-read before acting');
    }
  }

  // 0. The `before` state, taken FIRST and deliberately so: a snapshot stamps its own refs
  //    onto the elements it collects, which would overwrite the stamp the resolution below
  //    relies on. Reading first also keeps the resolution the last observation before the
  //    action, which is what makes a re-resolve meaningful.
  const before = await snapshot(cdp, sessionId, { maxElements: config?.maxElements ?? 60 });

  // 1. Resolve: a locator that cannot name exactly one element ends this attempt without
  //    consuming anything.
  const target = await resolveTarget(cdp, sessionId, { config: siteConfig, identity, action: 'greet' });
  if (!target.ok) return result('refused', `${target.code}: ${target.message}`);

  // 2. Take a slot. Synchronous, so the check and the take cannot be separated.
  const reserved = spend.reserve(
    { account, posting: posting.id, postingVersion: posting.version, siteVersion: siteConfig.version, greetingVersion: posting.greeting, action: 'greet' },
    { authorization },
  );
  if (!reserved.ok) return result('refused', reserved.reason);

  const release = (outcome) => spend.release(reserved.token, { outcome });

  try {
    // A stop after resolving but before acting: nothing has happened, so the slot goes back.
    if (control) {
      const state = control.stateOf(worker);
      if (state !== 'running') {
        release('failed');
        return result('held', `the window became ${state} before the action; nothing was sent`);
      }
    }

    // 4. The intent, immediately before acting. This is the line that makes a crash safe.
    const intent = {
      at: new Date().toISOString(),
      kind: 'intent',
      posting: posting.id,
      account,
      identity,
      action: 'greet',
      status: 'pending',
      name: name || '',
      url: url || '',
      greetingVersion: posting.greeting ?? '',
      window: windowName || worker,
    };
    try {
      await records.append(intent);
    } catch (error) {
      // A record that cannot be written must stop the action it was about to describe.
      release('failed');
      return result('refused', `the intent could not be recorded, so nothing was sent: ${error.message}`);
    }

    // 5. Act, through the path the model-driven flow already uses.
    const actionType = siteConfig.actions.greet.type === 'type' ? 'type' : 'click';
    const actionText = actionType === 'type' ? (text ?? posting.greeting ?? '') : undefined;
    const performed = await perform(cdp, sessionId, actionType, target.ref, actionText);
    if (!performed.ok) {
      await records.append({
        at: new Date().toISOString(), kind: 'result', posting: posting.id, account, identity,
        action: 'greet', status: 'failed', name: name || '', url: url || '',
        evidence: `the page refused the action: ${performed.message}`,
      });
      release('failed');
      return result('failed', performed.message);
    }

    // 6. Judge the outcome rather than assume it.
    const after = await snapshot(cdp, sessionId, { maxElements: config?.maxElements ?? 60 }).catch(() => null);
    const verification = await verifyAction({
      ctx, config, action: 'greet', targetLabel: target.label, text: actionText,
      before, after, allowModel, judge,
    }).catch((error) => ({ verdict: 'unconfirmed', basis: `verification could not run: ${error.message}` }));

    // 7. Settle the record. A verified success or an unknown outcome both keep the slot; only a
    //    known failure gives it back.
    const status = verification.verdict === 'verified' ? 'confirmed' : verification.verdict === 'refuted' ? 'failed' : 'executed_unverified';
    await records.append({
      at: new Date().toISOString(), kind: 'result', posting: posting.id, account, identity,
      action: 'greet', status, name: name || '', url: url || '',
      evidence: verification.basis || verification.verdict,
    });
    if (status === 'failed') release('failed');

    return {
      ok: status === 'confirmed',
      outcome: status,
      reason: verification.basis || verification.verdict,
      verdict: verification.verdict,
      basis: verification.basis ?? '',
      token: reserved.token,
      intentUnresolved: status === 'executed_unverified',
    };
  } catch (error) {
    // Anything unexpected after the intent leaves it unresolved on purpose: nobody knows
    // whether the action reached the page, so the candidate is held for a person.
    return result('executed_unverified', `the attempt ended without a known outcome: ${error.message}`, {
      intentUnresolved: true,
      token: reserved.token,
    });
  }
}
