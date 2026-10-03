/**
 * Runs this CLI's own commands as child processes for the Studio server's adapter capabilities (speech recognition,
 * the layout check). Such work is heavy or synchronous, so it never runs inside the server process; a child also
 * keeps native addons and headless Chrome out of the server, and lets Abort stop the whole process tree.
 */

import {
  spawnSync as nodeSpawnSync,
  spawn as nodeSpawn,
  type ChildProcess,
} from "node:child_process";

const KILL_GRACE_MS = 3000;

export interface CliInvocation {
  command: string;
  /** Everything before the subcommand: runtime flags, then the CLI entry. */
  prefix: string[];
}

/**
 * This process, run again. The packaged sidecar starts `bun serve.mjs cli.js preview ...`, and serve.mjs spawns
 * `bun cli.js ...`, so execPath is the bundled runtime and argv[1] the CLI entry there too. In source mode the
 * loader flags (`--import tsx`) live in execArgv.
 */
export function selfInvocation(): CliInvocation {
  const entry = process.argv[1];
  if (!entry) throw new Error("cannot locate the CLI entry (process.argv[1] is empty)");
  const runtimeFlags = process.execArgv.filter((a) => !a.startsWith("--inspect"));
  return { command: process.execPath, prefix: [...runtimeFlags, entry] };
}

export interface CliChildDeps {
  spawn?: typeof nodeSpawn;
  invocation?: () => CliInvocation;
}

export interface RunOptions {
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface CliRun {
  code: number | null;
  /** The last stdout line that was a JSON object, if any. */
  json: Record<string, unknown> | null;
  /** Everything the command printed on stdout. */
  stdout: string;
  stderrTail: string;
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

const running = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Signals the child's whole process group (the CLI and whatever it started: whisper, sherpa, Chrome). */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  // A signal only reaches the direct child on Windows, so escalate to
  // `taskkill /T` and reap the CLI's descendants (recognizers, Chrome) too.
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      const result = nodeSpawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 10_000,
      });
      if (result.status === 0) return;
    } catch {
      // Fall through to the direct kill below.
    }
  }
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // already gone
  }
}

/** A dying server must not leave a recognizer or a browser running for minutes. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of running) killTree(child, "SIGKILL");
  });
}

function lastJsonObject(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return Object.fromEntries(Object.entries(parsed));
      }
    } catch {
      // not the result line
    }
  }
  return null;
}

export function runCli(
  args: string[],
  { signal, onProgress }: RunOptions,
  deps: CliChildDeps,
): Promise<CliRun> {
  signal.throwIfAborted();
  const { command, prefix } = (deps.invocation ?? selfInvocation)();
  const child = (deps.spawn ?? nodeSpawn)(command, [...prefix, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on POSIX so Abort reaches every process the CLI started.
    detached: process.platform !== "win32",
    env: process.env,
    // A GUI-launched server has no console; without this every CLI child
    // flashes one on Windows. No-op on POSIX.
    windowsHide: true,
  });
  installExitHook();
  running.add(child);

  return new Promise<CliRun>((resolve, reject) => {
    let stdout = "";
    let stderrTail = "";
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        stderrTail = `${stderrTail}\n${text}`.slice(-2000);
        onProgress?.(text);
      }
    });

    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const settle = () => {
      running.delete(child);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
    };
    child.on("error", (err) => {
      settle();
      reject(err);
    });
    child.on("close", (code) => {
      settle();
      if (signal.aborted) {
        // The CLI is gone; make sure nothing it started outlives it.
        killTree(child, "SIGKILL");
        reject(abortError(signal));
      } else {
        resolve({ code, json: lastJsonObject(stdout), stdout, stderrTail: stderrTail.trim() });
      }
    });
  });
}

export function failureMessage(what: string, run: CliRun): string {
  if (typeof run.json?.error === "string") return run.json.error;
  const how = run.code === null ? "was stopped by a signal" : `exited with code ${run.code}`;
  return `${what} ${how}${run.stderrTail ? `: ${run.stderrTail.split("\n").at(-1)}` : ""}`;
}
