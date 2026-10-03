// @vitest-environment happy-dom

/**
 * The titlebar's behaviour: history with step names, Export's routing, the panel toggles over the
 * dock, the save state, Settings, the OpenVids back button, and hotkey filters (KTD13). Shell
 * contexts are mocked; the dock and save stores are the real ones.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { isTypingTarget } from "../utils/typingTarget";
import { shouldIgnorePlaybackShortcutTarget } from "../player/lib/playbackShortcuts";
import { useSaveActivityStore } from "../utils/saveActivity";
import { useDockLayoutStore, type DockController } from "./dock/dockLayoutStore";
import { PANEL_IDS, type PanelId } from "./dock/panelRegistry";
import { useSettingsDialog } from "./settings/settingsStore";
import { StudioHeader } from "./StudioHeader";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface ShellStub {
  projectId: string;
  editHistory: { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string };
  handleUndo: Mock<() => Promise<void>>;
  handleRedo: Mock<() => Promise<void>>;
  renderQueue: { isRendering: boolean; ffmpegMissing: boolean };
  writeBlockedReason: string | null;
}

const { shell, panelLayout } = vi.hoisted(() => {
  const stub: ShellStub = {
    projectId: "demo",
    editHistory: { canUndo: false, canRedo: false },
    handleUndo: vi.fn(async () => {}),
    handleRedo: vi.fn(async () => {}),
    renderQueue: { isRendering: false, ffmpegMissing: false },
    writeBlockedReason: null,
  };
  return { shell: stub, panelLayout: { setRightCollapsed: vi.fn(), setRightPanelTab: vi.fn() } };
});

vi.mock("../contexts/StudioContext", () => ({ useStudioShellContext: () => shell }));
vi.mock("../contexts/PanelLayoutContext", () => ({ usePanelLayoutContext: () => panelLayout }));

let mounted: { root: Root; host: HTMLElement } | null = null;
let controller: { [K in keyof DockController]: Mock };

beforeEach(() => {
  shell.editHistory = { canUndo: false, canRedo: false };
  shell.renderQueue = { isRendering: false, ffmpegMissing: false };
  shell.writeBlockedReason = null;
  vi.clearAllMocks();
  useSaveActivityStore.setState({ pending: 0 });
  useSettingsDialog.setState({ open: false });
  controller = {
    open: vi.fn(),
    activate: vi.fn(),
    setTitle: vi.fn(),
    close: vi.fn(),
    setGroupVisible: vi.fn(),
    enterStory: vi.fn(),
    leaveStory: vi.fn(),
    reset: vi.fn(),
  };
  useDockLayoutStore.setState({
    controller,
    openPanels: new Set(PANEL_IDS),
    visiblePanels: new Set<PanelId>(["preview", "timeline", "compositions", "design"]),
    lastActive: {},
  });
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.useRealTimers();
  if (!mounted) return;
  const { root, host } = mounted;
  mounted = null;
  act(() => root.unmount());
  host.remove();
});

function mount(search?: string): HTMLElement {
  if (search !== undefined) window.history.replaceState(null, "", `/${search}`);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  act(() => root.render(<StudioHeader />));
  return host;
}

function query(host: HTMLElement, selector: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`not rendered: ${selector}`);
  return el;
}

it("names the step Undo and Redo would take, and runs the shell's history", () => {
  shell.editHistory = {
    canUndo: true,
    canRedo: false,
    undoLabel: "Move clip",
    redoLabel: undefined,
  };
  const host = mount();
  const undo = query(host, '[aria-label="Undo Move clip"]');
  expect(undo.hasAttribute("disabled")).toBe(false);
  expect(query(host, '[aria-label="Redo"]').hasAttribute("disabled")).toBe(true);
  act(() => undo.click());
  expect(shell.handleUndo).toHaveBeenCalledTimes(1);
});

it("Export only opens Renders, so the user starts the render there", () => {
  const host = mount();
  act(() => query(host, '[data-testid="header-export"]').click());
  expect(panelLayout.setRightPanelTab).toHaveBeenCalledWith("renders");
  expect(panelLayout.setRightCollapsed).toHaveBeenCalledWith(false);
});

it("shows each dock zone's toggle pressed while it shows, and hides the zone on click", () => {
  const host = mount();
  const left = query(host, '[aria-label="Left panel"]');
  expect(left.getAttribute("aria-pressed")).toBe("true");
  expect(query(host, '[aria-label="Timeline"]').getAttribute("aria-pressed")).toBe("true");
  act(() => left.click());
  expect(controller.setGroupVisible).toHaveBeenCalledWith("compositions", false);
  act(() => query(host, '[aria-label="Timeline"]').click());
  expect(controller.setGroupVisible).toHaveBeenCalledWith("timeline", false);
});

it("reopens a hidden column on its last shown panel", () => {
  useDockLayoutStore.setState({
    visiblePanels: new Set<PanelId>(["preview", "timeline", "compositions"]),
    lastActive: { right: "layers" },
  });
  const host = mount();
  const right = query(host, '[aria-label="Right panel"]');
  expect(right.getAttribute("aria-pressed")).toBe("false");
  act(() => right.click());
  expect(controller.setGroupVisible).toHaveBeenCalledWith("design", true);
  expect(controller.activate).toHaveBeenCalledWith("layers");
});

it("reads Saving… while a write is in flight, Saved after it lands, Not saved when writes are blocked", () => {
  vi.useFakeTimers();
  const host = mount();
  const state = () => query(host, '[data-testid="save-state"]');
  expect(state().textContent).toBe("Saved");
  act(() => useSaveActivityStore.setState({ pending: 1 }));
  expect(state().textContent).toBe("Saving…");
  act(() => useSaveActivityStore.setState({ pending: 0 }));
  expect(state().textContent).toBe("Saving…");
  act(() => vi.advanceTimersByTime(600));
  expect(state().textContent).toBe("Saved");

  act(() => mounted?.root.unmount());
  mounted?.host.remove();
  mounted = null;
  shell.writeBlockedReason = "Saving is paused";
  const blocked = mount();
  expect(query(blocked, '[data-testid="save-state"]').textContent).toBe("Not saved");
});

it("opens Settings from the gear", () => {
  const host = mount();
  act(() => query(host, '[aria-label="Settings"]').click());
  expect(useSettingsDialog.getState().open).toBe(true);
});

it("keeps the titlebar controls out of the typing and playback hotkey paths (KTD13)", () => {
  shell.editHistory = { canUndo: true, canRedo: true, undoLabel: undefined, redoLabel: undefined };
  const host = mount();
  const controls = [
    query(host, '[data-testid="header-export"]'),
    query(host, '[aria-label="Undo"]'),
    query(host, '[aria-label="Left panel"]'),
    query(host, '[aria-label="Settings"]'),
  ];
  for (const el of controls) {
    expect(isTypingTarget(el), el.getAttribute("aria-label") ?? el.tagName).toBe(false);
    expect(shouldIgnorePlaybackShortcutTarget(el), el.tagName).toBe(true);
  }
});

it("keeps the logo when Studio is not embedded in OpenVids", () => {
  const host = mount();
  expect(host.querySelector('[data-testid="openvids-back"]')).toBeNull();
  expect(host.querySelector('[aria-label="OpenVids"]')).not.toBeNull();
});

it("swaps the logo for a back button when the OpenVids home param is present", () => {
  const host = mount("?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035");
  const back = query(host, '[data-testid="openvids-back"]');
  expect(back.tagName).toBe("BUTTON");
  expect(back.getAttribute("aria-label")).toBe("Back to projects");
  expect(back.textContent).toContain("Projects");
  expect(host.querySelector('[aria-label="OpenVids"]')).toBeNull();
  expect(isTypingTarget(back)).toBe(false);
  expect(shouldIgnorePlaybackShortcutTarget(back)).toBe(true);
});

it("keeps the logo when the OpenVids home param fails validation", () => {
  const host = mount("?openvidsHome=http%3A%2F%2Fexample.com%3A57035");
  expect(host.querySelector('[data-testid="openvids-back"]')).toBeNull();
  expect(host.querySelector('[aria-label="OpenVids"]')).not.toBeNull();
});

it("offers Report a problem only inside the desktop shell, and asks the home server to open its window", () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal("fetch", fetchMock);
  try {
    expect(mount().querySelector('[data-testid="header-report-problem"]')).toBeNull();
    act(() => mounted?.root.unmount());
    mounted?.host.remove();
    mounted = null;

    const host = mount("?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035");
    const button = query(host, '[data-testid="header-report-problem"]');
    expect(button.getAttribute("aria-label")).toBe("Report a problem");
    act(() => button.click());
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:57035/api/report/open", {
      method: "POST",
      mode: "no-cors",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ context: "studio" }),
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps the traffic-light inset on the macOS overlay frame", () => {
  const host = mount("?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035");
  expect(host.querySelector('[data-testid="window-controls"]')).toBeNull();
  expect(host.querySelector(".w-\\[52px\\]")).not.toBeNull();
});

it("draws caption buttons with no traffic-light inset on the Windows custom frame", () => {
  const host = mount("?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&openvidsFrame=custom");
  expect(host.querySelector(".w-\\[52px\\]")).toBeNull();
  const controls = query(host, '[data-testid="window-controls"]');
  const min = query(host, '[data-testid="window-minimize"]');
  const max = query(host, '[data-testid="window-maximize"]');
  const close = query(host, '[data-testid="window-close"]');
  expect(controls.contains(min)).toBe(true);
  expect(controls.contains(max)).toBe(true);
  expect(controls.contains(close)).toBe(true);
  expect(max.getAttribute("aria-label")).toBe("Maximize");
  for (const el of [min, max, close]) {
    expect(el.getAttribute("tabindex")).toBe("-1");
    expect(isTypingTarget(el)).toBe(false);
    expect(shouldIgnorePlaybackShortcutTarget(el)).toBe(true);
  }
  // The Projects page's own shapes, not the Phosphor set: minimize is one
  // horizontal stroke, maximize a single outlined square.
  expect(min.querySelector("svg")).not.toBeNull();
  expect(min.textContent).toBe("");
  expect(max.querySelectorAll("svg rect").length).toBe(1);
});

it("draws neither inset nor caption buttons on the Windows system-frame fallback", () => {
  const host = mount("?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&openvidsFrame=system");
  expect(host.querySelector(".w-\\[52px\\]")).toBeNull();
  expect(host.querySelector('[data-testid="window-controls"]')).toBeNull();
});

it("shows the app menu button only on the Windows custom frame", () => {
  // macOS overlay: the real menu bar owns these actions.
  expect(
    mount("?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035").querySelector(
      '[data-testid="openvids-app-menu"]',
    ),
  ).toBeNull();
  // Windows system-frame fallback: the native bar is visible again.
  expect(
    mount("?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&openvidsFrame=system").querySelector(
      '[data-testid="openvids-app-menu"]',
    ),
  ).toBeNull();
  // Windows custom frame: the button sits in the traffic-light inset's slot
  // and stays tabbable (a real control, unlike the caption buttons).
  const custom = mount("?openvidsHome=http%3A%2F%2F127.0.0.1%3A57035&openvidsFrame=custom");
  const menu = query(custom, '[data-testid="openvids-app-menu"]');
  expect(menu.tagName).toBe("BUTTON");
  // A real control, unlike the caption buttons (tabindex -1): Base UI's menu
  // trigger stays in Tab order (tabindex 0), keyboard-operable like the menu.
  expect(menu.getAttribute("tabindex")).toBe("0");
  expect(menu.getAttribute("aria-label")).toBe("Application menu");
  expect(isTypingTarget(menu)).toBe(false);
  expect(shouldIgnorePlaybackShortcutTarget(menu)).toBe(true);
});
