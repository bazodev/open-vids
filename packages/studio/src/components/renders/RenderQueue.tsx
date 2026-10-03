import { memo, useState } from "react";
import { CaretDown, Clock, WarningCircle, X } from "@phosphor-icons/react";
import { RenderJobStatus, RenderQueueItem, formatRenderDuration } from "./RenderQueueItem";
import { FfmpegRequiredNotice } from "./FfmpegRequiredNotice";
import {
  RenderSettingsForm,
  resolveResolution,
  useRenderSettings,
  type CompositionDimensions,
  type RenderFormat,
  type RenderFps,
  type RenderQuality,
} from "./RenderSettingsForm";
import type { FfmpegStatus } from "./useFfmpegStatus";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Pill } from "../ui/Status";
import { Tooltip } from "../ui/Tooltip";
import { cn } from "../ui/cn";
import type { RenderJob, ResolutionPreset } from "./useRenderQueue";
import { Trans, useTranslation } from "../../i18n";

export type StartRenderHandler = (
  format: RenderFormat,
  quality: RenderQuality,
  resolution: ResolutionPreset | "auto",
  fps: RenderFps,
) => void | Promise<void>;

export interface RenderQueueProps {
  jobs: RenderJob[];
  projectId: string;
  onDelete: (jobId: string) => void;
  onCancel?: (jobId: string) => void;
  /** Opens a finished render for the user (OS player in the desktop shell). */
  onOpen: (job: RenderJob) => void;
  onClearCompleted: () => void;
  onStartRender: StartRenderHandler;
  isRendering: boolean;
  /** History fetch failure (null when the last load succeeded). */
  loadError?: string | null;
  /** Retry a failed history load. */
  onRetryLoad?: () => void;
  /** Failure of a delete/cancel action, shown inline until dismissed. */
  actionError?: string | null;
  onDismissActionError?: () => void;
  /**
   * Authored dimensions of the active composition. Used to pick the
   * matching preset (landscape / portrait / square) when the user selects
   * a 1080p or 4K scale. `null` falls back to landscape (legacy default).
   */
  compositionDimensions?: CompositionDimensions | null;
  /** The composition a render targets (the active one), shown in the head. */
  compositionLabel?: string | null;
  /**
   * Encoder availability, owned by useRenderQueue so the panel's Render button
   * and the header's Export agree. `null` means "no answer", not "missing".
   */
  ffmpeg: FfmpegStatus | null;
  ffmpegChecking: boolean;
  onRecheckFfmpeg: () => void;
}

/** Recent Renders: a disclosure with the count, then rows newest first. */
function RecentRenders({
  jobs,
  projectId,
  onDelete,
  onOpen,
  onClearCompleted,
  loadError,
  onRetryLoad,
}: Pick<
  RenderQueueProps,
  "projectId" | "onDelete" | "onOpen" | "onClearCompleted" | "loadError" | "onRetryLoad"
> & { jobs: RenderJob[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  return (
    <section className="-mx-3 border-t border-border-subtle">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-[30px] w-full items-center gap-1 px-3 text-left text-sm font-semibold text-fg outline-hidden focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <CaretDown
          size={12}
          aria-hidden
          className={cn("text-fg-3 transition-transform duration-expand", !open && "-rotate-90")}
        />
        {t("renders.recent.title")}
        {jobs.length > 0 && <Pill className="ml-auto">{jobs.length}</Pill>}
      </button>
      {open && (
        <div className="px-3 pb-1 pt-0.5">
          {loadError && jobs.length === 0 ? (
            <div role="alert" className="grid justify-items-center gap-2 py-2">
              <p className="m-0 text-center text-xs text-error">{loadError}</p>
              {onRetryLoad && (
                <Button size="sm" onClick={onRetryLoad}>
                  {t("common.retry")}
                </Button>
              )}
            </div>
          ) : jobs.length === 0 ? (
            <p className="m-0 py-2 text-center text-xs text-fg-3">{t("renders.recent.empty")}</p>
          ) : (
            <>
              <div className="mb-0.5 flex min-h-ctl-sm items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-fg-3">
                  {t("renders.recent.count", { count: jobs.length })}
                </span>
                {/* Hides rows only: files stay on disk (delete is per row and
                    confirmed) and hidden rows don't come back on reload. */}
                <Tooltip label={t("renders.recent.clearTooltip")}>
                  <Button size="sm" variant="ghost" onClick={onClearCompleted} className="-mr-2">
                    {t("renders.recent.clear")}
                  </Button>
                </Tooltip>
              </div>
              <ul className="m-0 -mx-1.5 grid list-none gap-0.5 p-0">
                {jobs.map((job) => (
                  <RenderQueueItem
                    key={job.id}
                    job={job}
                    projectId={projectId}
                    onDelete={() => onDelete(job.id)}
                    onOpen={() => onOpen(job)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The Renders panel, laid out as the prototype's Export surface: head with the
 * composition, settings on a label column, Recent Renders, and a foot with the
 * estimate and Render. The titlebar Export button brings this panel forward.
 */
export const RenderQueue = memo(function RenderQueue({
  jobs,
  projectId,
  onDelete,
  onCancel,
  onOpen,
  onClearCompleted,
  onStartRender,
  isRendering,
  loadError,
  onRetryLoad,
  actionError,
  onDismissActionError,
  compositionDimensions,
  compositionLabel,
  ffmpeg,
  ffmpegChecking,
  onRecheckFfmpeg,
}: RenderQueueProps) {
  const { t } = useTranslation();
  const settingsState = useRenderSettings();
  const { settings } = settingsState;

  // Only a definite "not installed" blocks Render. A null status means the
  // probe gave no answer, and refusing on no answer would break setups that
  // are perfectly fine.
  const missingFfmpeg = ffmpeg && !ffmpeg.ok ? ffmpeg : null;
  const running = jobs.filter((job) => job.status === "rendering");
  // Newest first by creation time: history from the server and jobs started in
  // this session arrive in different orders, so array order is not a clock.
  const finished = jobs
    .filter((job) => job.status !== "rendering")
    .sort((a, b) => b.createdAt - a.createdAt);
  const lastRenderDurationMs = finished.find(
    (job) => job.status === "complete" && job.durationMs !== undefined,
  )?.durationMs;
  const dims = compositionDimensions
    ? `${compositionDimensions.width} × ${compositionDimensions.height}`
    : null;
  const headMeta = [compositionLabel, dims].filter(Boolean).join(" · ");

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-0 text-sm text-fg">
      <header className="flex h-head shrink-0 items-center gap-1.5 border-b border-border-subtle pl-3 pr-2">
        <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">{t("renders.title")}</h2>
        {headMeta && (
          <span className="min-w-0 truncate text-sm text-fg-2" title={headMeta}>
            {headMeta}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {missingFfmpeg && (
          <div className="pt-2.5">
            <FfmpegRequiredNotice
              status={missingFfmpeg}
              checking={ffmpegChecking}
              onRecheck={onRecheckFfmpeg}
            />
          </div>
        )}
        {actionError && (
          <div
            role="alert"
            className="mt-2.5 flex items-start gap-2 rounded-md border border-error/35 bg-error-soft py-1.5 pl-2.5 pr-1 text-xs text-error"
          >
            <span className="min-w-0 flex-1 pt-0.5">{actionError}</span>
            {onDismissActionError && (
              <IconButton
                size="xs"
                onClick={onDismissActionError}
                aria-label={t("renders.dismissError")}
                icon={<X size={10} aria-hidden />}
              />
            )}
          </div>
        )}
        {running.map((job) => (
          <RenderJobStatus key={job.id} job={job} onCancel={() => onCancel?.(job.id)} />
        ))}
        {isRendering && (
          <p
            role="status"
            className="m-0 rounded-md border border-border-subtle bg-bg-1 px-2.5 py-2 text-xs text-fg-2"
          >
            {t("renders.settings.lockedNotice")}
          </p>
        )}
        <RenderSettingsForm
          state={settingsState}
          disabled={isRendering}
          compositionDimensions={compositionDimensions}
        />
        <RecentRenders
          jobs={finished}
          projectId={projectId}
          onDelete={onDelete}
          onOpen={onOpen}
          onClearCompleted={onClearCompleted}
          loadError={loadError}
          onRetryLoad={onRetryLoad}
        />
      </div>

      <footer className="flex min-h-11 shrink-0 items-center gap-1.5 border-t border-border-subtle py-2 pl-3 pr-2.5">
        <span
          className={cn(
            "inline-flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs",
            missingFfmpeg ? "text-fg-2" : "text-fg-3",
          )}
        >
          {missingFfmpeg ? (
            <>
              <WarningCircle size={12} className="shrink-0 text-warning" aria-hidden />
              {t("renders.installFfmpeg")}
            </>
          ) : lastRenderDurationMs !== undefined ? (
            <>
              <Clock size={12} className="shrink-0" aria-hidden />
              <Trans
                i18nKey="renders.lastRenderTook"
                values={{ duration: formatRenderDuration(lastRenderDurationMs) }}
                components={{ mono: <span className="font-mono text-num text-fg-2" /> }}
              />
            </>
          ) : null}
        </span>
        <Button
          variant="primary"
          size="sm"
          data-testid="renders-export"
          loading={isRendering}
          disabled={missingFfmpeg !== null}
          title={missingFfmpeg ? t("renders.installFfmpegTitle") : undefined}
          onClick={() => {
            // loading already disables the button; this guard also stops a
            // double-click in the same frame from enqueueing two renders.
            if (isRendering || missingFfmpeg) return;
            void onStartRender(
              settings.format,
              settings.quality,
              resolveResolution(settings.scale, compositionDimensions),
              settings.fps,
            );
          }}
        >
          {isRendering ? t("renders.rendering") : t("renders.render")}
        </Button>
      </footer>
    </div>
  );
});
