import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type FfBinariesModule = typeof import("./ffBinaries.js");

// The module caches system lookups in module state, so each test that
// exercises lookup mechanics resets modules and dynamic-imports a fresh copy.
async function importFresh(): Promise<FfBinariesModule> {
  return import("./ffBinaries.js");
}

describe("findFfBinary", () => {
  const originalFfmpegPath = process.env.HYPERFRAMES_FFMPEG_PATH;
  const originalPath = process.env.PATH;
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs");
    if (originalFfmpegPath === undefined) delete process.env.HYPERFRAMES_FFMPEG_PATH;
    else process.env.HYPERFRAMES_FFMPEG_PATH = originalFfmpegPath;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("returns the resolved env override without touching the system", async () => {
    process.env.HYPERFRAMES_FFMPEG_PATH = "/tools/ffmpeg";
    vi.resetModules();
    const { findFfBinary } = await importFresh();

    expect(findFfBinary("ffmpeg")).toBe(resolve("/tools/ffmpeg"));
  });

  it("treats a missing env override as not-found when configuredMustExist is set", async () => {
    process.env.HYPERFRAMES_FFMPEG_PATH = join(tmpdir(), "definitely-missing-ffmpeg");
    vi.resetModules();
    const { findFfBinary } = await importFresh();

    expect(findFfBinary("ffmpeg", { configuredMustExist: true })).toBeUndefined();
    expect(findFfBinary("ffmpeg")).toBe(resolve(join(tmpdir(), "definitely-missing-ffmpeg")));
  });

  it("prefers the real Windows exe over a cmd shim in PATH", async () => {
    delete process.env.HYPERFRAMES_FFMPEG_PATH;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.PATH = "/tools";
    vi.resetModules();
    vi.doMock("node:fs", () => {
      const mocked = {
        // `join` emits `\` separators on Windows, so compare separator-blind.
        existsSync: (candidate: unknown) =>
          typeof candidate === "string" && candidate.replace(/\\/g, "/") === "/tools/ffmpeg.exe",
        accessSync: () => {},
        constants: { X_OK: 1 },
      };
      return { ...mocked, default: mocked };
    });
    const { findFfBinary } = await importFresh();

    // `findFfBinary` returns the resolved absolute path (`resolve` is a no-op
    // for it on POSIX; on Windows it prepends the drive letter).
    expect(findFfBinary("ffmpeg")).toBe(resolve(join("/tools", "ffmpeg.exe")));
  });

  it("discovers a Windows binary in a Unicode current directory without decoding console output", async () => {
    delete process.env.HYPERFRAMES_FFMPEG_PATH;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.PATH = "";
    const unicodeDirectory = "/用户/工具";
    const ffmpegPath = join(unicodeDirectory, "ffmpeg.exe");
    vi.spyOn(process, "cwd").mockReturnValue(unicodeDirectory);
    const execFileSync = vi.fn();
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync,
      default: { execFileSync },
    }));
    vi.doMock("node:fs", () => {
      const mocked = {
        existsSync: (candidate: unknown) => candidate === ffmpegPath,
        accessSync: () => {},
        constants: { X_OK: 1 },
      };
      return { ...mocked, default: mocked };
    });
    const { findFfBinary } = await importFresh();

    expect(findFfBinary("ffmpeg")).toBe(ffmpegPath);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("falls back to scanning PATH when which/where fails", async () => {
    delete process.env.HYPERFRAMES_FFMPEG_PATH;
    const binDir = mkdtempSync(join(tmpdir(), "hyperframes-ffbinaries-"));
    const ffmpegPath = join(binDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    writeFileSync(ffmpegPath, "#!/bin/sh\n");
    chmodSync(ffmpegPath, 0o755);
    process.env.PATH = binDir;
    const execFileSync = vi.fn(() => {
      throw new Error("lookup command failed");
    });
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFileSync, default: { execFileSync } }));

    try {
      const { findFfBinary } = await importFresh();

      expect(findFfBinary("ffmpeg")).toBe(resolve(ffmpegPath));
      // On Windows resolution enumerates PATH from Node directly and never
      // spawns a lookup command; on POSIX the `which` attempt runs first.
      if (process.platform === "win32") expect(execFileSync).not.toHaveBeenCalled();
      else expect(execFileSync).toHaveBeenCalledOnce();
    } finally {
      rmSync(binDir, { force: true, recursive: true });
    }
  });

  it("falls back to a common install dir when which and the PATH scan both fail", async () => {
    delete process.env.HYPERFRAMES_FFMPEG_PATH;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.PATH = "";
    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const mocked = {
        execFileSync: () => {
          throw new Error("which: no ffmpeg in PATH");
        },
      };
      return { ...mocked, default: mocked };
    });
    vi.doMock("node:fs", () => {
      const mocked = {
        existsSync: (candidate: unknown) => candidate === "/opt/homebrew/bin/ffmpeg",
        accessSync: () => {
          throw new Error("not executable");
        },
        constants: { X_OK: 1 },
      };
      return { ...mocked, default: mocked };
    });
    const { findFfBinary } = await importFresh();

    expect(findFfBinary("ffmpeg")).toBe(resolve("/opt/homebrew/bin/ffmpeg"));
  });

  it("falls back to the project-local .hyperframes bin", async () => {
    delete process.env.HYPERFRAMES_FFMPEG_PATH;
    process.env.PATH = "";
    const projectBinary = resolve(
      ".hyperframes",
      "bin",
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const mocked = {
        execFileSync: () => {
          throw new Error("not found");
        },
      };
      return { ...mocked, default: mocked };
    });
    vi.doMock("node:fs", () => {
      const mocked = {
        existsSync: (candidate: unknown) => candidate === projectBinary,
        accessSync: () => {
          throw new Error("not executable");
        },
        constants: { X_OK: 1 },
      };
      return { ...mocked, default: mocked };
    });
    const { findFfBinary } = await importFresh();

    expect(findFfBinary("ffmpeg")).toBe(projectBinary);
  });

  it("returns undefined when the binary is nowhere, remembers the miss only briefly, and finds it once it appears", async () => {
    delete process.env.HYPERFRAMES_FFMPEG_PATH;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.PATH = "";
    let installed = false;
    const execFileSync = vi.fn(() => {
      throw new Error("not found");
    });
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFileSync, default: { execFileSync } }));
    vi.doMock("node:fs", () => {
      const mocked = {
        existsSync: (candidate: unknown) => installed && candidate === "/opt/homebrew/bin/ffmpeg",
        accessSync: () => {
          throw new Error("not executable");
        },
        constants: { X_OK: 1 },
      };
      return { ...mocked, default: mocked };
    });
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { findFfBinary, clearFfBinaryLookupCache } = await importFresh();

    expect(findFfBinary("ffmpeg")).toBeUndefined();
    // Within the window the miss is answered without another lookup.
    now += 500;
    expect(findFfBinary("ffmpeg")).toBeUndefined();
    expect(execFileSync).toHaveBeenCalledOnce();

    // The binary is installed while this process keeps running: found without a restart.
    installed = true;
    now += 2_000;
    expect(findFfBinary("ffmpeg")).toBe(resolve("/opt/homebrew/bin/ffmpeg"));
    expect(execFileSync).toHaveBeenCalledTimes(2);

    // A hit is cached for good: no further lookups, even if the file vanishes.
    installed = false;
    now += 60_000;
    expect(findFfBinary("ffmpeg")).toBe(resolve("/opt/homebrew/bin/ffmpeg"));
    expect(execFileSync).toHaveBeenCalledTimes(2);

    clearFfBinaryLookupCache();
    expect(findFfBinary("ffmpeg")).toBeUndefined();
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });
});
