# OpenVids — desktop

A Tauri 2 shell around [HyperFrames Studio](../../packages/studio). The window
_is_ Studio: OpenVids starts the real HyperFrames server on `127.0.0.1` and
points the webview at it.

## Why it works this way

Studio is not a static site. Every API call it makes is a root-relative
`/api/...` path, and the composition being edited lives in an iframe that Studio
reaches into with `contentDocument` / `contentWindow` —
`packages/studio/AGENTS.md` says so explicitly. The API is mounted in the _same
process_ that serves the SPA (Vite middleware in development, a Hono server in
production), so the document's origin and the API's origin are the same thing.

Therefore:

- The webview loads `http://127.0.0.1:<port>`, not a `tauri://` asset. A custom
  scheme would put the API on a different origin and break every cross-document
  read the editor depends on.
- There is no `postMessage` bridge and no second editing path.
- The iframe `sandbox` is untouched (`allow-scripts allow-same-origin` —
  `allow-same-origin` is what makes `contentDocument` readable).

## Prerequisites

macOS: Xcode Command Line Tools (or Xcode), Rust stable, Bun, Node.js 22+, FFmpeg + ffprobe on `PATH`, a Chrome the CLI can drive, Git LFS for the render fixtures.

Windows: MSVC Build Tools (C++ workload, for the Rust/MSVC linker), Rust stable (MSVC target), Bun, Node.js 22+, Git with LFS, and a WebView2 runtime (the NSIS installer bootstraps it with the download bootstrapper). FFmpeg + ffprobe either on `PATH` or from the app's download button (official gyan.dev essentials build, SHA-256 verified, into `%USERPROFILE%\.openvids\ffmpeg`); Chrome from the app's Install button or a system Chrome. Symlink-based tests need Developer Mode or elevation — without it they skip. CI runs on both `macos-latest` and `windows-latest`.

## Commands

Run from the repository root:

```bash
bun run desktop:dev      # Studio dev server + Tauri window, one terminal
bun run desktop:build    # HyperFrames build -> staged runtime -> bundle (macOS: OpenVids.app + .dmg; Windows: NSIS setup)
bun run desktop:stage    # Stage the production runtime only
bun run desktop:check    # cargo check for src-tauri
bun run desktop:version  # set/verify the app version (see Releasing)
```

Open a specific project at launch:

```bash
OPENVIDS_PROJECT=/abs/path/to/project bun run desktop:dev
```

In dev, Studio's own project list in `packages/studio/data/projects` works
as-is. `OPENVIDS_PROJECT` (or a bare path argument) additionally symlinks that
directory into it — the same `linkProjectIntoStudioData()` mechanism the
HyperFrames CLI uses — so it appears in the list with no other change.

`desktop:dev` always rebuilds the workspace packages Studio's `vite.config.ts`
resolves through their `node` export condition (`parsers`, `lint`,
`studio-server`, `core`). It is a few seconds, and a stale `dist` there fails in
a way that looks like a Studio bug.

## Menus and shortcuts

**File > Open Project Folder…** (`Ctrl+O`) opens a project in a new tab (or
switches to its tab) and records the choice in recents. **File > Show All
Projects** (`Ctrl+Shift+O`) switches to the Projects tab; the open projects keep
running in theirs — so does the **Projects** back button in Studio's header
(top-left, where the logo sits when Studio runs inside OpenVids). The button is
a plain document navigation to the home origin (the webview has no IPC by
design); the project webview's navigation hook (`tab_webviews.rs`) cancels it
and shows the Projects tab instead. Outside OpenVids the logo renders exactly as before.
**Edit** supplies text-field Undo/Redo, Cut/Copy/Paste and Select All;
**Window** owns Minimize, Full Screen and Close Window. **View > Reload**
(`Ctrl+R`) reloads the current window without dropping the open project.
(On macOS these read `⌘O` / `⌘⇧O` / `⌘R`.)

On the Windows custom frame the native menu bar stays hidden, but its actions
have a mouse path. On the Projects page the title bar draws a real menu bar —
the app mark (a 36x36 button with the 21 px mark fitted inside), then
plain-text **File Edit View Window Help** labels wearing the toolbar's own
button shape — then a centred row: **Open Project…** / **New Project**
immediately left of the project search (8 px gap), the search field itself
window-centred (its centre = the window's centre ±2 px at >= 1100 px wide),
the grid/list toggle and the Settings gear immediately right of it, then a
mandatory >= 16 px gap, then the three caption buttons flush right. The
caption strip owns the rightmost 138 px (3 x 46 px) and nothing else may
intrude into it, at every window width. The big OpenVids wordmark is not
drawn on the custom frame (the corner mark carries the brand); macOS keeps it.
The labels open
dropdowns (hover switches while one is open; Escape closes; Left/Right move
between labels; items stay keyboard reachable): File holds Open Project…,
Show All Projects, Settings… and Quit; Edit acts on the focused field (Undo,
Redo, Cut, Copy, Paste, Select All); View holds Reload; Window holds
Minimize, Maximize/Restore and Close; Help holds Welcome to OpenVids…,
Check for Updates… and About OpenVids — the same actions as the hidden
native menu, with the same `Ctrl+` shortcuts shown where one exists. Below
1100 px of width the search shrinks first, then the labels collapse into the
mark's compact menu (which keeps About/Quit reachable) so nothing overlaps or
pushes the caption buttons out. Studio keeps the single mark menu in the
same slot (its header is too crowded for the full bar at 1100 px). Actions
run through one shared handler (`menu_action` in `lib.rs`): the native menu
calls it directly, the Projects page reaches it through `POST /api/menu/:action`
(token-gated; the webview has no Tauri IPC by design), so the two cannot
drift apart. Studio cannot forward the home token — it never receives it —
so on the Windows custom frame (and only there; `OPENVIDS_SYSTEM_FRAME=1` and
macOS get nothing) the home server answers a cross-origin request from
exactly the live Studio origins (`studio_grant` in `home_routes.rs`, the
origins of the open project tabs, published by `tab_actions::publish_state`)
for four endpoints: `POST /api/menu/{open_project,welcome,check_updates}`
and `GET /api/menu/about`, plus the `OPTIONS` preflight of exactly one of
them (requested method = that endpoint's, requested headers only
`content-type`). `Host` must name this server. The answer carries the exact
origin in `Access-Control-Allow-Origin` and `Vary: Origin` (never `*`, never
credentials), also on a 503 "app not ready". Every other request — another
action, a stale or missing `Origin`, a foreign `Host` — is judged by the
ordinary rules (403, no CORS headers), and quit/reload/show_home/open_settings
need the token. Studio's Quit closes the window through the window IPC
(`capabilities/windows-frame.json`: close, minimize, toggle_maximize,
is_maximized, Windows only); Rust ends the app when the main window closes,
also with the report window open. That allowance is strictly narrower than what
Studio's own `/api` already
lets any page on that origin do, and every other request still needs the
token. About renders a page-level sheet from `GET /api/menu/about` (the native dialog's own strings),
checked for its shape before use;
Quit exits through the same path as the native Quit, stopping the owned
processes. The native menu keeps its accelerators (pumped through
`TranslateAcceleratorW` with no bar attached) and stays the fallback surface
under `OPENVIDS_SYSTEM_FRAME=1`; the Projects page owns the same chords as
in-page handlers (`home.js`), and Studio owns Ctrl+O / Ctrl+Shift+O / Ctrl+,
/ Ctrl+R in-page too, so all three stay in sync. `Ctrl+,` opens
Settings (a menu item is the discoverable fallback). macOS is unchanged: the
real menu bar owns these actions and neither page draws the bar or the button.

For a Code-tab edit that has saved to disk but has not appeared in the preview,
use **View > Reload**; see the limitation below.

## Start window size (Windows)

Windows would cascade the window from the top-left at a fixed size, so the first window is
computed from the primary monitor's work area (taskbar excluded) by
`platform::start_window_size` and centred in it. On a landscape area the height fills the area
minus a fixed 48 px gap on every side and the width follows at 3:2; when the area is too narrow
for 3:2 the width takes what is left (never narrower than the height, so never below 1:1). A
square or portrait area gets a 1:1 window with a smaller 24 px gap at the sides. Sizes are
logical pixels. macOS positions and sizes its windows itself.

## Default Projects folder and reveal behavior (Windows)

New projects default to `~/Documents/OpenVids` on Windows (`~/Movies/OpenVids` on macOS/Linux).
On Windows, `~` expands to the user profile directory, so the folder is
`%USERPROFILE%\Documents\OpenVids`; Windows may redirect Documents (for example, to OneDrive).
The default lives in `prefs.rs` (`default_project_location`) and `studio-server`'s
`preferences.ts`, so onboarding, Settings and the New Project sheet agree. On Windows only, the
legacy saved value `~/Movies/OpenVids` is migrated to the new default; other saved locations are
preserved.
"Show in File Explorer" selects the project folder with `explorer.exe /select,"<path>"`
(one verbatim command-line element — re-quoting the whole `/select,…` element opens Documents
instead); opening a finished render goes straight to `explorer.exe` with the file as one
argument, never through `cmd /c start` (which re-parses `&` and spaces).

## Updates

OpenVids updates itself with `tauri-plugin-updater`. It is a Rust-only path: the webview holds no
capability for the plugin, and the pages only see the token-gated home API:

- `GET /api/update/status` — the current phase (`checking`, `available`, `downloading`, `ready`,
  `failed`, …) plus the version, release notes, download progress or the failure.
- `POST /api/update/check` — ask the release feed(s) of the chosen channel for a newer version.
- `POST /api/update/install` `{ "force"?: boolean }` — download, verify the signature, install and
  restart. Nothing is downloaded without this call.

**Channels.** `updates.channel` (`"stable"` by default, `"beta"` after Settings › General › Updates ›
“Get beta versions”) picks what a check reads. Stable reads only the configured endpoint
(`releases/latest/download/latest.json`). Beta reads that and the beta manifest
(`releases/download/channel-beta/beta.json`, `BETA_MANIFEST_URL` in `updater.rs`) and offers the
newer of the two: the plugin's `endpoints` list is a fallback chain (the first manifest that answers
wins), so each manifest is checked by its own updater and `updater::settle` picks the newest. The
`is_newer` rule stays strict semver precedence (`0.5.0-beta.1 < 0.5.0-beta.2 < 0.5.0`): a beta
build is offered the next beta and then the stable release, never an older stable; a stable build with
the switch off never sees a beta. A beta manifest that is not there yet (no beta published) or has no
entry for this platform counts as "no beta", not as a failed check. Flipping the switch saves the
preference and starts a check at once (a check running meanwhile is repeated for the new channel).
Turning the switch off drops a beta that is offered, downloading or parked (the fresh check on the stable
channel replaces it; `install` refuses one too), but does not roll the app back: the build stays on its beta until a newer stable
release exists, and Settings links the stable download page. A beta build shows a “Beta” badge next to its
version (`OV.buildChannel()`, from `OV_BOOT.channel`). The channel is a preference in `preferences.json`
(`prefs.rs` and `studio-server` `preferences.ts` normalize it identically); it is not sent in usage statistics.

**Check for Updates…** in the app menu runs the same check: with the Projects page open it opens
Settings › General, where the page shows progress and the install button; with a project open Rust
shows native dialogs instead. When `updates.autoCheck` (Settings › General, default on) is set,
release builds also do one quiet check about 15 seconds after launch; while a version waits, the
Projects page shows a dot on the Settings button and a compact pill beside it ("Update to x.y.z",
then the download percentage, then "Restart to Update") that opens Settings › General. The pill
shrinks to its icon when the toolbar is tight. Still nothing is downloaded or installed until the
user asks for it.

A downloaded archive is authenticated with a minisign signature checked against the updater key in
`tauri.conf.json` (`plugins.updater.pubkey`); the private key exists only as a GitHub Actions
secret. `requireSignedVersion` is on: the signature's trusted comment carries the version the
archive was built for, so a tampered `latest.json` cannot pair a new version number with an older
signed archive. A failed check leaves the installed bundle untouched. See [Releasing](#releasing).

Installing first stops what the app runs — the Studio sidecar (process group on macOS, Job Object tree on Windows), the agent runtimes
and running install jobs — the same way quitting does (`stop_owned_processes` in `lib.rs`), and
moves the window back to the Projects page. If the open project is mid-render or an agent turn is
running, the app asks for confirmation first ("Update and Restart" / "Restart Anyway"); a download
that finishes while the project is busy waits in `ready` and asks again. On macOS the plugin then replaces
the installed bundle (`/Applications/OpenVids.app`) and the app quits; a detached `/bin/sh` waits
for the old pid to exit and opens the new bundle with `/usr/bin/open`, as Finder would. On Windows the plugin
runs the downloaded NSIS installer in passive mode (which relaunches the app itself) and this process exits.
It does not use Tauri's in-place restart on macOS: that execs the new binary as a child of the old process, and in the
manual run the new window stayed behind the other apps and the new binary read the Documents folder
under the old binary's permission instead of asking for its own (see below). Each update downloads
the full installer archive; layered or delta updates are a separate future task.

### macOS permissions and Gatekeeper after an update

Measured with an ad-hoc-signed 0.1.0 installed in `/Applications` and updated to 0.1.1 through the
button:

- **TCC.** An ad-hoc signature's designated requirement is its code hash
  (`codesign -d -r-` prints `designated => cdhash H"…"`), and every build has a different one. TCC
  grants are bound to that requirement, so the updated app is a new client: the first launch of
  0.1.1 through LaunchServices asked again for access to the Documents folder (where the recent
  projects live), although 0.1.0 had been allowed. Every update repeats this for every protected
  location the app touches
  (Documents, Desktop, Downloads, removable volumes); the stale grants stay in System Settings ›
  Privacy & Security. Only a stable signing identity (Developer ID) keeps grants across updates.
- **Gatekeeper.** The plugin unpacks the archive itself, so the new bundle carries no
  `com.apple.quarantine` attribute (`xattr` shows only `com.apple.provenance`); Gatekeeper does
  not assess it and the app opens without a prompt. `codesign --verify --deep --strict` passes;
  `spctl -a` still says `rejected`, as it does for every ad-hoc build. Only the first install from a
  downloaded `.dmg` meets Gatekeeper (System Settings › Privacy & Security › Open Anyway, or
  `xattr -dr com.apple.quarantine /Applications/OpenVids.app`).

## Usage statistics

`src-tauri/src/telemetry.rs` is the only sender of the anonymous usage statistics described in the
root [README](../../README.md#usage-statistics): `app_start`, a `heartbeat` every 5 minutes,
`app_end` on a normal quit (sent while the processes stop, at most 1 s) and one
`telemetry_disabled` without an installation id when `telemetry.enabled` turns off. The preferences
watcher in `lib.rs` re-reads the file, so a change saved from Studio counts too. Debug builds send
nothing; to watch the requests, point one at a local receiver:

```bash
OPENVIDS_TELEMETRY_URL=http://127.0.0.1:8899/api/send bun run desktop:dev
```

## Architecture

```
apps/desktop/
  scripts/
    serve-studio-dev.mjs   Tauri's beforeDevCommand: build deps, link the
                           project, start Vite on a fixed strict port (5190)
    stage-runtime.mjs      Assemble the production payload under runtime/
  src-tauri/
    src/lib.rs             Window, menu, mode selection, project opening
    src/sidecar.rs         Spawn + readiness-poll + teardown the Studio server
    src/proc.rs            Whole-tree child supervision: process groups + SIGTERM/SIGKILL on Unix, kill-on-close Job Objects + CREATE_NO_WINDOW on Windows
    src/home.rs            Projects home screen: lifetime-owned loopback server
    src/home_page/         The Projects page + Settings window (HTML/CSS/JS, compiled in;
                           ported from the OpenDesign prototype, both themes)
                           (design.js, design-sheets.js, design.css: the Design systems section)
    src/home_routes.rs     Home HTTP plumbing: routing, pages/assets, open/pick/thumbs
    src/home_api.rs        Preferences, metadata, duplicate/reveal/locate, recents undo,
                           composer files, start-from-chat, agent-runtime proxy routes
    src/project_copy.rs    Shared Duplicate/Fork copier: exclusions, temp-sibling build + no-replace rename, lineage in meta.json, crash sweep, refusal while the agent works
    src/home_fork.rs       POST /api/fork, GET /api/fork/state, POST /api/fork/cancel: the background fork job with progress
    src/home_create.rs     POST /api/create (scaffold, optional design system, then open)
    src/home_design.rs     /api/design-systems JSON routes (list, detail, rename, delete) + open sandboxed /design-files/<id>/… reads
    src/design_library.rs  Design-system library reader/writer (~/.openvids/design-systems), path safety, manifest scan
    src/design_snapshot.rs Copy a system into <project>/design/ + the tokens link of a new project
    src/design_lock.rs     <library>/.lock, compatible with studio-server's ownerLock.ts
    src/voice_settings.rs  Voice provider settings, keys (0600) and saved voices in ~/.openvids/voice, byte-compatible with studio-server src/voice
    src/home_voice.rs      /api/voice/* JSON routes of the Voice settings section (providers, keys, presets, cached samples)
    src/home_project.rs    Rename (folder + meta.json) and Trash handlers (Recycle Bin via IFileOperation on Windows)
    src/home_auth.rs       Per-launch token + Host/Origin checks
    src/home_internal.rs   `/internal/*` for the Studio sidecars: per-launch secret, recents list/lookup, dev link file
    src/prefs.rs           ~/.openvids/app/preferences.json (shared with Studio; home is USERPROFILE on Windows, $HOME elsewhere)
    src/platform.rs        Home dir (== Node os.homedir()), bun.exe name, verbatim-prefix stripping
    src/ffmpeg_install.rs  FFmpeg installer: `brew install ffmpeg` on macOS, gyan.dev essentials download into ~/.openvids/ffmpeg on Windows
    src/chrome_install.rs  Chrome installer: `hyperframes browser ensure` into the CLI cache
    src/project_meta.rs    Duration + clip count from index.html (cached by mtime)
    src/intake.rs          Start-from-chat: folder name, file import, intake.json
    src/drop_paths.rs      Real paths of an OS drop (macOS drag pasteboard; Windows is file-picker-only in v1)
    src/agent_proxy.rs     Lazy project-less agent runtime for models/settings
    src/recents.rs         recents.json persistence (dedupe, sort, rename, undo, relink)
    src/structure.rs       index.html + data-composition-id validation, patching
    src/create.rs          Blank-template scaffold (fps/size/duration, meta.json)
    src/thumbnails.rs      Background thumbnail refresh from Studio
    src/project.rs         Directory -> Studio project id
    src/updater.rs         In-app updates: check, download + install, restart (NSIS passive install on Windows)
  sidecar/
    serve.mjs              Parent-death watch; see "Teardown" below
```

### Development

`beforeDevCommand` runs `serve-studio-dev.mjs`, which builds the workspace deps,
registers `OPENVIDS_PROJECT`, and starts Studio's Vite dev server on a fixed
strict port. The window then loads `devUrl` from `tauri.conf.json`. No sidecar,
no bundling, full HMR. Same commands on Windows (`OPENVIDS_PROJECT` takes a Windows path).

The base Tauri config deliberately has no bundled runtime resources: a fresh
clone can start dev mode or run `cargo check` before the production payload is
staged. Tauri generates `gen/schemas` as needed.

The icons are tracked. Their source is `src-tauri/icons/app-icon.svg` (the
design's app icon, inset to the macOS icon grid: an 824 px tile centered on a
1024 px canvas). To regenerate after changing it, run
`bun run tauri icon src-tauri/icons/app-icon.svg -o /tmp/ov-icons` and copy the
files that `bundle.icon` in `tauri.conf.json` lists, plus `icon.png`, into
`src-tauri/icons/`.

### Production

`desktop:build` runs the HyperFrames build first (`bun run build`), which
produces `packages/cli/dist` — including `dist/studio`, the prebuilt Studio SPA
that the CLI's `build:copy` step places there. `stage-runtime.mjs` then assembles
`apps/desktop/runtime/`:

| `runtime/bun[.exe]` | The JS runtime (`bun.exe` on Windows). |
| `runtime/hyperframes/` | A copy of `packages/cli/dist` plus its published dependencies. |
| `runtime/runtime.json` | The layout manifest. |

`stage-runtime.mjs` stages `bun.exe` plus the win32-only natives on Windows (`@esbuild/win32-x64`, `@img/sharp-win32-x64`, `lightningcss-win32-x64-msvc`, `@oh-my-pi/pi-natives-win32-x64`), strips `*.map`/`*.d.ts` from the staged `node_modules` (except the `declarations.d.ts` files the OMP SDK imports as text, kept via `KEPT_RUNTIME_FILES`), and pins the version-split families (`@opentelemetry/*` to 2.9.0, `linkedom` to 0.18.12) through `overrides` so no nested duplicate deepens the tree — the NSIS per-user install under `%LOCALAPPDATA%` then keeps headroom under the 260-character `MAX_PATH` (longest staged path is ~137 characters). Staging logs the longest staged path and fails on Windows with an actionable message when the checkout prefix plus that path would reach the 255-character budget, so a too-long checkout fails at staging instead of in `makensis…

`tauri.prod.conf.json` supplies the runtime resource paths only to
`desktop:build`, after staging has created them. They are bundled into the app;
nothing in the shipped app refers to the monorepo. `scripts/tauri-build.mjs` runs
`tauri build --config src-tauri/tauri.prod.conf.json --config src-tauri/tauri.prod.<windows|macos>.conf.json` (the second one adds the bundled Bun, `bun.exe` or `bun`, the only resource whose name differs per platform; Tauri 2 also merges `tauri.windows.conf.json` on Windows for the `nsis` bundle target and WebView2 download bootstrapper, and `tauri.macos.conf.json` on macOS for `app`+`dmg`); when no
`TAURI_SIGNING_PRIVATE_KEY` is set it adds a second `--config` that turns
`bundle.createUpdaterArtifacts` off, so local builds do not need the release key
(see [Releasing](#releasing)).

At runtime the Rust side:

1. reserves a loopback port (the Studio runtime takes a starting port and scans
   upward; it does not accept port 0),
2. spawns `bun hyperframes/cli.js preview --json --no-open --port <p> <dir>`,
3. reads the CLI's machine-readable lifecycle line from stdout for the port it
   actually bound,
4. polls `GET /api/projects` until the server answers — a bound socket is not a
   ready server,
5. adds a child webview for the project's tab at `http://127.0.0.1:<port>/#project/<id>` and shows it.

The child is supervised as a whole tree (`proc.rs`): on macOS/Linux it is placed in its own process group and terminated as a group, so the
Chrome instances the render pipeline spawns go with it. On Windows the child is spawned with `CREATE_NO_WINDOW` and assigned to a kill-on-close Job Object, so quitting — or killing OpenVids from Task Manager — reaps bun, Chrome and FFmpeg outright (there is no SIGTERM on Windows; recovery happens on next start). `StudioServer::drop`
reaps it on every exit path, and the `ExitRequested`/`Exit` handler does it
explicitly.

The Projects home screen is served by a small loopback listener that lives for
the whole app lifetime and stays loaded in the window's own webview under the
project tabs (File > Show All Projects only switches to it). The embedded server
is single-project by construction (`createStudioServer` takes one `projectDir`),
so every open project has a sidecar of its own; closing a tab stops only that
sidecar, and the home server is untouched.

## Releasing

The app version has one source of truth: `[package] version` in
`src-tauri/Cargo.toml`. Tauri reads it from there because `tauri.conf.json` sets
no `version`; two files mirror it — `apps/desktop/package.json` and the
`openvids-desktop` entry in `src-tauri/Cargo.lock`. `bun run desktop:version
0.1.1` writes all three, prints what changed, and `bun run desktop:version
--check` (also part of `bun run lint`) prints the mismatch and exits 1. The
version is bare semver — the tag is `v0.1.1`, the version is `0.1.1`; a leading
`v` is rejected.

To cut a release:

1. `bun run desktop:version 0.1.1`, commit the change.
2. Tag it with the release notes and push the tag:

   ```bash
   git tag -a v0.1.1 -m "OpenVids 0.1.1 — what changed…"
   git push origin v0.1.1
   ```

   The annotated tag's message becomes the release notes (the manifest's `notes` and the
   GitHub Release).

3. `.github/workflows/release.yml` checks that the tag and the app version
   agree, builds with the release key, writes `latest.json` (platforms `darwin-aarch64` and `windows-x86_64`) and creates a
   **draft** GitHub Release holding `OpenVids_<v>_aarch64.dmg`,
   `OpenVids_<v>_aarch64.app.tar.gz` (+ `.sig`), `OpenVids_<v>_x64-setup.exe` (+ `.sig`) and `latest.json`.
4. Check the draft and publish it. The updater endpoint
   `releases/latest/download/latest.json` only resolves once the release is
   published — GitHub serves “latest” from published, non-prerelease releases,
   never from drafts. Windows updates run the NSIS installer in passive mode.

**Betas.** A beta is a tag with a pre-release version (`bun run desktop:version 0.5.0-beta.1`, tag
`v0.5.0-beta.1`). The same workflow builds it, but the release is a GitHub **pre-release**
carrying `beta.json` instead of `latest.json`, so the stable endpoint never sees it. Publishing
that release (not the draft) triggers `.github/workflows/beta-manifest.yml`, which validates
`beta.json` and uploads it to the service pre-release `channel-beta`
(`releases/download/channel-beta/beta.json`, a fixed address; it never moves back to an
older beta). The signing key and the app identifier are the stable ones, so a beta installs over a
stable build and back. Neither bundle needs a version transform: the NSIS template takes the
version as is (installer name, `DisplayVersion`, `FileVersion`), derives the numeric
`VIProductVersion` from `major.minor.patch` and compares versions with a semver-aware routine; the
macOS bundle writes it verbatim into `CFBundleShortVersionString` and `CFBundleVersion`. (MSI would
need a numeric pre-release; there is no MSI target.) See `RELEASE_CHECKLIST.md` › Beta channel.

The build signs updates with the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. In the workflow
`OPENVIDS_RELEASE=1` makes a missing key a hard error; on a development machine
`bun run desktop:build` without the key skips updater artifacts instead
(`scripts/tauri-build.mjs` adds a `--config` that turns them off) and says so.

To exercise an update locally, build with the updater pointed at a loopback feed
and sign with a throwaway key. The extra `--config` is appended last, so it wins
over `tauri.conf.json`; keep any of this out of the committed configs:

```bash
# A throwaway key pair (its public key goes into the --config below).
bun run --cwd apps/desktop tauri signer generate -w /tmp/openvids-test.key -p test

# Build the app as usual, with the updater pointed at a local feed.
TAURI_SIGNING_PRIVATE_KEY=/tmp/openvids-test.key \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test \
bun run --cwd apps/desktop build -- \
  --config '{"plugins":{"updater":{"endpoints":["http://127.0.0.1:8000/latest.json"],"dangerousInsecureTransportProtocol":true,"pubkey":"<the test public key>"}}}'

# Serve the feed: latest.json (version, notes, pub_date, darwin-aarch64 / windows-x86_64 signature/url)
# plus the archives from the bundle. Each signature is the .sig file's contents.
cd /tmp/ov-feed && python3 -m http.server 8000
```

## Choosing the runtime: bun, not Node

The sidecar runs on **bun**, not Node.

- Homebrew's `node` is a dylib-linked shim over `/opt/homebrew/Cellar`, so
  copying the binary into a `.app` drags a Cellar of dylibs with it or fails to
  launch. `otool -L` shows 14 non-system dylibs.
- A Node.js.org macOS tarball _is_ self-contained, but that adds a network
  download to every build.
- `bun` is a single self-contained Mach-O linking only against stock macOS
  system libraries (`libicucore`, `libresolv`, `libc++`, `libSystem`). It is
  also already this repo's package manager, so dev and production run identical
  JavaScript and the build needs no new download.
- The one native dependency that could have ruled this out — `sharp`, used for
  thumbnails — is a prebuilt N-API addon and loads fine under bun from a
  `node_modules` staged exactly as it is in the bundle. Verified: `sharp`
  produced a PNG from the staged tree.

## The runtime dependency set

`stage-runtime.mjs` derives it from `packages/cli/package.json`, filtering out
`workspace:*`. It does not hand-maintain a list, so it cannot drift. The CLI
bundles every `@hyperframes/*` workspace package into `dist/cli.js` (tsup
`noExternal`), so only its npm dependencies stay external. That comes to about
86 MB, against 1.5 GB for the repository's own `node_modules`.

The versions are not resolved from those ranges at release time: each staged tree is seeded with the
repository `bun.lock`, resolved with `bun install --lockfile-only`, checked so that every `name@version`
is one the repository lockfile already pins (staging fails otherwise; only the exact Windows dedupe
pins above are exempt), and then installed with `--frozen-lockfile`. What ships is what CI tested. The
sidecar, the CLI launcher and the agent runtime run Bun with `--no-install`, so a module that fails to
resolve is an error and never an npm download, and the sidecar sets `OPENVIDS_EMBEDDED_STUDIO=1` so a
project folder can never supply its own Studio. It also passes `OPENVIDS_HOME_URL` and
`OPENVIDS_HOME_SECRET` (see "Security"), so the sidecar can list the user's other projects.

A `package.json` named `hyperframes` is written beside the bundle. Two reasons:
the render pipeline stamps provenance by walking up from its own module URL
looking for a package.json whose name matches
`/^(?:hyperframes|@hyperframes\/[^/]+)$/`, and `cli.js` is ESM, so the nearest
`package.json` needs `"type": "module"`.

The staged `bun` is chmod'ed `0755` explicitly. `tauri-build` copies resources
with `fs::copy`, which propagates the mode and then re-copies on the next
build; overwriting a `0555` destination fails with `EACCES` on macOS and
surfaces as an opaque `Permission denied` from the build script.

## Agent runtime

Agent Chat is backed by a **separate local Bun process**, not the Studio sidecar and not the
browser bundle. `packages/studio-server` (inside the Studio sidecar) owns a gateway at
`/api/projects/:id/agent/*` that lazily spawns `runtime/agent-runtime/main.ts` with the staged `bun`,
proxies to it over loopback with a per-launch bearer token (never exposed to the webview), restarts
it with back-off if it dies, and kills it on shutdown; the runtime also exits when its parent pid
disappears. If the runtime is missing or crashes the editor keeps working and the Chat panel shows
"Agent unavailable". See `packages/agent-runtime/README.md` for the process contract.

The runtime runs the Director, the per-chat specialists (Editor, Vision, Motion Designer, Research,
Audio) and the Jev worker. Chat state stays in each project (`.hyperframes/agent/`); per-user agent
settings live outside the app bundle in `~/.openvids/agent/` (`%USERPROFILE%\.openvids\agent` on Windows —
Rust `home_dir()` resolves exactly like Node `os.homedir()`, so both sides agree; override with
`OPENVIDS_AGENT_SETTINGS_DIR`): `settings.json` and `jev-credentials.json`, which holds a user secret
(Jev API key). Both are mode 0600, are never staged or bundled, and survive app updates.

`stage-runtime.mjs` stages it as `runtime/agent-runtime/` (sources, the vendored protocol package and
its own `bun install` of the OMP SDK), bundled through `tauri.prod.conf.json`. **Size:** the OMP SDK
brings native and onnx packages; unused voice/memory engines are pruned at staging, leaving about 500 MB
(mostly `@oh-my-pi/*` natives, 277 MB; before pruning `onnxruntime-node` and `onnxruntime-web` added
434 MB) against 194 MB for the Studio runtime. Override discovery with `OPENVIDS_AGENT_RUNTIME_ENTRY` (absolute path to `main.ts`)
and `OPENVIDS_AGENT_BUN`. `OPENVIDS_SKIP_AGENT_RUNTIME=1` stages an empty `agent-runtime/` (so the
Tauri resource mapping still resolves) without sources or dependencies; Chat then reports "Agent unavailable".

## Project tabs

Several projects stay open at once, each in its own tab: it is the only window model. Each open
project is a slot in `AppState.tabs` (`tabs.rs`), keyed by `recents::project_key` (16 hex of the SHA-256
of the folder path, never the folder name): its own Studio sidecar (own port, so own origin,
`localStorage`, IndexedDB and SSE connection budget, own Chrome and agent runtime, roughly 500 MB) and its
own child webview of the one window (`tab_webviews.rs`, Tauri's `unstable` multiwebview; the window's
`main` webview keeps the Projects page). Switching shows one webview and hides the others. Opening a
project that already has a tab focuses it; closing a tab (`POST /api/tabs/close`, Studio's back button
only switches to the Projects tab) stops that project's sidecar group alone, after asking when a render
(queued ones count) or an agent turn runs in it. Opening a seventh project asks first (soft limit). Quit and
updates take every project out of the state and reap all sidecars together; on Windows each sidecar has its
own kill-on-close Job Object (`proc.rs`). Trusted origins, downloads, render links, thumbnails, fork/duplicate
refusals, rename/trash refusals and the updater's activity check all work over every open project.
The pages draw the tab strip from `GET /api/tabs`; Studio (another origin, no home token) may call exactly
that and `POST /api/tabs/{activate,close,fork}` without the token. Every open project tab has a Fork button
(`POST /api/tabs/fork`): the same background fork as the card menu's, after which the window shows the
Projects page with the fork's progress and Cancel and then opens the fork as a new tab. In `desktop:dev` every project is served by
the one Vite server (same origin), so two open folders with the same name are refused. Native menu:
⌘W closes the tab (the window on the Projects page), Ctrl+Tab / Ctrl+Shift+Tab cycle tabs.

## Design-system library

The library of design systems lives in `~/.openvids/design-systems/` (`OPENVIDS_DESIGN_SYSTEMS_DIR` overrides it; the same `home_dir()` rules as the Asset Search policy). The Studio server (`packages/studio-server/src/design`) creates and updates systems; the Projects page only **reads** them, **renames** and **deletes** them, and **copies** one into a new project. The shell never passes the variable on: the Studio sidecar inherits the environment, and both sides default to the same folder. Layout and contract: `packages/agent-protocol/src/design.ts`.

- **Reader** (`design_library.rs`): `list()` reads only `<id>/meta.json` (schema `openvids.design-system-meta/1`), skips every folder that is not a well-formed entry (unreadable or garbage `meta.json`, a linked folder, an id that is not the folder name, does not match `^[a-z0-9][a-z0-9-]{0,47}$` or is a name Windows reserves for a device: `con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`, like the protocol's `isDesignSystemIdText`), newest `updatedAt` first. `detail()` adds the fonts, the transition count and the version count read from the manifest embedded in `system.html` (`<script type="application/json" id="openvids-design-manifest">`, found by a tolerant scan, not an HTML parser). `file()` serves only `system.html`, `tokens.css`, `thumbnail.svg`, `logo.<ext>` and `fonts/<file>`: no `..`, no absolute or drive paths, no hidden or nested names, and the real path of a regular file must stay inside the system's folder (a symlink never leads out).
- **Writer**: a rename edits only `name` and `updatedAt` of `meta.json` (every other field, known or not, stays; written beside the file and renamed over it); a delete renames the folder out of the listing, then removes it. Both run under the library lock.
- **Lock** (`design_lock.rs`): `<root>/.lock`, the protocol of `packages/studio-server/src/history/ownerLock.ts`, so Studio sidecars and the Projects page exclude each other. The file holds `<pid>` or `<pid> <start key>`, claimed by hard-linking a draft file; a dead owner's lock is removed under `<root>/.lock.evict`, re-reading the owner first. The start key is what TypeScript computes (`ps -o lstart=` with `TZ=UTC` on macOS, `/proc` boot id + start time on Linux); on Windows this side cannot compute TypeScript's key, so it writes the pid alone and treats any live pid as the owner — a live process's lock is never evicted. A second writer waits up to 5 s and then answers `busy` (503). Checked against the TypeScript implementation both ways (a TS lock holds Rust out, a hard-killed TS lock is evicted, a Rust lock holds TS out).
- **Snapshot** (`design_snapshot.rs`): `<project>/design/{system.html, tokens.css, logo.*, fonts/*, design.json}`, copied verbatim from the library's top level (no thumbnail), `design.json` last — `{schema: "openvids.project-design/1", id, version, name, attachedAt (epoch ms), createdAt, unknownLicenses, nonPortableFonts}` in that key order, 2-space pretty JSON with a trailing newline, the file Studio's attach writes; `createdAt` is the library entry's (`meta.json`) `createdAt`, the lineage of the system the id meant, so a deleted and recreated id is not mistaken for the same system. It is built in `<project>/.hyperframes/design-staging-<pid>-<random>` (where Studio stages too, so the preview signature and the history never see it; `.hyperframes/` is removed again when this call made it and it is empty) and swapped in as a whole (a previous `design/` is put back on failure); the library is held under its lock while it is read; a manifest whose `version` differs from `meta.json` (an interrupted update) is refused as `conflict`. Nothing outside `design/` is written.
- **New project** (`POST /api/create` with an optional `designSystemId`): after the project is scaffolded and before Studio opens it, the snapshot is copied and `<link rel="stylesheet" href="design/tokens.css" />` is added as the last child of the root `index.html` head (compositions only pick the system up through that link; skipped when the template already links it). A failure never fails the creation: the answer is `{ "opening": true, "designWarning": "<message>" }` and no half `design/` is left. A malformed id is refused (400 `design_system_invalid`) before anything is created. `POST /api/open` takes an optional `design: "create"` with an optional `designSource` (`scratch`, `project`, `video` or `website`; anything else is dropped), which become the Studio URL parameters `openvidsDesign=create` and `openvidsDesignSource=<source>` (`sidecar::DesignIntent`, `with_design_intent`); without `design: "create"` neither is sent.
- **Routes** (`home_design.rs`): token-guarded JSON `GET /api/design-systems`, `GET|PATCH|DELETE /api/design-systems/:id`; and open GETs (the `/thumb/<file>` precedent: an `<img>`/`<iframe>` `src` cannot send the token header) `/design-files/<id>/thumbnail.svg`, `/design-files/<id>/system.html`, `/design-files/<id>/logo.<ext>` and `/design-files/<id>/fonts/<file>` — nothing else (not `tokens.css`, `meta.json` or `versions/`). The file answers carry `Content-Security-Policy: sandbox allow-same-origin; default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:` and `X-Content-Type-Options: nosniff`, and **no CORS header at all**: the page frames the showcase with `sandbox="allow-same-origin"` (no `allow-scripts`, so no script can run in the frame or when a file is opened on its own), the framed document keeps this server's origin, and its font requests are plain same-origin loads. A request from any other origin (a website, the opaque `null`) is refused by the Host/Origin check (403), the same on every `/api` and `/design-files` route. Errors are `{ "error": { "code", "message" } }`: `invalid_request` 400, `not_found` 404, `conflict` 409, `invalid_system` 422, `busy` 503, anything else 500.
- **Projects page UI** (`home_page/design.js`, `design-sheets.js`, `design.css`): a «Design systems» section between Start and Recent (hidden while Recent is searched, and, with no projects and no systems, entirely) with cards — `<img>` of `/design-files/<id>/thumbnail.svg`, name, version, palette swatches (only plain `#hex` / `rgb()` / `hsl()` / `oklch()`-style values reach a style attribute), display font, a source badge (`scratch`/`project`/`video`/`website`/`external_project`) and warning chips for `unknownLicenses` ("checked before export") and `nonPortableFonts` ("system font, another computer may not have it"). Cards are a roving-tabindex list: ↵ view, F2 inline rename (`PATCH {name}`, Esc cancels, focus stays), Delete / ⌘⌫ a confirm sheet ("projects that use it keep their own copy", then `DELETE`), ⋯ / right-click / Shift+F10 the menu. **View** is a large sheet: `/design-files/<id>/system.html` in an `<iframe sandbox="allow-same-origin">` (no scripts; same origin, so its font requests need no CORS) beside the fonts (license, "not portable", "similar" for guessed fonts) and the transition / version counts from `GET /api/design-systems/:id`. **Create** picks a source and a project (recent, not missing) and calls the ordinary open with `design: "create"` + `designSource` (`scratch`/`project`/`video`/`website`); Studio shows its own dialog. The New Project sheet gets an optional «Design system» picker (None by default) that sends `designSystemId`; a `designWarning` in the answer is shown as a notice while the new project opens in its tab. `apps/desktop/tests/design-section.test.mjs` runs the scripts in happy-dom against a fake server.

## Voice settings

Voiceover (cloud text-to-speech with the user's own key) keeps its global state in `~/.openvids/voice/` (`OPENVIDS_VOICE_DIR` overrides it; same `home_dir()` rules). The Studio server (`packages/studio-server/src/voice`) owns synthesis; the Projects page's Settings › Voice (`home_page/settings-voice.js`) edits the same files through `voice_settings.rs` + `home_voice.rs`. Formats are the contract of `packages/agent-protocol/src/voice.ts`:

- `providers.json` (`openvids.voice-providers/1`): per provider `model`, `agentRules`, and for the custom server `baseUrl` + `voice`; unknown keys are kept, an unreadable file is copied to `.bak` before it is replaced. The defaults table is duplicated in `packages/studio-server/src/voice/store/providers.ts`: change both together.
- `api-keys.json` (`openvids.voice-keys/1`): owner-only (0600 in a 0700 folder), atomic; a key never appears in an answer or an error.
- `presets.json` (`openvids.voice-presets/1`): list, rename, delete; `GET /api/voice/audio/<64-hex>` plays a preset's cached sample (an entry counts only when both `cache/<hash>.wav|mp3` and its `.json` exist).
- **The custom server address is written only here.** Studio's `PUT /api/voice/providers/custom` refuses `baseUrl` (`desktop_only`), because composition code shares Studio's origin and could otherwise point the stored key at its own host. The shell makes no network call for voice: key checks and samples happen in Studio.

## Security

The webview gets no native access beyond moving its own window; on Windows only, the
page-drawn caption buttons add minimize, maximize and close (`capabilities/windows-frame.json`).

- `withGlobalTauri` is `false`, so there is no `window.__TAURI__`.
- On macOS the window uses an overlay titlebar (traffic lights over the pages' own 52 px
  titlebar). On Windows the window is frameless (`decorations(false)`): the pages draw their own
  minimize / maximize / close buttons and `OPENVIDS_SYSTEM_FRAME=1` falls back to the OS frame.
  `capabilities/main.json` grants the loopback pages
  (`remote.urls`: `http://127.0.0.1:*`, `http://localhost:*`) exactly
  `core:window:allow-start-dragging` plus minimize / toggle-maximize / close and maximize-state reads
  for those page-drawn caption buttons (and `allow-internal-toggle-maximize`), so
  `data-tauri-drag-region` titlebars drag and double-click-zoom the window.
  No other IPC command is reachable.
- The Projects page's own agent runtime (`agent_proxy.rs`): the model catalog
  and agent defaults are needed before any Studio sidecar exists, so the home
  server lazily spawns the same runtime with a per-launch bearer token that
  never reaches the webview, and proxies only `/v1/models` and `/v1/settings`
  behind the home token.
- OS file drops on the Projects page still arrive as HTML5 drops (see below);
  the page posts the dropped _names_ and Rust reads the real paths off the
  macOS drag pasteboard (`drop_paths.rs`), keeping only matching names. On Windows v1 there is
  no pasteboard equivalent, so drops resolve nothing and the page stays file-picker-only
  (it reports each dropped name via `unresolved`/`skipped` toasts). Files
  are copied into `<project>/assets/` on Start — nothing is
  streamed through JavaScript.
- No `fs`, `shell`, `process`, `http` or `dialog` plugin is installed. The
  folder picker is `rfd`, called from Rust — a Tauri dialog plugin would have
  put a dialog capability in the bundle, and picking a folder is the one
  privileged action the app performs.
- Trash uses the `trash` crate's `NsFileManager` backend on macOS
  (`trashItemAtURL`), not its default Finder AppleScript: the script path
  shells out to `osascript` and never returns without a GUI session to
  answer it (observed live: every `/api/trash` request hung until the
  client timed out), while `trashItemAtURL` completes synchronously. The
  trade-off is no Finder "Put Back" undo entry. On Windows the crate default moves
  the folder to the Recycle Bin via `IFileOperation`. Copy follows the same split:
  the UI says Finder/Trash on macOS, File Explorer/Recycle Bin on Windows (`.win` locale keys).
- The servers bind `127.0.0.1` only.
- The Studio project URL carries an `openvidsHome` query parameter naming
  the home origin, so the header can offer its back button. Studio validates
  it before navigating: only `http://127.0.0.1:<port>` and
  `http://localhost:<port>` origins are accepted — remote hosts, `file:`,
  `javascript:`, credentials, paths and query strings are rejected and the
  logo stays. The value is built by Rust from a bound loopback port, and the
  query survives View > Reload; the prod Hono server ignores it via its SPA
  fallback.
- The home-screen API is token-gated: a 128-bit per-launch token
  (`home_auth::HomeToken`, OS randomness) is injected into the served HTML
  and required as `X-OpenVids-Token` on every `/api` request; `Host` must
  name the server and a present `Origin` must match it, so a foreign website
  that guesses the port still cannot trigger pickers or deletes. Plain
  page/thumbnail GETs stay open so `<img>` tags load without scripting. Three
  narrow exceptions:
  `GET /api/menu/about` (static strings, read by the title-bar menu with a plain
  `fetch`); `POST /api/report/open` (opens or focuses the bug-report window; the
  Studio page has no token, and a loopback `Origin` is still required); and, on the
  Windows custom frame only, the Studio menu (see "Menus and shortcuts") — the server
  answers its own-origin requests for `open_project`, `welcome`, `check_updates` and
  the About read (plus their CORS preflights) only, and only while that Studio
  server is the open project.
- `/internal/*` is the Studio sidecars' door to the recents list (`home_internal.rs`), used by
  `#` project mentions in Agent Chat: `GET /internal/projects` →
  `{ "projects": [{ "key", "name", "openedAt", "dir" }] }` (`key` is the Projects page's recent key, 16
  hex chars of the folder-path hash; `openedAt` epoch ms; most recent first; folders that no
  longer exist are skipped, checked outside the home lock; `dir` comes with the list so the sidecar
  needs no request per project) and `GET /internal/projects/<key>` → `{ "key", "name", "dir" }`, or
  404 (a key must match `^[0-9a-f]{16}$`; a path is never accepted). Auth is a second
  per-launch secret (256 bits, OS randomness, `home_internal::InternalSecret`) sent as
  `X-OpenVids-Secret`, compared in constant time; missing or wrong → 401 with nothing else
  revealed. These routes accept only that secret (the page token opens nothing here) and the
  secret opens no `/api/*` route; any request carrying an `Origin` header is refused (403), as
  is a `Host` that does not name the server, and no CORS header is ever written. Percent-encoded
  spellings (`/%69nternal/…`) are decoded once, like every other check, and get the same decision.
  The shell hands each Studio sidecar `OPENVIDS_HOME_URL` (`http://127.0.0.1:<home port>`) and
  `OPENVIDS_HOME_SECRET` in its env (`sidecar::studio_command`); the secret is never injected
  into a page. `dir` is for the sidecar's own file reads and is never sent to a browser.
  `desktop:dev` has no sidecar: Vite starts before the shell, so `serve-studio-dev.mjs` gives it
  `OPENVIDS_HOME_FILE=packages/studio/data/home-link.json` (gitignored) and the shell writes
  `{ "url", "secret" }` there (owner-only, replaced atomically) when its home server binds; the
  script deletes a stale file first, and the Studio server re-reads it on each call.
- Home pages (Projects, Settings, Report) are served with
  `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`,
  so a foreign page cannot frame them (Settings is framed by the Projects page of
  the same origin).
- The main window's top-level navigation is not restricted to the loopback
  servers: wry's navigation handler (0.57) receives only a URL string and, on macOS, is
  called for subframe loads as well as the main frame, so a deny-list for unknown
  origins would also cancel external iframes a composition embeds. A navigated-away
  page still has no IPC beyond window dragging. `target="_blank"` links and
  `window.open` never navigate the window: `shell_links` sends web and mail links to the
  default apps.
- `dragDropEnabled` is **off**. Tauri otherwise intercepts OS file drops and
  re-emits them as its own drag-drop event, so the webview never sees the HTML5
  drop — and Studio imports assets through exactly that
  (`e.dataTransfer.files` in `AssetsTab`, `FileTree`, `useStudioContextValue`).
  With the default, Finder/Explorer → Studio media import silently stops
  working.
- Devtools are on in debug builds and off in release.
- `127.0.0.1` is a secure context, so the `navigator.clipboard` calls Studio
  makes in six components keep working. Another reason not to use a custom
  scheme.

`app.security.csp` was removed. Tauri only applies it to documents it serves
itself — it is baked into the embedded asset map at build time
(`tauri-codegen`'s `EmbeddedAssets`) and applied as a response header by the
`tauri://localhost` protocol handler (`tauri/src/protocol/tauri.rs`) and the
isolation pattern. The window here loads `WebviewUrl::External`, so the
document is fetched straight from the Studio server and Tauri is not in the
response path. Verified in the running webview: `document.querySelectorAll
('meta[http-equiv]')` is empty and Chrome reports the same for the same build,
so the policy was never applied. Keeping it would have been a security
guarantee the app did not actually provide.

`frontendDist` stays: Tauri's release codegen checks that it names a real
directory. Debug `cargo check` uses `devUrl` and skips embedding those assets,
so it does not prove this check. The tracked `dist/index.html` placeholder makes
a fresh clone buildable without a separate frontend build; the webview never
displays it.

## Teardown

Two mechanisms reap the sidecar, and they cover different failures. All owned spawns
(sidecar, agent runtimes, CLI runs, installers) go through `proc.rs`, so the platform
behavior cannot drift between owners.

**Normal quit: `proc::terminate`.** On macOS/Linux the child is put in its own
process group, and on every exit path — window close, Cmd+Q, a panic on the
main thread — `StudioServer::drop` sends `SIGTERM` to the group, waits three
seconds, then sends `SIGKILL` to whatever is left. The `ExitRequested`/`Exit`
handler also drops the state explicitly, while the child can still be waited on.
On Windows there are no process groups or signals: children spawn with
`CREATE_NO_WINDOW` (no console flash) and are assigned to a kill-on-close Job
Object (`KILL_ON_JOB_CLOSE`), so closing the last job handle — normal quit, crash,
or a kill from Task Manager — kills bun, Chrome and FFmpeg outright. There is no
graceful SIGTERM step on Windows (the `serve.mjs` signal handlers only run on Unix);
half-written Chrome profiles are swept on next start (`sweepOrphanBrowsers`).

Re-measured on macOS in the ad-hoc-signed `OpenVids.app` with `--foreground` in place:

```text
[openvids] killpg(<pgid>, SIGTERM) -> 0
```

so the group _is_ signalable from the running app and the graceful-then-fatal
sequence runs to completion. After quitting through the app menu, no
`serve.mjs`, no `hyperframes/cli.js`, no Chrome, and no listener on the port
remain. An earlier note in this file claimed `EPERM` here; that was measured
before `--foreground` was added, when the CLI re-exec'd itself detached, so the
pid the app held was not the process group the app believed it owned. With
`--foreground` the child is the CLI itself, in the app's group, and the signal
works.

**`sidecar/serve.mjs` is the backstop.** The app can only reap what it owns
while its own shutdown code runs. A `SIGKILL` of OpenVids, a crash, or a
logout never reaches `Drop` at all (on Windows the Job Object already covers the
kill cases; `serve.mjs` still covers the paths where the launcher outlives the app).
The launcher therefore records
OpenVids' pid and, while `process.kill(pid, 0)` — a permission probe, not a
signal — keeps succeeding, leaves the server alone; when the probe starts
failing the app is gone and the server is killed outright (`taskkill /T /F` on
Windows, signals on Unix). The launcher does
not exit until the server has actually been reaped.

**`--foreground` is load-bearing for both.** Without it the CLI reads a
non-TTY stdin as "run this in the background", re-execs itself detached, and
the original process exits — leaving a server the app cannot signal and the
launcher cannot supervise. `--foreground` is the CLI's own documented flag for
exactly this.
The loopback port is chosen per-launch, so a reaped server releases it
immediately.

## Known limitation: Code-tab preview can remain stale

Studio autosaves Code-tab edits to the project file, but its embedded-mode
preview does not reliably live-reload the changed source. The same behaviour
reproduces in upstream Chrome without OpenVids. **View > Reload** shows the
saved change; it does not perform an additional save.

## Known limitation: the Studio loopback API is unauthenticated

The Studio server on `127.0.0.1` exposes project file read/write/delete, render
spawning and media proxy transcoding with no token. Any other local process can
reach that port while OpenVids is running. Web pages cannot: the server checks the
`Host` header (DNS rebinding) and refuses cross-site or foreign-`Origin`
state-changing requests (`packages/studio-server/src/helpers/hostGuard.ts`, used by
the production host and the dev host alike).
The port is chosen per-launch and is not guessable in advance, but it is
discoverable (it is in the window's own origin; on macOS `lsof` lists it, on Windows `netstat -ano`).

The Projects home-screen API does not share this limitation: it mints a
per-launch token (see Security above). The Studio server itself has no token;
adding one would belong in `@hyperframes/studio-server`.

## Known limitation: drag-and-drop onto the Projects page (Windows)

The first Windows version is file-picker-only: there is no drag-pasteboard equivalent, so an OS drop onto the Projects page resolves no paths (the composer reports each dropped name via `unresolved`/`skipped` toasts instead of adding it). Use the file picker. macOS resolves drops through the drag pasteboard (`drop_paths.rs`).

## Known limitation: the home directory

`~/.openvids` (preferences, agent settings, the Asset Search policy, the design-system library, the Windows FFmpeg download) lives under the same home on both sides: Rust `home_dir()` resolves exactly like Node `os.homedir()` — `USERPROFILE` on Windows (the OS profile directory as fallback), `$HOME` elsewhere. `OPENVIDS_APP_DIR` moves the app dir.

## Rendering, thumbnails and FFmpeg

Rendering and thumbnails need a real Chrome. OpenVids ships none: the Studio runtime resolves one
through the existing `findSystemChrome()` probe, which honours
`PRODUCER_HEADLESS_SHELL_PATH` and otherwise looks in the puppeteer cache and
at well-known system paths. On a machine with Chrome installed, thumbnails and
renders work; the app's System check also offers an Install button (`hyperframes browser ensure`
into the CLI cache). Bundling a headless shell is a packaging decision that was left
out of this change.

FFmpeg is resolved per spawn as: explicit `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH`
overrides first, then the app's managed Windows download (`%USERPROFILE%\.openvids\ffmpeg`, via
`managed_env()` into those same variables at each child spawn), then `PATH` (plus the project-local
`.hyperframes/bin` and the well-known Unix dirs). On macOS the Install button runs
`brew install ffmpeg`; on Windows it downloads the official gyan.dev release-essentials build. The URL and the
SHA-256 of that exact archive are pinned in the binary (`WINDOWS_BUILD_URL` / `WINDOWS_BUILD_SHA256` in
`ffmpeg_install.rs`): the bytes are refused unless they hash to it, before anything is extracted, and no
environment variable or network response can change either (test builds alone may aim at a loopback server).
Only `ffmpeg.exe` + `ffprobe.exe` (and the license text) are extracted, into a temp dir that is renamed over the
managed dir — only after an explicit click, never on its own. The whole download-and-swap holds an exclusive
lock (`ffmpeg.lock` beside the managed dir; a second install is told one is in progress). A crash between the
two renames is recovered at the next start, before any sidecar runs, under the same lock: a missing managed dir
gets the newest complete `ffmpeg-<n>.bak` back, a complete one makes backups garbage, a working `.tmp` is
removed — never through a link, and never the only complete copy.
