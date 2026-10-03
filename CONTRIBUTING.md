# Contributing to OpenVids

Thanks for your interest. Bug reports, fixes and focused improvements are welcome. For a larger
change, open an issue first so the approach can be agreed before you write the code.

Everyone taking part in the project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need [Bun](https://bun.sh), a Rust stable toolchain, Node.js 22+, FFmpeg with ffprobe on
`PATH` (on Windows an FFmpeg from the app's download button also works for running the app),
a Chrome the CLI can drive, and [Git LFS](https://git-lfs.com) (render test fixtures are
stored in LFS).

macOS: Xcode Command Line Tools (or Xcode). Windows: the MSVC Build Tools (C++ workload,
for the Rust/MSVC linker), Rust with the MSVC target, and a WebView2 runtime (the installer
bootstraps it; for `desktop:dev` use an evergreen WebView2 from Windows Update or the Edge installer).
CI runs on both macOS and Windows.

Symlink-based tests need symlink privilege (Developer Mode or elevation) on Windows; without it
they skip. The desktop duplicate/copy paths have their own privilege-free unit tests.

```bash
git lfs install
git clone https://github.com/bazodev/open-vids.git
cd open-vids
bun install
bun run desktop:dev
```

OpenVids uses Bun. Do not use npm or pnpm, and do not commit their lockfiles. See
`apps/desktop/README.md` (Prerequisites, Teardown, Rendering/FFmpeg) for the desktop details.

## Before you open a pull request

Read [AGENTS.md](AGENTS.md) first: it is the canonical description of the architecture and its
constraints. `packages/studio/AGENTS.md` and `packages/agent-runtime/README.md` cover those two
packages in more detail.

Run the checks that CI runs, plus the ones that cover what you changed:

```bash
bun run build            # build all packages
bun run desktop:check    # cargo check for the Tauri shell
bun run lint             # workspace checks + oxlint + skills lint
bun run format:check     # oxfmt
bun run typecheck        # typecheck every workspace
bun run test             # unit tests across workspaces
```

Format with `bunx oxfmt <files>` and lint with `bunx oxlint <files>`. The repository does not use
eslint, prettier or biome.

## Conventions

- TypeScript: no `any` and no `as T` assertions. Use type guards and narrowing.
- Rendering must stay deterministic: no `Date.now()`, no unseeded `Math.random()`, no network
  fetches at render time.
- Studio stays on a loopback HTTP origin, same-origin with the composition iframe. Do not move it
  to `tauri://` or add a second editor UI.
- Project and source files on disk are the single source of truth. New long-lived state must be
  recoverable after a hard kill.
- The webview gets no native access beyond moving its window. Privileged work goes through the home
  or Studio HTTP APIs, not through new Tauri capabilities.
- Add or update tests next to the code you change.

## Localization

User-facing text lives in `locales/` (`locales/en.json` is the source of truth,
`locales/index.json` is the language list). Run `bun run locales:check` after changing them.

### How to add a language

1. Add `locales/<code>.json` with the same flat dot keys as `locales/en.json`, and one line
   with `{ "code": "<code>", "name": "<native name>" }` in `locales/index.json`.
2. Use the language's native name for `name` (for example `"Deutsch"`, not `"German"`).
3. Run `bun run locales:check`.

Translations may be partial: keys missing from a locale fall back to the English string
(the checker reports them as warnings), but keys that are not in `en.json`, messages that
do not parse, and arguments that differ from `en` fail the check.

### How to add a string

1. Add a flat dot key grouped by area: `area.component.purpose` (for example
   `studio.statusBar.hint.play`). Keep keys stable; never reuse a key for a different sentence.
2. Write ICU MessageFormat: plurals need at least `one` and `other` (Russian also needs `few`
   and `many`), and use `#` for the count (for example
   `{count, plural, one {# project} other {# projects}}`).
3. Never assemble sentences from fragments or concatenate pieces: pass values as params and let
   each locale order them (for example `{fps} fps`, not `"fps: " + fps`).
4. Render through `t()`: in Studio via `useTranslation` from `src/i18n`, on the home page via
   `OVI18N.t()`.
5. Run `bun run locales:check`.

## Commits and pull requests

- Keep a pull request to one topic and describe what changed and how you checked it.
- Commit subjects follow `type(scope): summary`, for example `fix(studio): keep playhead on trim`.
- Do not commit secrets, personal media or generated output (`renders/`, `dist/`,
  `apps/desktop/runtime/`).
- Media and other third-party assets need a license that allows redistribution; record the source in
  [CREDITS.md](CREDITS.md).

## Security issues

Do not file them as public issues. See [SECURITY.md](SECURITY.md).

## License

OpenVids is licensed under [Apache-2.0](LICENSE). By contributing you agree that your contribution
is licensed under the same terms.
