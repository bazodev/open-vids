#!/usr/bin/env bun
/**
 * Dev-mode backend for `bun run desktop:dev`.
 *
 * Tauri runs this as its `beforeDevCommand`, so a single terminal is enough to
 * get the Studio Vite server plus the Tauri window.
 *
 * It does three things, in order:
 *   1. builds the workspace packages the Studio's `vite.config.ts` resolves
 *      through the "node" export condition (dist output, not source),
 *   2. registers OPENVIDS_PROJECT as a Studio project by symlinking it into
 *      `packages/studio/data/projects/<basename>` — the same mechanism
 *      `linkProjectIntoStudioData()` uses in the CLI — so the Studio project
 *      list finds it with no other change,
 *   3. runs the Studio's own Vite dev server on a fixed strict port.
 *
 * The port is fixed and strict so `tauri.conf.json`'s devUrl always matches and
 * a stale server surfaces as a hard failure instead of a silent port shift.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO_ROOT = resolve(DESKTOP, "..", "..");

const DEV_PORT = Number(process.env.OPENVIDS_DEV_PORT ?? 5190);
const PROJECT_ARG =
  process.env.OPENVIDS_PROJECT ?? process.argv.find((a) => !a.startsWith("-")) ?? null;

const STUDIO_PROJECTS_DIR = join(REPO_ROOT, "packages", "studio", "data", "projects");

function log(message) {
  process.stderr.write(`[openvids] ${message}\n`);
}

/** Build what the Studio's Node-loaded vite.config.ts resolves via dist. */
function buildWorkspaceDeps() {
  const steps = [
    ["--filter", "@hyperframes/{agent-protocol,parsers,lint,studio-server}", "build"],
    ["--cwd", "packages/core", "build"],
  ];
  for (const args of steps) {
    log(`building workspace deps: bun run ${args.join(" ")}`);
    const result = spawnSync("bun", ["run", ...args], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: false,
    });
    if (result.status !== 0) {
      throw new Error(`workspace dep build failed: bun run ${args.join(" ")}`);
    }
  }
}

/** Mirror the CLI's `linkProjectIntoStudioData()`. */
function linkProject(projectDir) {
  const dir = resolve(projectDir);
  if (!existsSync(dir)) throw new Error(`OPENVIDS_PROJECT does not exist: ${dir}`);
  const name = basename(dir);
  if (!name) throw new Error(`OPENVIDS_PROJECT has no directory name: ${dir}`);

  mkdirSync(STUDIO_PROJECTS_DIR, { recursive: true });
  const linkPath = join(STUDIO_PROJECTS_DIR, name);
  if (linkPath === dir) return { name, created: false };

  if (existsSync(linkPath)) {
    try {
      const stat = lstatSync(linkPath);
      const isStaleLink = stat.isSymbolicLink() && resolve(readlinkSync(linkPath)) !== resolve(dir);
      if (isStaleLink) unlinkSync(linkPath);
    } catch {
      // A real directory at that name is left alone: the user put it there.
    }
  }
  if (!existsSync(linkPath)) {
    if (process.platform === "win32") {
      // `ln -sfn` does not exist on Windows and "dir" symlinks need
      // Developer Mode or elevation; NTFS junctions are unprivileged and keep
      // the live write-back the studio needs.
      symlinkSync(dir, linkPath, "junction");
    } else {
      spawnSync("ln", ["-sfn", dir, linkPath], { stdio: "inherit" });
    }
    log(`linked project ${name} -> ${dir}`);
    return { name, created: true };
  }
  return { name, created: false };
}

function cleanupLink(linkPath, created) {
  if (!created) return;
  process.on("exit", () => {
    try {
      if (existsSync(linkPath)) unlinkSync(linkPath);
    } catch {
      /* best effort */
    }
  });
}

let linked = null;
try {
  buildWorkspaceDeps();
  if (PROJECT_ARG) {
    linked = linkProject(PROJECT_ARG);
    cleanupLink(join(STUDIO_PROJECTS_DIR, linked.name), linked.created);
  }
} catch (error) {
  log(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const args = [
  "run",
  "--cwd",
  "packages/studio",
  "dev",
  "--",
  "--port",
  String(DEV_PORT),
  "--strictPort",
];
// The Tauri window is the only browser here. Rust navigates it to the project
// hash once the dev server answers, so nothing is opened externally.
log(
  `starting Studio dev server on http://127.0.0.1:${DEV_PORT}` +
    (linked ? ` (#project/${linked.name})` : ""),
);

const child = spawn("bun", args, { cwd: REPO_ROOT, stdio: "inherit", windowsHide: true });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (process.platform === "win32" && child.pid !== undefined) {
      // A signal only reaches the direct child on Windows; reap the whole
      // dev-server tree (Vite + Chrome) so Ctrl+C leaves nothing behind.
      try {
        const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 10_000,
        });
        if (result.status === 0) return;
      } catch {
        // Fall through to the direct kill below.
      }
    }
    child.kill(sig);
  });
}
