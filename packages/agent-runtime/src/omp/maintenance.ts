import { isRecord } from "@hyperframes/agent-protocol";
import type { BackendEvent } from "../backend.ts";
import { toolFailureMessage } from "./provider-errors.ts";

/**
 * What the SDK does around a model call without being asked: retrying a failed request after a back-off, and
 * compacting the conversation when the context fills up. Both can take minutes, so each shows as its own chat row
 * (a labelled tool row with a locale code) from the moment it starts until it ends.
 */
export class MaintenanceRows {
  private retryRow: string | null = null;
  private compactionRow: string | null = null;
  private counter = 0;
  /** Retries the SDK made since the prompt began; names the failure when they ran out. */
  private retries = 0;

  /** The number of retries of the current prompt. */
  get retryCount(): number {
    return this.retries;
  }

  /** A new prompt begins: nothing is open, nothing was retried. */
  reset(): void {
    this.retryRow = null;
    this.compactionRow = null;
    this.retries = 0;
  }

  /** The row events an SDK event produces, in order; empty for any other event. */
  translate(event: unknown): BackendEvent[] {
    if (!isRecord(event)) return [];

    if (event.type === "auto_retry_start") {
      const attempt = positive(event.attempt);
      const maxAttempts = positive(event.maxAttempts);
      const delaySeconds = Math.ceil(positive(event.delayMs) / 1000);
      // The provider's own words: without them a failing model reads the same as an overloaded one.
      const reason =
        typeof event.errorMessage === "string" ? toolFailureMessage(event.errorMessage) : "";
      this.retries = Math.max(this.retries, attempt);
      const out = this.closeRetry(true);
      this.retryRow = `provider-retry-${(this.counter += 1)}`;
      out.push({
        type: "tool.start",
        toolCallId: this.retryRow,
        kind: "other",
        targets: [],
        label: `The model provider failed; retrying in ${delaySeconds} s (attempt ${attempt} of ${maxAttempts})`,
        labelCode: "provider_retry",
        labelParams: { attempt, maxAttempts, delaySeconds, ...(reason && { reason }) },
      });
      return out;
    }

    if (event.type === "auto_retry_end") {
      const failure =
        event.success === true || typeof event.finalError !== "string" ? "" : event.finalError;
      return this.closeRetry(event.success === true, failure);
    }

    if (event.type === "auto_compaction_start") {
      const out = this.closeCompaction(true);
      this.compactionRow = `context-compaction-${(this.counter += 1)}`;
      out.push({
        type: "tool.start",
        toolCallId: this.compactionRow,
        kind: "other",
        targets: [],
        label: "Summarising the conversation to free up context",
        labelCode: "context_compaction",
      });
      return out;
    }

    if (event.type === "auto_compaction_end") {
      const failure = typeof event.errorMessage === "string" ? event.errorMessage : "";
      return this.closeCompaction(event.aborted !== true && !failure, failure);
    }

    // A prompt that ended must not leave a row spinning.
    if (event.type === "agent_end" && event.isTerminal !== false) {
      return [...this.closeRetry(false), ...this.closeCompaction(true)];
    }
    return [];
  }

  private closeRetry(ok: boolean, failure = ""): BackendEvent[] {
    const id = this.retryRow;
    this.retryRow = null;
    if (id === null) return [];
    return [
      {
        type: "tool.end",
        toolCallId: id,
        ok,
        ...(failure && { error: toolFailureMessage(failure) }),
      },
    ];
  }

  private closeCompaction(ok: boolean, failure = ""): BackendEvent[] {
    const id = this.compactionRow;
    this.compactionRow = null;
    if (id === null) return [];
    return [
      {
        type: "tool.end",
        toolCallId: id,
        ok,
        ...(failure && { error: toolFailureMessage(failure) }),
      },
    ];
  }
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
