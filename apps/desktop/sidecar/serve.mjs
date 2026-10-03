/**
 * The production Studio backend entry point.
 *
 * Runs HyperFrames' embedded Studio server and guarantees it does not outlive
 * OpenVids.
 *
 * Why this exists rather than spawning `cli.js` directly: the app's own
 * teardown only runs when OpenVids' shutdown code runs. On quit that is
 * enough — `killpg` on the child's process group works, and the app reaps the
 * server itself. But a `SIGKILL` of OpenVids, a crash, or a logout never
 * reaches that code, and the server would be orphaned holding a loopback port.
 *
 * A plain process has no such restriction, so the watch lives here. This
 * process records OpenVids' pid, and while `process.kill(pid, 0)` — a
 * permission probe, not a signal — keeps succeeding the server is healthy. When
 * it starts failing, OpenVids is gone and the server is killed outright.
 * (`EPERM` still counts as alive: the process exists but belongs to someone
 * else, e.g. an elevated OpenVids.)
 *
 * Everything else — argument handling, the port, the lifecycle line on stdout —
 * is the CLI's own. This launcher only wraps it and guarantees teardown.
 *
 * Windows notes: `child.kill()` only ends the direct child, so teardown goes
 * through `taskkill /T /F` and reaps the whole tree (the server, Chrome,
 * ffmpeg). `SIGHUP`/`SIGTERM` cannot be delivered by the OS on Windows, but
 * registering them is harmless; `SIGBREAK` (Ctrl+Break) is handled too. This
 * file ships standalone in the app resources, so the tree-kill is
 * self-contained here rather than imported from the workspace.
 *
 * Usage: serve.mjs <cli.js> <args...>
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , cliPath, ...args] = process.argv;
if (!cliPath) {
  process.stderr.write("[openvids:serve] usage: serve.mjs <cli.js> <args...>\n");
  process.exit(2);
}

// `process.ppid` is OpenVids, recorded before spawning so a reparent can never
// be mistaken for the original parent.
const owner = process.ppid;
// `isAbsolute` (not a leading-"/" check) so `C:\…`, `C:/…` and
// `\\server\share\…` entries resolve on Windows.
const cli = isAbsolute(cliPath) ? cliPath : join(dirname(fileURLToPath(import.meta.url)), cliPath);

const child = spawn(process.execPath, [cli, ...args], {
  stdio: ["ignore", "inherit", "inherit"],
  // A GUI-launched app has no console; without this every server child
  // flashes one on Windows. No-op on POSIX.
  windowsHide: true,
});

let escalation = null;

/**
 * Reaps the server's whole process tree on Windows (`taskkill /T /F`).
 * Returns true when taskkill took it; the caller falls back to a direct kill.
 */
function killWindowsTree(pid) {
  if (pid === undefined) return false;
  try {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function stop(initial) {
  if (escalation !== null) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  // On Windows a signal only reaches the direct child, so go straight for
  // the tree; elsewhere ask the child first and escalate below.
  if (!killWindowsTree(child.pid)) {
    try {
      child.kill(process.platform === "win32" ? "SIGKILL" : initial);
    } catch {
      // Already gone.
    }
  }
  // Not unref'd on purpose: the launcher must outlive the shutdown it started.
  // An exit that races the escalation leaves the server running unsupervised.
  escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      if (!killWindowsTree(child.pid)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  }, 3000);
}

/** Whether OpenVids is still alive. `EPERM` means it exists but belongs to
 * someone else — alive; anything else (`ESRCH`, `EINVAL`) means it is gone. */
function ownerAlive() {
  try {
    process.kill(owner, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "EPERM";
  }
}

// OpenVids is gone, so there is nothing left to be graceful *for*: the server
// holds a loopback port and may have Chrome running, and neither should
// outlive the app that owns it.
const watch = setInterval(() => {
  if (!ownerAlive()) {
    process.stderr.write(`[openvids:serve] OpenVids (pid ${owner}) is gone; stopping Studio\n`);
    stop("SIGKILL");
  }
}, 1000);

const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
if (process.platform === "win32") signals.push("SIGBREAK");
for (const signal of signals) {
  process.on(signal, () => stop("SIGTERM"));
}

child.on("exit", (code, signal) => {
  clearInterval(watch);
  clearTimeout(escalation);
  process.exit(signal ? 1 : (code ?? 0));
});
