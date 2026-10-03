import { spawn } from "node:child_process";
import { once } from "node:events";

/**
 * The platform's "open with the default application" command, as
 * `(command, args)`. macOS and Linux hand the path to a launcher that asks the
 * desktop for the file's default app. Windows cannot go through `cmd`'s
 * `start` here: `start` re-parses its tail itself, and neither a bare path
 * nor an extra-quoted one survives both spaces and `&` (`"a&b"` truncates at
 * the `&` — verified against this machine's `cmd.exe`), so a project or
 * render whose name has either would open the wrong file. `explorer.exe`
 * takes the file as one argv element instead (no shell), which both survive.
 */
export function openerCommand(path: string): [string, string[]] {
  if (process.platform === "darwin") return ["/usr/bin/open", [path]];
  if (process.platform === "win32") return ["explorer.exe", [path]];
  return ["xdg-open", [path]];
}

/** How long the launcher may take before the request gives up on it. */
const OPENER_TIMEOUT_MS = 10_000;

/**
 * Hand one file to the OS, the same thing double-clicking it in Finder does.
 *
 * This exists for the OpenVids desktop shell: its webview never opens a window
 * for a loopback `window.open` (the shell only forwards `https:` addresses to
 * the default browser), so the loopback server that already owns the render
 * file is the only party that can open it for the user. Resolves once the
 * launcher accepted the file; rejects when it is missing or fails, so the
 * caller can tell the user instead of leaving the click silent.
 */
export async function openInDefaultApp(path: string): Promise<void> {
  const [command, args] = openerCommand(path);
  // GUI launchers (`explorer.exe`, `open`) reuse no console, so no window
  // flashes; `windowsHide` is still set for the rare stub resolution.
  // No-op on POSIX.
  const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
  const timer = setTimeout(() => child.kill(), OPENER_TIMEOUT_MS);
  timer.unref?.();
  try {
    // `once` also rejects when the launcher cannot be spawned at all (ENOENT).
    const [code] = (await once(child, "close")) as [number | null];
    if (child.killed) throw new Error(`${command} did not finish within ${OPENER_TIMEOUT_MS} ms`);
    if (code !== 0) throw new Error(`${command} exited with code ${code ?? "null"}`);
  } finally {
    clearTimeout(timer);
  }
}
