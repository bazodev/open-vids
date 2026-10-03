import { useEffect } from "react";
import { isTypingTarget } from "../utils/typingTarget";
import { resolveModifierKey } from "../utils/keyMatch";
import { invokeHomeMenuAction } from "../utils/openvidsHost";
import { openSettings } from "../components/settings/settingsStore";

/**
 * In-page desktop shortcuts for Studio when it runs inside the OpenVids
 * shell (the `openvidsHome` query parameter is present).
 *
 * Without a system frame there is no menu bar, so these chords have no
 * native home on Windows: Ctrl+O opens the project picker (through
 * `POST /api/menu/open_project`, the same shared `menu_action` the hidden
 * native menu runs, so the picker steals no focus from the Shell), Ctrl+Shift+O
 * goes back to the Projects home screen (a plain navigation — Rust's
 * `on_navigation` hook runs the same cleanup as the menu), Ctrl+,
 * opens Settings in place and Ctrl+R reloads the window. Typing targets
 * keep their keys. Matching is layout-independent on Windows (`щ` on the O
 * position still opens); macOS and Linux compare `event.key` as before.
 */
export interface OpenvidsDesktopShortcuts {
  homeOrigin: string | null;
  onHome?: () => void;
  onOpen?: () => void;
  onReload?: () => void;
  onSettings?: () => void;
}

export function useOpenvidsDesktopShortcuts({
  homeOrigin,
  onHome,
  onOpen,
  onReload,
  onSettings,
}: OpenvidsDesktopShortcuts): void {
  useEffect(() => {
    if (!homeOrigin) return;
    const goHome = onHome ?? (() => void (window.location.href = homeOrigin));
    const openProject = onOpen ?? (() => void invokeHomeMenuAction(homeOrigin, "open_project"));
    const openDialog = onSettings ?? (() => openSettings());
    const reload = onReload ?? (() => window.location.reload());
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || isTypingTarget(event.target)) return;
      const key = resolveModifierKey(event);
      if (key === ",") {
        event.preventDefault();
        openDialog();
        return;
      }
      if (key === "o" && event.shiftKey && !event.altKey) {
        event.preventDefault();
        goHome();
        return;
      }
      if (key === "o" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        openProject();
        return;
      }
      if (key === "r" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        reload();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [homeOrigin, onHome, onOpen, onReload, onSettings]);
}
