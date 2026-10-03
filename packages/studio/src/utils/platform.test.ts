// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import {
  altKeyLabel,
  isMacPlatform,
  platformKey,
  resolveShortcutKey,
  shiftKeyLabel,
} from "./platform";

const MAC = "MacIntel";
const WIN = "Win32";

describe("isMacPlatform", () => {
  it.each(["MacIntel", "MacPPC", "iPhone", "iPad", "iPod"])("treats %s as Mac", (platform) => {
    expect(isMacPlatform(platform)).toBe(true);
  });

  it.each(["Win32", "Win64", "Linux x86_64"])("treats %s as non-Mac", (platform) => {
    expect(isMacPlatform(platform)).toBe(false);
  });

  it("keeps the long-standing Mac wording when the platform is unknown", () => {
    expect(isMacPlatform("")).toBe(true);
    vi.stubGlobal("navigator", { platform: "" });
    try {
      expect(isMacPlatform()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("modifier labels", () => {
  it("returns the Mac spelling on Apple platforms", () => {
    expect(shiftKeyLabel(MAC)).toBe("⇧");
    expect(altKeyLabel(MAC)).toBe("⌥");
  });

  it("spells the modifiers out elsewhere", () => {
    expect(shiftKeyLabel(WIN)).toBe("Shift");
    expect(altKeyLabel(WIN)).toBe("Alt");
  });
});

describe("resolveShortcutKey", () => {
  it("leaves every Mac keycap untouched on Mac", () => {
    for (const key of [
      "⌘Z",
      "⇧⌘Z",
      "⌘⇧G",
      "⌘.",
      "⌘F",
      "⌘↵",
      "⌘ Drag↕",
      "⇧Click",
      "⌥ Drag",
      "Ctrl+Z",
    ]) {
      expect(resolveShortcutKey(key, MAC)).toBe(key);
    }
  });

  it("spells Mac keycaps out on Windows", () => {
    expect(resolveShortcutKey("⌘Z", WIN)).toBe("Ctrl+Z");
    expect(resolveShortcutKey("⇧⌘Z", WIN)).toBe("Ctrl+Shift+Z");
    expect(resolveShortcutKey("⌘⇧G", WIN)).toBe("Ctrl+Shift+G");
    expect(resolveShortcutKey("⌘.", WIN)).toBe("Ctrl+.");
    expect(resolveShortcutKey("⌘F", WIN)).toBe("Ctrl+F");
    expect(resolveShortcutKey("⌘↵", WIN)).toBe("Ctrl+↵");
    expect(resolveShortcutKey("⌘ Drag↕", WIN)).toBe("Ctrl+Drag↕");
    expect(resolveShortcutKey("⌘ Scroll", WIN)).toBe("Ctrl+Scroll");
    expect(resolveShortcutKey("⇧Click", WIN)).toBe("Shift+Click");
    expect(resolveShortcutKey("⇧ Drag", WIN)).toBe("Shift+Drag");
    expect(resolveShortcutKey("⌥ Drag", WIN)).toBe("Alt+Drag");
    expect(resolveShortcutKey("⇧⌘R", WIN)).toBe("Ctrl+Shift+R");
    expect(resolveShortcutKey("⌘D", WIN)).toBe("Ctrl+D");
  });

  it("leaves text without Mac glyphs alone", () => {
    for (const key of ["Ctrl+Z", "Space", "Del", "F2", "Enter", "?"]) {
      expect(resolveShortcutKey(key, WIN)).toBe(key);
    }
  });
});

describe("platformKey", () => {
  it("returns the base key on Mac", () => {
    expect(platformKey("settings.providers.ompFoot", MAC)).toBe("settings.providers.ompFoot");
  });

  it("returns the .win variant on Windows when the catalog has one", () => {
    expect(platformKey("home.item.reveal", WIN)).toBe("home.item.reveal.win");
  });

  it("falls back to the base key on Windows when there is no variant", () => {
    expect(platformKey("settings.providers.ompFoot", WIN)).toBe("settings.providers.ompFoot");
  });
});
