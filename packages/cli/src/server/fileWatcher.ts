import { lstatSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join, relative, sep } from "node:path";
import { affectsProjectHistory } from "@hyperframes/studio-server";

export type FileChangeListener = (relativePath: string) => void;

export interface ProjectWatcher {
  addListener(fn: FileChangeListener): void;
  removeListener(fn: FileChangeListener): void;
  close(): void;
}

const WATCHER_EXCLUDED_DIRS = new Set([
  ".cache",
  ".git",
  ".hyperframes",
  ".next",
  ".thumbnails",
  ".transcode-cache",
  ".vite",
  ".waveform-cache",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "outputs",
  "renders",
]);
// A save reaches the preview QUIET_MS after the writes go quiet, but at most once per BURST_MS,
// so a checkout or a multi-file tool doesn't start a rebuild for every file.
const QUIET_MS = 30;
const BURST_MS = 300;

export function shouldWatchProjectFile(filename: string): boolean {
  if (!filename) return false;
  const parts = filename.split(/[\\/]+/);
  return !parts.some((part) => WATCHER_EXCLUDED_DIRS.has(part));
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

// FSEvents (macOS) can still deliver writes made just before the stream started: the host stamps
// hf-ids into every composition right before it watches, and those events arriving afterwards would
// reach Studio as an outside edit. For a short while after arming, a path whose last change predates
// the watch is such a replay, and so is an atomic write's temp file that is already gone.
const REPLAY_WINDOW_MS = 5000;
const ATOMIC_TEMP_FILE = /\.\d+\.[0-9a-f-]{36}\.tmp$/;

function isReplayFromBefore(path: string, armedAt: number): boolean {
  try {
    // `armedAt` is a whole millisecond (Date.now()); a write in that same millisecond came first.
    return Math.floor(lstatSync(path).ctimeMs) <= armedAt;
  } catch {
    return ATOMIC_TEMP_FILE.test(path);
  }
}

// On Linux, Node's `recursive` watch arms inotify per file inode, so a file replaced by rename
// (an atomic save) is never reported again; a watch per directory reports children by name.
function watchProjectTree(
  projectDir: string,
  onChange: (relativePath: string) => void,
): () => void {
  if (process.platform !== "linux") {
    let armedAt = Number.POSITIVE_INFINITY;
    const tree = watch(projectDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const relativePath = filename.toString();
      if (
        Date.now() - armedAt < REPLAY_WINDOW_MS &&
        isReplayFromBefore(join(projectDir, relativePath), armedAt)
      ) {
        return;
      }
      onChange(relativePath);
    });
    armedAt = Date.now();
    // An async 'error' (e.g. EMFILE) with no listener would crash the process.
    tree.on("error", () => tree.close());
    return () => tree.close();
  }

  const directories = new Map<string, FSWatcher>();
  const unwatch = (dir: string) => {
    for (const [watched, watcher] of directories) {
      if (watched === dir || watched.startsWith(dir + sep)) {
        watcher.close();
        directories.delete(watched);
      }
    }
  };
  const watchDirectory = (dir: string) => {
    if (directories.has(dir)) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { persistent: true }, (event, name) => {
        if (!name) return;
        const path = join(dir, name.toString());
        onChange(relative(projectDir, path));
        if (event !== "rename") return;
        if (isDirectory(path)) descend(path);
        else unwatch(path);
      });
    } catch (error) {
      // One unwatchable subdirectory (EACCES, inotify limit) must not cost the rest of the tree.
      if (dir === projectDir) throw error;
      return;
    }
    watcher.on("error", () => unwatch(dir));
    directories.set(dir, watcher);
    let entries: string[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(dir, entry.name));
    } catch {
      // Gone before we could list it; its parent reports the removal.
    }
    for (const child of entries) descend(child);
  };
  // `.hyperframes/` itself holds the two manifests the signature reads and `.hyperframes/story/` the history-tracked
  // Story Graph; nothing else below it matters.
  const descend = (dir: string) => {
    const rel = relative(projectDir, dir);
    if (
      shouldWatchProjectFile(rel) ||
      rel === ".hyperframes" ||
      rel === join(".hyperframes", "story")
    ) {
      watchDirectory(dir);
    }
  };

  watchDirectory(projectDir);
  return () => {
    for (const watcher of directories.values()) watcher.close();
    directories.clear();
  };
}

export function createProjectWatcher(projectDir: string): ProjectWatcher {
  const listeners = new Set<FileChangeListener>();
  const pendingPaths = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = Number.NEGATIVE_INFINITY;
  let closeTree: (() => void) | null = null;

  try {
    closeTree = watchProjectTree(projectDir, (relativePath) => {
      // The reload filter excludes all of `.hyperframes/`, but two files in
      // there feed the preview signature and Studio writes one of them at
      // runtime — dropping those at ingest left the CLI server's ETag stale
      // until restart — and the Story Graph is tracked by project history.
      // Admit them here and let the reload listener re-apply its own filter,
      // so what triggers a browser reload is unchanged. The story/graph
      // directory events themselves carry no file identity, but the watcher
      // must arm on them: the recursive watch reports the new dir before any
      // tracked file inside exists, and dropping it leaves later story files
      // unreported. Only the history-tracked family passes, not the subtree.
      const historyDirEvent =
        relativePath === ".hyperframes" ||
        relativePath === join(".hyperframes", "story") ||
        relativePath === join(".hyperframes", "research");
      if (!shouldWatchProjectFile(relativePath) && !historyDirEvent) {
        if (!affectsProjectHistory(projectDir, join(projectDir, relativePath))) return;
      }

      pendingPaths.add(relativePath);
      if (debounceTimer) clearTimeout(debounceTimer);
      const delay = Math.max(QUIET_MS, lastFlushAt + BURST_MS - Date.now());
      debounceTimer = setTimeout(() => {
        const changedPaths = [...pendingPaths];
        pendingPaths.clear();
        debounceTimer = null;
        lastFlushAt = Date.now();
        for (const changedPath of changedPaths) {
          for (const fn of listeners) {
            fn(changedPath);
          }
        }
      }, delay);
    });
  } catch {
    // fs.watch may fail on some platforms — degrade gracefully (no auto-refresh)
  }

  return {
    addListener(fn) {
      listeners.add(fn);
    },
    removeListener(fn) {
      listeners.delete(fn);
    },
    close() {
      if (debounceTimer) clearTimeout(debounceTimer);
      pendingPaths.clear();
      closeTree?.();
      listeners.clear();
    },
  };
}
