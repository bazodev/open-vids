import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** The Bun executable: vitest runs under Node, so `process.execPath` is node. */
const BUN_BIN = process.env.BUN_BIN ?? "bun";

function compile(js: string, exe: string): void {
  const built = spawnSync(BUN_BIN, ["build", js, "--compile", "--outfile", exe], {
    encoding: "utf-8",
    windowsHide: true,
  });
  if (built.status !== 0)
    throw new Error(`bun build fake ffmpeg failed: ${built.stderr || built.error}`);
}

/**
 * Stand-in ffmpeg executables for the cancellation tests. A `.sh` script
 * cannot exec on Windows (spawn reports `EFTYPE`), so there the stand-in is a
 * tiny compiled Bun exe instead (Bun is always on PATH in dev/CI here;
 * one `bun build --compile` takes ~1 s, once per test).
 *
 * - `writeHangExe`: records its pid (appended, one per child) and hangs, so
 *   the test can watch the service kill it on cancel/abort. Ignores argv, so
 *   it answers any ffmpeg invocation the service attempts.
 * - `writeBrokenExe`: prints "boom" on stderr and exits 3, so every stage that
 *   shells to ffmpeg fails with the binary's own message.
 */
export async function writeHangExe(dir: string, pidFile: string): Promise<string> {
  const js = join(dir, "fake-ffmpeg.js");
  const exe = join(dir, "fake-ffmpeg.exe");
  // The pid path is baked in: the service spawns the stand-in as `ffmpeg`
  // with its own argv, so no env contract is needed.
  writeFileSync(
    js,
    `const { appendFileSync } = require("node:fs");\n` +
      `appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");\n` +
      `setInterval(() => {}, 1000000);\n`,
  );
  compile(js, exe);
  return exe;
}

export async function writeBrokenExe(dir: string): Promise<string> {
  if (process.platform !== "win32") {
    const fake = join(dir, "broken-ffmpeg.sh");
    writeFileSync(fake, `#!/bin/sh\necho "boom" >&2\nexit 3\n`, { mode: 0o755 });
    return fake;
  }
  const js = join(dir, "broken-ffmpeg.js");
  const exe = join(dir, "broken-ffmpeg.exe");
  writeFileSync(js, `console.error("boom");\nprocess.exit(3);\n`);
  compile(js, exe);
  return exe;
}
