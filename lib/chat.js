/**
 * The chat box on the workbench.
 *
 * A person types into the workbench and the text becomes a prompt in a DSH conversation. The
 * reply does not come back here: it renders in the conversation panel, which is where that
 * conversation already lives. This is a way to send, not a second chat client, and the page says
 * so rather than leaving someone waiting for an answer that will appear somewhere else.
 *
 * The shape below is not invented. It is read from the platform's own live contract:
 *
 *   interface SessionPromptRequest {
 *     readonly requestId: SessionRequestId;
 *     readonly sessionId: SessionId;
 *     readonly mode: 'queue' | 'steer';
 *     readonly content: readonly PromptContentPart[];
 *     readonly clientTimeZone?: string;
 *   }
 *   type PromptContentPart = { type: 'text'; text: string } | ...
 *
 * and the method documents itself as "Admit one prompt after explicitly resuming its Session",
 * which is why the session is resolved before the prompt is admitted rather than assumed live.
 */

/** The most a single message may carry. Long enough for a real instruction, bounded so a paste
 *  of a whole file is refused here rather than in the conversation. */
export const MAX_CHAT_CHARS = 4000;

/**
 * Build the prompt request. Pure, so the wire shape can be asserted without a Host.
 *
 * @throws when the text is empty or too long, or the session is unknown — a chat box that
 *         silently returns success on a message it never sent is worse than one that refuses.
 */
export function assertSendableText(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('the message is empty');
  if (text.length > MAX_CHAT_CHARS) {
    throw new Error(`the message is ${text.length} characters; the most that may be sent is ${MAX_CHAT_CHARS}`);
  }
}

export function buildPrompt({ sessionId, text, requestId, timeZone, mode = 'queue' } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('the session is required');
  if (typeof requestId !== 'string' || requestId === '') throw new Error('the request id is required');
  assertSendableText(text);
  if (mode !== 'queue' && mode !== 'steer') throw new Error(`unknown delivery mode ${JSON.stringify(mode)}`);
  const request = {
    requestId,
    sessionId,
    mode,
    content: [{ type: 'text', text }],
  };
  if (typeof timeZone === 'string' && timeZone !== '') request.clientTimeZone = timeZone;
  return request;
}

/**
 * Pick the session a message goes to when the caller did not name one.
 *
 * The workbench panel is registered on the shell-wide `main` slot, so it is not handed a
 * session and cannot ask which one is on screen. `list` documents itself as "visible Session
 * summaries ordered by activity", so the first entry is the one being used. The page shows
 * which session that turned out to be, because a message that lands somewhere unexpected
 * should be visible rather than discovered later.
 */
export function pickSession(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  return sessions.find((entry) => entry && (entry.sessionId || entry.id)) ?? null;
}

/** A request id that is unique enough for one prompt: time plus randomness, no dependency. */
export function newRequestId(prefix = 'chat') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The sessions this Host can see, most recently active first, from whatever the Host exposes. */
export async function listSessions(ctx, signal) {
  const controller = ctx?.sessionController;
  if (!controller) throw new Error('this Host exposes no session controller, so there is nowhere to send');
  if (typeof controller.list === 'function') {
    const value = await controller.list({}, signal);
    return Array.isArray(value) ? value : (value?.sessions ?? value?.items ?? []);
  }
  throw new Error('the session controller has no list method');
}

/** A short display name for a session row, without depending on one field name. */
export function sessionLabel(entry) {
  if (!entry) return '';
  return String(entry.title ?? entry.name ?? entry.sessionId ?? entry.id ?? '');
}

/** The session id of a row, without depending on one field name. */
export function sessionIdOf(entry) {
  if (!entry) return '';
  return String(entry.sessionId ?? entry.id ?? '');
}

/**
 * Stream a conversation's transcript.
 *
 * `follow` is read from the platform's contract as
 * `SessionFollowRequest { address; maxMessages?; turnWindow?; assistantStream? }` — no cursor,
 * which is why this is used for reading rather than `page`: a page needs a `throughSeq` the
 * caller has to obtain first, and a wrong cursor is a silently empty transcript.
 *
 * Frames are handed to `onFrame` as they arrive, including ones that carry no message: the
 * caller decides what to do with a turn starting or a tool being called.
 *
 * @returns the session id that was followed.
 */
export async function followTranscript(ctx, { sessionId, maxMessages = 50, signal, onFrame, onSession } = {}) {
  const controller = ctx?.sessionController;
  if (!controller) throw new Error('this Host exposes no session controller, so there is nothing to read');
  if (typeof controller.follow !== 'function') throw new Error('the session controller cannot stream a transcript');

  let target = sessionId;
  if (!target) {
    const entry = pickSession(await listSessions(ctx, signal));
    if (!entry) throw new Error('no conversation is open, so there is nothing to read');
    target = sessionIdOf(entry);
  }
  if (!target) throw new Error('the session has no usable identity');

  // Reported before the stream is consumed: a live stream never ends, so a caller waiting until
  // the loop finishes to learn which session it is reading would wait forever.
  if (typeof onSession === 'function') onSession(target);

  const address = { kind: 'session', sessionId: target };
  const stream = controller.follow({ address, maxMessages, assistantStream: true }, signal);
  for await (const frame of stream) {
    if (typeof onFrame === 'function') onFrame(frame);
  }
  return target;
}

/**
 * Send one message to a conversation.
 *
 * @returns {{ accepted: boolean, sessionId: string, session: string }}
 */
export async function sendChat(ctx, { text, sessionId, timeZone, mode = 'queue', signal } = {}) {
  const controller = ctx?.sessionController;
  if (!controller) throw new Error('this Host exposes no session controller, so there is nowhere to send');
  if (typeof controller.prompt !== 'function') throw new Error('the session controller has no prompt method');
  // Checked before anything else: a message that cannot be sent must not list sessions or wake
  // one up on its way to being refused.
  assertSendableText(text);

  let target = sessionId;
  let label = '';
  if (!target) {
    const entry = pickSession(await listSessions(ctx, signal));
    if (!entry) throw new Error('no conversation is open, so there is nothing to send to');
    target = sessionIdOf(entry);
    label = sessionLabel(entry);
  }
  if (!target) throw new Error('the session has no usable identity');

  // The method admits a prompt "after explicitly resuming its Session", so the session is made
  // live first. Doing it in the other order would be relying on the prompt to do it for us.
  if (typeof controller.resolveAgent === 'function') await controller.resolveAgent(target);

  const request = buildPrompt({ sessionId: target, text, requestId: newRequestId(), timeZone, mode });
  // The platform's `prompt` declares a cancellation parameter and calls into it, so passing
  // nothing throws inside the Host rather than meaning "no cancellation". A caller with nothing
  // to cancel with still gets a real signal.
  const cancellation = signal ?? new AbortController().signal;
  const value = await controller.prompt(request, cancellation);
  return { accepted: value?.accepted === true, sessionId: target, session: label };
}
