import type { TranslationKey } from "../../i18n";

/** Bare keys Studio's app hotkeys bind; the shortcuts list names them from here. */
export const STUDIO_PLAIN_KEYS = { fullscreen: "f", split: "s", record: "r" } as const;

/**
 * `key` is a keycap (`Space`, `⌘Z` on macOS / `Ctrl+Z` on Windows) or the translation key of a gesture
 * (`Drag edge`); `label` is a translation key. The panel translates a value that is a catalog key (taking the
 * `.win` variant on Windows) and resolves Mac keycaps via `resolveShortcutKey`, showing anything else
 * (an embedder's own list) as is.
 */
export interface ShortcutHint {
  key: string;
  label: string;
}

export interface ShortcutSection {
  /** A translation key, or literal text from an embedder. */
  title: string;
  hints: readonly ShortcutHint[];
}

const hintKey = (key: string) => key.toUpperCase();

/** What PlayerControls' shortcuts panel lists unless an embedder passes its own sections. */
export const DEFAULT_SHORTCUT_SECTIONS: readonly ShortcutSection[] = [
  {
    title: "player.shortcuts.section.playback",
    hints: [
      { key: "Space", label: "player.shortcuts.hint.playPause" },
      { key: "J", label: "player.shortcuts.hint.playBackward" },
      { key: "K", label: "player.shortcuts.hint.stop" },
      { key: "L", label: "player.shortcuts.hint.playForward" },
      { key: "M", label: "player.shortcuts.hint.toggleMute" },
      { key: "⇧L", label: "player.shortcuts.hint.toggleLoop" },
      { key: "←/→", label: "player.shortcuts.hint.step1" },
      { key: "⇧←/⇧→", label: "player.shortcuts.hint.step10" },
      {
        key: hintKey(STUDIO_PLAIN_KEYS.fullscreen),
        label: "player.shortcuts.hint.toggleFullscreen",
      },
    ],
  },
  {
    title: "player.shortcuts.section.keyframes",
    hints: [
      { key: "K", label: "player.shortcuts.hint.addKeyframe" },
      { key: "Del", label: "player.shortcuts.hint.deleteKeyframe" },
      { key: "H", label: "player.shortcuts.hint.toggleHold" },
      { key: "U", label: "player.shortcuts.hint.toggleProperties" },
      { key: hintKey(STUDIO_PLAIN_KEYS.record), label: "player.shortcuts.hint.recordGesture" },
    ],
  },
  {
    title: "player.shortcuts.section.editing",
    hints: [
      { key: "⌘Z", label: "player.shortcuts.hint.undo" },
      { key: "⌘⇧Z", label: "player.shortcuts.hint.redo" },
      { key: "⌘C", label: "player.shortcuts.hint.copy" },
      { key: "⌘V", label: "player.shortcuts.hint.paste" },
      { key: "⌘X", label: "player.shortcuts.hint.cut" },
      { key: hintKey(STUDIO_PLAIN_KEYS.split), label: "player.shortcuts.hint.split" },
      { key: "player.shortcuts.key.shiftClick", label: "player.shortcuts.hint.razor" },
      { key: "⌘G", label: "player.shortcuts.hint.group" },
      { key: "⌘⇧G", label: "player.shortcuts.hint.ungroup" },
      { key: "Del", label: "player.shortcuts.hint.deleteElement" },
    ],
  },
  {
    title: "player.shortcuts.section.gestures",
    hints: [
      { key: "player.shortcuts.key.drag", label: "player.shortcuts.hint.recordXY" },
      { key: "player.shortcuts.key.scroll", label: "player.shortcuts.hint.recordZ" },
      { key: "player.shortcuts.key.shiftDrag", label: "player.shortcuts.hint.recordRotationXY" },
      { key: "player.shortcuts.key.altDrag", label: "player.shortcuts.hint.recordRotation" },
      { key: "player.shortcuts.key.cmdDragVertical", label: "player.shortcuts.hint.recordOpacity" },
      { key: "player.shortcuts.key.cmdScroll", label: "player.shortcuts.hint.recordScale" },
    ],
  },
  {
    title: "player.shortcuts.section.canvas",
    hints: [
      { key: "player.shortcuts.key.drag", label: "player.shortcuts.hint.moveElement" },
      { key: "player.shortcuts.key.altDrag", label: "player.shortcuts.hint.moveAnimationPath" },
      { key: "player.shortcuts.key.shiftDrag", label: "player.shortcuts.hint.uniformResize" },
    ],
  },
  {
    title: "player.shortcuts.section.crop",
    hints: [
      { key: "player.shortcuts.key.dragEdge", label: "player.shortcuts.hint.cropSide" },
      { key: "player.shortcuts.key.dragCenter", label: "player.shortcuts.hint.cropReposition" },
    ],
  },
  {
    title: "player.shortcuts.section.panels",
    hints: [
      { key: "⌘1", label: "player.shortcuts.hint.compositionsTab" },
      { key: "⌘2", label: "player.shortcuts.hint.assetsTab" },
    ],
  },
  {
    title: "player.shortcuts.section.workArea",
    hints: [
      { key: "I", label: "player.shortcuts.hint.setIn" },
      { key: "⇧I", label: "player.shortcuts.hint.clearIn" },
      { key: "O", label: "player.shortcuts.hint.setOut" },
      { key: "⇧O", label: "player.shortcuts.hint.clearOut" },
      { key: "A", label: "player.shortcuts.hint.jumpIn" },
      { key: "E", label: "player.shortcuts.hint.jumpOut" },
    ],
  },
] as const satisfies readonly {
  title: TranslationKey;
  hints: readonly { key: string; label: TranslationKey }[];
}[];
