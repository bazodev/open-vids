import { useMemo } from "react";
import { CaretLeft, Export } from "@phosphor-icons/react";
import { useTranslation } from "../i18n";
import { useStudioShellContext } from "../contexts/StudioContext";
import { usePanelLayoutContext } from "../contexts/PanelLayoutContext";
import { readOpenvidsHomeOrigin } from "../utils/openvidsHost";
import { WorkspaceSwitch } from "../story/WorkspaceSwitch";
import { Dock } from "./dock/Dock";
import { openSettings } from "./settings/settingsStore";
import {
  HistoryButtons,
  PanelToggles,
  SaveState,
  TitlebarSeparator,
} from "./shell/TitlebarControls";
import { ReportProblemButton } from "./shell/ReportProblemButton";
import { Button, IconButton, OpenvidsLogo, Tooltip } from "./ui";
import { StudioGear } from "./ui/StudioGear";

/**
 * Inside OpenVids the logo becomes a back button to the Projects home
 * screen. A plain <button> (not an <a href>): the home origin arrives via
 * the query string, and an href would let a crafted link aim the tab at an
 * arbitrary URL before validation runs. Assigning `window.location.href`
 * only after validation keeps one trusted navigation path.
 */
function OpenvidsBackOrLogo({ homeOrigin }: { homeOrigin: string | null }) {
  const { t } = useTranslation();
  if (!homeOrigin) return <OpenvidsLogo height={18} className="shrink-0 text-fg" />;
  return (
    <Tooltip label={t("shell.header.backTooltip")} side="bottom">
      <button
        type="button"
        aria-label={t("shell.header.backLabel")}
        data-testid="openvids-back"
        onClick={() => {
          window.location.href = homeOrigin;
        }}
        className="inline-flex h-ctl-sm shrink-0 items-center gap-1 rounded-sm pr-1.5 pl-2 text-sm text-fg-2 transition-colors duration-hover hover:bg-surface-2 hover:text-fg outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <CaretLeft size={12} weight="bold" aria-hidden />
        {t("shell.header.projects")}
      </button>
    </Tooltip>
  );
}

/**
 * The window's titlebar (prototype `openvids-editor.html`): back to Projects, the project and its
 * save state on the left; the Media | Story | Edit switch centred; history, panel toggles, Window,
 * Export and Settings on the right. In the desktop app the traffic lights sit over its left edge,
 * and the bar itself drags the window.
 */
export function StudioHeader() {
  const { t } = useTranslation();
  const { projectId, renderQueue } = useStudioShellContext();
  const { setRightCollapsed, setRightPanelTab } = usePanelLayoutContext();
  const homeOrigin = useMemo(() => readOpenvidsHomeOrigin(), []);
  const isRendering = renderQueue.isRendering;
  const ffmpegMissing = renderQueue.ffmpegMissing;

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-[52px] shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-1 pr-3 pl-5 select-none"
    >
      {/* The desktop's traffic lights (at 20, 20) sit over this inset. */}
      {homeOrigin ? (
        <span aria-hidden="true" data-tauri-drag-region className="mr-3 h-3 w-[52px] shrink-0" />
      ) : null}
      <OpenvidsBackOrLogo homeOrigin={homeOrigin} />
      <span
        data-tauri-drag-region
        title={projectId}
        className="max-w-[260px] truncate text-md font-semibold text-fg"
      >
        {projectId}
      </span>
      <SaveState />
      <WorkspaceSwitch className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
      <div data-tauri-drag-region className="min-w-0 flex-1 self-stretch" />
      <div
        role="toolbar"
        aria-label={t("shell.header.toolbarLabel")}
        className="flex items-center gap-2"
      >
        <HistoryButtons />
        <TitlebarSeparator />
        <PanelToggles />
        <Dock.WindowMenu />
        <TitlebarSeparator />
        <Tooltip
          label={
            ffmpegMissing
              ? t("shell.header.export.ffmpegMissing")
              : isRendering
                ? t("shell.header.export.busy")
                : t("shell.header.export.hint")
          }
          side="bottom"
        >
          <Button
            variant="secondary"
            size="sm"
            data-testid="header-export"
            icon={<Export size={14} />}
            onClick={() => {
              // Export only brings up Renders: the user picks format, quality and
              // size there and starts the render with its button. A render in
              // progress or a missing FFmpeg is shown in the same panel.
              setRightPanelTab("renders");
              setRightCollapsed(false);
            }}
          >
            {isRendering ? t("shell.header.rendering") : t("shell.header.export")}
          </Button>
        </Tooltip>
        <TitlebarSeparator />
        <Tooltip label={t("shell.header.settings")} side="bottom">
          <IconButton
            aria-label={t("shell.header.settings")}
            icon={<StudioGear />}
            onClick={() => openSettings()}
          />
        </Tooltip>
        {homeOrigin ? <ReportProblemButton homeOrigin={homeOrigin} /> : null}
      </div>
    </header>
  );
}
