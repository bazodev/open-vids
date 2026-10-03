/**
 * Layout-independent matching for modifier shortcuts on Windows.
 *
 * With a non-Latin layout (Russian, Greek, …) a Ctrl+chord reports the
 * localized character in `event.key` (`щ` instead of `o`), so a plain
 * `key === "o"` test silently drops the keystroke. The physical position is
 * still in `event.code` (`KeyO`), which is what this helper falls back to —
 * but only on Windows, and only when `event.key` is not a visible Latin
 * character: a Latin key stays authoritative, so Dvorak/AZERTY users keep
 * the letters they see. macOS and Linux take the plain `key` comparison,
 * byte-identical to the previous behavior.
 */

const CODE_TO_KEY: Record<string, string> = {
  KeyA: "a",
  KeyB: "b",
  KeyC: "c",
  KeyD: "d",
  KeyE: "e",
  KeyF: "f",
  KeyG: "g",
  KeyH: "h",
  KeyI: "i",
  KeyJ: "j",
  KeyK: "k",
  KeyL: "l",
  KeyM: "m",
  KeyN: "n",
  KeyO: "o",
  KeyP: "p",
  KeyQ: "q",
  KeyR: "r",
  KeyS: "s",
  KeyT: "t",
  KeyU: "u",
  KeyV: "v",
  KeyW: "w",
  KeyX: "x",
  KeyY: "y",
  KeyZ: "z",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Comma: ",",
  Period: ".",
};

/** A single visible ASCII character: a Latin key the user can see. */
const LATIN_KEY = /^[\x20-\x7E]$/;

/**
 * True on Windows (`navigator.platform` is `Win32`/`Win64` there); false
 * everywhere else, and false when there is no platform to read (tests), so
 * an unknown environment keeps the long-standing `key` comparison.
 */
export function isWindowsPlatform(platform?: string): boolean {
  const value = platform ?? (typeof navigator !== "undefined" ? navigator.platform : undefined);
  if (value == null || value.trim() === "") return false;
  return /win32|win64|windows/i.test(value);
}

/**
 * The key a modifier chord names, lowercase: `event.key` as today, except on
 * Windows with a non-Latin key, where the physical `code` translates back to
 * the Latin letter on that position (Russian `щ` on `KeyO` → `"o"`, `Dead`
 * and `Process` resolve the same way). Unknown codes fall back to
 * `event.key`, so macOS and Linux — and every Latin key — resolve
 * byte-identically to `event.key.toLowerCase()`. Compare the result with the
 * wanted letter (`=== "o"`, `=== ","`, …).
 */
export function resolveModifierKey(
  event: Pick<KeyboardEvent, "key" | "code">,
  platform?: string,
): string {
  const key = event.key.toLowerCase();
  if (!isWindowsPlatform(platform)) return key;
  if (LATIN_KEY.test(event.key)) return key;
  return CODE_TO_KEY[event.code] ?? key;
}
