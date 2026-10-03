// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenvidsDesktopShortcuts } from "./useOpenvidsDesktopShortcuts";
import * as host from "../utils/openvidsHost";
import { useSettingsDialog } from "../components/settings/settingsStore";
// happy-dom's globalThis lacks the React act-environment flag type.
const reactActEnv: { IS_REACT_ACT_ENVIRONMENT: boolean } = globalThis as unknown as {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
reactActEnv.IS_REACT_ACT_ENVIRONMENT = true;

const HOME = "http://127.0.0.1:57035";

let root: Root | null = null;
let hostEl: HTMLElement | null = null;

function mount(props: {
  homeOrigin: string | null;
  onHome?: () => void;
  onOpen?: () => void;
  onReload?: () => void;
  onSettings?: () => void;
}) {
  function Harness() {
    useOpenvidsDesktopShortcuts(props);
    return null;
  }
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  act(() => root?.render(<Harness />));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("navigator", { platform: "Win32" });
});

afterEach(() => {
  root?.unmount();
  root = null;
  hostEl?.remove();
  hostEl = null;
  vi.unstubAllGlobals();
});

function key(target: Element, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("useOpenvidsDesktopShortcuts", () => {
  it("stays inert outside the desktop shell", () => {
    const onHome = vi.fn();
    const onOpen = vi.fn();
    mount({ homeOrigin: null, onHome, onOpen });
    key(document.body, { key: "o", shiftKey: true, ctrlKey: true });
    key(document.body, { key: "o", ctrlKey: true });
    key(document.body, { key: ",", ctrlKey: true });
    key(document.body, { key: "r", ctrlKey: true });
    expect(onHome).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens the picker on Ctrl+O, goes home on Ctrl+Shift+O, reloads on Ctrl+R", () => {
    const menuAction = vi.spyOn(host, "invokeHomeMenuAction").mockResolvedValue(true);
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    try {
      const onHome = vi.fn();
      const onSettings = vi.fn();
      mount({ homeOrigin: HOME, onHome, onSettings });
      key(document.body, { key: "o", shiftKey: true, ctrlKey: true });
      expect(onHome).toHaveBeenCalledTimes(1);
      key(document.body, { key: "r", ctrlKey: true });
      expect(reload).toHaveBeenCalledTimes(1);
      // Plain Ctrl+O opens the picker through the shared menu action —
      // the same path the hidden native menu takes.
      key(document.body, { key: "o", ctrlKey: true });
      expect(menuAction).toHaveBeenCalledWith(HOME, "open_project");
      expect(onHome).toHaveBeenCalledTimes(1);
      // Typing targets keep their keys.
      const input = document.createElement("input");
      document.body.append(input);
      key(input, { key: "o", ctrlKey: true });
      expect(menuAction).toHaveBeenCalledTimes(1);
      input.remove();
    } finally {
      reload.mockRestore();
    }
  });

  it("opens Settings in place on Ctrl+,", () => {
    mount({ homeOrigin: HOME });
    expect(useSettingsDialog.getState().open).toBe(false);
    key(document.body, { key: ",", ctrlKey: true });
    expect(useSettingsDialog.getState().open).toBe(true);
    useSettingsDialog.setState({ open: false });
  });

  it("accepts Meta as the modifier like Ctrl (macOS parity)", () => {
    const onHome = vi.fn();
    mount({ homeOrigin: HOME, onHome });
    key(document.body, { key: "O", shiftKey: true, metaKey: true });
    expect(onHome).toHaveBeenCalledTimes(1);
  });

  it("matches a Russian-layout Ctrl+O on Windows", () => {
    const menuAction = vi.spyOn(host, "invokeHomeMenuAction").mockResolvedValue(true);
    mount({ homeOrigin: HOME });
    key(document.body, { key: "щ", code: "KeyO", ctrlKey: true });
    expect(menuAction).toHaveBeenCalledWith(HOME, "open_project");
  });

  it("ignores the code on macOS, exactly as before", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const menuAction = vi.spyOn(host, "invokeHomeMenuAction").mockResolvedValue(true);
    mount({ homeOrigin: HOME });
    key(document.body, { key: "щ", code: "KeyO", ctrlKey: true });
    expect(menuAction).not.toHaveBeenCalled();
  });
});
