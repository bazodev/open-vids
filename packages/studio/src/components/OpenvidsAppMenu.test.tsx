// @vitest-environment happy-dom

/**
 * The title-bar app menu on the Windows custom frame: it lists every action
 * with its Ctrl shortcut, and dispatches each row through the same path as
 * its native / shortcut twin.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenvidsAppMenu } from "./OpenvidsAppMenu";
import { useSettingsDialog } from "./settings/settingsStore";
import * as host from "../utils/openvidsHost";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOME = "http://127.0.0.1:57035";

let mounted: { root: Root; host: HTMLElement } | null = null;

function mount(homeOrigin: string): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  mounted = { root, host: el };
  act(() => root.render(<OpenvidsAppMenu homeOrigin={homeOrigin} />));
  return el;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  // Windows wording: the menu spells its shortcuts out (Ctrl+O, not ⌘O).
  vi.stubGlobal("navigator", { platform: "Win32" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (!mounted) return;
  const { root, host: el } = mounted;
  mounted = null;
  act(() => root.unmount());
  el.remove();
});

/** Base UI moves focus into the popup one task after open, not synchronously. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickWithMouse(target: Element): void {
  const init = { bubbles: true, cancelable: true, composed: true, detail: 1 };
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.dispatchEvent(new MouseEvent("click", init));
  });
}

async function openMenu(hostEl: HTMLElement): Promise<void> {
  const trigger = hostEl.querySelector<HTMLElement>('[data-testid="openvids-app-menu"]');
  if (!trigger) throw new Error("menu trigger not rendered");
  clickWithMouse(trigger);
  await settle();
}

describe("OpenvidsAppMenu", () => {
  it("lists every action with its Ctrl shortcut where one exists", async () => {
    const hostEl = mount(HOME);
    await openMenu(hostEl);
    const popup = document.querySelector('[role="menu"]');
    if (!popup) throw new Error("menu popup not rendered");
    // Label and shortcut are adjacent spans: no whitespace between them.
    const rows = [...popup.querySelectorAll('[role="menuitem"]')].map((row) =>
      (row.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    expect(rows).toEqual([
      "Open Project Folder…Ctrl+O",
      "Show All ProjectsCtrl+Shift+O",
      "Settings…Ctrl+,",
      "ReloadCtrl+R",
      "Welcome to OpenVids…",
      "Check for Updates…",
      "About OpenVids",
      "Quit OpenVids",
    ]);
    expect(popup.querySelectorAll('[role="separator"]').length).toBe(2);
  });

  it("opens Settings in place and dispatches the rest through the home server", async () => {
    const menuAction = vi.spyOn(host, "invokeHomeMenuAction").mockResolvedValue(true);
    const hostEl = mount(HOME);
    await openMenu(hostEl);
    const popup = document.querySelector('[role="menu"]');
    if (!popup) throw new Error("menu popup not rendered");
    const rows = [...popup.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const byName = (name: string) => {
      const row = rows.find((row) => (row.textContent ?? "").includes(name));
      if (!row) throw new Error(`menu row missing: ${name}`);
      return row;
    };
    // Settings opens the dialog in place: no home-server round trip.
    expect(useSettingsDialog.getState().open).toBe(false);
    byName("Settings").click();
    expect(useSettingsDialog.getState().open).toBe(true);
    useSettingsDialog.setState({ open: false });
    expect(menuAction).not.toHaveBeenCalled();
    // Open Project goes through POST /api/menu/open_project.
    byName("Open Project").click();
    expect(menuAction).toHaveBeenCalledWith(HOME, "open_project");
    // Quit goes through POST /api/menu/quit (Rust exits; processes stop there).
    byName("Quit OpenVids").click();
    expect(menuAction).toHaveBeenCalledWith(HOME, "quit");
  });

  it("shows the About sheet from the home server's strings", async () => {
    vi.spyOn(host, "readHomeAbout").mockResolvedValue({
      name: "OpenVids",
      version: "0.2.0",
      website: "https://openvids.ai",
      websiteLabel: "openvids.ai",
      comment: "Agent-native desktop video editor",
      credits: "openvids.ai",
    });
    const hostEl = mount(HOME);
    await openMenu(hostEl);
    const popup = document.querySelector('[role="menu"]');
    if (!popup) throw new Error("menu popup not rendered");
    const about = [...popup.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
      (row.textContent ?? "").includes("About OpenVids"),
    );
    if (!about) throw new Error("About row missing");
    about.click();
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error("About dialog not rendered");
    expect(dialog.textContent).toContain("OpenVids");
    expect(dialog.textContent).toContain("Version 0.2.0");
  });
});
