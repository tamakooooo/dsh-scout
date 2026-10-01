/**
 * Turning a session's event stream into something a chat box can render.
 *
 * The shapes here are the platform's, read from its live contract rather than guessed:
 *
 *   SessionPage        { records: readonly SessionHistoryRecord[]; hasMore }
 *   SessionHistoryRecord = SessionEventEntry = { type: 'event'; event: SessionWireEvent }
 *   SessionWireEvent   { type: string; seq: number; time: number; data: JsonValue }
 *   SessionEventMap    'user/message'      -> UserMessage   { role: 'user'; content: ContentBlock[] }
 *                      'assistant/message' -> { turn, step, message: AssistantMessage, ... }
 *   MessageBase        { id; content: readonly ContentBlock[]; source }
 *
 * A frame that is not one of these is ignored rather than rendered as noise, and the caller is
 * told how many were ignored: a transcript that silently drops half a conversation would look
 * like a conversation that never happened.
 */

/** The text of one message, from its content blocks. Non-text blocks contribute nothing. */
export function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * One frame from the stream, as a message a chat box can show, or null.
 *
 * Three shapes are accepted because the wrapper differs by how the frame was read — a history
 * record, a bare event, or an event already unwrapped — and being wrong about which one arrives
 * should not mean an empty panel. Anything else returns null.
 */
export function normalizeFrame(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const event = frame.type === 'event' && frame.event ? frame.event : frame;
  if (!event || typeof event !== 'object') return null;
  const type = event.type;
  const data = event.data;
  const at = typeof event.time === 'number' ? event.time : 0;

  if (type === 'user/message') {
    const text = textOf(data);
    if (text === '') return null;
    return { id: `u-${event.seq ?? ''}-${data?.id ?? ''}`, role: 'user', text, at };
  }
  if (type === 'assistant/message') {
    const message = data?.message;
    const text = textOf(message);
    if (text === '') return null;
    return { id: `a-${event.seq ?? ''}-${message?.id ?? ''}`, role: 'assistant', text, at };
  }
  return null;
}

/**
 * Append one message to a transcript, in order and without repeats.
 *
 * The stream may deliver a message twice (a replayed page plus the live event), and a chat box
 * that shows everything twice is worse than one that is briefly behind. Returns a new array.
 */
export function appendMessage(transcript, message, { limit = 200 } = {}) {
  if (!message) return transcript;
  if (transcript.some((entry) => entry.id === message.id)) return transcript;
  const next = transcript.concat([message]);
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** What a chat box should say about a frame that carried no message. */
export function describeEvent(frame) {
  const event = frame && frame.type === 'event' && frame.event ? frame.event : frame;
  const type = event && typeof event === 'object' ? event.type : '';
  if (type === 'turn/start') return { kind: 'busy', text: '正在回复…' };
  if (type === 'turn/end') {
    const reason = event?.data?.reason?.kind;
    if (reason === 'error') return { kind: 'error', text: '这一轮以错误结束' };
    if (reason === 'aborted' || reason === 'interrupted') return { kind: 'idle', text: '这一轮被中断' };
    if (reason === 'max-tokens') return { kind: 'idle', text: '这一轮达到长度上限' };
    return { kind: 'idle', text: '' };
  }
  if (type === 'tool/call') return { kind: 'busy', text: `正在调用 ${event?.data?.name ?? '工具'}…` };
  return null;
}
