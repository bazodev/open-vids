import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import init from "./init.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, existsSync: vi.fn(original.existsSync) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("init config creation", () => {
  it.each(
    ["package.json", "hyperframes.json"].flatMap((filename) =>
      ["existing", "concurrent"].map((kind) => ({ filename, kind })),
    ),
  )("preserves $kind $filename while completing initialization", async ({ filename, kind }) => {
    const dir = fs.mkdtempSync(join(tmpdir(), "hf-init-package-"));
    const project = join(dir, "project");
    const packagePath = join(project, filename);
    const original = await vi.importActual<typeof fs>("node:fs");
    let injected = false;
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (path === packagePath && !injected) {
        injected = true;
        fs.writeFileSync(packagePath, '{"name":"preserve-me"}\n');
        return kind === "existing";
      }
      return original.existsSync(path);
    });
    vi.stubEnv("HYPERFRAMES_SKIP_SKILLS", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runCommand(init, {
        rawArgs: [project, "--example", "blank", "--non-interactive"],
      });
      expect(injected).toBe(true);
      expect(fs.readFileSync(packagePath, "utf-8")).toBe('{"name":"preserve-me"}\n');
      expect(fs.existsSync(join(project, "index.html"))).toBe(true);
      expect(log.mock.calls.flat().join("\n")).toContain("npm run dev");
      expect(fs.readdirSync(project).filter((name) => name.startsWith(".hf-create-"))).toEqual([]);
    } finally {
      vi.mocked(fs.existsSync).mockImplementation(original.existsSync);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The dangling-symlink race fixture needs elevation / Developer Mode on
  // Windows (EPERM without it) — skip there; POSIX still guards this path.
  it
    .skipIf(process.platform === "win32")
    .each(["package.json", "hyperframes.json"].map((filename) => ({ filename })))(
    "preserves dangling symlink $filename while completing initialization",
    async ({ filename }) => {
      const dir = fs.mkdtempSync(join(tmpdir(), "hf-init-package-"));
      const project = join(dir, "project");
      const packagePath = join(project, filename);
      const target = join(dir, "missing-target.json");
      const original = await vi.importActual<typeof fs>("node:fs");
      let injected = false;
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === packagePath && !injected) {
          injected = true;
          fs.symlinkSync(target, packagePath);
          return false;
        }
        return original.existsSync(path);
      });
      vi.stubEnv("HYPERFRAMES_SKIP_SKILLS", "1");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await runCommand(init, {
          rawArgs: [project, "--example", "blank", "--non-interactive"],
        });
        expect(injected).toBe(true);
        expect(fs.lstatSync(packagePath).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(target)).toBe(false);
        expect(fs.existsSync(join(project, "index.html"))).toBe(true);
        expect(log.mock.calls.flat().join("\n")).toContain("npm run dev");
        expect(fs.readdirSync(project).filter((name) => name.startsWith(".hf-create-"))).toEqual(
          [],
        );
      } finally {
        vi.mocked(fs.existsSync).mockImplementation(original.existsSync);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
