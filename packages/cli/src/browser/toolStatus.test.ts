import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectToolStatus, ffVersionNumber } from "./preflight.js";
import * as manager from "./manager.js";

const runProcess = vi.hoisted(() => vi.fn());

// Run no real binary: CreateProcess cannot exec the POSIX shell stubs this
// test used before, chmod +x is a no-op here, and .cmd shims need shell:true
// which the runner never passes. Version parsing is covered through the
// stubbed banner; real spawning is covered by preflight.test.ts.
vi.mock("../utils/cancellableProcess.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/cancellableProcess.js")>();
  return {
    ...actual,
    runCancellableProcess: (
      command: string,
      args: readonly string[],
      options: { signal?: AbortSignal },
    ) => runProcess(command, args, options),
  };
});

describe("ffVersionNumber", () => {
  it("reads the number out of a version banner", () => {
    expect(
      ffVersionNumber("ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers"),
    ).toBe("9.0.2");
    expect(ffVersionNumber("ffprobe version N-126899-gd975849594-tessus Copyright")).toBe(
      "N-126899-gd975849594-tessus",
    );
    expect(ffVersionNumber("something else")).toBeUndefined();
  });
});

describe("collectToolStatus", () => {
  const saved = {
    ffmpeg: process.env.HYPERFRAMES_FFMPEG_PATH,
    ffprobe: process.env.HYPERFRAMES_FFPROBE_PATH,
  };
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openvids-toolstatus-"));
    runProcess.mockReset();
    runProcess.mockResolvedValue({ stdout: "ffmpeg version 9.0.2 Copyright", stderr: "" });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    for (const [key, value] of [
      ["HYPERFRAMES_FFMPEG_PATH", saved.ffmpeg],
      ["HYPERFRAMES_FFPROBE_PATH", saved.ffprobe],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // The path only needs to EXIST (findFfBinary checks existsSync); the version
  // comes from the stubbed runner, never from executing the file.
  function tool(name: string): string {
    const path = join(dir, name);
    writeFileSync(path, "stub");
    return path;
  }

  it("reports found tools with path and version, and the ready Chrome", async () => {
    const ffmpeg = tool("ffmpeg");
    process.env.HYPERFRAMES_FFMPEG_PATH = ffmpeg;
    process.env.HYPERFRAMES_FFPROBE_PATH = tool("ffprobe");
    vi.spyOn(manager, "findReadyManagedBrowser").mockResolvedValue({
      executablePath: "/cache/chrome-headless-shell",
      source: "cache",
    });
    vi.spyOn(manager, "findSystemBrowser").mockReturnValue(undefined);
    const report = await collectToolStatus();
    expect(report.ffmpeg).toEqual({ found: true, path: ffmpeg, version: "9.0.2" });
    expect(report.ffprobe.version).toBe("9.0.2");
    expect(report.chrome).toEqual({
      found: true,
      path: "/cache/chrome-headless-shell",
      source: "cache",
      version: manager.managedChromeVersion(),
    });
  });

  it("reports missing tools as not found, and names a system Chrome that rendering does not use", async () => {
    process.env.HYPERFRAMES_FFMPEG_PATH = join(dir, "missing-ffmpeg");
    process.env.HYPERFRAMES_FFPROBE_PATH = join(dir, "missing-ffprobe");
    vi.spyOn(manager, "findReadyManagedBrowser").mockResolvedValue(undefined);
    vi.spyOn(manager, "findSystemBrowser").mockReturnValue({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      source: "system",
    });
    const report = await collectToolStatus();
    expect(report.ffmpeg).toEqual({ found: false });
    expect(report.ffprobe).toEqual({ found: false });
    expect(report.chrome).toEqual({
      found: false,
      systemPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
  });

  it("does not call a file that fails to run found", async () => {
    const path = tool("ffmpeg");
    runProcess.mockRejectedValue(new Error("exit 3"));
    process.env.HYPERFRAMES_FFMPEG_PATH = path;
    process.env.HYPERFRAMES_FFPROBE_PATH = join(dir, "missing");
    vi.spyOn(manager, "findReadyManagedBrowser").mockResolvedValue(undefined);
    vi.spyOn(manager, "findSystemBrowser").mockReturnValue(undefined);
    expect((await collectToolStatus()).ffmpeg).toEqual({ found: false, path });
  });
});
