import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diarizeMediaViaCli,
  transcribeMediaViaCli,
  type SpeechAdapterDeps,
} from "./speechAdapter.js";

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** Runs when the child "starts": may write files the real CLI would write. */
  before?: (args: string[]) => void;
  /** Never exits on its own; only a signal ends it. */
  hang?: boolean;
}

const PID = 4242;

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
      script.before?.(args);
      if (script.stderr) child.stderr.write(script.stderr);
      if (script.stdout) child.stdout.write(script.stdout);
      if (!script.hang) setImmediate(() => child.emit("close", script.code ?? 0));
    });
    return child;
  });
  return { spawn, calls, children };
}

const invocation = () => ({ command: "/usr/bin/runtime", prefix: ["--flag", "/cli/cli.js"] });

function deps(fake: ReturnType<typeof fakeSpawn>, dirs: string[] = []): SpeechAdapterDeps {
  return {
    spawn: fake.spawn as never,
    invocation,
    makeTempDir: () => {
      const dir = mkdtempSync(join(tmpdir(), "openvids-asr-test-"));
      dirs.push(dir);
      return dir;
    },
  };
}

function dirOf(args: string[]): string {
  return args[args.indexOf("--dir") + 1]!;
}

describe("transcribeMediaViaCli", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs `transcribe` with the multilingual model and reads the normalized words back", async () => {
    const fake = fakeSpawn({
      before: (args) => {
        writeFileSync(
          join(dirOf(args), "transcript.json"),
          JSON.stringify([
            { id: "w0", text: " Привет", start: 0.5, end: 0.9 },
            { id: "w1", text: "мир", start: 0.9, end: 1.2 },
            // Broken rows a recognizer can emit: dropped instead of poisoning the transcript.
            { id: "w2", text: "  ", start: 1.2, end: 1.3 },
            { id: "w3", text: "bad", start: 2, end: 1 },
            { id: "w4", text: "nan", start: Number.NaN, end: 3 },
          ]),
        );
      },
      stdout: `${JSON.stringify({ ok: true, engine: "whisper", model: "small", language: "ru" })}\n`,
    });
    const dirs: string[] = [];
    try {
      const result = await transcribeMediaViaCli(
        { inputPath: "/media/a.mp4", signal: new AbortController().signal },
        deps(fake, dirs),
      );
      expect(result).toEqual({
        words: [
          { text: "Привет", start: 0.5, end: 0.9 },
          { text: "мир", start: 0.9, end: 1.2 },
        ],
        language: "ru",
        producer: "whisper.cpp small",
      });
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }

    const { command, args, options } = fake.calls[0]!;
    expect(command).toBe("/usr/bin/runtime");
    expect(args.slice(0, 4)).toEqual(["--flag", "/cli/cli.js", "transcribe", "/media/a.mp4"]);
    expect(args).toContain("--json");
    expect(args[args.indexOf("--model") + 1]).toBe("small");
    // No hint: whisper detects the language, so no --language may be sent.
    expect(args).not.toContain("--language");
    expect(options.detached).toBe(process.platform !== "win32");
    // The temp dir is gone whatever happened.
    expect(existsSync(dirs[0]!)).toBe(false);
  });

  it("passes a language hint through and names a Parakeet run by its model", async () => {
    const fake = fakeSpawn({
      before: (args) => {
        writeFileSync(join(dirOf(args), "transcript.json"), JSON.stringify([]));
      },
      stdout: `${JSON.stringify({ ok: true, engine: "parakeet", model: "parakeet-tdt-0.6b-v3", language: null })}\n`,
    });
    const result = await transcribeMediaViaCli(
      { inputPath: "/media/a.wav", language: "ru", signal: new AbortController().signal },
      deps(fake),
    );
    const args = fake.calls[0]!.args;
    expect(args[args.indexOf("--language") + 1]).toBe("ru");
    expect(result).toEqual({ words: [], language: null, producer: "parakeet-tdt-0.6b-v3" });
  });

  it("resolves { unavailable } with the CLI's reason when no recognizer can run", async () => {
    const fake = fakeSpawn({
      code: 1,
      stdout: `${JSON.stringify({ ok: false, skipped: true, reason: "whisper_unavailable", error: "whisper-cpp not found. Install: brew install whisper-cpp" })}\n`,
    });
    await expect(
      transcribeMediaViaCli(
        { inputPath: "/a.wav", signal: new AbortController().signal },
        deps(fake),
      ),
    ).resolves.toEqual({ unavailable: "whisper-cpp not found. Install: brew install whisper-cpp" });
  });

  it("still names the reason when the CLI printed only the code", async () => {
    const fake = fakeSpawn({
      code: 1,
      stdout: `${JSON.stringify({ ok: false, skipped: true, reason: "whisper_unavailable" })}\n`,
    });
    const result = await transcribeMediaViaCli(
      { inputPath: "/a.wav", signal: new AbortController().signal },
      deps(fake),
    );
    expect(result).toMatchObject({ unavailable: expect.stringContaining("whisper_unavailable") });
  });

  it("rejects with the CLI's error when recognition failed", async () => {
    const fake = fakeSpawn({
      code: 1,
      stdout: `${JSON.stringify({ ok: false, error: "Whisper did not produce output." })}\n`,
    });
    await expect(
      transcribeMediaViaCli(
        { inputPath: "/a.wav", signal: new AbortController().signal },
        deps(fake),
      ),
    ).rejects.toThrow("Transcription failed: Whisper did not produce output.");
  });

  it("rejects with the exit code and last stderr line when the CLI died without a result", async () => {
    const fake = fakeSpawn({ code: 3, stderr: "warming up\nboom: out of memory\n" });
    await expect(
      transcribeMediaViaCli(
        { inputPath: "/a.wav", signal: new AbortController().signal },
        deps(fake),
      ),
    ).rejects.toThrow(/exited with code 3: boom: out of memory/);
  });

  it("does not spawn when already aborted, and kills the child's whole group on abort", async () => {
    const done = new AbortController();
    done.abort();
    const idle = fakeSpawn({});
    await expect(
      transcribeMediaViaCli({ inputPath: "/a.wav", signal: done.signal }, deps(idle)),
    ).rejects.toThrow();
    expect(idle.spawn).not.toHaveBeenCalled();

    const fake = fakeSpawn({ hang: true });
    const signals: Array<[number, unknown]> = [];
    vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      signals.push([pid, sig]);
      // Whatever the CLI was running dies with the group, so the child closes.
      if (sig === "SIGTERM") setImmediate(() => fake.children[0]!.emit("close", null));
      return true;
    });
    const abort = new AbortController();
    const pending = transcribeMediaViaCli(
      { inputPath: "/a.wav", signal: abort.signal },
      deps(fake),
    );
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
    abort.abort(new Error("cancelled by user"));
    await expect(pending).rejects.toThrow("cancelled by user");

    if (process.platform !== "win32") {
      // A negative pid is the process group: the CLI, whisper-cli and the sherpa worker together.
      expect(signals[0]).toEqual([-PID, "SIGTERM"]);
      expect(signals.every(([pid]) => pid === -PID)).toBe(true);
    }
  });

  it("forwards the CLI's stderr lines as progress", async () => {
    const fake = fakeSpawn({
      code: 1,
      stderr: "Parakeet failed: x. Using whisper for this run.\n",
      stdout: `${JSON.stringify({ ok: false, error: "nope" })}\n`,
    });
    const lines: string[] = [];
    await transcribeMediaViaCli(
      {
        inputPath: "/a.wav",
        signal: new AbortController().signal,
        onProgress: (m) => lines.push(m),
      },
      deps(fake),
    ).catch(() => {});
    expect(lines).toContain("Parakeet failed: x. Using whisper for this run.");
  });
});

describe("diarizeMediaViaCli", () => {
  afterEach(() => vi.restoreAllMocks());

  const turns = [
    { speaker: 0, start: 0.8, end: 8.1 },
    { speaker: 1, start: 9, end: 14.8 },
  ];

  it("runs `diarize --json` and returns the turns", async () => {
    const fake = fakeSpawn({
      stdout: `${JSON.stringify({ ok: true, turns, speakerCount: 2, producer: "sherpa-onnx test" })}\n`,
    });
    const result = await diarizeMediaViaCli(
      { inputPath: "/media/a.mp4", signal: new AbortController().signal },
      deps(fake),
    );
    expect(result).toEqual({ turns, producer: "sherpa-onnx test" });
    expect(fake.calls[0]!.args).toEqual([
      "--flag",
      "/cli/cli.js",
      "diarize",
      "/media/a.mp4",
      "--json",
    ]);
  });

  it("resolves { unavailable } when the platform is unsupported or offline", async () => {
    const fake = fakeSpawn({
      code: 1,
      stdout: `${JSON.stringify({ ok: false, skipped: true, reason: "diarization_unavailable", error: "no network" })}\n`,
    });
    await expect(
      diarizeMediaViaCli({ inputPath: "/a.wav", signal: new AbortController().signal }, deps(fake)),
    ).resolves.toEqual({ unavailable: "no network" });
  });

  it("rejects a turn that ends before it starts instead of passing it on", async () => {
    const fake = fakeSpawn({
      stdout: `${JSON.stringify({ ok: true, turns: [{ speaker: 0, start: 5, end: 4 }], producer: "p" })}\n`,
    });
    await expect(
      diarizeMediaViaCli({ inputPath: "/a.wav", signal: new AbortController().signal }, deps(fake)),
    ).rejects.toThrow(/bad turn/);
  });

  it("rejects with the CLI's error on failure", async () => {
    const fake = fakeSpawn({
      code: 1,
      stdout: `${JSON.stringify({ ok: false, error: "Speaker diarizer crashed (SIGABRT)" })}\n`,
    });
    await expect(
      diarizeMediaViaCli({ inputPath: "/a.wav", signal: new AbortController().signal }, deps(fake)),
    ).rejects.toThrow("Speaker diarization failed: Speaker diarizer crashed (SIGABRT)");
  });
});
