/**
 * TypeSafe Jev (System One) client, spoken over CommandCode's Provider API.
 *
 * Jev is a decision model, not a chat model: one request carries a single `state`
 * plus any number of typed questions, and the response carries calibrated
 * probabilities per question. It never generates text, which is exactly why the
 * browser action space has to be finite and enumerated by the caller.
 *
 * The wire shape is `POST {baseUrl}/systemone` with `{ model, state, questions }`;
 * see https://commandcode.ai/docs/provider ("Decision models (typesafe/jev)").
 *
 * @module @local/dsh-jev-browser/lib/jev
 */

/** The three question kinds System One answers. */
export const QUESTION_TYPES = ['noul', 'choice', 'score'];

/**
 * Validate questions before spending a request.
 * @param questions - the question map.
 * @throws when a question would be rejected by the endpoint.
 */
/**
 * Validate the `state` field.
 *
 * The endpoint accepts a string, an object, or an array: "use an object for most requests so
 * each part of the state has a descriptive name". A string is what this plugin sends today,
 * and an object is where it is heading — accepting both here is what keeps that a change of
 * caller, not of transport.
 *
 * @throws when the value is absent or carries nothing.
 */
export function validateState(state) {
  if (typeof state === 'string') {
    if (state.trim() === '') throw new Error('state must not be an empty string');
    return;
  }
  if (Array.isArray(state)) {
    if (state.length === 0) throw new Error('state must not be an empty array');
    return;
  }
  if (state !== null && typeof state === 'object') {
    if (Object.keys(state).length === 0) throw new Error('state must not be an empty object');
    return;
  }
  throw new Error('state must be a string, an object, or an array');
}

export function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new Error('questions must be an object keyed by question id');
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new Error('at least one question is required');
  for (const id of ids) {
    const question = questions[id];
    if (!question || typeof question !== 'object') throw new Error(`question "${id}" must be an object`);
    if (!QUESTION_TYPES.includes(question.type)) {
      throw new Error(`question "${id}" has type "${question.type}"; expected one of ${QUESTION_TYPES.join('/')}`);
    }
    if (typeof question.instructions !== 'string' || question.instructions.trim() === '') {
      throw new Error(`question "${id}" needs non-empty instructions`);
    }
    if (question.type === 'choice') {
      const criteria = question.criteria;
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria) || Object.keys(criteria).length < 2) {
        throw new Error(`choice question "${id}" needs a criteria object with at least two options`);
      }
    }
    if (question.type === 'score') {
      const criteria = question.criteria;
      if (!Array.isArray(criteria) || criteria.length < 2) {
        throw new Error(`score question "${id}" needs a criteria array of at least two ordered levels`);
      }
    }
  }
}

/**
 * Ask one batch of typed questions about one state.
 *
 * @param options - endpoint, credential, model, state, questions, and timeout.
 * @returns the raw System One response, including `answers` and `usage`.
 */
export async function systemOne({ baseUrl, apiKey, model, state, questions, timeoutMs = 45000, signal }) {
  if (!apiKey) throw new Error('no CommandCode API key resolved');
  validateState(state);
  validateQuestions(questions);
  const url = `${String(baseUrl).replace(/\/+$/, '')}/systemone`;
  const timeout = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error(`the Jev decision request timed out after ${timeoutMs}ms`);
    throw new Error(`the Jev decision request failed: ${error?.message ?? error}`);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Jev endpoint returned ${response.status}: ${body.slice(0, 400)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`the Jev endpoint returned non-JSON: ${body.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed.answers !== 'object' || parsed.answers === null) {
    throw new Error(`the Jev response carried no answers: ${body.slice(0, 200)}`);
  }
  return parsed;
}

/**
 * Read one `noul` answer.
 * @returns the probability of "true", or `undefined` when the answer is missing or mistyped.
 */
export function readNoul(answers, id) {
  const answer = answers?.[id];
  return answer && answer.type === 'noul' && typeof answer.noul === 'number' ? answer.noul : undefined;
}

/**
 * Read one `choice` answer.
 * @returns `{ choice, confidence, probabilities }`, or `undefined` when missing or mistyped.
 */
export function readChoice(answers, id) {
  const answer = answers?.[id];
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') return undefined;
  return {
    choice: answer.choice,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : undefined,
    probabilities: answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : undefined,
  };
}

/**
 * Read one `score` answer.
 * @returns `{ score, confidence, probabilities }`, or `undefined` when missing or mistyped.
 */
export function readScore(answers, id) {
  const answer = answers?.[id];
  if (!answer || answer.type !== 'score' || typeof answer.score !== 'number') return undefined;
  return {
    score: answer.score,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : undefined,
    probabilities: answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : undefined,
  };
}

/** Round for display without pretending to more precision than the model reports. */
export const round = (value, digits = 2) => {
  if (typeof value !== 'number') return undefined;
  const rounded = Number(value.toFixed(digits));
  // A negative value inside the rounding window lands on `-0`, which the harness rejects as
  // non-lossless JSON — it would fail the whole tool result over a number that means zero.
  return Object.is(rounded, -0) ? 0 : rounded;
};

/**
 * Resolve the CommandCode credential for one call.
 *
 * Resolution is per call by contract: a key changed in Settings reaches the next
 * decision without a restart.
 *
 * @param ctx - the plugin context, used for the optional credentials service.
 * @param apiKeyEnv - the credential reference name.
 * @returns `{ value, source }`.
 * @throws when the reference is unconfigured everywhere.
 */
export async function resolveApiKey(ctx, apiKeyEnv) {
  const credentials = ctx.get('credentials');
  if (credentials && typeof credentials.resolve === 'function') {
    const resolved = await credentials.resolve(apiKeyEnv);
    if (resolved && typeof resolved.value === 'string' && resolved.value !== '') {
      return { value: resolved.value, source: resolved.source ?? 'credentials' };
    }
  }
  const fromEnv = process.env[apiKeyEnv];
  if (typeof fromEnv === 'string' && fromEnv !== '') return { value: fromEnv, source: 'process.env' };
  throw new Error(
    `no credential is configured for ${apiKeyEnv}; store it in Settings → Models (or export it in the launching environment)`,
  );
}
