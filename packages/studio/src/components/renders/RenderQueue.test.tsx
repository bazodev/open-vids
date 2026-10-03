// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { RenderQueue, type StartRenderHandler } from "./RenderQueue";
import { getPersistedRenderSettings } from "./renderSettings";
import { isTypingTarget } from "../../utils/typingTarget";
import { shouldIgnorePlaybackShortcutTarget } from "../../player/lib/playbackShortcuts";
import type { FfmpegStatus } from "./useFfmpegStatus";
import type { RenderJob } from "./useRenderQueue";

// Encoder availability arrives as a prop (useRenderQueue owns the probe), so
// each case just states the environment it is about.
let ffmpegStatus: FfmpegStatus | null = { ok: true };
const recheck = vi.fn();

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;

beforeEach(() => {
  ffmpegStatus = { ok: true };
  recheck.mockClear();
  // The format, frame-rate and quality controls write through to the real
  // store, so each case has to start from the shipped defaults.
  localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function mountRenderQueue(
  onStartRender: Mock<StartRenderHandler>,
  compositionDimensions = { width: 1920, height: 1080 },
  jobs: RenderJob[] = [],
  isRendering = false,
) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <RenderQueue
        jobs={jobs}
        projectId="demo"
        onDelete={vi.fn()}
        onOpen={vi.fn()}
        onClearCompleted={vi.fn()}
        onStartRender={onStartRender}
        isRendering={isRendering}
        compositionDimensions={compositionDimensions}
        ffmpeg={ffmpegStatus}
        ffmpegChecking={false}
        onRecheckFfmpeg={recheck}
      />,
    );
  });
  return host;
}

/** Base UI moves focus a task later than React renders; happy-dom is no faster. */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

function fire(el: Element, type: string, key?: string) {
  const event =
    key === undefined
      ? new MouseEvent(type, { bubbles: true })
      : new KeyboardEvent(type, { bubbles: true, key });
  act(() => void el.dispatchEvent(event));
}

function triggerFor(host: HTMLElement, label: string): HTMLElement {
  const trigger = host.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`);
  if (!trigger) throw new Error(`no select labelled ${label}`);
  return trigger;
}

/** Opens a Select and arrows down `steps` items before committing, the way a keyboard user
 * does. happy-dom does not synthesise the click Space would trigger, so it is dispatched here. */
async function chooseByArrowing(trigger: HTMLElement, steps: number) {
  fire(trigger, "keydown", " ");
  fire(trigger, "keyup", " ");
  act(() => trigger.click());
  await settle();
  for (let i = 0; i < steps; i += 1) {
    fire(document.activeElement ?? document.body, "keydown", "ArrowDown");
    await settle();
  }
  fire(document.activeElement ?? document.body, "keydown", "Enter");
  await settle();
}

function exportButtonIn(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('[data-testid="renders-export"]');
  if (!button) throw new Error("export button did not render");
  return button;
}

describe("RenderQueue controls", () => {
  it("has no native select left in the panel", () => {
    // R8. The four format / resolution / frame-rate / quality controls are the
    // shared Select now; a native one would bring back an OS popup that no
    // token can reach.
    expect(mountRenderQueue(vi.fn()).querySelector("select")).toBeNull();
  });

  it("classifies the format Select the way it classified the native one (KTD13)", async () => {
    const host = mountRenderQueue(vi.fn());
    const reference = document.createElement("select");
    document.body.append(reference);
    await settle();

    const trigger = triggerFor(host, "Format");

    // Both true, not merely equal: two falses would agree and prove nothing.
    expect(isTypingTarget(reference)).toBe(true);
    expect(shouldIgnorePlaybackShortcutTarget(reference)).toBe(true);
    expect(isTypingTarget(trigger)).toBe(isTypingTarget(reference));
    expect(shouldIgnorePlaybackShortcutTarget(trigger)).toBe(
      shouldIgnorePlaybackShortcutTarget(reference),
    );
  });

  it("submits the canonical landscape 4K preset selected by the user", async () => {
    const onStartRender: Mock<StartRenderHandler> = vi.fn();
    const host = mountRenderQueue(onStartRender);

    // Auto, 1080p, 4K: two steps down from the default.
    await chooseByArrowing(triggerFor(host, "Resolution"), 2);
    act(() => {
      exportButtonIn(host).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onStartRender).toHaveBeenCalledWith("mp4", "standard", "landscape-4k", 30);
  });

  it("refuses a resolution the composition cannot reach, and says why", async () => {
    // 1080p on a 1280x720 comp is a 1.5x scale, which the producer rejects; the
    // option stays listed (its label explains why) but the keyboard skips it.
    const onStartRender: Mock<StartRenderHandler> = vi.fn();
    const host = mountRenderQueue(onStartRender, { width: 1280, height: 720 });
    const trigger = triggerFor(host, "Resolution");

    fire(trigger, "keydown", " ");
    fire(trigger, "keyup", " ");
    act(() => trigger.click());
    await settle();
    const blocked = [...document.querySelectorAll('[role="option"]')].filter((option) =>
      option.hasAttribute("data-disabled"),
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.textContent).toContain("not an integer scale of 1280×720");

    fire(document.activeElement ?? document.body, "keydown", "ArrowDown");
    await settle();
    fire(document.activeElement ?? document.body, "keydown", "Enter");
    await settle();
    fire(document.activeElement ?? document.body, "keydown", "Escape");
    await settle();
    act(() => {
      exportButtonIn(host).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onStartRender).toHaveBeenCalledWith("mp4", "standard", "auto", 30);
  });

  it("persists a changed format as the literal union value", async () => {
    const host = mountRenderQueue(vi.fn());

    // MP4, MOV, WebM: one step down commits "mov", not the label "MOV (ProRes)".
    await chooseByArrowing(triggerFor(host, "Format"), 1);

    expect(getPersistedRenderSettings()).toEqual({
      format: "mov",
      quality: "standard",
      fps: 30,
    });
  });
  it("locks settings controls and shows a notice while a render is active", () => {
    const activeJob: RenderJob = {
      id: "active",
      status: "rendering",
      progress: 42,
      filename: "active.mp4",
      createdAt: 1,
    };
    const host = mountRenderQueue(vi.fn(), undefined, [activeJob], true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Settings can be changed after the render finishes.",
    );
    for (const label of ["Resolution", "Frame rate", "Format"]) {
      expect(triggerFor(host, label).hasAttribute("disabled")).toBe(true);
    }
    const quality = host.querySelector('[role="radiogroup"][aria-label="Quality"]');
    expect(quality?.querySelectorAll("button[disabled]")).toHaveLength(3);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.find((button) => button.textContent?.includes("Cancel Render"))?.disabled).toBe(
      false,
    );
    expect(buttons.find((button) => button.textContent?.includes("Edit"))?.disabled).toBe(true);
  });

  it("leaves settings enabled with no notice when idle or finished", () => {
    const terminalStatuses: RenderJob["status"][] = ["complete", "failed", "cancelled"];
    const terminalJobs: RenderJob[] = terminalStatuses.map((status) => ({
      id: status,
      status,
      progress: 100,
      filename: `${status}.mp4`,
      createdAt: 1,
    }));
    const host = mountRenderQueue(vi.fn(), undefined, terminalJobs);
    expect(host.querySelector('[role="status"]')).toBeNull();
    for (const label of ["Resolution", "Frame rate", "Format"]) {
      expect(triggerFor(host, label).hasAttribute("disabled")).toBe(false);
    }
    expect(
      host.querySelector('[role="radiogroup"][aria-label="Quality"] button:disabled'),
    ).toBeNull();
    expect(host.querySelector('[data-testid="renders-export"]')?.hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("does not persist or change a setting when its control is disabled", async () => {
    const host = mountRenderQueue(vi.fn(), undefined, [], true);
    const format = triggerFor(host, "Format");
    fire(format, "click");
    await settle();
    expect(document.querySelector('[role="option"]')).toBeNull();
    expect(getPersistedRenderSettings()).toEqual({
      format: "mp4",
      quality: "standard",
      fps: 30,
    });
    const quality = host.querySelector<HTMLButtonElement>(
      '[role="group"][aria-label="Quality"] button',
    );
    quality?.click();
    expect(getPersistedRenderSettings()).toEqual({
      format: "mp4",
      quality: "standard",
      fps: 30,
    });
  });
});

describe("RenderQueue Export button", () => {
  it("leaves the font size to the shared Button", () => {
    const host = mountRenderQueue(vi.fn());
    expect(exportButtonIn(host).className).not.toMatch(/text-\[/);
  });
});

describe("RenderQueue recent renders", () => {
  it("lists finished renders newest first and reports the newest render's duration", () => {
    const job = (id: string, createdAt: number, durationMs: number): RenderJob => ({
      id,
      status: "complete",
      progress: 100,
      filename: `${id}.mp4`,
      createdAt,
      durationMs,
    });
    // Server history arrives newest-first, session jobs are appended: neither order is a clock.
    const host = mountRenderQueue(vi.fn(), undefined, [
      job("middle", 2_000, 20_000),
      job("oldest", 1_000, 10_000),
      job("newest", 3_000, 30_000),
    ]);

    const names = [...host.querySelectorAll("li b")].map((b) => b.textContent);
    expect(names).toEqual(["newest.mp4", "middle.mp4", "oldest.mp4"]);
    expect(host.querySelector("footer")?.textContent).toContain("30s");
  });
});

describe("RenderQueue FFmpeg gate", () => {
  it("refuses Export and shows the install command when the server reports no FFmpeg", () => {
    ffmpegStatus = {
      ok: false,
      title: "FFmpeg not found",
      detail: "FFmpeg is required to encode video.",
      hint: "brew install ffmpeg",
      command: "brew install ffmpeg",
    };
    const onStartRender: Mock<StartRenderHandler> = vi.fn();
    const host = mountRenderQueue(onStartRender);

    expect(host.textContent).toContain("FFmpeg not found");
    expect(host.querySelector("code")?.textContent).toBe("brew install ffmpeg");

    const exportButton = exportButtonIn(host);
    expect(exportButton.disabled).toBe(true);
    act(() => {
      exportButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onStartRender).not.toHaveBeenCalled();
  });

  it("offers a recheck so installing FFmpeg does not require restarting Studio", () => {
    ffmpegStatus = { ok: false, title: "FFmpeg not found", command: "brew install ffmpeg" };
    const host = mountRenderQueue(vi.fn());

    const recheckButton = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Check Again",
    );
    if (!recheckButton) throw new Error("recheck button did not render");
    act(() => {
      recheckButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(recheck).toHaveBeenCalledTimes(1);
  });

  // An unreachable or older dev server answers nothing. Treating "no answer"
  // as "not installed" would lock Export for setups that render fine.
  it("leaves Export usable when the probe returns no answer", () => {
    ffmpegStatus = null;
    const onStartRender: Mock<StartRenderHandler> = vi.fn();
    const host = mountRenderQueue(onStartRender);

    expect(host.textContent).not.toContain("FFmpeg not found");
    const exportButton = exportButtonIn(host);
    expect(exportButton.disabled).toBe(false);
    act(() => {
      exportButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onStartRender).toHaveBeenCalledTimes(1);
  });

  it("says nothing when FFmpeg is present", () => {
    const host = mountRenderQueue(vi.fn());

    expect(host.textContent).not.toContain("FFmpeg not found");
    expect(exportButtonIn(host).disabled).toBe(false);
  });
});
