/**
 * Finding identity in text, so it can be kept out of a public repository.
 *
 * The scanner is deliberately split from the policy that uses it:
 *
 * - **Shapes** live here. They are generic — a provider key, a home-directory path, an email,
 *   a mobile number, a console usage phrase — and they are useful to anyone, so they can be
 *   published.
 * - **This user's identifiers** live in a local file
 *   (`$DSH_SCOUT_HOME/privacy-denylist.txt`) and are passed in. They can never be published,
 *   which is exactly why they cannot be part of the public pattern list.
 *
 * A line carrying the {@link ALLOW_MARKER} is skipped. That is what keeps the pattern
 * definitions from matching their own source; the marker is visible in review, so it cannot
 * hide anything quietly.
 *
 * @module @local/dsh-jev-browser/lib/privacy
 */

/** Put this on a line that must mention a sensitive shape on purpose. */
export const ALLOW_MARKER = 'privacy-check:allow';

/**
 * The shapes that give a person or an account away.
 *
 * Deliberately narrow. A looser list — any long number, any capitalised word — reports so
 * much ordinary code that the real finding disappears among the noise.
 */
export const SHAPES = [
  { id: 'provider key', re: /sk-[A-Za-z0-9_-]{16,}|gho_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}/g },
  { id: 'bearer token', re: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { id: 'home directory path', re: /\/(?:Users|home)\/[^/\s"'`]+\//g }, // privacy-check:allow
  { id: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g },
  { id: 'chinese mobile number', re: /1[3-9]\d{9}/g },
  { id: 'console usage phrase', re: /聊天配额|剩余聊天|聊天\s*\d+\s*次/g }, // privacy-check:allow
];

/**
 * Scan text for sensitive shapes and for the supplied local tokens.
 *
 * @param text - the text to scan.
 * @param extraTokens - this user's own identifiers; an empty string is ignored.
 * @returns one finding per occurrence, with a 1-based line number and the matched literal.
 */
export function scanText(text, extraTokens = []) {
  const findings = [];
  const lines = String(text ?? '').split('\n');
  const tokens = (Array.isArray(extraTokens) ? extraTokens : []).filter((token) => typeof token === 'string' && token !== '');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes(ALLOW_MARKER)) continue;
    for (const { id, re } of SHAPES) {
      re.lastIndex = 0;
      for (const match of line.matchAll(re)) findings.push({ line: index + 1, id, hit: match[0].slice(0, 60) });
    }
    for (const token of tokens) {
      if (line.includes(token)) findings.push({ line: index + 1, id: 'local denylist', hit: token });
    }
  }
  return findings;
}

/**
 * Replace sensitive shapes in text with neutral placeholders.
 *
 * Used by the fixture sanitiser so turning a real page into a publishable one is a repeatable
 * step rather than a manual reading. It reports what it replaced, because a replacement that
 * cannot be reviewed is one nobody should trust.
 *
 * @returns `{ text, replacements }` where each replacement names the shape and the original.
 */
export function sanitizeText(text, extraTokens = []) {
  const replacements = [];
  let output = String(text ?? '');
  const applyAll = (id, re, replace) => {
    output = output.replace(re, (...args) => {
      const match = args[0];
      replacements.push({ id, from: match.slice(0, 60), to: replace(match) });
      return replace(match);
    });
  };
  applyAll('provider key', SHAPES[0].re, () => 'REDACTED-KEY');
  applyAll('bearer token', SHAPES[1].re, () => 'Bearer REDACTED');
  // The placeholders must not look like what they replace: a phone-shaped placeholder is
  // itself a mobile number, and a path-shaped one is itself a home path, so the sanitiser
  // would hand back text that its own scanner flags. (Spelled out rather than quoted, because
  // a comment containing the shape it warns about is the same trap.)
  applyAll('home directory path', SHAPES[2].re, () => 'REDACTED-PATH');
  applyAll('email address', SHAPES[3].re, () => 'REDACTED-EMAIL');
  applyAll('chinese mobile number', SHAPES[4].re, () => 'REDACTED-PHONE');
  for (const token of (Array.isArray(extraTokens) ? extraTokens : [])) {
    if (typeof token !== 'string' || token === '') continue;
    while (output.includes(token)) {
      replacements.push({ id: 'local denylist', from: token, to: 'REDACTED' });
      output = output.replace(token, 'REDACTED');
    }
  }
  return { text: output, replacements };
}
