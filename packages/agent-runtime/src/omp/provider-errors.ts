import type { AgentErrorCode } from "@hyperframes/agent-protocol";
import { RuntimeError } from "../errors.ts";

/** Longest message a failure or a failed tool row carries to the chat. */
export const FAILURE_MESSAGE_LIMIT = 300;

const CONTEXT_OVERFLOW =
  /context[ _-]?(length|window|limit)|maximum context|prompt is too long|too many (input )?tokens|exceeds? the (model'?s? )?(max|context)|request (is )?too large|input is too long|token limit/i;
const RATE_LIMITED =
  /\b429\b|rate[ _-]?limit|too many requests|quota|usage limit|insufficient[ _-]?(quota|credits?)|credit balance|billing|exceeded your current|spend limit/i;
const AUTH =
  /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid[ _-]?(api[ _-]?)?(key|token|credentials?)|authentication|authenticat(e|ion) (failed|error)|permission denied|no (api )?key|no authenticated|api key (is )?(missing|not)|(no|missing|without) (configured )?credentials|not (logged|signed) in|sign[ -]?in (expired|required)|token (has )?expired|revoked|oauth/i;
const OVERLOADED =
  /overloaded|\b52[0-9]\b|\b50[0234]\b|service unavailable|temporarily unavailable|bad gateway|gateway time-?out|at capacity|capacity|try again later|timed? ?out|econnreset|socket hang up|network error|fetch failed/i;

/**
 * The failure class of a model provider's error text. The provider's wording is all there is to go on (the SDK hands
 * over a message, not a status), so the checks run from the most specific class to the most generic one.
 */
export function classifyProviderError(message: string): AgentErrorCode {
  if (CONTEXT_OVERFLOW.test(message)) return "context_overflow";
  if (RATE_LIMITED.test(message)) return "rate_limited";
  if (AUTH.test(message)) return "provider_auth";
  if (OVERLOADED.test(message)) return "provider_overloaded";
  return "agent_failed";
}

/**
 * The error a failed prompt rejects with: classified, and when the SDK retried first, saying that it did so a user
 * does not read a bare "overloaded" after minutes of silence.
 */
export function providerFailure(message: string, retries?: { attempts: number }): RuntimeError {
  const code = classifyProviderError(message);
  const tried =
    retries && retries.attempts > 0 && code !== "agent_failed" && code !== "context_overflow"
      ? ` (still failing after ${retries.attempts} ${retries.attempts === 1 ? "retry" : "retries"})`
      : "";
  return new RuntimeError(code, `${message}${tried}`, 502);
}

const BARE_SECRETS: readonly RegExp[] = [
  /\b(sk|pk|rk|key|tok|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{20,}/g,
];
const LABELLED_SECRET =
  /\b(api[_-]?key|token|secret|password|authorization)(["']?\s*[=:]\s*["']?)[^\s"',;]{6,}/gi;
/** `?key=…` in a request URL a provider error may quote. Only `=`: "key: value" is ordinary error prose. */
const KEY_PARAMETER = /\b(key=)[^\s"'&,;]{6,}/gi;

/** A tool's own failure text, cut to what a chat row shows, with anything that looks like a credential masked. */
export function toolFailureMessage(text: string): string {
  let clean = text.replace(/\s+/g, " ").trim();
  for (const pattern of BARE_SECRETS) clean = clean.replace(pattern, "[hidden]");
  clean = clean.replace(LABELLED_SECRET, "$1$2[hidden]").replace(KEY_PARAMETER, "$1[hidden]");
  return clean.length <= FAILURE_MESSAGE_LIMIT
    ? clean
    : `${clean.slice(0, FAILURE_MESSAGE_LIMIT - 1).trimEnd()}…`;
}
