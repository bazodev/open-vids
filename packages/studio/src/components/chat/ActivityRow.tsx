import { useId, useState, type ReactNode } from "react";
import { Check, WarningCircle, X } from "@phosphor-icons/react";
import type { Activity, AgentId, CodedMessageParams } from "@hyperframes/agent-protocol";
import {
  formatPercent,
  isTranslationKey,
  t,
  useTranslation,
  type TranslationKey,
} from "../../i18n";
import { cn } from "../ui/cn";
import { Meter, Spinner, StatusDot } from "../ui/Status";
import { describeServerError } from "../../agent/agentErrors";
import { AgentMonogram, chatAgentName } from "./AgentMonogram";
import { chatFocus } from "./chatStyles";
import { formatElapsed } from "./relativeTime";
import { useNow } from "./useNow";

/**
 * The text of runtime-reported work (an activity row, a delegation step): Studio's `activity.<code>` wording when the
 * catalog has it, else the runtime's English text. The runtime sets a code for its own sentences only; model-written
 * titles (a delegated task, a plan step) carry no code and pass through unchanged.
 */
export function activityText(
  label: string,
  labelCode?: string,
  labelParams?: CodedMessageParams,
): string {
  if (labelCode === undefined) return label;
  const key = `activity.${labelCode}`;
  return isTranslationKey(key) ? t(key, labelParams) : label;
}

/** How a Working-list row reads: running, done, failed, stopped before it ran, or waiting. */
export type WorkState = "running" | "done" | "failed" | "skipped" | "pending";

export const WORK_STATE_TEXT: Record<WorkState, TranslationKey> = {
  running: "chat.work.state.running",
  done: "chat.work.state.done",
  failed: "chat.work.state.failed",
  skipped: "chat.work.state.skipped",
  pending: "chat.work.state.pending",
};

export function WorkGlyph({ state }: { state: WorkState }) {
  switch (state) {
    case "running":
      return <Spinner size="sm" />;
    case "done":
      return <Check aria-hidden weight="bold" className="size-icon-sm text-success" />;
    case "failed":
      return <WarningCircle aria-hidden weight="fill" className="size-icon-sm text-error" />;
    case "skipped":
      return <X aria-hidden className="size-icon-sm" />;
    case "pending":
      return <StatusDot tone="off" />;
  }
}

/** The row grid every Working-list entry shares: monogram · "Agent — step" · glyph · elapsed. */
export const workRowGrid = cn(
  "grid w-full min-h-row-sm grid-cols-[16px_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-[5px] @max-[299px]/chat:gap-x-1.5",
  "rounded-md border border-transparent px-1.5 py-[5px] text-left text-sm leading-4",
);

export const WORK_ROW_TONE: Record<WorkState, string> = {
  running: "text-fg-2",
  pending: "text-fg-2",
  done: "text-fg-3",
  failed: "text-fg-2",
  skipped: "text-fg-disabled",
};

export const WORK_AGENT_TONE: Record<WorkState, string> = {
  running: "text-fg",
  pending: "text-fg",
  done: "text-fg-2",
  failed: "text-fg",
  skipped: "text-fg-3",
};

/** The trailing half of a row: the state glyph and how long the work took (live while it runs). */
export function WorkTail({
  state,
  startedAt,
  endedAt,
}: {
  state: WorkState;
  startedAt: number;
  endedAt: number | undefined;
}) {
  const now = useNow(state === "running" && endedAt === undefined);
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "inline-flex w-3.5 items-center justify-center",
          state === "skipped" ? "text-fg-disabled" : "text-fg-3",
        )}
      >
        <WorkGlyph state={state} />
      </span>
      <span className="min-w-[30px] text-right font-mono text-num leading-[14px] text-fg-3 tabular-nums">
        {formatElapsed((endedAt ?? now) - startedAt)}
      </span>
    </>
  );
}

/** "Editor — building rough cut": who is working, then what. */
export function WorkText({
  agent,
  state,
  children,
}: {
  agent: AgentId;
  state: WorkState;
  children: ReactNode;
}) {
  useTranslation();
  return (
    <span className="min-w-0 [overflow-wrap:anywhere]">
      <b className={cn("font-medium", WORK_AGENT_TONE[state])}>{chatAgentName(agent)}</b>
      {" — "}
      {children}
    </span>
  );
}

const ACTIVITY_STATE: Record<Activity["status"], WorkState> = {
  running: "running",
  done: "done",
  failed: "failed",
};

const ACTIVITY_NOTE =
  "mb-1 ml-[30px] line-clamp-3 text-xs leading-[15px] text-fg-3 [overflow-wrap:anywhere]";

/** Why the model call of a `provider_retry` row failed, in the provider's own words; null for any other row. */
function providerRetryReason(activity: Activity): string | null {
  if (activity.labelCode !== "provider_retry") return null;
  const reason = activity.labelParams?.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

/**
 * One product-level unit of an agent's own work ("Reading 3 files") as a Working-list row; never a raw tool
 * name. A render that reports progress gets a determinate meter. Targets open on request.
 */
export function ActivityRow({ activity, agent }: { activity: Activity; agent: AgentId }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { t } = useTranslation();
  const state = ACTIVITY_STATE[activity.status];
  const progress =
    state === "running" && activity.progress !== undefined
      ? Math.round(Math.min(100, Math.max(0, activity.progress)))
      : null;
  const percent = progress === null ? "" : formatPercent(progress / 100);
  const text = activityText(activity.label, activity.labelCode, activity.labelParams);
  const phrase =
    progress === null ? text : t("chat.activity.withProgress", { label: text, percent });
  const expandable = activity.targets.length > 0;
  const retryReason = providerRetryReason(activity);
  const failure =
    state === "failed" && activity.error
      ? describeServerError(activity.error.code, activity.error.message)
      : null;

  const body = (
    <>
      <AgentMonogram agent={agent} />
      <WorkText agent={agent} state={state}>
        {phrase}
      </WorkText>
      <span className="sr-only">, {t(WORK_STATE_TEXT[state])}</span>
      <WorkTail state={state} startedAt={activity.startedAt} endedAt={activity.endedAt} />
      {progress !== null && (
        <Meter
          value={progress / 100}
          label={t("chat.activity.progressLabel", { label: text, percent })}
          data-testid="activity-progress"
          className="col-start-2 col-end-[-1]"
        />
      )}
    </>
  );

  return (
    <li data-activity-status={activity.status}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
          className={cn(workRowGrid, WORK_ROW_TONE[state], "hover:text-fg", chatFocus)}
        >
          {body}
        </button>
      ) : (
        <div className={cn(workRowGrid, WORK_ROW_TONE[state])}>{body}</div>
      )}
      {retryReason !== null && retryReason !== failure && (
        <p data-testid="activity-retry-reason" title={retryReason} className={ACTIVITY_NOTE}>
          <span className="sr-only">{t("chat.activity.reason")} </span>
          {retryReason}
        </p>
      )}
      {failure !== null && (
        <p data-testid="activity-error" title={activity.error?.message} className={ACTIVITY_NOTE}>
          <span className="sr-only">{t("chat.activity.reason")} </span>
          {failure}
        </p>
      )}
      {open && expandable && (
        <ul id={listId} className="mb-1 ml-[30px] grid gap-px">
          {activity.targets.map((target) => (
            <li
              key={target}
              title={target}
              className="truncate font-mono text-num leading-[14px] text-fg-3"
            >
              {target}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
