/**
 * A small Markdown parser, for rendering an agent's replies as something other than punctuation.
 *
 * The conversation panel renders Markdown; a place that shows the same replies as raw text looks
 * broken beside it, which is exactly how it was reported.
 *
 * Deliberately a parser and not a renderer: the blocks it returns are plain data, so they can be
 * asserted without a DOM. The Client half renders them, and it cannot import from here — it is a
 * separate bundle — so it carries a verbatim copy that `test/markdown-check.mjs` compares against
 * this file. The duplicate is checked, not trusted.
 *
 * Scope: what an agent actually writes. Headings, paragraphs, fenced code, lists, tables, quotes,
 * rules, and inline code, bold, italic and links. **Not** nested lists, footnotes, HTML passthrough,
 * or reference links — a flatter subset that is honest about its edges rather than half-supporting
 * the rest.
 */

/** Split a table row into cells, trimming the outer pipes. */
function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

/** Whether a line is a table's separator row: |---|:--:|---| */
function isTableSeparator(line) {
  const cells = splitRow(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, '')));
}

/**
 * Parse one message body into blocks.
 *
 * @param text - the raw text.
 * @returns an array of blocks; empty input yields no blocks.
 */
export function parseMarkdown(text) {
  const source = typeof text === 'string' ? text : '';
  if (source.trim() === '') return [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    // Blank lines only separate.
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // A fenced code block, to its closing fence or the end.
    const fence = line.match(/^\s*(```|~~~)\s*([A-Za-z0-9+#._-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    // A table: a row with pipes, then a separator row.
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const head = splitRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      const body = [quote[1]];
      index += 1;
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: body.join('\n') });
      continue;
    }

    const bullet = line.match(/^\s*([-*+])\s+(.*)$/);
    const numbered = line.match(/^\s*(\d{1,9})[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const start = numbered ? Number(numbered[1]) : 1;
      const items = [];
      while (index < lines.length) {
        const next = ordered
          ? lines[index].match(/^\s*(\d{1,9})[.)]\s+(.*)$/)
          : lines[index].match(/^\s*([-*+])\s+(.*)$/);
        if (!next) break;
        items.push(next[2]);
        index += 1;
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    // A paragraph, up to the next blank line or a line that starts another block.
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index];
      if (candidate.trim() === '') break;
      if (/^\s*(```|~~~)/.test(candidate)) break;
      if (/^\s{0,3}#{1,6}\s+/.test(candidate)) break;
      if (/^\s{0,3}>\s?/.test(candidate)) break;
      if (/^\s*([-*+])\s+/.test(candidate) || /^\s*\d{1,9}[.)]\s+/.test(candidate)) break;
      if (candidate.includes('|') && isTableSeparator(candidate)) break;
      paragraph.push(candidate.trim());
      index += 1;
    }
    blocks.push({ type: 'para', text: paragraph.join('\n') });
  }

  return blocks;
}

/**
 * Split a line of text into inline spans.
 *
 * Code first, so that `**` inside `code` is code and not emphasis.
 */
export function parseInline(text) {
  const source = typeof text === 'string' ? text : '';
  const spans = [];
  const push = (span) => {
    if (span.text === '') return;
    const last = spans[spans.length - 1];
    if (last && last.type === 'text' && span.type === 'text') last.text += span.text;
    else spans.push(span);
  };
  let rest = source;

  while (rest !== '') {
    const code = rest.match(/^`([^`]+)`/);
    if (code) {
      push({ type: 'code', text: code[1] });
      rest = rest.slice(code[0].length);
      continue;
    }
    const link = rest.match(/^\[([^\]]*)\]\(([^)\s]+)\)/);
    if (link) {
      push({ type: 'link', text: link[1] || link[2], href: link[2] });
      rest = rest.slice(link[0].length);
      continue;
    }
    const strong = rest.match(/^\*\*([^*]+)\*\*/) || rest.match(/^__([^_]+)__/);
    if (strong) {
      push({ type: 'strong', text: strong[1] });
      rest = rest.slice(strong[0].length);
      continue;
    }
    const em = rest.match(/^\*([^*\s][^*]*)\*/) || rest.match(/^_([^_\s][^_]*)_/);
    if (em) {
      push({ type: 'em', text: em[1] });
      rest = rest.slice(em[0].length);
      continue;
    }
    // Take one character of plain text and try again from the next position.
    const next = rest.slice(1).search(/[`*_[\]\\]/);
    const take = next === -1 ? rest.length : next + 1;
    push({ type: 'text', text: rest.slice(0, take) });
    rest = rest.slice(take);
  }

  return spans;
}
