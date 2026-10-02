/**
 * The workbench's own conversation.
 *
 * The panel on the right is not the conversation you happen to be in. It is one session, with a
 * stable identity, whose job is operating this workbench — so what you tell it is about the run
 * in front of you and nothing else, and it is still there tomorrow.
 *
 * The identity is not invented here. `SessionId` is a branded value and the platform validates
 * it, so the first time the platform is asked for a session and whichever id it returns is
 * written down; every time after that, that id is what is adopted. `create` is documented as
 * "Create or idempotently adopt one ordinary Session" and its implementation calls
 * `Adopt(sessionId, …)`, so passing the stored id is how the same conversation comes back.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { localPath } from './local.js';

/** Where the adopted session's identity is kept, beside the other per-user data. */
export function workbenchSessionFile() {
  return localPath('workbench', 'session.json');
}

/** The stored identity, or null. A corrupt file throws rather than being treated as absent. */
export async function readWorkbenchSession() {
  const file = workbenchSessionFile();
  const raw = await readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`the workbench session file ${file} is not valid JSON: ${error.message}`);
  }
  const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId : '';
  if (sessionId === '') throw new Error(`the workbench session file ${file} names no session`);
  return { sessionId, agentPreset: parsed?.agentPreset ?? null, at: parsed?.at ?? null };
}

/** Write the identity down. Called once, when the platform first hands one over. */
export async function writeWorkbenchSession({ sessionId, agentPreset = null }) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('the workbench session id must be a non-empty string');
  }
  const file = workbenchSessionFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ sessionId, agentPreset, at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * The workbench's session, adopting it if it exists and creating it if it does not.
 *
 * @returns {{ sessionId: string, created: boolean }}
 */
export async function ensureWorkbenchSession(ctx, { signal } = {}) {
  const controller = ctx?.sessionController;
  if (!controller) throw new Error('this Host exposes no session controller, so the workbench has no assistant');
  if (typeof controller.create !== 'function') throw new Error('the session controller cannot create a session');

  const stored = await readWorkbenchSession();
  if (stored) {
    // Adopted rather than created: the same id comes back as the same conversation.
    const value = await controller.create({ sessionId: stored.sessionId });
    return { sessionId: value?.sessionId ?? stored.sessionId, created: false };
  }
  const value = await controller.create({});
  const sessionId = value?.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('the Host created a session but reported no identity for it');
  }
  await writeWorkbenchSession({ sessionId, agentPreset: value?.agentPreset ?? null });
  return { sessionId, created: true };
}
