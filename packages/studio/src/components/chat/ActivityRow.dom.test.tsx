// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { Activity } from "@hyperframes/agent-protocol";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { ActivityRow } from "./ActivityRow";

const REASON = "Google API error (503): The model is overloaded.";

function retryRow(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "provider-retry-1",
    category: "other",
    status: "running",
    label: "The model provider failed; retrying in 2 s (attempt 1 of 10)",
    labelCode: "provider_retry",
    labelParams: { attempt: 1, maxAttempts: 10, delaySeconds: 2, reason: REASON },
    count: 1,
    targets: [],
    startedAt: 1_000,
    ...overrides,
  };
}

function shown(activity: Activity, testId: string): string | null {
  const host = mountHost(
    <ul>
      <ActivityRow activity={activity} agent="director" />
    </ul>,
  );
  return host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
}

afterEach(cleanupMounted);

describe("ActivityRow's model retry", () => {
  it("says why the model call failed while it waits to retry", () => {
    expect(shown(retryRow(), "activity-retry-reason")).toContain(REASON);
  });

  it("keeps the reason after the attempt moved on", () => {
    const row = retryRow({ status: "done", endedAt: 2_000 });
    expect(shown(row, "activity-retry-reason")).toContain(REASON);
  });

  it("shows both the reason and how the retries ended when they differ", () => {
    const row = retryRow({
      status: "failed",
      endedAt: 2_000,
      error: { code: "tool_failed", message: "Retry cancelled" },
    });
    expect(shown(row, "activity-retry-reason")).toContain(REASON);
    cleanupMounted();
    expect(shown(row, "activity-error")).toContain("Retry cancelled");
  });

  it("does not repeat a final error that is the same text", () => {
    const row = retryRow({
      status: "failed",
      endedAt: 2_000,
      error: { code: "tool_failed", message: REASON },
    });
    expect(shown(row, "activity-retry-reason")).toBeNull();
    cleanupMounted();
    expect(shown(row, "activity-error")).toContain(REASON);
  });

  it("shows nothing extra for a row without a reason, or for another kind of row", () => {
    const noReason = retryRow({ labelParams: { attempt: 1, maxAttempts: 10, delaySeconds: 2 } });
    expect(shown(noReason, "activity-retry-reason")).toBeNull();
    cleanupMounted();
    const other = retryRow({ labelCode: "context_compaction" });
    expect(shown(other, "activity-retry-reason")).toBeNull();
  });
});
