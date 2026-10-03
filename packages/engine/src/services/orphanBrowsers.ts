/**
 * Chrome the engine launched that outlived a killed owner.
 *
 * A browser is a separate process: when its owner dies without running any handler (SIGKILL, crash, power-cycled
 * parent), Chrome keeps running under init with its DevTools port open and holds hundreds of MB until reboot. Each
 * launch leaves a small record (browser pid -> owner pid) in the temp dir; `sweepOrphanBrowsers` kills the browsers
 * whose owner is gone. A live owner's browsers are never touched, and a record whose pid now belongs to an
 * unrelated program is dropped, not killed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RECORD_DIR = "hyperframes-browsers";

function recordDir(root: string): string {
  return join(root, RECORD_DIR);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** The command line of `pid` on Windows, or null when it is gone or cannot be read. */
function windowsCommandOf(pid: number): string | null {
  try {
    // `tasklist` only reports the image name, while Chrome is identified by its
    // command line (headless-shell, `puppeteer_dev_chrome_profile`), so read it
    // through CIM the way the CLI's process-identity lookups do.
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if ($p) { $p.CommandLine }`,
      ],
      {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    ).trim();
    return output || null;
  } catch {
    return null;
  }
}

/** The command line of `pid`, or null when it is gone or cannot be read. */
function commandOf(pid: number): string | null {
  if (process.platform === "win32") return windowsCommandOf(pid);
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Ends the browser and, on Windows, the helpers Chrome spawned beneath it.
 * Throws when the process is already gone, so the caller drops the record
 * without counting a kill — the same contract `process.kill` has on POSIX.
 */
function killBrowser(pid: number): void {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 10_000,
      });
      if (result.status === 0) return;
    } catch {
      // Fall through to the direct kill below.
    }
  }
  process.kill(pid, "SIGKILL");
}

/** Notes that this process owns the browser `browserPid`. Best effort: the registry is a safety net, not a contract. */
export function recordBrowserOwner(browserPid: number, root: string = tmpdir()): void {
  try {
    mkdirSync(recordDir(root), { recursive: true });
    writeFileSync(
      join(recordDir(root), `${browserPid}.json`),
      JSON.stringify({ ownerPid: process.pid }),
    );
  } catch {
    // An unwritable temp dir only costs the crash cleanup.
  }
}

/** Drops the record of a browser that closed normally. */
export function forgetBrowserOwner(browserPid: number, root: string = tmpdir()): void {
  rmSync(join(recordDir(root), `${browserPid}.json`), { force: true });
}

function ownerOf(file: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || !("ownerPid" in parsed)) return null;
    const { ownerPid } = parsed;
    return typeof ownerPid === "number" && Number.isInteger(ownerPid) && ownerPid > 0
      ? ownerPid
      : null;
  } catch {
    return null;
  }
}

/** Kills browsers whose owner died and clears their records. Returns the pids killed. */
export function sweepOrphanBrowsers(root: string = tmpdir()): number[] {
  const dir = recordDir(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const killed: number[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const browserPid = Number(name.replace(/\.json$/, ""));
    const ownerPid = ownerOf(file);
    if (!Number.isInteger(browserPid) || browserPid <= 0 || ownerPid === null) {
      rmSync(file, { force: true });
      continue;
    }
    if (ownerPid === process.pid || isAlive(ownerPid)) continue;
    const command = commandOf(browserPid);
    if (command !== null && /chrom/i.test(command)) {
      try {
        killBrowser(browserPid);
        killed.push(browserPid);
      } catch {
        // Already gone.
      }
    }
    rmSync(file, { force: true });
  }
  return killed;
}
