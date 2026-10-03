import { Folder } from "@phosphor-icons/react";
import { isChapter } from "@hyperframes/agent-protocol";
import { useFileManagerContext } from "../../contexts/FileManagerContext";
import { useTranslation, type TranslationKey } from "../../i18n";
import { resolveShortcutKey } from "../../utils/platform";
import { usePlayerStore } from "../../player";
import { STUDIO_PREVIEW_FPS } from "../../player/lib/time";
import { useStoryStore } from "../../story/storyContext";
import { useCurrentWorkspace } from "../../story/WorkspaceSwitch";
import type { Workspace } from "../dock/dockWorkspace";
import { Kbd } from "../ui";

interface Hint {
  /** The key cap, when the hint is a shortcut. */
  keys?: string;
  label: TranslationKey;
}

/** The shortcuts each workspace really answers to (ours, not the prototype's wish list). */
const HINTS: Record<Workspace, readonly Hint[]> = {
  edit: [
    { keys: "Space", label: "studio.statusBar.hint.play" },
    { keys: "B", label: "studio.statusBar.hint.blade" },
    { keys: "S", label: "studio.statusBar.hint.split" },
  ],
  story: [
    { label: "studio.statusBar.hint.panCanvas" },
    { label: "studio.statusBar.hint.scrollZoom" },
    { keys: "⌫", label: "studio.statusBar.hint.delete" },
  ],
  media: [
    { keys: "Space", label: "studio.statusBar.hint.preview" },
    { keys: resolveShortcutKey("⌘F"), label: "studio.statusBar.hint.search" },
    { label: "studio.statusBar.hint.dragToTimeline" },
  ],
};

/** `/Users/me/Movies/x` reads as `~/Movies/x`, the way the prototype prints project paths. */
export function homeRelative(path: string): string {
  const portable = path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)(?=\/|$)/, "~");
  if (portable !== path) return portable;
  // Windows (`C:\Users\<name>\...`, either slash style): the macOS/Linux rule
  // above never matches a drive-letter path, so reaching here means it did
  // not apply and its output stays byte-identical.
  return path.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/i, "~");
}

/** The window's bottom line: where the project lives, then the shown workspace's hints and state. */
export function StudioStatusBar() {
  const { t } = useTranslation();
  const { projectDir } = useFileManagerContext();
  const workspace = useCurrentWorkspace();
  const snap = usePlayerStore((state) => state.timelineSnapEnabled);
  const chapters = useStoryStore((state) => state.graph?.nodes.filter(isChapter).length ?? 0);
  return (
    <footer
      data-testid="studio-status-bar"
      className="flex h-[26px] shrink-0 items-center justify-between gap-4 overflow-hidden border-t border-border-subtle bg-bg-1 px-5 text-xs whitespace-nowrap text-fg-3"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {projectDir ? (
          <>
            <Folder size={12} aria-hidden className="shrink-0" />
            <span className="truncate font-mono" title={projectDir}>
              {homeRelative(projectDir)}
            </span>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {HINTS[workspace].map((hint) => (
          <span key={hint.label} className="inline-flex items-center gap-[5px]">
            {hint.keys ? <Kbd>{hint.keys}</Kbd> : null}
            {t(hint.label)}
          </span>
        ))}
        {workspace === "edit" ? (
          <span>{t(snap ? "studio.statusBar.snapOn" : "studio.statusBar.snapOff")}</span>
        ) : null}
        {workspace === "story" ? (
          <span className="font-mono">{t("studio.statusBar.chapters", { count: chapters })}</span>
        ) : (
          <span className="font-mono">
            {t("studio.statusBar.fps", { fps: STUDIO_PREVIEW_FPS })}
          </span>
        )}
      </div>
    </footer>
  );
}
