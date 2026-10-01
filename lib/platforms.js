/**
 * The four platforms, as a closed set.
 *
 * Everything the plugin stores is now scoped to one of these: contacts, authorisations, postings.
 * The same person exists on more than one platform and the same posting is four different pools
 * with four different quotas, so a shared bucket is not a simplification — it is a wrong answer
 * that looks like a right one.
 *
 * The domain match is by whole labels, never by substring. `notzhaopin.com` and
 * `zhaopin.com.evil.tld` are not 智联, and a run authorised for 智联 must not act on a page that
 * merely contains its name.
 */

export const PLATFORMS = [
  { id: 'zhaopin', name: '智联招聘', domains: ['zhaopin.com'] },
  { id: 'zhipin', name: 'BOSS直聘', domains: ['zhipin.com'] },
  { id: '51job', name: '前程无忧', domains: ['51job.com'] },
  { id: 'liepin', name: '猎聘', domains: ['liepin.com'] },
];

/** The platform ids, in the order the workbench shows them. */
export const PLATFORM_IDS = PLATFORMS.map((platform) => platform.id);

/** The separator between a platform and a file name: `zhaopin--contacts.jsonl`. */
export const PLATFORM_SEPARATOR = '--';

/** One platform by id, or undefined. */
export function platformById(id) {
  return PLATFORMS.find((platform) => platform.id === id);
}

/** One platform by id, or a refusal naming the ones that exist. */
export function requirePlatform(id) {
  const platform = platformById(id);
  if (!platform) {
    throw new Error(`unknown platform ${JSON.stringify(id)}; expected one of ${PLATFORM_IDS.join(', ')}`);
  }
  return platform;
}

/** The display name for an id, falling back to the id itself. */
export function platformName(id) {
  return platformById(id)?.name ?? String(id ?? '');
}

/**
 * The hostname of a URL, or of something that is already a hostname.
 *
 * A bare string that will not parse as a URL is treated as a host, with any port and path cut
 * off, so this works on a full page URL and on a domain the caller typed.
 */
export function hostOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  const text = value.trim();
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`);
    return url.hostname.toLowerCase();
  } catch {
    return text.split('/')[0].split(':')[0].toLowerCase();
  }
}

/** Whether a host belongs to a domain, by whole labels. */
export function hostBelongsTo(host, domain) {
  const h = hostOf(host);
  const d = String(domain ?? '').toLowerCase();
  if (h === '' || d === '') return false;
  return h === d || h.endsWith(`.${d}`);
}

/** The platform a URL or host belongs to, or null. */
export function platformOf(value) {
  const host = hostOf(value);
  if (host === '') return null;
  for (const platform of PLATFORMS) {
    if (platform.domains.some((domain) => hostBelongsTo(host, domain))) return platform;
  }
  return null;
}

/** Whether a URL or host belongs to the named platform. */
export function belongsToPlatform(platformId, value) {
  const platform = platformById(platformId);
  if (!platform) return false;
  return platformOf(value)?.id === platform.id;
}

/**
 * Assert that a URL belongs to the named platform.
 *
 * Used before a run acts: an authorisation for one platform is not a licence to act on another,
 * and a page whose address merely contains the platform's name is not that platform.
 */
export function assertOnPlatform(platformId, value) {
  const platform = requirePlatform(platformId);
  const found = platformOf(value);
  if (!found) throw new Error(`${JSON.stringify(String(value))} is not a page on any known platform`);
  if (found.id !== platform.id) {
    throw new Error(`this is ${found.name}, not ${platform.name}: an authorisation for one platform does not cover another`);
  }
  return true;
}

/** A file name scoped to a platform: `zhaopin--contacts.jsonl`. */
export function platformFile(platformId, name) {
  requirePlatform(platformId);
  return `${platformId}${PLATFORM_SEPARATOR}${name}`;
}

/** The platform a file name is scoped to, or null for a name that is not scoped. */
export function platformOfFile(fileName) {
  const text = String(fileName ?? '');
  for (const platform of PLATFORMS) {
    if (text.startsWith(`${platform.id}${PLATFORM_SEPARATOR}`)) return platform.id;
  }
  return null;
}

/**
 * A short line describing one platform's state, for the workbench.
 *
 * Kept here rather than in the client so the page and any future report describe a platform the
 * same way; the client cannot import from here, so this is for the Host's own status payload.
 */
export function describePlatforms(states = {}) {
  return PLATFORMS.map((platform) => ({
    id: platform.id,
    name: platform.name,
    ...(states[platform.id] ?? {}),
  }));
}
