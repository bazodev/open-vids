import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const paths = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => paths.home,
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, existsSync: vi.fn(original.existsSync) };
});
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("./python.js", () => ({
  findPython: () => "test-python",
  hasPythonPackage: () => true,
}));
vi.mock("./manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manager.js")>()),
  ensureModel: vi.fn().mockResolvedValue("model.onnx"),
  ensureVoices: vi.fn().mockResolvedValue("voices.bin"),
}));

describe("synthesis script cache", () => {
  let cacheDir: string;
  let scriptPath: string;
  let outputPath: string;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    paths.home = fs.mkdtempSync(join(tmpdir(), "hf-tts-cache-"));
    cacheDir = join(paths.home, ".cache", "hyperframes", "tts");
    scriptPath = join(cacheDir, "synth-v3.py");
    outputPath = join(paths.home, "speech.wav");
    fs.mkdirSync(cacheDir, { recursive: true });
    vi.mocked(execFileSync).mockImplementation(() => {
      fs.writeFileSync(outputPath, "stub audio");
      return JSON.stringify({
        outputPath,
        sampleRate: 24000,
        durationSeconds: 1,
        langApplied: true,
      });
    });
  });

  afterEach(() => {
    expect(fs.readdirSync(cacheDir).filter((name) => name.startsWith(".hf-create-"))).toEqual([]);
    fs.rmSync(paths.home, { recursive: true, force: true });
  });

  it("creates the script, removes only old script versions, and reuses the current cache", async () => {
    fs.writeFileSync(join(cacheDir, "synth-v2.py"), "old script");
    fs.writeFileSync(join(cacheDir, "notes.txt"), "keep");
    const { synthesize } = await import("./synthesize.js");
    await synthesize("Hello", outputPath);
    const script = fs.readFileSync(scriptPath, "utf-8");
    expect(script).toContain("import kokoro_onnx");
    expect(script).toContain('"durationSeconds": round(duration, 3)');
    expect(fs.existsSync(join(cacheDir, "synth-v2.py"))).toBe(false);
    expect(fs.readFileSync(join(cacheDir, "notes.txt"), "utf-8")).toBe("keep");
    fs.writeFileSync(scriptPath, "existing current script");
    await synthesize("Again", outputPath);
    expect(fs.readFileSync(scriptPath, "utf-8")).toBe("existing current script");
  });

  it("preserves a concurrent file at publication", async () => {
    const original = await vi.importActual<typeof fs>("node:fs");
    let injected = false;
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (path === scriptPath && !injected) {
        injected = true;
        fs.writeFileSync(scriptPath, "concurrent script");
        return false;
      }
      return original.existsSync(path);
    });
    try {
      const { synthesize } = await import("./synthesize.js");
      await synthesize("Hello", outputPath);
      expect(injected).toBe(true);
      expect(fs.readFileSync(scriptPath, "utf-8")).toBe("concurrent script");
      expect(execFileSync).toHaveBeenCalledWith(
        "test-python",
        expect.arrayContaining([scriptPath, "model.onnx", "voices.bin", "Hello", outputPath]),
        expect.objectContaining({ timeout: 300_000 }),
      );
    } finally {
      vi.mocked(fs.existsSync).mockImplementation(original.existsSync);
    }
  });

  // The dangling-symlink race fixture needs elevation / Developer Mode on
  // Windows (EPERM without it) — skip there; POSIX still guards this path.
  it.skipIf(process.platform === "win32")(
    "preserves a dangling symlink at publication",
    async () => {
      const target = join(paths.home, "missing.py");
      const original = await vi.importActual<typeof fs>("node:fs");
      let injected = false;
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === scriptPath && !injected) {
          injected = true;
          fs.symlinkSync(target, scriptPath);
          return false;
        }
        return original.existsSync(path);
      });
      try {
        const { synthesize } = await import("./synthesize.js");
        await synthesize("Hello", outputPath);
        expect(injected).toBe(true);
        expect(fs.lstatSync(scriptPath).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(target)).toBe(false);
        expect(execFileSync).toHaveBeenCalledWith(
          "test-python",
          expect.arrayContaining([scriptPath, "model.onnx", "voices.bin", "Hello", outputPath]),
          expect.objectContaining({ timeout: 300_000 }),
        );
      } finally {
        vi.mocked(fs.existsSync).mockImplementation(original.existsSync);
      }
    },
  );
});
