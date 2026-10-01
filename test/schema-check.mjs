/**
 * Self-contained schema regression test — run with any Node 22+: `node test/schema-check.mjs`.
 *
 * This guards the defect that made the first installation unusable: a schema node
 * carrying a key whose value is `undefined` survives `Object.hasOwn` but not a JSON
 * round trip, and `@deepseek-ai/dsh-tools` refuses to project a parameters or output
 * document that is not lossless JSON. That refusal happens once per model request
 * while building the request, so it breaks the whole session rather than one tool.
 *
 * The authoritative check is `assertSupportedJsonSchema` / `validateJsonSchemaValue`
 * from the shipped `@deepseek-ai/dsh-tools`; this file re-implements only the rules it
 * can state exactly, so it runs without the Harness packages present.
 */

import { buildTools } from '../lib/tools.js';
import { resolveConfig } from '../index.js';

const problems = [];
const fail = (message) => problems.push(message);

/** Everything a JSON round trip would change or drop. */
function scanLossless(value, path, seen = new Set()) {
  if (value === undefined) return fail(`${path}: undefined is not a JSON value`);
  if (typeof value === 'number' && !Number.isFinite(value)) return fail(`${path}: ${value} is not a JSON number`);
  if (['function', 'symbol', 'bigint'].includes(typeof value)) return fail(`${path}: ${typeof value} is not a JSON value`);
  if (value === null || typeof value !== 'object') return undefined;
  if (seen.has(value)) return fail(`${path}: circular reference`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanLossless(entry, `${path}[${index}]`, seen));
  } else {
    for (const key of Object.keys(value)) {
      if (!(key in value)) fail(`${path}.${key}: missing value (sparse object)`);
      scanLossless(value[key], `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
  return undefined;
}

const SCALARS = ['string', 'number', 'integer', 'boolean', 'null'];
const ON_OBJECT_ONLY = ['properties', 'required', 'additionalProperties'];
const ON_ARRAY_ONLY = ['items'];
const ON_SCALAR_ONLY = ['enum', 'const'];

/** The registry's supported JSON Schema subset, as `assertSupportedJsonSchema` enforces it. */
function checkSchema(node, path) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return fail(`${path}: must be a schema object`);
  }
  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (hasType && hasOneOf) return fail(`${path}: cannot declare both type and oneOf`);
  if (!hasType && !hasOneOf) return fail(`${path}: needs type or oneOf`);

  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) fail(`${path}.oneOf must hold at least two schemas`);
    for (const key of [...ON_OBJECT_ONLY, ...ON_ARRAY_ONLY, ...ON_SCALAR_ONLY]) {
      if (Object.hasOwn(node, key)) fail(`${path}.${key} is not supported beside oneOf`);
    }
    (node.oneOf ?? []).forEach((entry, index) => checkSchema(entry, `${path}.oneOf[${index}]`));
    return undefined;
  }

  const type = node.type;
  if (typeof type !== 'string' || ![...SCALARS, 'object', 'array'].includes(type)) {
    return fail(`${path}.type must be a single supported type string, got ${JSON.stringify(type)}`);
  }
  for (const key of ON_OBJECT_ONLY) {
    if (Object.hasOwn(node, key) && type !== 'object') fail(`${path}.${key} requires type "object"`);
  }
  for (const key of ON_ARRAY_ONLY) {
    if (Object.hasOwn(node, key) && type !== 'array') fail(`${path}.${key} requires type "array"`);
  }
  for (const key of ON_SCALAR_ONLY) {
    if (Object.hasOwn(node, key) && !SCALARS.includes(type)) fail(`${path}.${key} requires a scalar type`);
  }

  if (type === 'object') {
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
        fail(`${path}.required must be an array of strings`);
      } else {
        const declared = node.properties && typeof node.properties === 'object' ? node.properties : {};
        for (const key of node.required) {
          if (!Object.hasOwn(declared, key)) fail(`${path}.required names "${key}" which is not in properties`);
        }
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      fail(`${path}.additionalProperties must be a boolean`);
    }
    for (const [key, sub] of Object.entries(node.properties ?? {})) checkSchema(sub, `${path}.properties.${key}`);
  }
  if (type === 'array' && Object.hasOwn(node, 'items')) checkSchema(node.items, `${path}.items`);
  return undefined;
}

const tools = buildTools({ ctx: { get: () => undefined }, config: resolveConfig({}), sessions: {} });
const seenNames = new Set();

/**
 * Build the smallest value that conforms to one schema node, so `render` is exercised
 * with the shape it will actually receive instead of an empty placeholder.
 */
function sampleFrom(node) {
  if (Array.isArray(node.oneOf)) return sampleFrom(node.oneOf[0]);
  if (node.const !== undefined) return node.const;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  switch (node.type) {
    case 'object': {
      const sample = {};
      for (const [key, sub] of Object.entries(node.properties ?? {})) sample[key] = sampleFrom(sub);
      return sample;
    }
    case 'array':
      return node.items ? [sampleFrom(node.items)] : [];
    case 'string':
      return 'sample';
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

for (const tool of tools) {
  if (typeof tool.name !== 'string' || tool.name === '') fail('a tool has no name');
  if (seenNames.has(tool.name)) fail(`duplicate tool name ${tool.name}`);
  seenNames.add(tool.name);
  if (tool.name === 'run_code') fail('run_code is reserved and cannot be registered');
  if (typeof tool.description !== 'string' || tool.description === '') fail(`${tool.name}: needs a description`);
  if (typeof tool.execute !== 'function') fail(`${tool.name}: needs execute()`);
  if (typeof tool.output?.render !== 'function') fail(`${tool.name}: output.render must be a function`);
  if (!(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0)) fail(`${tool.name}: timeoutMs must be positive and finite`);

  for (const [label, node] of [
    ['parameters', tool.parameters],
    ['output.schema', tool.output.schema],
  ]) {
    scanLossless(node, `${tool.name}.${label}`);
    checkSchema(node, `${tool.name}.${label}`);
    if (node.type !== 'object') fail(`${tool.name}.${label} should be object-rooted`);
  }

  if (typeof tool.output?.render === 'function' && typeof tool.execute === 'function') {
    let rendered;
    try {
      rendered = tool.output.render(sampleFrom(tool.parameters), sampleFrom(tool.output.schema));
    } catch (error) {
      fail(`${tool.name}: output.render threw on a schema-shaped sample: ${error.message}`);
    }
    if (rendered !== undefined && (!Array.isArray(rendered) || rendered.length === 0)) {
      fail(`${tool.name}: output.render must return a non-empty ContentBlock array`);
    }
  }
}

const names = tools.map((tool) => tool.name).join(', ');
console.log(`${tools.length} tool definitions checked: ${names}`);
if (problems.length === 0) {
  console.log('schema-check: OK — every schema is in the supported subset and lossless JSON');
  process.exit(0);
}
console.log(`schema-check: ${problems.length} problem(s)`);
for (const problem of problems) console.log('  !! ' + problem);
process.exit(1);
