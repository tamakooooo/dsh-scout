/**
 * Named browser sessions.
 *
 * A session owns one browser and one attached page target. Tools name a session so
 * consecutive calls act on the same tab; the oldest session is evicted when a
 * configured ceiling is reached.
 *
 * Three things outlive the Host's connection to a browser, and each one used to cost
 * the user an authenticated session:
 *
 * 1. **The page target can disappear** while the browser lives — on macOS, closing the
 *    last Chrome window does not quit the app. Every later command then fails with a
 *    raw `Session with given id not found`. {@link Sessions.page} reconciles the
 *    target in place and reports the recovery.
 * 2. **The WebSocket can drop** — a plugin reload disposes this module's effect while
 *    Chrome keeps running. {@link Sessions.page} reconnects to the recorded port
 *    instead of demanding a relaunch.
 * 3. **The whole Host can restart.** A small registry of launched browsers (pid, port,
 *    profile) is kept in the temporary directory, so the next `browser_open` reattaches
 *    to the browser that is still running — and to the login inside it.
 *
 * Only a browser this plugin launched is ever killed. A browser the caller attached to
 * is detached, never terminated.
 *
 * @module @local/dsh-jev-browser/lib/sessions
 */

import { readFile, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Cdp, expandHome, launchChrome, resolveCdpEndpoint } from './browser.js';
import { waitForReady, navigate } from './page.js';

/**
 * The launched-browser registry. It lives in the temporary directory on purpose: it
 * describes processes, so it should not outlive a reboot any more than they do.
 *
 * The file is scoped per profile because a profile is the unit that owns browsers. A
 * test process and the Host must never share one: a stray harness reusing — or
 * forgetting — the Host's records is how a logged-in browser gets lost.
 */
const REGISTRY_PATH = join(
  tmpdir(),
  `dsh-jev-browser-launched${process.env.DSH_PROFILE ? `-${process.env.DSH_PROFILE}` : '-standalone'}.json`,
);

/** Raised when a tool names a session that was never opened. */
export class UnknownSessionError extends Error {
  constructor(name, known) {
    super(`no browser session named "${name}"; open one with browser_open first (known: ${known.length ? known.join(', ') : 'none'})`);
    this.name = 'UnknownSessionError';
  }
}

/** Raised when the browser process itself is gone, so the session cannot be revived. */
export class SessionEndedError extends Error {
  constructor(name) {
    super(`the browser for session "${name}" is gone; open it again with browser_open`);
    this.name = 'SessionEndedError';
  }
}

/**
 * Targets this process has failed to attach to, so the attempt is not repeated.
 *
 * A frozen background tab accepts `Target.attachToTarget` and then never answers
 * `Page.enable`. Without this the failure is rediscovered on every single call, paying
 * the whole timeout each time. Target ids are unique within a browser instance, so a
 * stale entry only means skipping a target that no longer exists.
 */
const UNATTACHABLE = new Set();

/** Whether a recorded pid still names a live process. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether a recorded DevTools port still answers. */
async function portAnswers(port, timeoutMs = 3000) {
  if (!Number.isInteger(port) || port <= 0) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Find a browser that is already running on a profile directory.
 *
 * The session registry is not the only record of a live browser, and it is the fragile
 * one: it lives in `tmpdir()`, which the OS cleans periodically, and its name is scoped
 * by `DSH_PROFILE`, so a browser launched from another context is recorded under a
 * different file entirely. The profile directory is the durable record — Chrome writes
 * `DevToolsActivePort` into it and holds it with a `SingletonLock` symlink naming the
 * owning pid.
 *
 * Checking it is not a nicety, it is the difference between recovering and failing: when
 * the registry is missing or stale, the plugin tries to launch, and that launch cannot
 * succeed because the profile is locked by the very browser nobody remembered. The cost
 * is the whole startup timeout and an error that names nothing useful.
 *
 * @param profileDir - the resolved profile directory, or an empty string for ephemeral.
 * @returns `{ port, pid }` when a live browser holds the profile, otherwise null.
 */
async function liveBrowserOnProfile(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return null;
  // `SingletonLock` is a symlink to `<hostname>-<pid>`.
  const lock = await readlink(join(profileDir, 'SingletonLock')).catch(() => '');
  const pid = Number(/(\d+)\s*$/.exec(lock)?.[1]);
  if (!Number.isInteger(pid) || !pidAlive(pid)) return null;
  const raw = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8').catch(() => '');
  const port = Number(String(raw).split('\n')[0].trim());
  if (!Number.isInteger(port) || port <= 0) return null;
  if (!(await portAnswers(port))) return null;
  return { port, pid };
}

/**
 * Wait, briefly, for a browser to publish itself on this profile.
 *
 * The window between probing a profile and launching on it is where a concurrent `ensure`
 * wins: it starts the browser, so this one cannot. The winner needs a moment to write
 * `DevToolsActivePort` and start answering, so the loser polls rather than giving up.
 *
 * @returns the same shape as {@link liveBrowserOnProfile}, or null when nothing appears.
 */
async function waitForBrowserOnProfile(profileDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await liveBrowserOnProfile(profileDir);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** The tab list a caller sees: document order, 1-based, active tab flagged. */
export function tabsOf(session) {
  const tracked = [...(session.pages ?? new Map()).entries()];
  return tracked.map(([targetId, page], index) => ({
    index: index + 1,
    target: targetId,
    title: page.title || '',
    url: page.url || '',
    active: targetId === session.activeTargetId,
  }));
}

/** A one-line tab summary for an error message. */
function describeTabs(session) {
  const list = tabsOf(session);
  if (list.length === 0) return 'none';
  return list.map((tab) => `${tab.index}:${tab.title || tab.url || 'untitled'}${tab.active ? '*' : ''}`).join(', ');
}

export class Sessions {
  #config;
  #sessions = new Map();
  /** Serializes browser startup; see the comment in {@link ensure}. */
  #launchChain = Promise.resolve();

  /** @param config - the resolved plugin config. */
  constructor(config) {
    this.#config = config;
  }

  /** Names of every live session, oldest first. */
  list() {
    return [...this.#sessions.keys()];
  }

  /**
   * Raw lookup with no liveness check.
   *
   * Deliberately not the tool-facing accessor: it returns the session exactly as it
   * stands, including one whose page target is already gone. Tool code must use
   * {@link Sessions.page}. This exists for diagnostics and tests that need to observe
   * or perturb the session itself.
   *
   * @param name - the session name.
   * @throws {UnknownSessionError} when the name is unknown.
   */
  raw(name) {
    const session = this.#sessions.get(name);
    if (!session) throw new UnknownSessionError(name, this.list());
    return session;
  }

  /**
   * Resolve a session whose page target is usable, reconnecting and reviving as needed.
   *
   * Tabs are tracked by *polling* `Target.getTargets`, which this already had to call to
   * check that the active page still exists. That means a tab the site opened for itself
   * — `window.open`, a `target="_blank"` link, an OAuth hop — is picked up on the next
   * call rather than needing `Target.setAutoAttach` and an event-driven model. Polling is
   * enough because every action already begins with a round trip, and it keeps the
   * session model small.
   *
   * @param name - the session name.
   * @param options - an optional tab selector: a 1-based index, or a substring of a URL
   *   or title. Selecting a tab makes it the one later calls act on.
   * @returns the live session, whether the active tab had to be re-created, and the tab list.
   * @throws {UnknownSessionError} when the name is unknown.
   * @throws {SessionEndedError} when the browser process is gone.
   */
  async page(name, { tab } = {}) {
    let session = this.#sessions.get(name);
    if (!session) throw new UnknownSessionError(name, this.list());
    if (session.cdp.closed) {
      const reconnected = await this.#reconnect(name, session);
      if (!reconnected) throw new SessionEndedError(name);
      session = reconnected;
    }
    const recovered = await this.#reconcile(session);
    if (tab !== undefined && tab !== null && tab !== '') {
      const selected = await this.#selectTab(session, tab);
      if (!selected) throw new Error(`no tab matches ${JSON.stringify(tab)}; known tabs: ${describeTabs(session)}`);
    }
    return { session, recovered, tabs: tabsOf(session) };
  }

  /**
   * Make one tracked tab the active page.
   * @param session - the session to switch.
   * @param selector - a 1-based index, or a substring of a URL or title.
   * @returns whether a tab was selected.
   */
  async #selectTab(session, selector) {
    const tracked = [...(session.pages ?? new Map()).entries()];
    let chosen;
    if (Number.isInteger(Number(selector)) && String(selector).trim() !== '') {
      chosen = tracked[Number(selector) - 1];
    } else {
      const needle = String(selector).toLowerCase();
      chosen = tracked.find(([, page]) => `${page.url} ${page.title}`.toLowerCase().includes(needle));
    }
    if (!chosen) return false;
    const [targetId, page] = chosen;
    // Tabs are registered from metadata alone, so the ones nobody asked for were never
    // attached. Attaching is what can hang on a frozen tab, so it happens here — only
    // for the tab actually being switched to.
    if (page.sessionId === null || page.sessionId === undefined) {
      if (UNATTACHABLE.has(targetId)) {
        throw new Error(
          `tab ${JSON.stringify(selector)} never answered Page.enable, so it cannot be driven; it is a frozen background tab — close it and retry, or pick another tab`,
        );
      }
      try {
        page.sessionId = await this.#attachExisting(session.cdp, targetId);
      } catch (error) {
        UNATTACHABLE.add(targetId);
        throw new Error(`cannot switch to tab ${JSON.stringify(selector)}: ${error?.message ?? error}`);
      }
    }
    session.activeTargetId = targetId;
    session.targetId = targetId;
    session.sessionId = page.sessionId;
    return true;
  }

  /**
   * Return the named session, reattaching to a browser that is still running, or
   * launching one when nothing can be reused.
   *
   * @param name - the session name.
   * @param options - per-call headless override and an explicit CDP locator to attach to.
   * @returns the live session record.
   */
  /** Take the startup lock; the returned function releases it (idempotently). */
  async #acquireLaunch() {
    const previous = this.#launchChain;
    let release;
    this.#launchChain = new Promise((resolve) => { release = resolve; });
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  async ensure(name, { headless, cdp } = {}) {
    const existing = this.#sessions.get(name);
    if (existing && !existing.cdp.closed) {
      // A surviving browser with a closed tab is the common case after a manual
      // window close: keep the process, restore the page.
      await this.#reconcile(existing);
      return existing;
    }
    if (existing) {
      const reconnected = await this.#reconnect(name, existing);
      if (reconnected) return reconnected;
      this.#sessions.delete(name);
      await existing.dispose().catch(() => {});
      await this.#forget(name);
    }

    if (typeof cdp === 'string' && cdp.trim() !== '') {
      return this.#attachViaCdp(name, { locator: cdp, origin: 'attached' });
    }

    const remembered = (await this.#read())[name];
    if (remembered && pidAlive(remembered.pid) && (await portAnswers(remembered.port))) {
      try {
        return await this.#attachViaCdp(name, {
          locator: `http://127.0.0.1:${remembered.port}`,
          origin: 'reconnected',
          remembered,
        });
      } catch {
        // The recorded browser stopped answering between the probe and the attach; a
        // fresh launch is the honest fallback.
      }
    }

    // Startup is serialized per plugin instance.
    //
    // The probe and the launch are not atomic. Every caller that sees a free profile proceeds
    // to launch, and Chrome starts one process per caller on the same `--user-data-dir`:
    // four browsers sharing one profile, each with its own debugging port, none of them the
    // one the others believe they are using. Nothing throws in that case — the profile guard
    // only sees a lock after the first launch has written it — so this cannot be handled by
    // catching a failure, only by not having two launches at once.
    const releaseStart = await this.#acquireLaunch();
    try {
      return await this.#startSession(name, { headless });
    } finally {
      releaseStart();
    }
  }

  /**
   * Probe the profile, then adopt or launch a browser for one session.
   *
   * Separate from {@link ensure} so the whole probe-then-launch sequence sits inside the
   * launch lock: a second probe under the lock is what lets the waiter attach to the browser
   * the winner just started instead of starting another one.
   */
  async #startSession(name, { headless }) {
    // Before launching, ask the profile directory whether a browser already holds it.
    // A launch onto a locked profile cannot succeed, so this is the difference between
    // recovering a session and waiting out the whole startup timeout to fail.
    const profileDir = expandHome(this.#config.profileDir);
    const onProfile = await liveBrowserOnProfile(profileDir);
    if (onProfile) {
      try {
        return await this.#attachViaCdp(name, {
          locator: `http://127.0.0.1:${onProfile.port}`,
          origin: 'reconnected',
          remembered: {
            pid: onProfile.pid,
            port: onProfile.port,
            userDataDir: profileDir,
            ephemeral: false,
            headless: this.#config.headless,
            lastUrl: '',
          },
        });
      } catch {
        // It stopped answering between the probe and the attach; launching is the honest
        // fallback, and it will now report whatever is actually wrong.
      }
    }

    while (this.#sessions.size >= this.#config.maxSessions) {      const oldest = this.#sessions.keys().next().value;
      const victim = this.#sessions.get(oldest);
      this.#sessions.delete(oldest);
      await victim.dispose().catch(() => {});
      await this.#forget(oldest);
    }

    let chrome;
    try {
      chrome = await launchChrome({
        chromePath: this.#config.chromePath,
        managedDir: this.#config.managedBrowserDir,
        headless: typeof headless === 'boolean' ? headless : this.#config.headless,
        profileDir: this.#config.profileDir,
      });
    } catch (error) {
      // Only an *external* winner is left to handle here: this plugin's own concurrent
      // `ensure` calls are already serialized by the launch lock, so a launch cannot lose to
      // one of them. A browser someone else started on the profile in the meantime still
      // makes this launch impossible, and the guard's own message says to attach instead.
      // Rethrow when nothing holds the profile, so a real fault — a missing binary, a bad
      // flag — still surfaces as itself.
      const late = await waitForBrowserOnProfile(profileDir, 1500);
      if (!late) throw error;
      return await this.#attachViaCdp(name, {
        locator: `http://127.0.0.1:${late.port}`,
        origin: 'reconnected',
        remembered: {
          pid: late.pid,
          port: late.port,
          userDataDir: profileDir,
          ephemeral: false,
          headless: typeof headless === 'boolean' ? headless : this.#config.headless,
          lastUrl: '',
        },
      });
    }
    let client;
    try {
      client = await Cdp.connect(chrome.wsUrl);
      const { targetId, sessionId } = await this.#attachPage(client, 'about:blank');
      const session = this.#makeSession(name, {
        cdp: client,
        targetId,
        sessionId,
        lastUrl: 'about:blank',
        headless: chrome.headless,
        origin: 'launched',
        pid: chrome.pid,
        port: chrome.port,
        profile: chrome.ephemeral ? 'ephemeral' : chrome.userDataDir,
        chrome,
      });
      this.#sessions.set(name, session);
      await this.#remember(name, {
        pid: chrome.pid,
        port: chrome.port,
        userDataDir: chrome.userDataDir,
        ephemeral: chrome.ephemeral,
        headless: chrome.headless,
        lastUrl: 'about:blank',
        startedAt: Date.now(),
      });
      return session;
    } catch (error) {
      client?.close();
      await chrome.kill().catch(() => {});
      throw error;
    }
  }

  /**
   * Close one session, terminating a browser this plugin launched.
   * @returns `true` when a session was closed.
   */
  async close(name) {
    const session = this.#sessions.get(name);
    if (!session) return false;
    this.#sessions.delete(name);
    await session.dispose().catch(() => {});
    await this.#forget(name);
    return true;
  }

  /** Close every session, terminating the browsers this plugin launched. */
  async closeAll() {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.dispose().catch(() => {})));
    // Forget only the names this instance held: the registry is shared by every session
    // in this profile, so wiping it wholesale would strand unrelated records.
    for (const session of sessions) await this.#forget(session.name);
  }

  /**
   * Drop every connection but leave the browsers running and remembered.
   *
   * This is what plugin disposal does, and it is the difference between a reload that
   * costs the user their login and one that does not: the registry entry survives, so
   * the next call reattaches to the same browser. Use {@link Sessions.closeAll} when
   * the browsers themselves should end.
   */
  async detachAll() {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const session of sessions) {
      try {
        session.cdp.close();
      } catch {
        /* already closed */
      }
      if (session.origin === 'attached') continue;
      const record = (await this.#read())[session.name];
      if (record) await this.#remember(session.name, { ...record, lastUrl: session.lastUrl });
    }
  }

  // ── DevTools plumbing ───────────────────────────────────────────────────────

  /**
   * Attach to a target the browser already holds, with every step bounded.
   *
   * A background tab can be frozen, and `Page.enable` against a frozen renderer does not
   * fail — it never answers. Under the 30-second default command timeout that turns
   * "which tabs are open" into a stall, so each step carries its own short bound.
   *
   * `Page.enable` is the step that matters: navigation, screenshots, and the load event
   * all need it. `Runtime.enable` only layers conveniences on top, so its failure is not
   * fatal and cannot extend the wait.
   *
   * @returns the flat session id.
   */
  async #attachExisting(cdp, targetId) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, 8000);
    await cdp.send('Page.enable', {}, sessionId, 4000);
    await cdp.send('Runtime.enable', {}, sessionId, 2000).catch(() => {});
    return sessionId;
  }

  /**
   * Create and attach a fresh page target.
   *
   * `newWindow` decides whether a session gets its own window or a tab: tabs share one
   * window and one place to look, separate windows suit watching sessions side by side.
   */
  async #attachPage(cdp, url, newWindow = this.#config.newWindow === true) {
    const params = newWindow ? { url, newWindow: true } : { url };
    const { targetId } = await cdp.send('Target.createTarget', params, undefined, 15000);
    const sessionId = await this.#attachExisting(cdp, targetId);
    return { targetId, sessionId };
  }

  /**
   * Adopt the tab a reattached browser already has open, so an authenticated page is
   * used rather than replaced. Falls back to opening one when the browser has no page.
   */
  async #adoptOrCreatePage(cdp, fallbackUrl, selfName) {
    let pages = [];
    try {
      const { targetInfos } = await cdp.send('Target.getTargets', {}, undefined, 10000);
      pages = (Array.isArray(targetInfos) ? targetInfos : []).filter(
        (info) => info.type === 'page' && !String(info.url ?? '').startsWith('devtools://'),
      );
    } catch {
      pages = [];
    }

    // Rank candidates: a real page beats a blank one, and an unattached target beats an
    // attached one. Attaching to a target another session already holds fails, and the
    // old single-candidate version fell straight through to creating a tab on that
    // failure — which is how a duplicate tab of the same page got left behind.
    const rank = (info) => [info.url && info.url !== 'about:blank' ? 0 : 1, info.attached === true ? 1 : 0];
    const ranked = [...pages].sort((a, b) => {
      const [blankA, attachedA] = rank(a);
      const [blankB, attachedB] = rank(b);
      return blankA - blankB || attachedA - attachedB;
    });

    const failures = [];

    // Targets another named session already drives. Adopting one would put two sessions on
    // one document — each with its own goal, its own action budget and its own pacing — so
    // two runs would interleave their actions on the same page while both counted their own
    // spend. The target list's `attached` flag is not enough to exclude them: this
    // connection is flattened, so a second attach to an already-attached target succeeds.
    // The adopting session's own record still holds its former target while it reconnects,
    // and that target is exactly the one worth re-adopting — so it is not "someone else's".
    const claimed = new Set();
    for (const [owner, entry] of this.#sessions.entries()) {
      if (owner === selfName) continue;
      if (entry.targetId) claimed.add(entry.targetId);
      if (entry.pages instanceof Map) for (const targetId of entry.pages.keys()) claimed.add(targetId);
    }

    for (const candidate of ranked) {
      // A target that never answered once will not answer now; skipping it is what keeps
      // a frozen background tab from being re-tried on every single reattach.
      if (UNATTACHABLE.has(candidate.targetId)) {
        failures.push(`${candidate.targetId}: skipped, it never answered Page.enable`);
        continue;
      }
      if (claimed.has(candidate.targetId)) {
        failures.push(`${candidate.targetId}: in use by another session`);
        continue;
      }
      try {
        const sessionId = await this.#attachExisting(cdp, candidate.targetId);
        const url = String(candidate.url ?? '');
        // A blank tab is not worth adopting when the caller knows a better URL: reuse it,
        // but navigate it so the session does not silently start on about:blank.
        if ((!candidate.url || candidate.url === 'about:blank') && fallbackUrl && fallbackUrl !== 'about:blank') {
          return { targetId: candidate.targetId, sessionId, adopted: true, url: fallbackUrl, navigateTo: fallbackUrl };
        }
        return { targetId: candidate.targetId, sessionId, adopted: true, url };
      } catch (error) {
        UNATTACHABLE.add(candidate.targetId);
        failures.push(`${candidate.targetId}: ${error?.message ?? error}`);
      }
    }

    const created = await this.#attachPage(cdp, fallbackUrl || 'about:blank');
    return { ...created, adopted: false, url: fallbackUrl || 'about:blank', failures };
  }

  /**
   * Register page targets this session does not track yet, and drop the ones that are
   * gone.
   *
   * Registration is **metadata only** — `Target.getTargets` already reports each page's
   * URL and title, and that is all a tab list needs. Attaching is deferred to
   * `#selectTab`, for two reasons: a tab the *site* opened (`window.open`, a
   * `target="_blank"` link, an OAuth hop) still shows up in the list immediately, and a
   * tab nobody asked for is never attached — which matters because attaching to a frozen
   * background tab is what used to stall a call for 30 seconds.
   *
   * The new tab is registered, not activated: silently following a popup would move the
   * caller's context under them, so it is reported and the caller switches with `tab`.
   */
  async #refreshPages(session, targetInfos) {
    const pages = targetInfos.filter((info) => info.type === 'page' && !String(info.url ?? '').startsWith('devtools://'));
    const seen = new Set();
    for (const info of pages) {
      seen.add(info.targetId);
      const tracked = session.pages.get(info.targetId);
      const url = String(info.url ?? '');
      const title = String(info.title ?? '');
      if (tracked) {
        tracked.url = url || tracked.url;
        tracked.title = title || tracked.title;
        continue;
      }
      // `null` means known but not attached yet.
      session.pages.set(info.targetId, { sessionId: null, url, title });
    }
    for (const targetId of [...session.pages.keys()]) if (!seen.has(targetId)) session.pages.delete(targetId);
  }

  /**
   * Refresh the tab list and make sure the active tab is usable.
   *
   * One `Target.getTargets` covers both jobs. It needs no page session — the thing that
   * may be gone — so it still works when the active tab has died.
   *
   * @returns whether the active page had to be re-created.
   */
  async #reconcile(session) {
    let targetInfos;
    try {
      ({ targetInfos } = await session.cdp.send('Target.getTargets', {}, undefined, 10000));
    } catch {
      return false;
    }
    if (!Array.isArray(targetInfos)) return false;
    await this.#refreshPages(session, targetInfos);

    const live = targetInfos.some((info) => info.targetId === session.activeTargetId && info.type === 'page');
    if (live) {
      const tracked = session.pages.get(session.activeTargetId);
      if (tracked) {
        session.targetId = session.activeTargetId;
        session.sessionId = tracked.sessionId;
      }
      return false;
    }

    // The active tab is gone. Prefer a tab the session already tracks over opening a new
    // one: a site that moved the user elsewhere usually wants them there.
    const tracked = [...session.pages.entries()];
    const fallback = tracked.find(([, page]) => page.url && page.url !== 'about:blank') ?? tracked[0];
    if (fallback) {
      await this.#selectTab(session, tracked.indexOf(fallback) + 1);
      session.lastUrl = fallback[1].url || session.lastUrl;
      return false;
    }

    const url = session.lastUrl || 'about:blank';
    const { targetId, sessionId } = await this.#attachPage(session.cdp, url);
    session.pages.set(targetId, { sessionId, url, title: '' });
    session.activeTargetId = targetId;
    session.targetId = targetId;
    session.sessionId = sessionId;
    session.revivedAt = Date.now();
    // Hand back a page that is actually usable. A freshly created target starts
    // loading, so a caller that snapshots immediately would otherwise read a blank
    // document and report an empty page as the state it is deciding over.
    await waitForReady(session.cdp, sessionId, 15000);
    return true;
  }

  /**
   * Open another tab and make it the active page.
   * @param name - the session name.
   * @param url - the document to load, or empty for a blank tab.
   * @returns the new tab as the caller sees it.
   */
  async openTab(name, url) {
    const { session } = await this.page(name);
    // Create the target blank and then navigate explicitly, rather than passing the URL
    // to `createTarget`: an explicit `Page.navigate` is what gives `navigate` a load
    // event to wait on, so the caller does not get handed `about:blank`.
    const { targetId, sessionId } = await this.#attachPage(session.cdp, 'about:blank');
    session.pages.set(targetId, { sessionId, url: 'about:blank', title: '' });
    session.activeTargetId = targetId;
    session.targetId = targetId;
    session.sessionId = sessionId;
    if (url) await navigate(session.cdp, sessionId, url, { timeoutMs: 25000 });
    return tabsOf(session).find((tab) => tab.target === targetId);
  }

  /** Build a session record with origin-aware disposal. */
  #makeSession(name, parts) {
    const session = {
      name,
      cdp: parts.cdp,
      targetId: parts.targetId,
      sessionId: parts.sessionId,
      // The tab registry starts with the one page this session already holds. `#refreshPages`
      // grows it from what the browser actually reports.
      pages: new Map([[parts.targetId, { sessionId: parts.sessionId, url: parts.lastUrl || 'about:blank', title: '' }]]),
      activeTargetId: parts.targetId,
      lastUrl: parts.lastUrl || 'about:blank',
      headless: parts.headless === true,
      origin: parts.origin,
      pid: parts.pid,
      port: parts.port,
      profile: parts.profile,
      startedAt: Date.now(),
      revivedAt: null,
      dispose: async () => {
        parts.cdp.close();
        // Only a browser this plugin started is ours to end. Tearing down a browser the
        // caller attached to would close windows the user is still working in.
        if (parts.origin === 'attached') return;
        if (parts.chrome) return parts.chrome.kill();
        if (pidAlive(parts.pid)) {
          try {
            process.kill(parts.pid, 'SIGTERM');
          } catch {
            /* already gone */
          }
        }
        return undefined;
      },
    };
    return session;
  }

  /** Connect to an already-running browser and adopt its page. */
  async #attachViaCdp(name, { locator, origin, remembered }) {
    const wsUrl = await resolveCdpEndpoint(locator);
    const client = await Cdp.connect(wsUrl);
    try {
      const adopted = await this.#adoptOrCreatePage(client, remembered?.lastUrl, name);
      if (adopted.navigateTo) {
        // A blank tab was reused and the caller knows where the session was; go there
        // rather than handing back an empty page.
        await navigate(client, adopted.sessionId, adopted.navigateTo, { timeoutMs: 25000 }).catch(() => {});
      }
      const session = this.#makeSession(name, {
        cdp: client,
        targetId: adopted.targetId,
        sessionId: adopted.sessionId,
        lastUrl: adopted.url || remembered?.lastUrl || 'about:blank',
        headless: remembered?.headless ?? this.#config.headless,
        origin,
        pid: remembered?.pid,
        port: remembered?.port ?? Number(new URL(wsUrl.replace(/^ws/, 'http')).port),
        profile: remembered ? (remembered.ephemeral === false ? remembered.userDataDir : 'ephemeral') : 'external',
      });
      this.#sessions.set(name, session);
      if (origin === 'reconnected' && remembered) {
        await this.#remember(name, { ...remembered, port: session.port, lastUrl: session.lastUrl });
      }
      return session;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  /**
   * Reattach the Host's connection to a browser that is still running.
   * @returns the new session, or `null` when the browser is genuinely gone.
   */
  async #reconnect(name, session) {
    const record = (await this.#read())[name];
    const port = record?.port ?? session.port;
    if (!(await portAnswers(port))) return null;
    if (record?.pid && !pidAlive(record.pid) && !pidAlive(session.pid)) return null;
    try {
      const reconnected = await this.#attachViaCdp(name, {
        locator: `http://127.0.0.1:${port}`,
        origin: session.origin === 'attached' ? 'attached' : 'reconnected',
        remembered: { ...record, pid: session.pid ?? record?.pid, port, headless: session.headless },
      });
      for (const field of ['actionsTaken', 'cooldowns', 'lastActionAt', 'startedAt', 'revivedAt', 'pacingPolicy']) {
        if (Object.hasOwn(session, field)) reconnected[field] = session[field];
      }
      return reconnected;
    } catch {
      return null;
    }
  }

  // ── launched-browser registry ───────────────────────────────────────────────

  /** Read the registry, tolerating an absent or corrupt file. */
  async #read() {
    try {
      const parsed = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') return parsed.sessions;
      return {};
    } catch {
      return {};
    }
  }

  /** Write the registry, ignoring a failure: losing it only costs one relaunch. */
  async #write(sessions) {
    try {
      await writeFile(REGISTRY_PATH, JSON.stringify({ version: 1, sessions }, null, 2));
    } catch {
      /* a read-only temporary directory only costs a relaunch */
    }
  }

  /** Record one launched browser. */
  async #remember(name, record) {
    const sessions = await this.#read();
    sessions[name] = record;
    await this.#write(sessions);
  }

  /** Drop one recorded browser. */
  async #forget(name) {
    const sessions = await this.#read();
    if (!(name in sessions)) return;
    delete sessions[name];
    await this.#write(sessions);
  }

  /** Where this session's profile lives, for reporting. */
  describeProfile(session) {
    if (session.profile) return session.profile;
    return this.#config.profileDir ? expandHome(this.#config.profileDir) : 'ephemeral';
  }
}
