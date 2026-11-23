import { describe, expect, it } from "vitest";
import { RuntimeError } from "../errors.ts";
import { failureCode } from "../errors.ts";
import {
  FAILURE_MESSAGE_LIMIT,
  classifyProviderError,
  providerFailure,
  toolFailureMessage,
} from "./provider-errors.ts";

describe("classifyProviderError", () => {
  it.each([
    ["401 Unauthorized: invalid x-api-key", "provider_auth"],
    ["No authenticated OMP model is available. Sign in with OMP.", "provider_auth"],
    ["The selected model a/b is not available or has no configured credentials.", "provider_auth"],
    ["429 Too Many Requests", "rate_limited"],
    ["You exceeded your current quota, please check your plan and billing details", "rate_limited"],
    ["Anthropic: rate_limit_error", "rate_limited"],
    ["529 overloaded_error: Overloaded", "provider_overloaded"],
    ["503 Service Unavailable", "provider_overloaded"],
    ["fetch failed", "provider_overloaded"],
    ["prompt is too long: 215000 tokens > 200000 maximum", "context_overflow"],
    ["This model's maximum context length is 128000 tokens", "context_overflow"],
    ["Something nobody has seen before", "agent_failed"],
  ])("%s → %s", (message, code) => {
    expect(classifyProviderError(message)).toBe(code);
  });

  it("reads a context overflow before the generic request-too-large 400", () => {
    expect(classifyProviderError("400 invalid_request_error: prompt is too long")).toBe(
      "context_overflow",
    );
  });
});

describe("providerFailure", () => {
  it("is a 502 RuntimeError with the class, and says when the SDK retried first", () => {
    const failure = providerFailure("529 overloaded", { attempts: 3 });
    expect(failure).toBeInstanceOf(RuntimeError);
    expect(failure.code).toBe("provider_overloaded");
    expect(failure.status).toBe(502);
    expect(failure.message).toBe("529 overloaded (still failing after 3 retries)");
    expect(providerFailure("401 unauthorized", { attempts: 0 }).message).toBe("401 unauthorized");
    // A conversation that does not fit fails the same way every time: retries are not the story.
    expect(providerFailure("prompt is too long", { attempts: 4 }).message).toBe(
      "prompt is too long",
    );
  });

  it("is what failureCode reports for a turn; anything else is agent_failed", () => {
    expect(failureCode(providerFailure("429"))).toBe("rate_limited");
    expect(failureCode(new Error("429"))).toBe("agent_failed");
    expect(failureCode(new RuntimeError("chat_busy", "busy", 409))).toBe("agent_failed");
  });
});

describe("toolFailureMessage", () => {
  it("masks credentials and cuts to the row limit", () => {
    expect(
      toolFailureMessage("401 for Bearer abcdefghijklmnop at sk-ant-api03-ABCDEF1234567890XYZ"),
    ).toBe("401 for [hidden] at [hidden]");
    expect(toolFailureMessage('request failed: {"apiKey": "hunter2hunter2"}')).toContain(
      "[hidden]",
    );
    expect(toolFailureMessage('request failed: {"apiKey": "hunter2hunter2"}')).not.toContain(
      "hunter2",
    );
    const long = toolFailureMessage("x ".repeat(500));
    expect(long.length).toBeLessThanOrEqual(FAILURE_MESSAGE_LIMIT);
    expect(long.endsWith("…")).toBe(true);
  });

  it("masks a Google API key, bare or in a request URL, and leaves prose about a key alone", () => {
    const key = `AIza${"Sy0123456789abcdefghijklmnopqrstu"}`;
    expect(toolFailureMessage(`invalid credential ${key}`)).toBe("invalid credential [hidden]");
    expect(toolFailureMessage(`POST /v1beta/models/x:generate?alt=sse&key=abcdef123456 503`)).toBe(
      "POST /v1beta/models/x:generate?alt=sse&key=[hidden] 503",
    );
    expect(toolFailureMessage("Unknown key: durationSeconds")).toBe("Unknown key: durationSeconds");
  });
});
