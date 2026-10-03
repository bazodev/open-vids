/**
 * Platform labels for Studio's shortcuts and file-manager wording.
 *
 * macOS shows the prototype's glyphs (`⌘Z`, `⇧-click`); Windows spells the
 * modifiers out (`Ctrl+Z`, `Shift-click`). Every helper takes an optional
 * `platform` (a `navigator.platform` value) so tests can assert both
 * variants; without it the current browser is read, and an unknown value
 * keeps the long-standing Mac wording so the Mac UI stays byte-identical.
 */
import { isTranslationKey, type TranslationKey } from "../i18n";

/** True on macOS/iOS (whose keyboards carry ⌘); false on Windows and the rest. */
export function isMacPlatform(platform?: string): boolean {
  const value = platform ?? (typeof navigator !== "undefined" ? navigator.platform : undefined);
  if (value == null || value.trim() === "") return true;
  return /Mac|iPhone|iPad|iPod/i.test(value);
}

/** Shift as a `{key}` param: `⇧` on Mac, `Shift` on Windows. */
export function shiftKeyLabel(platform?: string): string {
  return isMacPlatform(platform) ? "⇧" : "Shift";
}

/** Option/Alt as a `{key}` param: `⌥` on Mac, `Alt` on Windows. */
export function altKeyLabel(platform?: string): string {
  return isMacPlatform(platform) ? "⌥" : "Alt";
}

/**
 * A Mac keycap (`⌘⇧G`, `⌘ Drag↕`, `⇧Click`) spelled for Windows
 * (`Ctrl+Shift+G`, `Ctrl+Drag↕`, `Shift+Click`); unchanged on Mac, and a
 * no-op for text that already spells the modifiers out. `⌫`/`↵`/arrows are
 * shared symbols, so they pass through on both platforms.
 */
export function resolveShortcutKey(key: string, platform?: string): string {
  if (isMacPlatform(platform)) return key;
  return key
    .replace(/⇧⌘/g, "Ctrl+Shift+")
    .replace(/⌘⇧/g, "Ctrl+Shift+")
    .replace(/⌘/g, "Ctrl+")
    .replace(/⇧/g, "Shift+")
    .replace(/⌥/g, "Alt+")
    .replace(/⌃/g, "Ctrl+")
    .replace(/\+\s+/g, "+");
}

/**
 * The catalog key to translate: `key` on Mac, its `<key>.win` variant on
 * Windows when the catalog has one, else `key`. Lets call sites stay
 * branch-free while the Mac string renders exactly as before.
 */
export function platformKey<K extends TranslationKey>(key: K, platform?: string): TranslationKey {
  if (isMacPlatform(platform)) return key;
  const win = `${key}.win`;
  return isTranslationKey(win) ? win : key;
}
