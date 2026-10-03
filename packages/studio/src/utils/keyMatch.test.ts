// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { isWindowsPlatform, resolveModifierKey } from "./keyMatch";

const WIN = "Win32";
const WIN64 = "Win64";
const MAC = "MacIntel";
const LINUX = "Linux x86_64";

function key(key: string, code: string): Pick<KeyboardEvent, "key" | "code"> {
  return { key, code };
}

describe("isWindowsPlatform", () => {
  it("treats Win32/Win64 as Windows", () => {
    expect(isWindowsPlatform(WIN)).toBe(true);
    expect(isWindowsPlatform(WIN64)).toBe(true);
  });

  it("treats macOS and Linux as non-Windows", () => {
    expect(isWindowsPlatform(MAC)).toBe(false);
    expect(isWindowsPlatform(LINUX)).toBe(false);
  });

  it("is false when there is no platform to read, so unknown environments keep the key comparison", () => {
    expect(isWindowsPlatform("")).toBe(false);
    vi.stubGlobal("navigator", {});
    try {
      expect(isWindowsPlatform(undefined)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("resolveModifierKey", () => {
  it("resolves a Latin key on every platform", () => {
    for (const platform of [WIN, MAC, LINUX, undefined]) {
      expect(resolveModifierKey(key("o", "KeyO"), platform)).toBe("o");
      expect(resolveModifierKey(key("O", "KeyO"), platform)).toBe("o");
      expect(resolveModifierKey(key(",", "Comma"), platform)).toBe(",");
      expect(resolveModifierKey(key("1", "Digit1"), platform)).toBe("1");
    }
  });

  it("resolves a Cyrillic key by physical code on Windows", () => {
    // Russian layout: the O position types щ (Щ with CapsLock/Shift).
    expect(resolveModifierKey(key("щ", "KeyO"), WIN)).toBe("o");
    expect(resolveModifierKey(key("Щ", "KeyO"), WIN)).toBe("o");
    expect(resolveModifierKey(key("б", "Comma"), WIN)).toBe(",");
  });

  it("ignores the code on macOS and Linux, exactly as before", () => {
    expect(resolveModifierKey(key("щ", "KeyO"), MAC)).toBe("щ");
    expect(resolveModifierKey(key("щ", "KeyO"), LINUX)).toBe("щ");
    expect(resolveModifierKey(key("б", "Comma"), MAC)).toBe("б");
  });

  it("keeps the visible Latin letter authoritative on Windows (Dvorak/AZERTY)", () => {
    // Dvorak "o" sits on a different physical key; the letter typed wins.
    expect(resolveModifierKey(key("s", "KeyO"), WIN)).toBe("s");
    expect(resolveModifierKey(key("o", "KeyS"), WIN)).toBe("o");
  });

  it("keeps shifted symbols authoritative on Windows, as the Latin comparison did", () => {
    // Ctrl+Shift+1 on an English layout is "!", which never matched "1".
    expect(resolveModifierKey(key("!", "Digit1"), WIN)).toBe("!");
  });

  it("resolves Dead/Process keys by code on Windows", () => {
    expect(resolveModifierKey(key("Dead", "KeyO"), WIN)).toBe("o");
    expect(resolveModifierKey(key("Process", "KeyR"), WIN)).toBe("r");
  });
  it("falls back to the key for unknown codes", () => {
    expect(resolveModifierKey(key("щ", "Unknown"), WIN)).toBe("щ");
  });

  it("reads the live platform when none is passed", () => {
    vi.stubGlobal("navigator", { platform: WIN });
    expect(resolveModifierKey(key("щ", "KeyO"))).toBe("o");
    vi.stubGlobal("navigator", { platform: MAC });
    expect(resolveModifierKey(key("щ", "KeyO"))).toBe("щ");
    vi.unstubAllGlobals();
  });
});
