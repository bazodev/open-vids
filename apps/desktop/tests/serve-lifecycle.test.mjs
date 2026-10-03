import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const SERVE_PATH = fileURLToPath(new URL("../sidecar/serve.mjs", import.meta.url));

// The launcher contract, run don't read: a dead owner means the whole child
// tree dies (SIGKILL on POSIX, taskkill /T /F on Windows), and the launcher
// itself exits nonzero. Skipped unless explicitly opted in: it spawns real
// processes and takes ~5 s (watch interval + escalation timeout).
const RUN = process.env.OPENVIDS_TEST_SERVE_LIFECYCLE === "1";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

test("serve.mjs uses an absolute path for the CLI entry", { skip: !RUN }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "openvids-serve-"));
  try {
    // The probe CLI prints a marker and exits, so the launcher exits 0
    // without ever firing its watch kill.
    const cli = join(dir, "cli-probe.mjs");
    writeFileSync(cli, "process.stdout.write('probe-ok');");
    const viaAbsolute = spawnSync(process.execPath, [SERVE_PATH, cli], {
      encoding: "utf-8",
      timeout: 15_000,
      windowsHide: true,
    });
    assert.match(viaAbsolute.stdout ?? "", /probe-ok/);
    assert.equal(viaAbsolute.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve.mjs kills the child tree when the owner dies", { skip: !RUN }, async (t) => {
  // Parent (recorded owner) -> launcher -> child tree (child + grandchild).
  // Killing the parent makes the launcher's watch fire; the grandchild must
  // die too, proving tree-kill rather than direct-child-kill.
  const probeDir = mkdtempSync(join(tmpdir(), "openvids-serve-tree-"));
  const readyFile = join(probeDir, "grandchild.ready");
  const childScript = join(probeDir, "child.mjs");
  writeFileSync(
    childScript,
    `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 500)"], { stdio: "ignore", windowsHide: true });
    writeFileSync(${JSON.stringify(readyFile)}, String(grandchild.pid));
    grandchild.on("exit", () => process.exit(0));
    setInterval(() => {}, 500);
    `,
  );
  const parentScript = join(probeDir, "parent.mjs");
  writeFileSync(
    parentScript,
    `
    import { spawn } from "node:child_process";
    const launcher = spawn(process.execPath, [${JSON.stringify(SERVE_PATH)}, ${JSON.stringify(childScript)}], { stdio: "ignore" });
    process.stdout.write(String(launcher.pid));
    setInterval(() => {}, 500);
    `,
  );
  t.after(() => rmSync(probeDir, { recursive: true, force: true }));

  const parent = spawn(process.execPath, [parentScript], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  t.after(() => {
    try {
      parent.kill("SIGKILL");
    } catch {}
  });
  let launcherPid;
  let out = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("parent did not report launcher pid")), 10_000);
    parent.stdout.on("data", (chunk) => {
      out += chunk.toString();
      const pid = Number(out.trim());
      if (Number.isInteger(pid) && pid > 0) {
        launcherPid = pid;
        clearTimeout(timer);
        resolve();
      }
    });
    parent.on("error", reject);
  });
  assert.ok(launcherPid, "parent reported the launcher pid");

  // Wait for the grandchild to exist, then kill the parent (the owner).
  let grandchildPid;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (existsSync(readyFile)) {
        grandchildPid = Number(readFileSync(readyFile, "utf-8"));
        if (Number.isInteger(grandchildPid) && grandchildPid > 0) break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(grandchildPid, "grandchild started");
  assert.equal(isAlive(grandchildPid), true);

  try {
    parent.kill("SIGKILL");
  } catch {}
  // Watch interval (1 s) + escalation (3 s) + slack.
  const gone = Date.now() + 15_000;
  while (Date.now() < gone) {
    if (!isAlive(grandchildPid) && !isAlive(launcherPid)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(isAlive(grandchildPid), false, "grandchild tree reaped after owner death");
  assert.equal(isAlive(launcherPid), false, "launcher exited after owner death");
});
