/**
 * Bounded adaptive max_tokens retry helpers.
 *
 * Some real endpoints reject ProbeMux's intentionally tiny probe token limit
 * (max_tokens / max_output_tokens: 1) with an EXPLICIT token-lower-bound error
 * (e.g. "max_tokens must be greater than 2"). ProbeMux never blindly retries:
 * the retry fires only when the error message explicitly names the token limit
 * as too small, raises it to the minimum safe value (at least 3, honoring an
 * endpoint-stated minimum when present), and happens at most once per request
 * inside the caller's existing per-model request budget.
 */

const TOKEN_NAME = /(?:max[_ ]?output[_ ]?tokens?|max[_ ]?tokens?|token limit|tokens? (?:per request|budget))/i;

/** True ONLY when the endpoint explicitly reports the token limit / request body as too small. */
export function isTokenLowerBoundError(message: string): boolean {
  const lower = message.toLowerCase();
  const bodyTooSmall = /(?:request body|payload|request)\s+is?\s+too\s+small/i.test(lower);
  if (!TOKEN_NAME.test(lower) && !bodyTooSmall) return false;
  if (bodyTooSmall) return true;
  return [
    /(?:max[_ ]?output[_ ]?tokens?|max[_ ]?tokens?)\s*>\s*\d+/i,
    /(?:must|should|has to|needs to)\s+(?:be\s+)?(?:greater|larger|higher|bigger)\s+than\s+\d+/i,
    /(?:must|should)\s+(?:be\s+)?(?:at least|>=|>\s?)\s*\d+/i,
    /(?:is|are)\s+too\s+(?:small|low)/i,
    /min(?:imum)?\s*(?:[:=]|of)\s*\d+/i,
  ].some((pattern) => pattern.test(lower));
}

/** The numeric minimum the endpoint stated, when it stated one. */
export function extractMinimumTokens(message: string): number | undefined {
  const lower = message.toLowerCase();
  const patterns = [
    /(?:greater|larger|higher|bigger)\s+than\s+(\d+)/i,
    /(?:at least)\s+(\d+)/i,
    /(?:minimum|min)\s*[:=]\s*(\d+)/i,
    /(?:max[_ ]?output[_ ]?tokens?|max[_ ]?tokens?)\s*>\s*(\d+)/i,
    /(?:>=|>)\s*(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return undefined;
}

/** Minimum safe token limit ProbeMux raises to when the endpoint demands more. */
export const TOKEN_RETRY_MIN = 3;
/** Hard ceiling for the raised limit; a server-claimed minimum above this is not trusted. */
export const TOKEN_RETRY_CAP = 1024;

/** Return a copy of the probe body with the token limit raised to the minimum safe value. */
export function raiseTokenLimit(body: Record<string, unknown>, minTokens?: number): Record<string, unknown> {
  const raised = structuredClone(body);
  const target = Math.min(Math.max(minTokens ?? TOKEN_RETRY_MIN, TOKEN_RETRY_MIN), TOKEN_RETRY_CAP);
  for (const key of ["max_output_tokens", "max_tokens"] as const) {
    if (typeof raised[key] === "number") raised[key] = target;
  }
  return raised;
}
