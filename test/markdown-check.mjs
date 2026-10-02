/**
 * The Markdown parser, and the copy of it the Client half carries.
 *
 * The parser is tested for the things an agent actually writes — and for the edges that are easy to
 * get quietly wrong: a fence that never closes, a `|` in prose, `**` inside `code`, a list that
 * follows a paragraph without a blank line.
 *
 * The second half of the suite is the more unusual one. The Client half is a separate bundle and
 * cannot import from `lib/`, so it carries a verbatim copy of the parser; this compares that copy
 * against the original, so the duplicate is checked rather than trusted. A parser fixed in one
 * place and not the other would otherwise be two different renderers with one test between them.
 *
 * Run: node test/markdown-check.mjs
 */

import './isolate.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { parseMarkdown, parseInline } = await import('../lib/markdown.js');

let failures = 0;
async function verify(name, run) {
  try {
    await run();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${error.message}`);
  }
}

/** The block types in order, for compact assertions. */
const kinds = (text) => parseMarkdown(text).map((block) => block.type);

await verify('an empty body yields nothing, not an empty paragraph', async () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('   \n\n  '), []);
  assert.deepEqual(parseMarkdown(null), []);
});

await verify('headings, rules and paragraphs', async () => {
  assert.deepEqual(parseMarkdown('# 标题'), [{ type: 'heading', level: 1, text: '标题' }]);
  assert.deepEqual(parseMarkdown('### 三级'), [{ type: 'heading', level: 3, text: '三级' }]);
  assert.deepEqual(kinds('段落一\n\n---\n\n段落二'), ['para', 'rule', 'para']);
  // A paragraph keeps its internal line breaks and loses the surrounding ones.
  assert.deepEqual(parseMarkdown('  第一行\n第二行  '), [{ type: 'para', text: '第一行\n第二行' }]);
  // `#` without a space is not a heading, which is how agents write C# and issue numbers.
  assert.deepEqual(kinds('#hashtag'), ['para']);
});

await verify('a fenced code block is taken whole', async () => {
  const blocks = parseMarkdown('先说：\n\n```js\nconst a = 1;\n**not bold**\n```\n\n后说。');
  assert.deepEqual(blocks.map((b) => b.type), ['para', 'code', 'para']);
  assert.equal(blocks[1].lang, 'js');
  assert.equal(blocks[1].text, 'const a = 1;\n**not bold**');
  // An unclosed fence runs to the end rather than swallowing the rest as prose.
  const open = parseMarkdown('```\nrunaway');
  assert.deepEqual(open, [{ type: 'code', lang: '', text: 'runaway' }]);
  // A fence inside a paragraph ends the paragraph.
  assert.deepEqual(kinds('文字\n```\ncode\n```'), ['para', 'code']);
});

await verify('lists, ordered and not', async () => {
  assert.deepEqual(parseMarkdown('- 一\n- 二'), [{ type: 'list', ordered: false, start: 1, items: ['一', '二'] }]);
  assert.deepEqual(parseMarkdown('3. 三\n4. 四'), [{ type: 'list', ordered: true, start: 3, items: ['三', '四'] }]);
  // A list directly after a paragraph is a list: agents rarely leave the blank line.
  assert.deepEqual(kinds('说明：\n- 一\n- 二'), ['para', 'list']);
  // Mixed markers are separate lists rather than one with a wrong marker.
  assert.deepEqual(kinds('- 一\n1. 二'), ['list', 'list']);
});

await verify('a table is read as a table, and a stray pipe is not', async () => {
  const blocks = parseMarkdown('| 平台 | 条数 |\n| --- | ---: |\n| 智联 | 6 |\n| BOSS | 0 |');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { type: 'table', head: ['平台', '条数'], rows: [['智联', '6'], ['BOSS', '0']] });
  // One line with a pipe and no separator is prose.
  assert.deepEqual(kinds('a | b'), ['para']);
  assert.deepEqual(kinds('| 只有表头 |'), ['para']);
});

await verify('quotes', async () => {
  assert.deepEqual(parseMarkdown('> 引用\n> 续行'), [{ type: 'quote', text: '引用\n续行' }]);
  assert.deepEqual(kinds('> 引用\n\n正文'), ['quote', 'para']);
});

await verify('inline code is taken before emphasis', async () => {
  assert.deepEqual(parseInline('`**not bold**`'), [{ type: 'code', text: '**not bold**' }]);
  assert.deepEqual(parseInline('**粗** 和 *斜*'), [
    { type: 'strong', text: '粗' }, { type: 'text', text: ' 和 ' }, { type: 'em', text: '斜' },
  ]);
  assert.deepEqual(parseInline('[名](https://example.com)'), [{ type: 'link', text: '名', href: 'https://example.com' }]);
  // Plain text stays one span, so a message without markup renders as one piece.
  assert.deepEqual(parseInline('就是一句话'), [{ type: 'text', text: '就是一句话' }]);
  assert.deepEqual(parseInline(''), []);
  // An asterisk with nothing to close is left alone rather than eating the line.
  assert.deepEqual(parseInline('2 * 3'), [{ type: 'text', text: '2 * 3' }]);
});

await verify('the Client half carries the same parser', async () => {
  const lib = await readFile(new URL('../lib/markdown.js', import.meta.url), 'utf8');
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const marker = '/** Split a table row into cells, trimming the outer pipes. */';
  const original = lib.slice(lib.indexOf(marker)).trimEnd();

  const open = client.indexOf('// ─── markdown parser: a verbatim copy of lib/markdown.js');
  const close = client.indexOf('// ─── end markdown parser');
  assert.ok(open !== -1 && close > open, 'the client copy is not delimited any more');
  // The copy starts at the parser's own doc comment, so the note above it is not compared.
  const carried = client.slice(client.indexOf(marker, open), client.lastIndexOf('\n', close));

  // Only two differences are allowed: `export `, and the client keeps its own indentation.
  const normalise = (text) => text.replace(/export function /g, 'function ').split('\n').map((line) => line.trimEnd()).join('\n').trim();
  assert.equal(
    normalise(carried),
    normalise(original),
    'the parser in client.js has drifted from lib/markdown.js — copy it again with the same script',
  );
});

console.log(`\n===== ${failures} failure(s) =====`);
process.exit(failures === 0 ? 0 : 1);
