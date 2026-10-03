import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLayoutViaCli } from "./layoutAdapter.js";

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** Never exits on its own; only a signal ends it. */
  hang?: boolean;
}

const PID = 5151;

/** A spawn that plays `script` instead of running the CLI; records every call. */
function fakeSpawn(script: Script) {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const children: EventEmitter[] = [];
  const spawn = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
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
      if (script.stderr) child.stderr.write(script.stderr);
      if (script.stdout) child.stdout.write(script.stdout);
      if (!script.hang) setImmediate(() => child.emit("close", script.code ?? 0));
    });
    return child;
  });
  return { spawn, calls, children };
}

function deps(fake: ReturnType<typeof fakeSpawn>) {
  return {
    spawn: fake.spawn as never,
    invocation: () => ({ command: "/usr/bin/runtime", prefix: ["--flag", "/cli/cli.js"] }),
  };
}

const LAYOUT_ISSUE = {
  code: "content_overlap",
  severity: "error",
  time: 1.5,
  firstSeen: 1,
  lastSeen: 2,
  selector: "#caption-word-0-1",
  containerSelector: "#title",
  text: "everyone",
  message: "Two text blocks overlap and may render unreadable.",
  fixHint: "Give each block its own zone.",
  sourceFile: "compositions/captions.html",
  dataAttributes: { "data-hf-id": "hf-cap", "data-x": 3 },
  bbox: { x: 0, y: 0, width: 1, height: 1 },
};

function report(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      ok: false,
      lint: { errorCount: 0, findings: [] },
      runtime: { findings: [] },
      layout: { samples: [1.5, 3], findings: [LAYOUT_ISSUE] },
      _meta: { version: "0.0.0" },
      ...overrides,
    },
    null,
    2,
  );
}

describe("checkLayoutViaCli", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs `check` on the project with the sample times and returns the layout findings", async () => {
    const fake = fakeSpawn({ stdout: `${report()}\n`, code: 1 });
    const result = await checkLayoutViaCli(
      {
        project: { dir: "/projects/demo" },
        times: [3, 1.5, 1.5004],
        signal: new AbortController().signal,
      },
      deps(fake),
    );
    const { command, args, options } = fake.calls[0]!;
    expect(command).toBe("/usr/bin/runtime");
    expect(args).toEqual([
      "--flag",
      "/cli/cli.js",
      "check",
      "/projects/demo",
      "--json",
      "--no-contrast",
      "--at",
      "1.5,3",
      "--frame-check",
    ]);
    // Its own process group, so Abort reaches headless Chrome too.
    expect(options.detached).toBe(process.platform !== "win32");
    // A non-zero exit (the audit found errors) is a result, not a failure.
    expect(result).toEqual({
      samples: [1.5, 3],
      findings: [
        {
          code: "content_overlap",
          severity: "error",
          time: 1.5,
          firstSeen: 1,
          lastSeen: 2,
          selector: "#caption-word-0-1",
          containerSelector: "#title",
          text: "everyone",
          message: "Two text blocks overlap and may render unreadable.",
          fixHint: "Give each block its own zone.",
          sourceFile: "compositions/captions.html",
          // Only string attributes survive.
          dataAttributes: { "data-hf-id": "hf-cap" },
        },
      ],
    });
  });

  it("finds the report after stray log lines and drops malformed findings", async () => {
    const fake = fakeSpawn({
      stdout: `warming up the browser\n${report({
        layout: {
          samples: [1],
          findings: [LAYOUT_ISSUE, { code: "x" }, { ...LAYOUT_ISSUE, severity: "fatal" }],
        },
      })}\n`,
    });
    const result = await checkLayoutViaCli(
      { project: { dir: "/p" }, times: [1], signal: new AbortController().signal },
      deps(fake),
    );
    expect(result).toMatchObject({ samples: [1], findings: [{ code: "content_overlap" }] });
    if ("findings" in result) expect(result.findings).toHaveLength(1);
  });

  it("is unavailable when lint errors kept the audit from running, and fails on a crashed browser", async () => {
    const lint = fakeSpawn({
      stdout: report({
        lint: { errorCount: 2, findings: [] },
        layout: { samples: [], findings: [] },
      }),
    });
    expect(
      await checkLayoutViaCli(
        { project: { dir: "/p" }, times: [1], signal: new AbortController().signal },
        deps(lint),
      ),
    ).toEqual({
      unavailable: "The composition has 2 lint errors, so the layout audit did not run",
    });

    const crashed = fakeSpawn({
      stdout: report({
        layout: { samples: [], findings: [] },
        runtime: { findings: [{ severity: "error", message: "Chrome could not be launched" }] },
      }),
    });
    await expect(
      checkLayoutViaCli(
        { project: { dir: "/p" }, times: [1], signal: new AbortController().signal },
        deps(crashed),
      ),
    ).rejects.toThrow("Layout check failed: Chrome could not be launched");

    const refused = fakeSpawn({
      stdout: JSON.stringify({ ok: false, error: "No index.html file found." }),
    });
    await expect(
      checkLayoutViaCli(
        { project: { dir: "/p" }, times: [1], signal: new AbortController().signal },
        deps(refused),
      ),
    ).rejects.toThrow("Layout check failed: No index.html file found.");
  });

  it("rejects with the exit code and last stderr line when the CLI died without a report", async () => {
    const fake = fakeSpawn({ code: 3, stderr: "boom: out of memory\n" });
    await expect(
      checkLayoutViaCli(
        { project: { dir: "/p" }, times: [1], signal: new AbortController().signal },
        deps(fake),
      ),
    ).rejects.toThrow(/check exited with code 3: boom: out of memory/);
  });

  it("does not spawn when already aborted, and kills the child's whole group on abort", async () => {
    const done = new AbortController();
    done.abort();
    const idle = fakeSpawn({});
    await expect(
      checkLayoutViaCli({ project: { dir: "/p" }, times: [1], signal: done.signal }, deps(idle)),
    ).rejects.toThrow();
    expect(idle.spawn).not.toHaveBeenCalled();

    const fake = fakeSpawn({ hang: true });
    const signals: Array<[number, unknown]> = [];
    vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      signals.push([pid, sig]);
      // Chrome and the CLI die with the group, so the child closes.
      if (sig === "SIGTERM") setImmediate(() => fake.children[0]!.emit("close", null));
      return true;
    });
    const abort = new AbortController();
    const pending = checkLayoutViaCli(
      { project: { dir: "/p" }, times: [1], signal: abort.signal },
      deps(fake),
    );
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
    abort.abort(new Error("client went away"));
    await expect(pending).rejects.toThrow("client went away");
    if (process.platform !== "win32") {
      expect(signals[0]).toEqual([-PID, "SIGTERM"]);
      expect(signals.every(([pid]) => pid === -PID)).toBe(true);
    }
  });
});
