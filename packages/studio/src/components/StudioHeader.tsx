import { useEffect, useMemo, useState } from "react";
import { CaretLeft, Export, GearSix } from "@phosphor-icons/react";
import { useTranslation } from "../i18n";
import { useStudioShellContext } from "../contexts/StudioContext";
import { usePanelLayoutContext } from "../contexts/PanelLayoutContext";
import {
  invokeWindowCommand,
  readOpenvidsFrame,
  readOpenvidsHomeOrigin,
} from "../utils/openvidsHost";
import { WorkspaceSwitch } from "../story/WorkspaceSwitch";
import { Dock } from "./dock/Dock";
import { OpenvidsAppMenu } from "./OpenvidsAppMenu";
import { openSettings } from "./settings/settingsStore";
import {
  HistoryButtons,
  PanelToggles,
  SaveState,
  TitlebarSeparator,
} from "./shell/TitlebarControls";
import { ReportProblemButton } from "./shell/ReportProblemButton";
import { Button, IconButton, OpenvidsLogo, Tooltip } from "./ui";
import {
  CaptionClose,
  CaptionMaximize,
  CaptionMinimize,
  CaptionRestore,
} from "./ui/StudioChromeIcons";

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
 * Minimize / maximize-restore / close for the Windows frameless frame
 * (`openvidsFrame=custom`, read once like the home origin). The glyphs are the
 * Projects page's own caption shapes (`./ui/StudioChromeIcons`, same geometry as
 * home_page/home.css) in wells flush with the header's top-right edge. Plain
 * <button>s: they stay out of Tab order (a caption button is a pointer
 * affordance, not a document control) and out of the drag region — Tauri's
 * drag script never starts a drag from a clickable element, so no opt-out
 * attribute is needed. The maximize glyph polls `plugin:window|is_maximized`
 * on every resize (Win+arrows, edge snap, double-click zoom all land there)
 * so the restore icon follows the real window state; the double-click zoom
 * itself comes from Tauri's own drag-region script, not from here. Outside
 * the desktop shell the channel is absent and every click is a no-op.
 */
function WindowControls() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = () => {
      const pending = invokeWindowCommand("is_maximized");
      if (pending) {
        pending
          .then((value) => {
            if (alive) setMaximized(value === true);
          })
          .catch(() => {});
      }
    };
    poll();
    window.addEventListener("resize", poll);
    // The webview can paint before the IPC channel is up; poll once late.
    const late = window.setTimeout(poll, 500);
    return () => {
      alive = false;
      window.removeEventListener("resize", poll);
      window.clearTimeout(late);
    };
  }, []);
  // The caption glyphs match the Projects page (home_page/home.css): 10 px shapes with a 1 px stroke,
  // drawn here as the same SVG so the two pages cannot drift; the restore pair masks like the page's.
  const btn =
    "group flex h-[52px] w-11 items-center justify-center text-fg-2 outline-hidden hover:bg-surface-2 hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";
  return (
    <div data-testid="window-controls" className="-mr-3 flex shrink-0 items-stretch self-stretch">
      <Tooltip label={t("window.controls.minimize")} side="bottom">
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("window.controls.minimize")}
          data-testid="window-minimize"
          className={btn}
          onClick={() => {
            void invokeWindowCommand("minimize");
          }}
        >
          <CaptionMinimize size={12} />
        </button>
      </Tooltip>
      <Tooltip
        label={t(maximized ? "window.controls.restore" : "window.controls.maximize")}
        side="bottom"
      >
        <button
          type="button"
          tabIndex={-1}
          aria-label={t(maximized ? "window.controls.restore" : "window.controls.maximize")}
          data-testid="window-maximize"
          className={btn}
          onClick={() => {
            void invokeWindowCommand("toggle_maximize");
          }}
        >
          {maximized ? <CaptionRestore size={12} /> : <CaptionMaximize size={12} />}
        </button>
      </Tooltip>
      <Tooltip label={t("window.controls.close")} side="bottom">
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("window.controls.close")}
          data-testid="window-close"
          className={`${btn} hover:bg-error hover:text-white`}
          onClick={() => {
            void invokeWindowCommand("close");
          }}
        >
          <CaptionClose size={12} />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The window's titlebar (prototype `openvids-editor.html`): back to Projects, the project and its
 * save state on the left; the Media | Story | Edit switch centred; history, panel toggles, Window,
 * Export and Settings on the right. In the desktop app the bar itself drags the window; the
 * left inset is the macOS traffic lights (`overlay`), the right-edge caption buttons the Windows
 * frameless frame (`custom`), and the Windows system-frame fallback draws neither.
 */
export function StudioHeader() {
  const { t } = useTranslation();
  const { projectId, renderQueue } = useStudioShellContext();
  const { setRightCollapsed, setRightPanelTab } = usePanelLayoutContext();
  const homeOrigin = useMemo(() => readOpenvidsHomeOrigin(), []);
  const frame = useMemo(() => readOpenvidsFrame(), []);
  const isRendering = renderQueue.isRendering;
  const ffmpegMissing = renderQueue.ffmpegMissing;

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-[52px] shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-1 pr-3 pl-5 select-none"
    >
      {/* The desktop's traffic lights (at 20, 20) sit over this inset — macOS overlay frame only. */}
      {homeOrigin && frame === "overlay" ? (
        <span aria-hidden="true" data-tauri-drag-region className="mr-3 h-3 w-[52px] shrink-0" />
      ) : null}
      {/* Windows custom frame: the app menu button takes the traffic-light inset's slot (same 52 px,
        before the back button/logo), so nothing after it shifts. macOS and the system-frame fallback
        keep their menus and never draw this. */}
      {homeOrigin && frame === "custom" ? <OpenvidsAppMenu homeOrigin={homeOrigin} /> : null}
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
            icon={<GearSix size={14} />}
            onClick={() => openSettings()}
          />
        </Tooltip>
        {homeOrigin ? <ReportProblemButton homeOrigin={homeOrigin} /> : null}
      </div>
      {/* Windows frameless frame: the page draws the caption buttons. */}
      {homeOrigin && frame === "custom" ? <WindowControls /> : null}
    </header>
  );
}
