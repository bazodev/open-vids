import { describe, expect, it } from "vitest";
import { MaintenanceRows } from "./maintenance.ts";

describe("MaintenanceRows", () => {
  it("shows each retry wait as a coded row that ends when the retry does", () => {
    const rows = new MaintenanceRows();
    const start = rows.translate({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 10,
      delayMs: 4200,
      errorMessage: "529 overloaded",
    });
    expect(start).toEqual([
      expect.objectContaining({
        type: "tool.start",
        kind: "other",
        labelCode: "provider_retry",
        labelParams: { attempt: 2, maxAttempts: 10, delaySeconds: 5, reason: "529 overloaded" },
      }),
    ]);
    const id = start[0]?.type === "tool.start" ? start[0].toolCallId : "";
    expect(rows.retryCount).toBe(2);

    expect(rows.translate({ type: "auto_retry_end", success: true, attempt: 2 })).toEqual([
      { type: "tool.end", toolCallId: id, ok: true },
    ]);
  });

  it("carries the provider's reason on the row, trimmed and with credentials masked", () => {
    const rows = new MaintenanceRows();
    const [start] = rows.translate({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: `Google API error (503): overloaded key=abcdef123456 ${"x".repeat(400)}`,
    });
    const reason = start?.type === "tool.start" ? start.labelParams?.reason : undefined;
    expect(reason).toContain("Google API error (503): overloaded key=[hidden]");
    expect(String(reason).length).toBeLessThanOrEqual(300);
  });

  it("adds no reason when the SDK gave none", () => {
    const rows = new MaintenanceRows();
    const [start] = rows.translate({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
    });
    expect(start).toMatchObject({
      labelParams: { attempt: 1, maxAttempts: 3, delaySeconds: 1 },
    });
    expect(start?.type === "tool.start" && start.labelParams).not.toHaveProperty("reason");
  });

  it("closes the previous retry row when the next attempt starts, and a failed ending carries the reason", () => {
    const rows = new MaintenanceRows();
    rows.translate({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000 });
    const second = rows.translate({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 2000,
    });
    expect(second.map((event) => event.type)).toEqual(["tool.end", "tool.start"]);
    const end = rows.translate({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "529 overloaded token=abcdef123456",
    });
    expect(end).toEqual([
      expect.objectContaining({
        type: "tool.end",
        ok: false,
        error: "529 overloaded token=[hidden]",
      }),
    ]);
  });

  it("shows compaction as a row, and never leaves one open when the prompt ends", () => {
    const rows = new MaintenanceRows();
    const start = rows.translate({
      type: "auto_compaction_start",
      reason: "threshold",
      action: "context-full",
    });
    expect(start).toEqual([expect.objectContaining({ labelCode: "context_compaction" })]);
    const ended = rows.translate({ type: "agent_end", messages: [] });
    expect(ended).toEqual([expect.objectContaining({ type: "tool.end", ok: true })]);
    expect(rows.translate({ type: "agent_end", messages: [] })).toEqual([]);
  });

  it("marks an aborted or failed compaction as failed", () => {
    const rows = new MaintenanceRows();
    rows.translate({ type: "auto_compaction_start", reason: "overflow", action: "handoff" });
    expect(
      rows.translate({
        type: "auto_compaction_end",
        action: "handoff",
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: "summary model failed",
      }),
    ).toEqual([expect.objectContaining({ ok: false, error: "summary model failed" })]);
  });

  it("ignores a non-final agent_end and unrelated events", () => {
    const rows = new MaintenanceRows();
    rows.translate({ type: "auto_compaction_start", reason: "idle", action: "shake" });
    expect(rows.translate({ type: "agent_end", isTerminal: false, messages: [] })).toEqual([]);
    expect(rows.translate({ type: "turn_start" })).toEqual([]);
    expect(rows.translate("nope")).toEqual([]);
  });
});
