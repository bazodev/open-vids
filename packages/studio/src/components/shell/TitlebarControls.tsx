import { useEffect, useState } from "react";
import { ArrowUUpLeft, ArrowUUpRight } from "@phosphor-icons/react";
import { useStudioShellContext } from "../../contexts/StudioContext";
import { useTranslation } from "../../i18n";
import { resolveShortcutKey } from "../../utils/platform";
import { useStoryStore } from "../../story/storyContext";
import { useSaveActivityStore } from "../../utils/saveActivity";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { panelsInZone, type PanelZone } from "../dock/panelRegistry";
import { cn, IconButton, StatusDot, Tooltip } from "../ui";

/** A save shorter than this still reads as "Saving…" instead of a flicker. */
const SAVING_HOLD_MS = 600;

/** The prototype's `.tb-sep`: a 16 px hairline between toolbar groups. */
export function TitlebarSeparator() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

/** Saved / Saving… / Not saved beside the project name, from every project write and the Story graph. */
export function SaveState() {
  const { t } = useTranslation();
  const { writeBlockedReason } = useStudioShellContext();
  const writing = useSaveActivityStore((state) => state.pending > 0);
  const story = useStoryStore((state) => state.saveState);
  const busy = writing || story === "saving" || story === "pending";
  const [shownBusy, setShownBusy] = useState(busy);
  useEffect(() => {
    if (busy) {
      setShownBusy(true);
      return;
    }
    const timer = setTimeout(() => setShownBusy(false), SAVING_HOLD_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  const failed = writeBlockedReason !== null || story === "failed";
  const state = failed ? "failed" : shownBusy ? "saving" : "saved";
  return (
    <span
      role="status"
      data-testid="save-state"
      data-state={state}
      title={failed ? (writeBlockedReason ?? t("shell.titlebar.saveFailed")) : undefined}
      className="inline-flex shrink-0 items-center gap-[5px] text-xs whitespace-nowrap text-fg-3"
    >
      <StatusDot tone={failed ? "warn" : shownBusy ? "running" : "ok"} />
      {failed
        ? t("shell.titlebar.notSaved")
        : shownBusy
          ? t("shell.titlebar.saving")
          : t("shell.titlebar.saved")}
    </span>
  );
}

/** Undo / Redo with the step they would take, over the shell's edit history. */
export function HistoryButtons() {
  const { t } = useTranslation();
  const { editHistory, handleUndo, handleRedo } = useStudioShellContext();
  const steps = [
    {
      verb: "undo",
      can: editHistory.canUndo,
      step: editHistory.undoLabel,
      run: handleUndo,
      shortcut: resolveShortcutKey("⌘Z"),
      Icon: ArrowUUpLeft,
    },
    {
      verb: "redo",
      can: editHistory.canRedo,
      step: editHistory.redoLabel,
      run: handleRedo,
      shortcut: resolveShortcutKey("⇧⌘Z"),
      Icon: ArrowUUpRight,
    },
  ] as const;
  return (
    <>
      {steps.map(({ verb, can, step, run, shortcut, Icon }) => {
        const label = step
          ? t(verb === "undo" ? "shell.titlebar.undoStep" : "shell.titlebar.redoStep", { step })
          : t(verb === "undo" ? "common.undo" : "common.redo");
        return (
          <Tooltip key={verb} label={label} shortcut={shortcut} side="bottom">
            <IconButton
              aria-label={label}
              disabled={!can}
              icon={<Icon size={14} />}
              onClick={() => void run()}
            />
          </Tooltip>
        );
      })}
    </>
  );
}

/** The prototype's `panel-left` / `panel-bottom` / `panel-right` glyph: a window with one pane ruled off. */
function PanelGlyph({ side }: { side: "left" | "bottom" | "right" }) {
  const rule = { left: "M9 3v18", bottom: "M3 15h18", right: "M15 3v18" }[side];
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d={rule} />
    </svg>
  );
}

/** Where a zone's toggle reopens it when none of its panels is open: its first registered panel. */
function showZone(zone: Exclude<PanelZone, "center">) {
  const store = useDockLayoutStore.getState();
  const panels = panelsInZone(zone);
  const open = panels.filter((id) => store.openPanels.has(id));
  if (open.length === 0) {
    const first = panels[0];
    if (first) store.activatePanel(first);
    return;
  }
  store.setZoneVisible(zone, true);
  const last = store.lastActive[zone];
  if (last && open.includes(last)) store.activatePanel(last);
}

/**
 * Left column, bottom panel and right column on or off: the prototype's three-button `.seg`, mapped
 * onto the dock. Hiding keeps every panel open in its place, so turning a zone back on restores it as
 * it was. The Story workspace has no right column, and its bottom panel is the Story graph.
 */
export function PanelToggles() {
  const { t } = useTranslation();
  const visiblePanels = useDockLayoutStore((state) => state.visiblePanels);
  const inStory = useDockLayoutStore((state) => state.arrangement === "story");
  // Story's left column is Chat and Media as tabs of one group; either one showing means the column shows.
  const leftShown =
    panelsInZone("left").some((id) => visiblePanels.has(id)) ||
    (inStory && visiblePanels.has("media"));
  const rightShown = panelsInZone("right").some((id) => visiblePanels.has(id));
  const bottomPanel = inStory ? "story" : "timeline";
  const bottomShown = visiblePanels.has(bottomPanel);
  const toggles = [
    {
      side: "left",
      label: t("shell.titlebar.leftPanel"),
      pressed: leftShown,
      disabled: false,
      toggle: () =>
        leftShown ? useDockLayoutStore.getState().setZoneVisible("left", false) : showZone("left"),
    },
    {
      side: "bottom",
      label: inStory ? t("shell.dock.panel.story") : t("shell.titlebar.timeline"),
      pressed: bottomShown,
      disabled: false,
      toggle: () => {
        const store = useDockLayoutStore.getState();
        if (bottomShown) store.setGroupVisible(bottomPanel, false);
        else store.activatePanel(bottomPanel);
      },
    },
    {
      side: "right",
      label: t("shell.titlebar.rightPanel"),
      pressed: rightShown,
      disabled: inStory,
      toggle: () =>
        rightShown
          ? useDockLayoutStore.getState().setZoneVisible("right", false)
          : showZone("right"),
    },
  ] as const;
  return (
    <div
      role="group"
      aria-label={t("shell.titlebar.panels")}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-bg-0 p-0.5"
    >
      {toggles.map(({ side, label, pressed, disabled, toggle }) => (
        <Tooltip key={side} label={label} side="bottom">
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={toggle}
            className={cn(
              "inline-flex h-[22px] w-[26px] items-center justify-center rounded-sm text-fg-3 select-none",
              "transition-[background-color,color] ease-standard duration-hover",
              "hover:bg-surface-2 hover:text-fg",
              "aria-pressed:bg-surface-3 aria-pressed:text-fg aria-pressed:shadow-[inset_0_0_0_1px_var(--color-border-strong)]",
              "disabled:pointer-events-none disabled:opacity-40",
              "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
            )}
          >
            <PanelGlyph side={side} />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
