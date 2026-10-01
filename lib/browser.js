/**
 * Raw-CDP browser plumbing for the Jev Browser plugin.
 *
 * Responsibilities: locate and launch a Chromium-family browser, speak the DevTools
 * Protocol over its browser-level WebSocket, and own the process lifetime.
 *
 * Zero third-party dependencies. Node's global `fetch` and `WebSocket` carry both
 * transports; they exist in Node 22+ and in the DSH Host runtime (Electron/Node 24).
 *
 * @module @local/dsh-jev-browser/lib/browser
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveManagedBrowser } from './managed.js';
// Imported for local use as well as re-exported: `export { x } from './y'` alone would
// publish the name without creating the binding `launchChrome` calls.
import { expandHome } from './paths.js';

export { expandHome };

/** Sleep helper shared by the launch and action paths. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chromium-family binaries probed in order when the caller names no path.
 * The first existing entry wins; a caller-supplied path is never probed.
 */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/snap/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

/**
 * Resolve one Chromium-family binary.
 * @param explicitPath - a caller-configured path; validated when non-empty.
 * @returns the absolute binary path.
 * @throws when the configured path is missing or nothing is installed.
 */
/**
 * Resolve one Chromium-family binary.
 *
 * Precedence is deliberate: an explicit `chromePath` is the user's decision and always
 * wins; a managed Chrome for Testing build comes next, because installing one is how a
 * project opts into owning its browser; the machine's own Chrome is the fallback.
 *
 * @param explicitPath - a caller-configured path; validated when non-empty.
 * @param managedBinary - a resolved managed install, when one exists.
 * @returns the absolute binary path.
 * @throws when the configured path is missing or nothing is installed.
 */
export function findChrome(explicitPath, managedBinary) {
  const configured = typeof explicitPath === 'string' ? explicitPath.trim() : '';
  if (configured) {
    if (!existsSync(configured)) throw new Error(`chromePath does not exist: ${configured}`);
    return configured;
  }
  const managed = typeof managedBinary === 'string' ? managedBinary.trim() : '';
  if (managed !== '' && existsSync(managed)) return managed;
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error(
    'no Chromium-family browser found; install Google Chrome, set chromePath, or run browser_open with install_browser: true to fetch a managed Chrome for Testing build',
  );
}

/**
 * Read the browser-level WebSocket URL from a DevTools HTTP endpoint.
 * @param base - `http://host:port`, with or without a trailing slash.
 * @param options - request timeout.
 * @returns the `webSocketDebuggerUrl`.
 */
export async function fetchBrowserWsUrl(base, { timeoutMs = 8000 } = {}) {
  const url = `${String(base).replace(/\/+$/, '')}/json/version`;
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const body = await response.json();
  if (typeof body?.webSocketDebuggerUrl !== 'string' || body.webSocketDebuggerUrl === '') {
    throw new Error(`${url} carried no webSocketDebuggerUrl`);
  }
  return body.webSocketDebuggerUrl;
}

/**
 * Turn a caller-supplied locator into a browser-level WebSocket URL.
 *
 * Attaching to a browser the user already has open is what keeps an authenticated
 * session alive across a Host restart, so this accepts whatever can be copied out of
 * `chrome://inspect/#remote-debugging`: a full `ws(s)://` URL, a bare port (`61157`),
 * `host:port`, or an `http(s)://host:port` endpoint.
 *
 * @param locator - the locator, as the caller wrote it.
 * @param options - request timeout for the HTTP forms.
 * @returns the WebSocket URL.
 */
export async function resolveCdpEndpoint(locator, { timeoutMs = 8000 } = {}) {
  const raw = String(locator ?? '').trim();
  if (raw === '') throw new Error('the cdp locator is empty');
  if (/^wss?:\/\//i.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return fetchBrowserWsUrl(`http://127.0.0.1:${raw}`, { timeoutMs });
  if (!/^https?:\/\//i.test(raw)) return fetchBrowserWsUrl(`http://${raw}`, { timeoutMs });
  return fetchBrowserWsUrl(raw, { timeoutMs });
}

/** A DevTools Protocol failure carrying the wire error the browser returned. */
export class CdpError extends Error {
  /** @param error - the protocol `error` object. @param method - the failing method. */
  constructor(error, method) {
    super(`CDP ${method} failed: ${error?.message ?? JSON.stringify(error)}`);
    this.name = 'CdpError';
    this.code = error?.code;
    this.data = error?.data;
  }
}

/**
 * One browser-level DevTools WebSocket.
 *
 * Commands are flat-session: a page-scoped command passes the `sessionId` returned by
 * `Target.attachToTarget` with `flatten: true`. Every command carries its own timeout,
 * so one unresponsive renderer cannot pin a tool call open.
 */
export class Cdp {
  #socket;
  #seq = 0;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  /** @param socket - an open WebSocket. Prefer {@link Cdp.connect}. */
  constructor(socket) {
    this.#socket = socket;
    this.#wire(socket);
  }

  /**
   * Open a browser-level connection.
   * @param url - the `webSocketDebuggerUrl` from `/json/version`.
   * @param options - connection timeout in milliseconds.
   * @returns the connected client.
   */
  static async connect(url, { timeoutMs = 15000 } = {}) {
    if (typeof WebSocket !== 'function') {
      throw new Error('this Host runtime has no global WebSocket; Node 22+ or Electron/Node 24 is required');
    }
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* the socket is already unusable */
        }
        reject(new Error(`timed out after ${timeoutMs}ms connecting to the DevTools socket`));
      }, timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('failed to open the DevTools socket'));
        },
        { once: true },
      );
    });
    return new Cdp(socket);
  }

  /** Route inbound frames to pending commands and event listeners. */
  #wire(socket) {
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (typeof message.id === 'number') {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new CdpError(message.error, pending.method));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (typeof message.method !== 'string') return;
      const handlers = this.#listeners.get(message.method);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        try {
          handler(message.params ?? {}, message.sessionId);
        } catch {
          /* a listener must never break the frame loop */
        }
      }
    });
    socket.addEventListener('close', () => this.#fail(new Error('the DevTools connection closed')));
    socket.addEventListener('error', () => {
      /* the close event carries the actionable failure */
    });
  }

  /** Reject every in-flight command exactly once. */
  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /**
   * Send one protocol command.
   * @param method - protocol method, e.g. `Page.navigate`.
   * @param params - protocol parameters.
   * @param sessionId - flat session id for a page-scoped command.
   * @param timeoutMs - per-command timeout.
   * @returns the command result.
   */
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.#closed) return Promise.reject(new Error('the DevTools connection is closed'));
    const id = ++this.#seq;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, method, timer });
      try {
        this.#socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Subscribe to one protocol event.
   * @param method - event name, e.g. `Page.loadEventFired`.
   * @param handler - receives `(params, sessionId)`.
   * @returns the unsubscribe function.
   */
  on(method, handler) {
    let handlers = this.#listeners.get(method);
    if (!handlers) {
      handlers = new Set();
      this.#listeners.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  /**
   * Await the next occurrence of one event.
   * @param method - event name.
   * @param timeoutMs - rejection deadline.
   * @returns the event params.
   */
  once(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  /** Whether the underlying socket is still usable. */
  get closed() {
    return this.#closed;
  }

  /** Close the connection, failing everything still in flight. */
  close() {
    try {
      this.#socket.close();
    } catch {
      /* nothing left to close */
    }
    this.#fail(new Error('the DevTools connection was closed by the caller'));
  }
}

/**
 * Launch a browser with an ephemeral profile and a kernel-assigned debugging port.
 *
 * `--remote-debugging-port=0` makes the browser choose the port and publish it in
 * `<user-data-dir>/DevToolsActivePort`; a private `--user-data-dir` is what makes that
 * safe on current Chrome, which refuses remote debugging on the default profile.
 *
 * @param options - binary path override, headless flag, and startup deadline.
 * @returns the running browser handle, including its DevTools endpoint and `kill()`.
 */
/**
 * The pid holding a Chrome profile directory, when one is alive.
 *
 * Chrome holds its `--user-data-dir` with a `SingletonLock` symlink pointing at
 * `<hostname>-<pid>`. That makes the profile directory itself the authoritative record
 * that a browser is running on it, independent of any bookkeeping the caller kept.
 *
 * @param userDataDir - the resolved profile directory.
 * @returns the live pid, or null when nothing holds the profile.
 */
export async function profileHolderPid(userDataDir) {
  const target = await readlink(join(userDataDir, 'SingletonLock')).catch(() => '');
  const pid = Number(/(\d+)\s*$/.exec(String(target))?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export async function launchChrome({
  chromePath,
  managedDir = '',
  headless = false,
  profileDir = '',
  windowSize = '1440,960',
  startupTimeoutMs = 25000,
} = {}) {
  // A managed install is looked up per launch, so installing one takes effect on the
  // next fresh browser launch without a Host restart; an existing session is reused.
  const managed = await resolveManagedBrowser(managedDir).catch(() => null);
  const binary = findChrome(chromePath, managed?.binary);
  // `profileDir` opts out of the throwaway profile: a fixed directory keeps cookies and
  // logins across launches, at the cost of the isolation the temporary one provides.
  const persistent = String(profileDir ?? '').trim() !== '';
  const userDataDir = persistent ? expandHome(profileDir) : await mkdtemp(join(tmpdir(), 'dsh-jev-browser-'));
  if (persistent) await mkdir(userDataDir, { recursive: true });
  // A locked profile cannot be launched onto at all: Chrome refuses, no DevTools port is
  // ever published, and the caller waits out the whole startup timeout to be told nothing
  // useful. Worse, the cleanup below deletes the *running* browser's DevToolsActivePort on
  // the way, so failing here also destroys the evidence that would have found it.
  if (persistent) {
    const holder = await profileHolderPid(userDataDir);
    if (holder !== null) {
      throw new Error(
        `a browser is already running on ${userDataDir} (pid ${holder}) and holds the profile; ` +
          `attach to it instead of launching (browser_open with its DevTools port as cdp), or close it first`,
      );
    }
  }
  // A reused profile still holds the previous run's DevToolsActivePort. Reading that
  // stale file first would point us at a browser that has already exited, so clear it
  // and let this launch publish its own.
  await rm(join(userDataDir, 'DevToolsActivePort'), { force: true }).catch(() => {});
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    `--window-size=${windowSize}`,
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 8000) stderr += chunk;
  });
  let exited = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.once('error', (error) => {
    exited = { error };
  });

  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + startupTimeoutMs;
  let port = null;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const text = await readFile(portFile, 'utf8').catch(() => '');
      const first = text.split('\n')[0]?.trim();
      if (first && /^\d+$/.test(first)) {
        port = Number(first);
        break;
      }
    }
    if (exited) break;
    await sleep(120);
  }

  const kill = async () => {
    if (exited === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2500)]);
      if (exited === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    if (!persistent) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  };

  if (port === null) {
    const detail = exited?.error ? String(exited.error.message ?? exited.error) : (stderr.trim() || 'no diagnostics on stderr');
    await kill();
    throw new Error(`the browser did not expose a DevTools port within ${startupTimeoutMs}ms: ${detail}`);
  }

  let wsUrl = null;
  while (Date.now() < deadline && wsUrl === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(4000) });
      if (response.ok) {
        const body = await response.json();
        if (typeof body?.webSocketDebuggerUrl === 'string') wsUrl = body.webSocketDebuggerUrl;
      }
    } catch {
      /* the HTTP endpoint needs a moment after the port file appears */
    }
    if (wsUrl === null) await sleep(150);
  }

  if (wsUrl === null) {
    await kill();
    throw new Error(`the browser published port ${port} but never served /json/version`);
  }

  return { binary, pid: child.pid, port, wsUrl, userDataDir, headless, persistent, ephemeral: !persistent, kill };
}
