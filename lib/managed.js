/**
 * Managed Chromium — a browser this project owns, instead of borrowing the user's.
 *
 * Why it exists: installed Chrome can use the plugin's own persistent login profile, but
 * the Chrome Auto-Update treadmill can change the DevTools surface under a running
 * plugin. A pinned Chrome-for-Testing build removes that variable and leaves the user's
 * own browser completely alone.
 *
 * What it deliberately is not: a stealth build. It is stock Chrome for Testing, so it
 * presents exactly the automation signals stock Chrome does. Pinning a version buys
 * reproducibility, not invisibility.
 *
 * Nothing here downloads by itself. A ~200 MB fetch is the user's decision, so it
 * happens only when `browser_open` is called with `install_browser: true`.
 *
 * @module @local/dsh-jev-browser/lib/managed
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expandHome } from './paths.js';

/** The pinned-versions index published by the Chrome for Testing project. */
const KNOWN_GOOD_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

/** Where a managed browser lives when the config names no directory. */
export function defaultManagedDir(configured) {
  const explicit = String(configured ?? '').trim();
  if (explicit !== '') return expandHome(explicit);
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh');
  return join(home, 'runtimes', 'jev-browser');
}

/** The Chrome-for-Testing platform key for this machine. */
export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'win32') return arch === 'ia32' ? 'win32' : 'win64';
  return 'linux64';
}

/** The executable's path inside an extracted platform archive. */
export function binaryRelativePath(platform = platformKey()) {
  if (platform.startsWith('mac')) {
    return join(`chrome-${platform}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  }
  if (platform.startsWith('win')) return join(`chrome-${platform}`, 'chrome.exe');
  return join(`chrome-${platform}`, 'chrome');
}

/** The install pointer this module owns. */
const pointerPath = (root) => join(root, 'installed.json');

/**
 * Resolve an installed managed browser.
 *
 * The pointer is authoritative, but a missing one falls back to the conventional layout
 * for this platform, so a directory populated by hand still works.
 *
 * @param dir - configured managed directory, or empty for the default.
 * @returns `{ binary, version, platform }`, or `null` when nothing is installed.
 */
export async function resolveManagedBrowser(dir) {
  const root = defaultManagedDir(dir);
  try {
    const record = JSON.parse(await readFile(pointerPath(root), 'utf8'));
    if (record && typeof record.binary === 'string' && existsSync(record.binary)) {
      return { binary: record.binary, version: record.version ?? null, platform: record.platform ?? platformKey() };
    }
  } catch {
    /* fall through to the conventional layout */
  }
  const fallback = join(root, binaryRelativePath());
  return existsSync(fallback) ? { binary: fallback, version: null, platform: platformKey() } : null;
}

/**
 * Read the pinned version and download URL for this machine.
 * @returns `{ version, url, platform }`.
 */
export async function resolveDownload({ channel = 'Stable', platform = platformKey(), timeoutMs = 20000 } = {}) {
  const response = await fetch(KNOWN_GOOD_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${KNOWN_GOOD_URL} returned ${response.status}`);
  const body = await response.json();
  const release = body?.channels?.[channel];
  if (!release) throw new Error(`the Chrome for Testing index has no "${channel}" channel`);
  const entry = (release.downloads?.chrome ?? []).find((candidate) => candidate.platform === platform);
  if (!entry?.url) throw new Error(`no Chrome for Testing build for "${platform}" in ${release.version}`);
  return { version: String(release.version), url: String(entry.url), platform };
}

/** Run one child process to completion, keeping stderr for diagnostics. */
function run(command, args, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(undefined);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 400)}`));
    });
  });
}

/**
 * Download, extract, and record a pinned Chrome for Testing build.
 *
 * Extraction goes to a version-named directory, so the recorded binary path is stable
 * and a re-install of the same version lands in the same place instead of accumulating
 * copies.
 *
 * @param options - target directory, release channel, and a progress callback.
 * @returns `{ binary, version, platform, dir }`.
 */
export async function installManagedBrowser({ dir, channel = 'Stable', onProgress = () => {} } = {}) {
  const root = defaultManagedDir(dir);
  await mkdir(root, { recursive: true });
  const { version, url, platform } = await resolveDownload({ channel });
  onProgress(`downloading Chrome for Testing ${version} (${platform})`);

  const archive = join(root, `chrome-${platform}-${version}.zip`);
  const response = await fetch(url, { signal: AbortSignal.timeout(900000) });
  if (!response.ok) throw new Error(`the download returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(archive, bytes);
  onProgress(`downloaded ${(bytes.length / 1e6).toFixed(0)} MB; extracting`);

  const extractDir = join(root, `chrome-${platform}-${version}`);
  await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(extractDir, { recursive: true });
  try {
    await run('unzip', ['-q', '-o', archive, '-d', extractDir]);
    const binary = join(extractDir, binaryRelativePath(platform));
    if (!existsSync(binary)) throw new Error(`the archive did not contain ${binaryRelativePath(platform)}`);
    await writeFile(
      pointerPath(root),
      JSON.stringify({ version, platform, url, binary, installedAt: new Date().toISOString() }, null, 2),
    );
    onProgress(`installed ${version} at ${binary}`);
    return { binary, version, platform, dir: root };
  } finally {
    await rm(archive, { force: true }).catch(() => {});
  }
}
