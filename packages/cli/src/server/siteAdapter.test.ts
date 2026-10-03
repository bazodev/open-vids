import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { inspectWebsiteViaCli, recordWebsiteViaCli } from "./siteAdapter.js";

const PID = 7272;

const SITE = {
  url: "https://example.com/",
  finalUrl: "https://example.com/",
  host: "example.com",
  title: "Example",
  capturedAt: 1,
};

interface Script {
  /** Files the CLI writes into its `--out` directory. */
  files?: Record<string, string>;
  /** Content the CLI writes to its `--out` path itself (`record-site`). */
  outFileContent?: string;
  report?: Record<string, unknown>;
  stderr?: string;
  code?: number;
  hang?: boolean;
}

interface FakeSpawn {
  spawn: Mock<(command: string, args: string[]) => EventEmitter>;
  calls: Array<{ args: string[] }>;
  children: EventEmitter[];
  outDir(): string;
}

/** A spawn that plays `script` instead of running the CLI, writing files where `--out` points. */
function fakeSpawn(script: Script): FakeSpawn {
  const calls: Array<{ args: string[] }> = [];
  const children: EventEmitter[] = [];
  let outDir = "";
  const spawn = vi.fn((_command: string, args: string[]) => {
    calls.push({ args });
    outDir = args[args.indexOf("--out") + 1] ?? "";
    const child = Object.assign(new EventEmitter(), {
      pid: PID,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      // cliChild kills via child.kill() on Windows; mirror runCli's contract so
      // abort closes the fake child on every platform, not only via process.kill.
      kill: vi.fn(() => {
        setImmediate(() => child.emit("close", null));
        return true;
      }),
    });
    children.push(child);
    setImmediate(() => {
      for (const [name, content] of Object.entries(script.files ?? {})) {
        mkdirSync(dirname(join(outDir, name)), { recursive: true });
        writeFileSync(join(outDir, name), content);
      }
      if (script.outFileContent !== undefined) {
        mkdirSync(dirname(outDir), { recursive: true });
        writeFileSync(outDir, script.outFileContent);
      }
      if (script.stderr) child.stderr.write(script.stderr);
      if (script.report) child.stdout.write(`${JSON.stringify(script.report)}\n`);
      if (!script.hang) setImmediate(() => child.emit("close", script.code ?? 0));
    });
    return child;
  });
  return { spawn, calls, children, outDir: () => outDir };
}

const deps = (fake: FakeSpawn) => ({
  spawn: fake.spawn as never,
  invocation: () => ({ command: "/usr/bin/runtime", prefix: ["/cli/cli.js"] }),
});

const input = (signal = new AbortController().signal) => ({ url: "https://example.com/", signal });

const okReport = {
  ok: true,
  site: SITE,
  screenshots: [
    { name: "viewport.jpg", file: "viewport.jpg", width: 1440, height: 900 },
    { name: "fullpage.jpg", file: "fullpage.jpg", width: 720, height: 3000 },
  ],
  logo: { file: "logo.svg", mimeType: "image/svg+xml", url: "https://example.com/" },
  fonts: [
    {
      file: "fonts/Inter.woff2",
      family: "Inter",
      weight: 400,
      style: "normal",
      url: "https://example.com/Inter.woff2",
      mimeType: "font/woff2",
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe("inspectWebsiteViaCli", () => {
  it("runs `inspect-site` with a private out directory, returns the files' bytes and removes the directory", async () => {
    const fake = fakeSpawn({
      report: okReport,
      files: {
        "viewport.jpg": "top",
        "fullpage.jpg": "full",
        "logo.svg": "<svg/>",
        "fonts/Inter.woff2": "woff2",
      },
    });
    const result = await inspectWebsiteViaCli(input(), deps(fake));
    expect(fake.calls[0]?.args.slice(0, 3)).toEqual([
      "/cli/cli.js",
      "inspect-site",
      "https://example.com/",
    ]);
    expect(fake.calls[0]?.args).toContain("--json");
    if ("error" in result) throw new Error("expected an inspection");
    expect(result.site.host).toBe("example.com");
    expect(
      result.screenshots.map((shot) => [shot.name, shot.width, Buffer.from(shot.data).toString()]),
    ).toEqual([
      ["viewport.jpg", 1440, "top"],
      ["fullpage.jpg", 720, "full"],
    ]);
    expect(result.logo).toMatchObject({ name: "logo.svg", mimeType: "image/svg+xml" });
    expect(Buffer.from(result.logo?.data ?? []).toString()).toBe("<svg/>");
    expect(result.fonts).toEqual([
      expect.objectContaining({
        name: "Inter.woff2",
        family: "Inter",
        weight: 400,
        style: "normal",
      }),
    ]);
    expect(existsSync(fake.outDir())).toBe(false);
  });

  it("answers a refused or unreadable page as a typed error instead of throwing", async () => {
    for (const code of ["blocked_by_policy", "unavailable", "network", "unsupported"]) {
      const fake = fakeSpawn({ report: { ok: false, code, error: `because ${code}` }, code: 1 });
      expect(await inspectWebsiteViaCli(input(), deps(fake))).toEqual({
        error: { code, message: `because ${code}` },
      });
    }
  });

  it("throws when the CLI died without a report or reported something unusable", async () => {
    await expect(
      inspectWebsiteViaCli(input(), deps(fakeSpawn({ code: 3, stderr: "out of memory\n" }))),
    ).rejects.toThrow(/inspect-site exited with code 3: out of memory/);
    await expect(
      inspectWebsiteViaCli(
        input(),
        deps(fakeSpawn({ report: { ok: false, code: "weird", error: "x" }, code: 1 })),
      ),
    ).rejects.toThrow();
    await expect(
      inspectWebsiteViaCli(
        input(),
        deps(fakeSpawn({ report: { ...okReport, site: { title: "no address" } } })),
      ),
    ).rejects.toThrow(/not usable/);
  });

  it("never reads a file outside its out directory", async () => {
    const fake = fakeSpawn({
      report: {
        ...okReport,
        screenshots: [{ name: "viewport.jpg", file: "../../etc/passwd", width: 1, height: 1 }],
      },
    });
    await expect(inspectWebsiteViaCli(input(), deps(fake))).rejects.toThrow(/escapes/);
    expect(existsSync(fake.outDir())).toBe(false);
  });

  it("kills the child's group on abort and still removes the out directory", async () => {
    const fake = fakeSpawn({ hang: true, files: { "viewport.jpg": "partial" } });
    const signals: Array<[number, unknown]> = [];
    vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      signals.push([pid, sig]);
      if (sig === "SIGTERM") setImmediate(() => fake.children[0]?.emit("close", null));
      return true;
    });
    const abort = new AbortController();
    const pending = inspectWebsiteViaCli(input(abort.signal), deps(fake));
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
    abort.abort(new Error("client went away"));
    await expect(pending).rejects.toThrow("client went away");
    if (process.platform !== "win32") expect(signals[0]).toEqual([-PID, "SIGTERM"]);
    expect(existsSync(fake.outDir())).toBe(false);
  });
});

const recordInput = (over: Partial<Parameters<typeof recordWebsiteViaCli>[0]> = {}) => ({
  url: "https://example.com/",
  seconds: 5,
  width: 1920,
  height: 1080,
  outFile: join(tmpdir(), `openvids-record-${randomUUID()}.mp4`),
  signal: new AbortController().signal,
  ...over,
});

describe("recordWebsiteViaCli", () => {
  it("runs `record-site` straight into the caller's file and returns the recording's facts", async () => {
    const outFile = join(tmpdir(), `openvids-record-${randomUUID()}.mp4`);
    const fake = fakeSpawn({
      outFileContent: "mp4-bytes",
      report: {
        ok: true,
        finalUrl: "https://example.com/after",
        width: 640,
        height: 480,
        duration: 5,
        bytes: 9,
        notes: ['The selector ".hero" matched nothing; the whole viewport was recorded.'],
      },
    });
    const result = await recordWebsiteViaCli(
      recordInput({ outFile, selector: ".hero", scroll: true }),
      deps(fake),
    );
    expect(fake.calls[0]?.args.slice(0, 3)).toEqual([
      "/cli/cli.js",
      "record-site",
      "https://example.com/",
    ]);
    expect(fake.calls[0]?.args).toEqual(
      expect.arrayContaining([
        "--json",
        "--scroll",
        "--selector",
        ".hero",
        "--seconds",
        "5",
        "--width",
        "1920",
        "--height",
        "1080",
        "--out",
        outFile,
      ]),
    );
    expect(result).toEqual({
      finalUrl: "https://example.com/after",
      width: 640,
      height: 480,
      duration: 5,
      notes: [expect.stringContaining("matched nothing")],
    });
    rmSync(outFile, { force: true });
  });

  it("answers a refused or unrecordable page as a typed error and leaves no file behind", async () => {
    for (const code of ["blocked_by_policy", "unavailable", "network", "unsupported"]) {
      const outFile = join(tmpdir(), `openvids-record-${randomUUID()}.mp4`);
      const fake = fakeSpawn({
        outFileContent: "partial",
        report: { ok: false, code, error: `because ${code}` },
        code: 1,
      });
      expect(await recordWebsiteViaCli(recordInput({ outFile }), deps(fake))).toEqual({
        error: { code, message: `because ${code}` },
      });
      expect(existsSync(outFile)).toBe(false);
    }
  });

  it("throws when the CLI died, reported something unusable, or wrote no file", async () => {
    const died = join(tmpdir(), `openvids-record-${randomUUID()}.mp4`);
    await expect(
      recordWebsiteViaCli(
        recordInput({ outFile: died }),
        deps(fakeSpawn({ code: 3, stderr: "no ffmpeg\n" })),
      ),
    ).rejects.toThrow(/record-site exited with code 3: no ffmpeg/);
    expect(existsSync(died)).toBe(false);

    const empty = join(tmpdir(), `openvids-record-${randomUUID()}.mp4`);
    await expect(
      recordWebsiteViaCli(
        recordInput({ outFile: empty }),
        deps(
          fakeSpawn({
            report: {
              ok: true,
              finalUrl: "https://example.com/",
              width: 1920,
              height: 1080,
              duration: 5,
              notes: [],
            },
          }),
        ),
      ),
    ).rejects.toThrow(/missing or empty/);
  });

  it("kills the child's group on abort and removes the partial file", async () => {
    const outFile = join(tmpdir(), `openvids-record-${randomUUID()}.mp4`);
    writeFileSync(outFile, "partial");
    const fake = fakeSpawn({ hang: true });
    const signals: Array<[number, unknown]> = [];
    vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      signals.push([pid, sig]);
      if (sig === "SIGTERM") setImmediate(() => fake.children[0]?.emit("close", null));
      return true;
    });
    const abort = new AbortController();
    const pending = recordWebsiteViaCli(recordInput({ outFile, signal: abort.signal }), deps(fake));
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
    abort.abort(new Error("client went away"));
    await expect(pending).rejects.toThrow("client went away");
    if (process.platform !== "win32") expect(signals[0]).toEqual([-PID, "SIGTERM"]);
    expect(existsSync(outFile)).toBe(false);
  });
});
