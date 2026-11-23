# @hyperframes/agent-runtime

The OpenVids Agent Runtime: a **separate local Bun process** that owns project-scoped chats,
turns, checkpoints and the OMP-backed Director. It is never imported by the Studio browser bundle
or by `studio-server`/`cli`; those reach it over loopback HTTP through the gateway in
`packages/studio-server/src/agent/`.

```
Studio UI ──▶ /api/projects/:id/agent/*  (studio-server gateway, same origin)
          ──▶ http://127.0.0.1:<port>/v1/*  (this process, bearer token per launch)
          ──▶ AgentBackend port (src/backend.ts)
          ──▶ OMP adapter (src/omp/**)  ──▶ OMP SDK ──▶ providers
```

The wire model (chats, turns, messages, events, editor context, references) is owned by
`@hyperframes/agent-protocol`. Nothing outside `src/omp/` may import `@oh-my-pi/*`.

## Process and security

- Spawned lazily by the gateway on the first agent request; restarted lazily (with back-off) if it
  dies. Editing never depends on it: an unavailable runtime yields `503 runtime_unavailable` and the
  Studio chat panel shows "Agent unavailable".
- While the gateway waits out the back-off after a crash it answers at once, `503 runtime_restarting` with `Retry-After` and
  `details.retryAfterSeconds`, and starts the replacement in the background (the request is not forwarded). A request gets
  60 s to receive its response headers; past that the gateway probes the runtime's health (3 s): a runtime that still
  answers keeps running (`504 runtime_unavailable`, the request is not repeated), one that does not is stopped, so the next
  request starts a fresh one (`503 runtime_restarting`).
- Binds `127.0.0.1` only. Every request needs `Authorization: Bearer <OPENVIDS_AGENT_TOKEN>`; the
  token is generated per launch and known only to the gateway and this process. The browser never
  sees the token or the port.
- The project is selected per request by gateway-set headers (`x-openvids-project-id`,
  `-project-dir`, percent-encoded since ids and folders may be non-Latin, and `-studio-origin`).
  The runtime only ever touches the directory it is handed.
- Env: `OPENVIDS_AGENT_TOKEN` (required), `OPENVIDS_AGENT_PORT` (default `0`),
  `OPENVIDS_AGENT_PARENT_PID` (exit when that process disappears).
- Prints one stdout line, `{"openvids-agent":"listening","port":N,"protocolVersion":1}`.

## Persistence

`<projectDir>/.hyperframes/agent/chats/<chatId>/events.jsonl` is a log of protocol
events (append-only while a turn runs); chat state is `foldChatEvents(log)`. It holds the main conversation and every delegated
run's thread (task message + reply, keyed by `runId`), so specialist views reopen after a restart.
`backend/` beside it is the Director's OMP session directory and `agents/<specialist>/` each
specialist's (resume keeps model context per agent); Jev sessions are ephemeral. `.hyperframes/` is
already excluded from project history, the file watcher and the project signature, so chat files are
never part of a checkpoint; the path guard also forbids it. A crash leaves a running turn (and its
runs) in the log; on load the runs and the turn are closed as `interrupted` and the checkpoint is
recovered from project history.

- **Compaction.** When a turn ends (`turn.completed/failed/aborted`) the chat's log is rewritten without its streaming
  chatter: the text and thinking deltas of a part become one delta, and the updates of one activity, permission, question,
  offer, usage report, QA or plan state become the last one (`src/store/compact.ts`). The result is written beside the log,
  flushed and renamed over it, and only used when it folds to exactly the state in memory (any difference keeps the old log).
  Sequence numbers are kept, so a client that reconnects from the middle of the old range sees a gap and resyncs from the
  snapshot.
- **Lazy loading.** Each chat keeps `summary.json` next to its log: the chat summary, the log size it describes and a
  `recoverable` flag (a running turn or an unclosed checkpoint). At start the runtime lists chats from those summaries
  only; a summary that is missing, stale (the log has a different size) or `recoverable` makes that log be read in full.
  A chat first asked for (`get`, `emit`, `subscribeChat`) is read and folded then. `ChatService.recoverableChatIds()` names
  the chats crash recovery has to look at without loading any other.
- **One owner per project.** A runtime process takes `<project>/.hyperframes/agent/owner.pid` (pid plus the process start, a
  dead owner's file is taken over) before it serves the project's chats; another live process gets `409
project_served_elsewhere` instead of writing events with the same sequence numbers. `src/processLock.ts` is the lock.
- **Project usage journal.** `<project>/.hyperframes/agent/usage.jsonl` (`src/usage/`) records what the project's agents
  used, because the chats cannot: a deleted chat takes its usage along and a copied chat doubles it. When a turn ends
  (`completed`, `failed`, `aborted`, and `interrupted` when crash recovery closes it) `ChatService` calls
  `UsageJournal.recordTurn`, which appends one line per agent: the Director (`runId: null`) and each run, with the chat's id
  and title, `turnId`, `runId`, agent, model, `UsageTotals` and the turn's end time (`UsageEntry`, `agent-protocol/src/usageReport.ts`).
  A run the runtime started itself (the Vision run of a Render QA pass, `titleCode: render_qa_pass`) is marked
  `internal: "render_qa"` and reported on its own row, like Jev. A line is one append (a half-written last line is skipped on
  read and cut off by a newline before the next append); the later line of a `turnId` + `runId` wins, so writing a turn again
  never counts it twice, and a turn found in a copied chat counts once. When the journal exists it is reconciled with the chat logs on load: a turn that ended without its lines landing (the process
  was killed between the turn's last event and the append, or the append failed — a failed write makes the next use reload and
  reconcile every chat) is appended from its log; chats whose stored summary is older than the journal's newest line are not
  read. The fork cut-off applies to every write, recovery's included, so a pre-fork turn closed in a fork is never counted
  there. A turn closed as `interrupted` by crash recovery is dated by what it did before the crash, not by the recovery day,
  and the running turn's live figures replace what the journal holds for it. With no journal (a project from before it, a copied
  project) it is rebuilt once from the chat logs (`FileChatStore.peek`, which never repairs a log the writer may be appending
  to) and written whole through a temp file and a rename; turns that started before the fork marker
  (`agent/fork.json` `{forkedAt}`) belong to the original project and are skipped, so a fork starts from zero.
  `GET /v1/usage?since=&until=` (epoch ms; through the gateway `…/agent/usage`) answers a `UsageReport`: total, by agent, by
  model, by chat (deleted chats named by the title they had), plus what the running turn has used so far
  (`live`). Costs are the providers' own: a null `cost` is never counted as zero (`UsageSlice.unpricedTokens` carries the
  tokens without a cost, so a cost with `unpricedTokens > 0` is a lower bound and a null one is "tokens only"). Costs are
  summed as whole nano-dollars so the parts add up to the total exactly. Nothing else in OpenVids prices work (speech is a
  local Kokoro model, transcription is local, stock libraries are free; the title generated for a new project is not
  metered), so Studio labels the figures "Agent costs".
- `DELETE /chats/:chatId` goes through `FileChatStore.deleteChat` (log, summary and every agent's session directory).

Global (per-user) agent settings — Director defaults, per-specialist defaults, Jev, Autonomy — live in
`OPENVIDS_AGENT_SETTINGS_DIR` (default `~/.openvids/agent`): `settings.json`, `jev-credentials.json` and
`provider-credentials.json`, all mode 0600 (the directory 0700), re-read from disk on every access so several runtime
processes share them; every change is a read-modify-write under a lock file (`write.lock`) so two processes changing
different fields never drop one of the changes. The Jev API key is never returned by the API
(`apiKeyConfigured` only) and is handed to one ephemeral backend session at a time, in a private
in-memory credential store, so it never replaces the credentials other agents use. The global Execution Quality default
(see Render QA and Execution Quality) and the Autonomy group (see Autonomy) are part of `settings.json`; a file
from before either existed reads with its defaults and gains it on the next write. The per-provider API keys in
`provider-credentials.json` are described under Providers and credentials.

## Providers and credentials

The model catalog and the credentials come from the user's OMP setup (`~/.omp/agent`; OpenVids stores nothing of its own there) **plus the
API keys the user enters in OpenVids**, so a user with no OMP login can still use the agents.

- **Storage.** `provider-credentials.json` in the settings directory: `{"version":1,"apiKeys":{"<provider>":"<key>"}}`,
  mode 0600. A key is never returned by any route, never logged and never put into an error message.
- **Applying.** The OMP adapter applies the stored keys as the SDK's _runtime key overrides_
  (`AuthStorage.keys.setRuntime`). That is an in-memory `Map` in the SDK: nothing is written to `~/.omp/agent` (checked in
  the SDK source and by scanning a scratch home after setting a key). The override wins over every OMP credential of the
  same provider, so a key saved here replaces the OMP login for that provider until it is removed. The catalog, every
  agent session and Jev's provider-login mode use it (their credential layer is the shared one), and a key change takes
  effect without a restart: the backend re-reads the file on every catalog/provider/session access (one small file),
  applies the difference and rebuilds the catalog, so a key saved by the desktop's runtime reaches a project runtime too.
  (Jev's own API-key mode still uses a private per-session store.) The SDK keeps its own files in the OMP agent
  directory as it always did (`agent.db`, the `models.db` catalog cache, logs) — they hold no OpenVids key.
- **Default model.** When the OMP config names no default, a turn starts on OMP's default for the connected provider
  (`pickDefaultAvailableModel`), or on OpenVids' own choice where OMP's does not suit a new user (`START_MODEL_BY_PROVIDER`
  in `src/omp/model-mapping.ts`: OMP's Gemini default has no free tier, so Gemini starts on `gemini-3.8-flash`). The
  catalog reports it as `defaultModel`, so every picker shows the model a turn really uses. It is never simply the first
  model listed: that order is the provider's, and its first entry can be a retired model. Apple's on-device model is
  left out of the catalog and the provider list (`isAgentProvider`): macOS 27 lists it with nothing connected, and its
  8K context cannot hold an agent's prompt.
- **Provider list** (`ProviderInfo`): `id`, `name` (plain display name), `authenticated`, `status`
  (`connected` | `not_configured` | `error` | `signin_required`), `credentialSource` (`omp` | `api-key` | `oauth` | null), `error`
  (a one-line reason), `modelCount`, `keyless` (a local provider that needs no credential) and `verified` (a live model
  list was fetched with the credential in this process). Status is derived in `src/omp/provider-status.ts` from what the
  SDK can tell: the winning layer of its credential cascade (`keys.source`), the registry's per-provider discovery state,
  and the tombstones of torn-down OAuth credentials (`credentials.listDisabled`). `signin_required` is reported only
  when such a tombstone exists (an OAuth refresh failed definitively) and nothing else authenticates the provider; a
  logout (`deleted by user`) is not one, and an expired token that has not been refreshed yet is invisible. `error` means
  the credential exists but the provider's live model list failed: the SDK swallows HTTP errors of built-in providers, so
  a rejected key, no network and an outage look alike, which is why it is raised for OMP's own credentials only with an
  explicit message or a 401/403 from a models.yml provider, and also for a key stored in OpenVids (the key the user just
  typed) when the listing failed silently. While a refresh is running nothing is concluded. The models of an `error`
  provider stay usable.
- **Routes** (all global: token only, no project): `GET /v1/providers` → `{providers, syncedAt}`;
  `POST /v1/providers/refresh` re-reads OMP's credentials and the stored keys and re-fetches every provider's live model
  list; `POST /v1/providers/:provider/api-key` with `{"apiKey": string | null}` saves or removes the key, then refreshes
  that provider (a new key is checked live — it can take up to the SDK's discovery timeout when the provider is
  unreachable; a removal does not touch the network). Both answer with the fresh provider list. An unknown provider
  (setting) or an invalid id is `400 invalid_request`. `POST /v1/settings/jev/test` is global too: it runs in an empty
  scratch directory, so it needs no project.

### In-app OAuth sign-in

A provider that offers a sign-in (`ProviderInfo.oauth`, not null) can be signed in to from the app. The runtime drives the
SDK's own login (`AuthStorage.oauth.login`) and **never opens a browser**: the UI or the desktop shell opens the URL the
state carries.

- **Where it is stored.** OpenVids' own `auth.db` (SQLite, `<settings dir>/auth.db`, directory 0700, files 0600, same
  schema as OMP's), never `~/.omp/agent`. The SDK's `AuthStorage` takes one credential store, so `src/omp/layered-auth-store.ts`
  presents two as one: OMP's `agent.db` and OpenVids' `auth.db`. Reads show both (a provider with an OpenVids sign-in is
  shown with its OpenVids credentials only, so the sign-in replaces OMP's login for that provider until it is signed out).
  New credentials, sign-out and everything about an OpenVids row — **token refresh**, disabling after a failed refresh,
  refresh leases, rate-limit blocks — go to `auth.db` (ids of OpenVids rows are shifted by 10^12 so the two never collide).
  The SDK's cache rows also live there. `credentialSource: "oauth"` marks a provider whose credential is such a sign-in
  (an API key stored in OpenVids still wins over it). Sign-out blanks the tokens in the row and retires it; closing the
  runtime checkpoints the write-ahead log. Providers are not told: a grant is revoked at the provider's account page.
- **What still writes to OMP's database.** The layering never writes an OpenVids sign-in there. But a credential **OMP**
  owns is still refreshed by the SDK in OMP's database, as it was before OpenVids layered anything (and as the SDK's
  startup housekeeping does): OAuth refresh tokens rotate, so a refresh OMP's database never saw would invalidate the user's
  OMP login. That is the one remaining write, and only for a login the user made with OMP.
- **Both runtimes.** The home and project runtimes open the same `auth.db`; each polls both databases for another process's
  commit (`pollExternalChanges`) when providers are listed and when a key is resolved, so a sign-in done in one is used by
  the other without a restart. A sign-in's state (the polling surface) lives in the runtime that started it. Refresh of the
  same credential by two runtimes is fenced by the SDK's refresh leases, which live in `auth.db` for OpenVids rows.
- **When it is off.** `oauth` is null for every provider, and the start route answers 400, when OMP keeps its credentials in an
  auth broker (`OMP_AUTH_BROKER_URL` or a `broker` entry in OMP's `config.yml`), when `XDG_DATA_HOME` is set (OMP's database
  location is then not derivable), or when the layering could not be set up. OMP's credentials are then used exactly as before.
- **Routes** (global, token only; start + poll, nothing is held open):
  `POST /v1/providers/:provider/oauth/login` (optional body `{"flow":"browser"|"device"|"paste"}`) starts a sign-in, or returns
  the one already running for that provider, and answers within 8 s with an `OAuthLoginState` (as soon as there is a URL or a
  prompt to show; otherwise `pending` with `authUrl: null` and the UI polls). `GET /v1/oauth/logins/:id` polls.
  `POST /v1/oauth/logins/:id/input` with `{"text"}` answers the prompt (a pasted code or redirect URL; never echoed).
  `POST /v1/oauth/logins/:id/cancel` stops it (idempotent). `POST /v1/providers/:provider/oauth/logout` removes the OpenVids
  sign-in and answers with the provider list (409 when OpenVids holds none: what OMP holds cannot be removed here).
  Errors: 400 `invalid_request` (bad id or body, no sign-in for that provider, unsupported setup), 404 `login_not_found`,
  409 `invalid_request` (nothing is waiting for an answer, nothing to sign out, too many sign-ins).
- **States** (`OAuthLoginState.status`): `pending` (the user must act, or the runtime is working; an optional paste prompt
  may be present), `needs_input` (a required prompt, e.g. GitHub Enterprise domain), `succeeded`, `failed` (`error`, one
  line, tokens and query strings removed), `cancelled`, `expired`. A sign-in not finished in 10 minutes expires; a finished one
  stays pollable for 10 minutes. Cancel, expiry and shutdown abort the SDK flow, whose `finally` closes the callback
  listener; they wait at most 3 s for it. `dispose()` cancels every sign-in.
- **Flows** (`ProviderOAuthInfo.flows`, the first is the default; read from the SDK's auth policies in
  `src/omp/oauth-support.ts`). `browser`: the SDK listens on loopback (`127.0.0.1` and `::1` only) on the provider's port and
  the user approves in the browser; if that port is taken it falls back to a random one, except where the provider insists
  on its registered redirect (`fixedPort`; then a taken port is a failure with a clear message). Ports: `anthropic` 54545,
  `openai-codex` 1455 (fixed; the Codex CLI uses the same port, hence its `device` alternative), `openrouter` 54549,
  `google-gemini-cli` 8085, `google-antigravity` 51121, `devin` 59653, `gitlab-duo` 8080, `stencil` 54547. `device`: the user
  opens `authUrl` and enters `deviceCode` (also in `instructions`) while the runtime polls: `github-copilot` (asks the
  Enterprise domain first), `kimi-code`, `xai-oauth`, `muse-code`, `kilo`, `cursor`, `openai-codex` (second flow). `paste`:
  `gitlab-duo-agent`, the user pastes the code or redirect URL back. Providers whose login is a pasted key, a prompt-driven
  account/e-mail flow, needs a host-owned browser session or an OS URL-scheme handler (`zai`, `perplexity`, the Alibaba,
  Xiaomi and Cloudflare logins) are not offered.

## Autonomy

`AgentSettings.autonomy` (`PATCH /v1/settings` with a partial `autonomy` group) holds three values, defaults `big`, `true`,
`true`:

- `planApproval` (`big` | `always` | `never`): when the Director proposes a plan (`propose_plan`) that the user approves with
  "Carry out the plan" before anything changes. `big` (default): only for a big request (more than two steps, two or more
  specialists, a render, import or download, removing or replacing what the user made, long-form analysis); `always`: every
  request that changes the project; `never`: run directly. After a proposal the rest of that turn changes nothing. The old
  `defaultIntent` key was removed; the validator ignores it like any unknown key.
- `askBeforeLockedEdits`: locks are never overridden — the editing and story services refuse a change to a locked or
  hand-set item (and the file-tool guard refuses to rewrite a locked clip) whatever this says. The setting decides what the
  agent does about it. On: the Director's `<team>` block, every delegated task (`<autonomy>`) and every such refusal
  (`dispatchTool`: `locked` / `user_decision` tool errors; the OMP guard's refusal for `edit`/`write` of a locked clip) tell
  it to stop work on that item, say what it wanted to change and why, and wait for the user. Off: the same places tell it to
  leave the item alone, carry on and list what it left untouched in the final reply. It is an instruction to the model (the
  refusal itself is enforced); it is read at the start of the turn.
- `askBeforeDownloads`: **enforced** in the research executor, in every kind of turn (a Story build included). On:
  `import_asset`, `read_website` with `save`, `get_website_file` with mode `save` and `record_website` need the user's
  approval in the turn before Studio is asked: the Story workspace's "Find missing material"
  (`storyAction: "resolve"`), or a message of that turn (prompt or steering; never assistant text or tool results) that
  tells the agents to download/import/fetch/grab it (an action word aimed at the material, in English or Russian; a bare
  yes/ok/go ahead does not count, and a negation such as "don't download", "I haven't decided" or "no, wait" anywhere
  in the same sentence cancels it: `approvesDownload` in `src/autonomy.ts`, a deterministic text rule like the
  long-render guard) counts as approval. Without one, the call **asks in the chat**: the runtime publishes an
  `asset_download` permission card (see **Permission requests** under Research) and the call WAITS for the answer —
  Allow once (downloads approved for the rest of the turn), Don't ask again (this setting is switched off) or Don't allow
  (every later download of the turn is refused and the model continues without outside material). Approval does not
  carry over to later turns. Without a permission broker the old text flow stays (the call is refused and Research lists
  what it found for the user's next message). Searching, inspecting pages and reading a site's style stay free.
  Research's task and the Director's brief state the rule: import what the job needs, never stop the turn just to ask in
  text. Off: downloads run without asking (the Asset Search policy and license rules still apply).

## Multi-agent orchestration

- Fixed specialists (`editor`, `vision`, `motion`, `research`, `audio`), enabled per chat
  (`enabledAgents`, seeded from the global `enabledByDefault`). Per-chat `agentOverrides` replace the
  global model/thinking/allowed-models of one specialist.
- The Director gets runtime-implemented host tools (`src/agents/tools.ts`): `update_plan`
  (`plan.updated`), `delegate` / `wait_for_agents` / `message_agent` / `cancel_agent` (only when at
  least one specialist is enabled; `agent` is an enum of the enabled ones and is re-checked; a
  mangled name such as `_editor` or `Editor` is accepted), and `jev` when Jev is usable.
  Specialists get only the tools below plus `jev`; Jev gets the read-only readers
  (`inspect_project`, `inspect_timeline`, `read_story`, `read_analysis`) and edits project files
  with its file tools — the hierarchy is one level and OMP's own task/subagent tools are never
  enabled. Argument parsers live in `src/agents/toolArgs.ts`.
- **A specialist that is off hands its work to the Director.** Its tools are added to the Director's
  (every tool family applies `withInheritedTools`, `src/agents/inherit.ts`, inside its own
  `...ToolsFor`; the same turn/phase gating, policy and approvals apply), its compact working rules are
  appended to the Director's instructions (`directorInstructions(enabled)`, so the Director session
  signature follows the chat's team), and the team block names what is off. `delegate` to it is
  refused with the tools to use instead. Tool names are exact (the Director's prompt says so; a call
  to an unknown name is rejected by the SDK before it reaches the runtime). Only the `agent` argument of
  `delegate` / `message_agent` is read leniently (`parseSpecialistName`, `src/agents/aliases.ts`: `_editor`,
  `Editor`, `delegate_to_editor`, "Motion Designer").
- Routing (`src/agents/routing.ts`): a delegated task runs on the specialist's model unless the
  Director names one of its `allowedModels` (and it is authenticated); thinking may be lowered for a
  task, never raised. Violations are returned to the Director as tool errors. When the model list
  could not be loaded (`catalogKnown` false) credentials cannot be judged: an allowed model is
  accepted, Jev with provider sign-in stays on offer, and the team block says the list is missing.
- `src/agents/orchestrator.ts` runs one turn's delegated work (helpers beside it: `runFactory`,
  `runExecutor`, `runSettle`, `runWaiter`, `runMessage`, `planKeeper`, `specialistQueue`,
  `stallWatchdog`, `taskText`). Specialist runs are async and parallel across specialists; one task
  at a time per specialist, two for Research and Vision (the second on its own ephemeral session of
  the same role), the rest queue. Jev calls are synchronous for the caller. Every run shares the
  turn's abort signal and checkpoint and releases its write leases when it ends.
  - A delegated task carries the Director's text, the user's own words of the turn (prompt and
    steering, shortened with a stated count of omitted characters) and their attachments, the
    selection and the light editor context, and the reply language. A report reaches the Director
    up to 20 000 characters; a cut is announced in the text.
  - `wait_for_agents` blocks until the awaited runs have finished (`until: "any"`: until the first
    has), the user steers, or `timeoutSeconds` (default 120) pass, and then says what is still
    going. `message_agent` also reaches a run that is queued or opening its session: the message
    is placed in front of its task. Cancelling a queued run frees its place at once.
  - A run that shows no sign of life (no backend event) for the stall limit is stopped and fails
    with a clear reason; while one of its tool calls is in flight (`trackToolCall`, wrapped around
    every dispatch) the clock is held.
  - `cancelRun(runId, reason)` stops one run on the user's request (status `cancelled`); the
    Director reads "stopped by the user — do not start it again unless the user asks" in its result.
  - The automatic plan lists the runs the Director started plus the closing assembly step; runs the
    runtime starts itself (the Render QA review) are not steps of the user's plan.
  - Steering goes to the Director; a pending `wait_for_agents` returns early so it can react. If the
    Director stops without collecting its runs it is re-prompted with their reports (at most 3
    times). Before the checkpoint closes, `shutdown()` aborts unfinished runs and force-closes a
    session that does not stop within the grace period, so no run outlives its turn.

## Editing tools

Agents assemble and change videos through an OpenVids-owned capability layer, not by hand-editing
composition HTML. The runtime talks to Studio's editing service over loopback HTTP
(`src/editing/host.http.ts`, base `${studioOrigin}/api/projects/:id`): `editing/project`,
`editing/timeline`, `editing/apply` (atomic batch of `EditOperation`s), `editing/presets`,
`editing/probe`, plus the existing render routes (POST render → progress SSE → renders list →
probe). The wire contract is `packages/agent-protocol/src/editing.ts`. The service writes project
files; Studio's watcher reloads the timeline/preview live, and because the write happens while the
Director's transaction is open the history engine attributes it to the turn.

| Tool               | Director                                | Editor | Motion | Audio | Vision / Research | Jev |
| ------------------ | --------------------------------------- | ------ | ------ | ----- | ----------------- | --- |
| `inspect_project`  | yes                                     | yes    | yes    | yes   | yes               | yes |
| `inspect_timeline` | yes                                     | yes    | yes    | yes   | yes               | yes |
| `browse_presets`   | yes                                     | yes    | yes    | no    | yes               | no  |
| `edit_timeline`    | when the Editor, Motion or Audio is off | yes    | yes    | yes   | no                | no  |
| `render_video`     | yes                                     | yes    | no     | no    | no                | no  |

- `inspect_timeline` also reports the playhead, selection and active composition from the turn's
  `EditorContext` (captured when the user sent the message). A service refusal (`EditError`) or a
  malformed batch comes back as a tool error with its code, message and `operations[N]`.
- Each editing tool declares an `activity` label ("Inspecting the timeline", "Editing the timeline ·
  4 changes (add clip ×3, split)", "Browsing caption presets", "Rendering video"); the OMP adapter
  reports these as `tool.start` with a `label`, and `TurnEventWriter` shows each as its own row.
- `render_video` refuses a composition longer than 180 s unless the turn's user messages (prompt and steering) explicitly
  ask for a render, an export or a video file (English or Russian; "don't render" does not count): the Director offers
  the render instead of starting a long one on its own (`src/editing/renderGuard.ts`). Short renders are unchanged.
- Lifecycle guarantee (`src/editing/executor.ts`, `TurnRunner.finalize`): editing calls go to a
  per-turn executor bound to the turn's scope, editor context and abort signal. They are refused when
  no turn is running or it is finalizing. Before the checkpoint closes, the turn stops accepting
  calls, cancels running renders (`POST /render/:jobId/cancel`) and awaits every started call. An
  `apply` follows the turn signal by `POST editing/cancel {requestId}`: the service stops the batch
  before its commit point (nothing written) or finishes it, and the call returns what the service
  answered — so no editing write can land after the checkpoint transaction ends, and a stopped turn
  never leaves a half-applied batch. Reads and applies also carry generous ceilings (2 min / 10 min).
- Renders run one at a time on the machine (Studio's render queue, shared with the user's own exports and other
  projects): a render asked for while another runs streams `queued` progress events (`queuePosition`, `queueHolder`).
  `HttpEditingHost.render` keeps waiting through them (no deadline of its own: only the turn's signal ends the wait) and
  only a status other than `queued`/`rendering` is final. The place is reported as data, `RenderProgress.queue`
  (`{position, holder}`), never as text: `render_video`'s activity row switches to `activity.rendering_video_queued`
  / `rendering_video_queued_behind` (parameters `position`, `project`) and back to `rendering_video`, and a Render QA
  pass carries `progress.queue` (the card shows "Queued", the place and who is rendering, with no meter). The QA calls
  that carry timeouts (`QA_TIMEOUTS_MS`) all start after the render has finished, so queue wait is never counted
  against them.
- **`edit_timeline` runtime behaviour** (`src/editing/apply.ts`): the runtime, not the model, owns the
  turn id, the base version and the request id. `baseVersion` defaults to the version of the
  composition last read or applied this turn (`SeenVersions`), so a change made behind the agent's
  back is a crisp `conflict`; a version the model names wins. The `requestId` is a hash of the turn,
  the composition and the operations: the service replays the stored answer for a repeated id while
  the composition is exactly as that batch left it, so a retry after a timeout never doubles clips.
  `dryRun: true` validates the batch in memory and reports the difference to the current timeline
  (`+`/`-`/`~` lines, length and canvas) without writing. The batch claims its composition in the
  turn's `WriteLeases` for the calling run (a dry run only checks). Results carry per-operation notes
  and warnings (a new overlap on track 0, clips without a transcript).
- `inspect_timeline {track, from, to, offset, limit}`, `inspect_project {query, kind, offset, limit}`
  and `browse_presets {kind, query, offset, limit}` page and filter, and say which offset continues.
  `browse_presets` also lists `color_grade` and `audio_fx` presets (for `set_color_grade` /
  `set_audio_fx`).
- The Director inherits the editing tools of every disabled specialist (`withInheritedTools`): without
  an Editor (or Motion/Audio) it gets `edit_timeline`; Jev only ever gets `inspect_project` and
  `inspect_timeline`.
- Operations beyond the first set (all in `studio-server/src/editing/ops*.ts`, written exactly as
  Studio's own panels write them): `set_speed` (`data-playback-rate`), `retime_captions`,
  `captions_from_transcript` (cached transcripts mapped through each clip's in-point and speed),
  `mount_composition` (Studio's drop helper), `set_color_grade` (`data-color-grading`),
  `set_audio_fx` (`data-fx-chain`), `set_volume_automation` and `duck_audio` (`data-automation`),
  `set_locked` (an agent cannot lift a user's lock), `set_clip.opacity`, `remove_clip`/`set_speed`
  `rippleScope: "all"` and `set_canvas.fit` (contain/cover re-frame placed clips). There is no
  cut-to-cut transition operation: the engine only has transition blocks (`add_component`).
  The composition length follows content only upwards; `set_composition` shortens it (the blank
  template's own 10 s goes once its placeholder is replaced).
- `FakeEditingHost` (`src/testing`) is the in-memory host for tests; the runtime fixture wires it.

### Composition frames (`inspect_composition`)

Agents see their result without a full render: `inspect_composition { times (≤ 12), composition? }` returns JPEGs of the
composition as the preview shows it (video, text, captions, graphics; no audio) as `HostToolResult.images`, plus a text
naming each second (a time past the end shows the last readable frame). Director, Editor, Motion and Vision have it
(`framesToolsFor`, with the D1 inheritance); the roles tell them to check their own work with it instead of rendering
(`FRAMES_ROLE_PROMPT`). Activity row: label code `inspecting_composition` (`count`).

- Path: runtime `TurnFrames` (`src/editing/frames.executor.ts`, budget per turn = Execution Quality
  `analysisFramesPerSource`, a call is checked by its size and its cached frames are given back) → `HttpFramesHost` →
  Studio `POST /api/projects/:id/editing/frames` (`studio-server/src/routes/editingFrames.ts`; contract in
  `agent-protocol/src/frames.ts`) → adapter `captureFrames` → `hyperframes frames` in a CLI child (own headless Chrome,
  never the server process; the same seek + screenshot + video-frame injection path as `snapshot`; implemented in the CLI
  host `cli/src/server/framesAdapter.ts` and in the vite dev host). Aborting the request (the tool call, the turn, a
  closed connection) kills the child and its browser; captures queue one browser at a time.
- Studio caches frames in memory per (project content, composition, time, width): an unchanged project answers from the
  cache (`cached: true`), any file change misses.
- Render QA's correction tasks use the tool itself: the correction prompt gives every picture issue a "Look at:
  inspect_composition {times}" line and the Director puts those times into the delegated task (a prompt carries text
  only, so the frames are not attached to it). `FakeFramesHost` (`src/testing`) is the test host, and the runtime
  fixture wires it.

## Long-form analysis tools

Long raw footage becomes durable, cached analysis artifacts and then a rough cut on the real timeline. The runtime talks
to Studio's analysis service over loopback HTTP
(`src/analysis/host.http.ts`, base `${studioOrigin}/api/projects/:id/analysis`): `jobs` (start/join,
poll, cancel), `overview`, `transcript`, `artifact`, `segments`, `vision`, `frames`, `cuts`
(plan/list/get). The wire contract is `packages/agent-protocol/src/analysis.ts`; artifacts live
in `<project>/.hyperframes/analysis` outside project history, so Revert never touches the cache.

| tool                                                                                    | Director                         | Editor | Vision | Motion/Audio/Research |
| --------------------------------------------------------------------------------------- | -------------------------------- | ------ | ------ | --------------------- |
| `analyze_media` (starts/joins the job, waits, returns the compact overview)             | yes                              | yes    | yes    | no                    |
| `read_analysis` (overview or one section), `read_transcript` (paged; marks take issues) | yes                              | yes    | yes    | yes                   |
| `save_segments`                                                                         | yes                              | yes    | no     | no                    |
| `inspect_frames` (JPEGs to the model), `save_vision_notes`                              | inherited when Vision is off     | no     | yes    | no                    |
| `plan_cut`, `build_rough_cut`                                                           | inherited when the Editor is off | yes    | no     | no                    |

Jev only gets `read_analysis`. "Inherited" is the general rule (`src/agents/inherit.ts`): a tool family's Director set is
its own tools plus those of every specialist that is off in the chat.

- `build_rough_cut` reads the plan and the timeline, then sends ONE atomic `editing/apply` batch with
  `baseVersion`: `remove_clip {clips}` for the clips **of the target track** that play the plan's source (the previous
  cut; clips on other tracks — cutaways, B-roll, graphics, manual additions — are kept and reported as "kept N clips on
  other tracks; their positions refer to the previous cut"), `add_sequence` of the plan's ranges (`edgeFade` 0.02,
  stamped with provenance `{cut: plan.id, turn}`) and `set_composition` to the cut length. With the optional
  `captions` (a caption preset name) the cues come from the transcript's words through the plan's placed ranges
  (`captionCuesFromWords`) and an `apply_captions` joins the same batch. It reports the clip count, the length and the
  timeline ranges where kept material overlaps black/frozen picture. Whether a plan is on the timeline is derived from
  the clips stamped with its id (`CutPlanSummary.applied = {composition, clips}`), so a reverted cut is never shown as
  applied. Because it goes through the editing service inside the turn's transaction, Revert undoes it.
- `inspect_frames` returns `HostToolResult.images` (base64 JPEG). The OMP adapter maps them to OMP image
  content after the text part (`src/omp/tool-content.ts`); nothing outside `src/omp/` knows OMP.
- A job is awaited by polling `GET jobs/:id` (750 ms); its overall progress and stage go out on the tool's progress channel
  (the same `tool.progress` a render uses, so the activity row shows a percent and the stage). A job whose stage, progress,
  finished stages and sign of life (`AnalysisJob.updatedAt`) do not move for 15 minutes (`TurnAnalysisOptions.stallMs`) is
  cancelled when this call started it and the call fails with `stalled` naming the stage; one that was only joined keeps
  running. The recognizer and the diarizer print no progress while they decode, so the service reports the job alive on a
  timer for as long as that child process runs (a wedged child ends with the engine's own timeout). Every analysis read has
  a two-minute ceiling (a wedged Studio answers `unavailable`, it does not park the poll). Aborting the call cancels the
  job on the service so ffmpeg and the recognizer never outlive the turn. Analysis is cached per file, so a follow-up
  turn's `analyze_media` returns immediately. `read_analysis` pages every list section (takes, segments, silence, shots,
  speakers' turns, vision, cuts) with `offset`: the result says which items it shows and the offset of the next page.
- Lifecycle guarantee (`src/analysis/executor.ts`, `TurnRunner.finalize`): like editing, analysis calls go
  to a per-turn executor bound to the turn's abort signal. They are refused when no turn is running or it
  is finalizing. Before the checkpoint closes, the turn stops accepting calls, cancels running jobs and
  awaits every started call — a rough-cut batch already sent is awaited to its end.
- Failures come back as `code: message` tool errors (`AnalysisToolError`; service codes plus `aborted` and
  `unavailable` for transport failures). A stage the machine cannot run (no speech recognizer) is reported
  in the overview as `unavailable` with its reason, not as a failure.
- Role instructions (`src/agents/roles.ts`) hold the pipeline: the Director runs `analyze_media`, delegates
  Vision (only the not-yet-inspected targets) and Editor (semantic segmentation) in parallel, then the
  Editor plans, builds, checks the timeline, runs a pacing pass and rebuilds. Follow-up turns reuse the
  cached segments, vision notes and cut plans.
- Each analysis tool declares an `activity` label ("Analyzing raw-talk.mp4", "Reading the transcript",
  "Saving 14 segments", "Looking at 8 frames", "Saving 3 visual notes", "Planning the cut · rough cut",
  "Building the rough cut · 143 clips"). While `analyze_media` waits, its row also names the stage the job is in next to
  the percent ("Analyzing raw-talk.mp4 · mapping speakers", label codes `analyzing_stage_<stage>`): a host tool's
  progress callback is `(percent, label?)` and `TurnEventWriter` re-publishes the row when the percent or the label
  changes (`src/analysis/stageLabel.ts`).
- `FakeAnalysisHost` (`src/testing`) is the in-memory host for tests (jobs that stay running until a gate
  opens, recorded requests); the runtime fixture wires it.

## Story Mode

The project's plan of the video is the Story Graph (`<project>/.hyperframes/story/graph.json`; contract in
`packages/agent-protocol/src/story.ts`): chapters in a narrative sequence, material nodes (video, picture, music,
motion preset, missing asset) attached to them, locks, and authorship (what the user set by hand, created or removed).
The user reshapes it in Studio's Story workspace; agents change it only through Studio's story service (validated,
locks and user decisions enforced), never with file tools (the path guard forbids `.hyperframes/`). The runtime talks
to it over loopback HTTP (`src/story/host.http.ts`, base `${studioOrigin}/api/projects/:id/story`): `GET` (view),
`POST edit` (an agent's atomic `StoryOperation` batch), `POST build` (compile the whole graph into the timeline),
`POST rebuild` (Rebuild affected sections: only what the graph changed since the last build, against the service's
sync ledger).

- **Modes.** A chat has a persisted `activeMode` (`normal` | `story`, `PATCH` chat). A turn's mode is `story` when it
  runs a `storyAction` (`review`, `build`, `rebuild`, `resolve`; sent by Studio's "Review with AI" / "Build Story" /
  "Rebuild affected" / "Find missing material"), else the request's `mode`, else the chat's `activeMode`.
  `TurnSummary.mode` / `storyAction` /
  `storyOptions` record it. All are ordinary checkpointed turns, so "Revert this turn" restores the graph, the sync
  ledger and the timeline together.
- **User options.** `StartTurnRequest.storyOptions` carries the user's choices from the Story workspace: for `rebuild`
  `chapters` (scope), `manualEdits` (`keep` | `replace`) and `allowLocked`; for `build` only `allowLocked`. The executor
  merges them into the service request; the model passes only `baseVersion` / `dryRun`, so it can never unlock a
  chapter or replace the user's edited material on its own. For `resolve`, `missing` limits the Missing Asset nodes the
  turn may resolve (enforced by the research executor, see Research).
- **Prompt.** Every story-mode turn prompt carries a `<story-graph>` block (the `read_story` rendering as of the
  turn's start, including "User decisions", locks and the "Timeline sync" section) and a
  `<story-mode action="plan|review|build|rebuild|resolve">` block with the rules of the action and the user's options
  (`src/story/prompt.ts`). The Director's role text holds the standing rules (user decisions outrank the AI's earlier
  plan, locked nodes never change, never restore the previous variant on review).
- **Tools** (`src/story/tools.ts`): `read_story` (everyone, any mode; Jev too; `chapter` reads one chapter in full with
  its material, links and open items, `section` one named part — overview, chapters, materials, links, decisions,
  attention, locks, sync — and `offset` continues a long reading, the result names the next offset), `edit_story`
  (Director, in story plan/review turns and, before the build, in build turns), `build_story` (build turns: the
  Editor's; the Director gets it when the Editor is off), `rebuild_story` (rebuild turns only, the Director).
  Specialists that are off in the chat hand their tools to the Director (`src/agents/inherit.ts`
  `withInheritedTools`), which is how the Director gets `build_story`, the cut tools and the frame tools. Service
  refusals (`locked`, `user_decision`, `conflict`, `unknown_node`, `unsupported`, …) come back as tool errors
  `code (operations[N]): message`. A rebuild
  refused because the story has no sync ledger (never built, or built before sync tracking) says nothing was written and
  tells the model to propose a full Build Story, naming what it replaces.
- **No timeline writes outside a build.** In a story-mode turn without `build`, nobody gets `edit_timeline`,
  `render_video` or `build_rough_cut` (analysis tools stay); a rebuild turn's only write is `rebuild_story`. A build turn
  keeps the normal editing tools plus `build_story`.
- **A length the user set is kept by the build.** When the user set a chapter's `estimatedDuration` and its cleaned A-roll
  runs longer than that by more than max(10 s, 15 %), `build_story` trims every piece proportionally (each keeps its
  start) and warns; an AI estimate never trims, and the review/needs-attention text tells the Director to choose the
  ranges itself for a clean cut (`fitToEstimate` in `studio-server/src/story/aroll.ts`).
- **Story offer material.** When an offer is accepted, the music, sound effects and footage a chapter's `material` text
  clearly names (English/Russian wording, at most 3 per chapter) become Missing Asset nodes attached to that chapter
  (music throughout, effect at the start, footage in the middle; the full text stays as the chapter's B-roll intent)
  — `storyOfferOperations` in `src/storyOffer.ts`, within the 100-operation batch cap.
- **Build turns produce the complete video** (`storyAction: "build"`; the rules are `buildRules` in `src/story/prompt.ts`):
  the user expects a finished, watchable video with sound, not a silent draft, from this one turn. The Director (1)
  prepares the graph with `edit_story` — Missing Asset nodes (`video` / `picture` / `music` / `sfx`) for the music bed
  (unless the user said no music), the sound effects and the footage/pictures the chapters name, attached to the chapters
  that use them (one music node attached to several chapters is one bed across them; a resolved `sfx` plays inside its
  chapter at the attachment's offset, see `studio-server/src/story/compile.ts`); (2) when the Asset Search policy is
  readable, fetches what is missing — Research delegated in tasks of up to 4 nodes, or the Director itself with the
  research tools it inherits when Research is off — importing with `resolveMissing` (downloads that need approval ask
  the user in the chat and the import call waits, see Autonomy); when Studio could not read the policy it says outside
  material cannot be fetched and builds with what exists;
  (3) runs `build_story` exactly once (the Editor, or the Director without one) and verifies with `inspect_timeline`;
  (4) delegates Motion for the scenes and titles the build cannot generate and (5) Audio for the final mix (music level
  under speech and effects, fades at the ends, effects on the beats); (6) reports per chapter including its sound and what
  is still missing. `TurnStory.hasBuilt()` becomes true after a successful, non-`dryRun` `build_story`; from then on the
  graph is frozen for the rest of the turn (`edit_story` is refused by `TurnStory`, `resolveMissing` /
  `resolve_missing_asset` by the research executor through `TurnResearchOptions.storyBuilt`). A **rebuild** turn keeps
  its narrow rules: only `rebuild_story` writes, Research gets nothing, and the prompts say so.
- **Edit attribution.** `edit_timeline` requests carry the turn id (set by the executor, never the model), so the
  editing service stamps the clips an agent changes (`data-ov-ai-edit`) and Story sync can tell a later AI edit of
  generated material from the user's.
- **Lifecycle.** Like editing and analysis, story calls go to a per-turn executor (`src/story/executor.ts`): refused
  when no turn is running or it is finalizing; `TurnRunner.finalize` awaits every started edit/build (atomic on the
  service) before the checkpoint closes, so no story write can escape Revert.
- `FakeStoryHost` (`src/testing`) is the in-memory host for tests (gates to hold an edit/build in flight, recorded
  requests and signals); the runtime fixture wires it.

## Design Systems

A design system is a saved look (palette, fonts, transitions, rules) in the user's global library
(`~/.openvids/design-systems/<id>/`, owned by Studio's design service; contract in
`packages/agent-protocol/src/design.ts`). Agents never write its HTML or CSS: they send a structured `DesignSystemSpec`
and the service renders `system.html` / `tokens.css` / the thumbnail. A project carries one version of a system as a
snapshot in `<project>/design/` (`system.html`, `tokens.css`, `fonts/`, `design.json`).

- **Design host.** `main.ts` always wires the design host. A runtime without one (a test fixture, another embedder)
  refuses `designAction`, gives no agent a design tool, and neither the role prompts (`DESIGN_DIRECTOR` /
  `DESIGN_SPECIALIST`, `RoleOptions.design`), the `<project-design>` block nor the `inspect_project` line mention design
  systems. `ToolAvailability.design` is that host's presence.
- **Host** (`src/design/host.http.ts`, bound to one project; `${studioOrigin}/api/design-systems` and
  `/api/projects/:id/design`): `list` (`GET /design-systems`), `get` (`GET /design-systems/:id[?version=n]`), `save`
  (`PUT /design-systems/:id`, answers are validated with the protocol guards; a save ignores the turn's abort, like a
  story edit, and may take minutes because Google fonts are downloaded), `extract` (`GET …/design/extract`),
  `videoPalette` (`GET …/design/video-palette?video=&samples=`, measured colors of a project video), `projectState`
  (`GET …/design`), `snapshot` (the state plus the tokens of `design/tokens.css` and the manifest in
  `design/system.html`, parsed by `src/design/snapshot.ts`), `attach` (`PUT …/design {id}`) and `externalProject` (the
  `external_project` source: `GET …/design/extract/external/:key`; the Studio server resolves the host's project key
  through its `externalProjects` capability, so no folder reaches the runtime; fonts that are files of the other project
  come back `unresolved`, a file of another project cannot be copied into the library). Service refusals arrive as `DesignToolError` with the service's `issues`.
- **Design action.** `StartTurnRequest.designAction` (`create` | `edit`) and `designOptions` (`source`:
  `scratch` | `project` | `video` | `website` | `external_project`; `systemId`, `video`, `url`, `projectKey`) are recorded on
  `TurnSummary`. The turn is an `edit`-intent, checkpointed turn in the chat's mode (the chat's intent is left alone),
  Director-led; the story blocks, the plan-approval block, the Story Mode offer and Render QA do not apply to it. A
  runtime without a design host refuses the action.
- **Tools** (`src/design/tools.ts`, executor `src/design/executor.ts`; the Director only, with a design host — all of them in a design turn, the free-mode subset below in an ordinary one):
  `list_design_systems`, `read_design_system` (spec as text, with the version to use as `baseVersion`, plus the
  manifest's guesses), `extract_project_design` (the deterministic extraction, counted; the other project's one for an
  `external_project` source), `video_palette` (measured `#rrggbb` shares), `save_design_system` and
  `attach_design_system` (copies a library system into the project's `design/`; never touches a composition). Both
  writes are project-changing for the intent rules (never in an Ask turn, refused after a plan proposal); the save is
  outside the project's history (Revert leaves the library alone, the attach is counted as `design_attach`).
- **The user's choices are enforced by the executor, not the prompt.** A `create` saves with the chosen `source`
  (`ref` = the video path, the site's host or the project key); a different `source.kind`, an id that is not the one
  already created in this turn and any `baseVersion` are refused; later saves in the turn refine the system it created
  (`baseVersion` is filled in). An `edit` saves only to `designOptions.systemId`, only after `read_design_system` of it in
  this turn, and always on the version it read. A `project` / `external_project` save needs `extract_project_design`
  first and is refused when a token holds a hex color the extraction does not list (alpha variants of listed colors are
  fine). `video_palette` measures the chosen video. `attach_design_system` takes only the system saved in the turn (or
  the edited one) and refuses a project that carries another system. The request is validated with
  `parseSaveDesignSystemRequest` before it is sent; a refusal of the service (`invalid_system` with every issue, `conflict`)
  is returned to the model verbatim so it can fix and retry; the result lists the library's notes (fonts downloaded,
  system fonts that are not portable, unknown licenses).
- **Free mode (typed requests).** In an ordinary turn (no `designAction`) the Director has `list_design_systems`,
  `read_design_system`, `extract_project_design`, `save_design_system` and `attach_design_system` (no `video_palette`),
  so "make a design system from this project", "attach Sunset" or "make the accent warmer" work from the chat. The same
  executor, with `action: null`, applies stricter rules: a new system only from `scratch` or `project` (a `video`,
  `website` or `external_project` source is refused with a pointer to the Design button — those start from the dialog; the
  `project` source keeps its extraction-first and no-invented-hex rules, also for refinements of what the turn created);
  a system that already exists is changed only after `read_design_system` in this turn, on the version read, with its
  `baseCreatedAt`; creating over a taken id is the library's `conflict` with the way out spelled out; `attach` takes any
  library system but never switches a project that carries another one. Nothing here writes a composition; applying a
  system to existing compositions stays a separate, user-approved step.
- **Name and lineage on a change.** A save that changes a system the turn read (an `edit`, a free-mode change, a
  refinement of what the turn created) sends `baseVersion` and `baseCreatedAt` (the library entry's `createdAt`, so an id
  deleted and recreated meanwhile is a `conflict`), and sends `name` only when the model changed it from the name it read,
  so a rename made meanwhile is not undone. The project-extraction color guard applies to new systems only, not to an
  `edit` of a system that came from a project; it accepts an opaque color whose only extracted form has alpha and the
  other way round.
- **Sources** (`src/design/prompt.ts`, the `<design-turn>` block): `scratch` (the brief), `project` (group and name the
  extraction, nothing invented), `video` (exact palette from `video_palette`, a few frames judged by Vision — or by the
  Director with `inspect_frames` when Vision is off —, fonts and transitions flagged `guess: true`), `website`
  (`read_website` of the chosen URL — it counts as linked in this turn — ends, in a design turn, with the draft
  `websiteStyleToSpecDraft(style, saved)` (`src/design/website.ts`) built by fixed rules: palette → the tokens by role,
  Google / saved self-hosted / system fonts → `google` / `file` / `system`, durations and easings → `--dur-*`, `--ease-*`
  and transitions; the model refines and fills the tokens the draft lists as missing), `external_project` (see the
  host), and `edit` (read, change what was asked coherently, save a new version). Unknown licenses are `null`, never
  invented.
- **No composition writes.** A design turn writes only the library (and `design/` on attach): `edit_timeline`,
  `render_video`, `build_rough_cut` and the harness's `edit` / `write` are refused for everyone. Applying a system to
  existing compositions is a separate, user-approved step: the Director may call `propose_plan` for it only after the
  system is saved (and only when the user's plan approval offers it); the approved plan runs as an ordinary turn.
- **The project's attached system in prompts** (`renderDesignSnapshotBlock`): when `design/system.html` exists every turn's
  Director prompt, and the task of Editor, Motion and Jev, carry a compact `<project-design>` block — the system is the
  first source of design truth; one `<link rel="stylesheet" href="design/tokens.css">` in the root `index.html` head
  (which also makes the stored fonts resolve offline); use the `var(--…)` tokens and the system's fonts and
  transitions; never hard-code a color it has; never restyle existing compositions unasked — plus the tokens, fonts,
  transitions, rules and guesses (not the showcase). `inspect_project` ends with the attached id, version and
  `updateAvailable`. Role text: `DESIGN_DIRECTOR` / `DESIGN_SPECIALIST`.
- Chat rows: `listing_design_systems`, `reading_design_system {id}`, `extracting_project_design`,
  `reading_video_palette`, `saving_design_system {id, name}`, `attaching_design_system {id}` (host tools get no `targets`).
- `FakeDesignHost` (`src/testing/design.ts`) is the in-memory host for tests; the runtime fixture wires it.

## Research

Research is the only specialist that can look for material outside the project. The Studio server (Milestone 7; contract
in `packages/agent-protocol/src/research.ts`) performs every search, page read and download, keeps the user's global
Asset Search policy (`trusted` = only the enabled trusted sources, `any` = any public page, trusted sources first) and
records a provenance entry for every import; the runtime reaches it over loopback HTTP (`src/research/host.http.ts`:
`${studioOrigin}/api/research/policy` for the global policy and `${studioOrigin}/api/projects/:id/research/{search,
inspect,import,resolve,sources,export-check}` for the project). Agents have no network tools of their own (the OMP path
guard rejects URLs), so the **policy enforcement point is the Studio server**: a request the policy does not allow is
refused there with `blocked_by_policy`, and no request the runtime sends carries a policy mode. Provenance fields
(URL, source, author, license and its confidence, retrieval time, agent, model) come from the source and the server,
never from model-supplied text.

| Tool                                                                 | Who                        | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_assets {query, mediaKind, sources?, limit?}`                 | Research                   | Candidates from the allowed sources: id, title, source (trusted or web), license name + status + confidence, author, size, page URL, `inProject`; per-source errors and `blocked` entries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `inspect_url {url, mediaKind?}`                                      | Research                   | Reads one page or media URL and lists the media it offers (HLS/DASH and protected streams are refused by the server).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `import_asset {candidate \| url, name?, resolveMissing?}`            | Research                   | Downloads into `assets/research/`, records provenance, detects duplicates (same URL or same content: reused, not downloaded again), optionally resolves a Missing Asset node in the same step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `resolve_missing_asset {missing, asset}`                             | Research                   | Resolves a Missing Asset node with a file already in the project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `read_sources {}`                                                    | Research, Director         | The project's Sources/Licenses: records, where they are used, issues, credits owed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `read_website {url, save?}`                                          | Director, Motion, Research | Opens one page of a website **the user linked in this chat** and extracts its visual style (palette with roles, fonts and how to load them, type scale, radii, shadows, buttons, design tokens, motion character, logo, headings) as a compact text summary plus two screenshots as images (`HostToolImage`), and lists the files the page uses (`resources`: videos, images, SVG, Lottie/Rive animations, fonts, styles, scripts — up to 40 lines, media first). With `save: true` the screenshots, logo and self-hosted fonts the page uses are written to `assets/web/<host>/` with provenance (origin "website", license unknown). Activity row: `inspect` · "Reading <host>".                                                        |
| `get_website_file {url, mode, pageUrl?}`                             | Director, Motion, Research | Fetches one file of a linked site — the site itself or an exact URL an earlier `read_website` of it listed (CDN hosts included): `save` downloads it into `assets/web/<host>/files/` and records a website reference (license unknown), `read` returns its raw text (HTML, CSS, JS, JSON, SVG) and saves nothing; `pageUrl` records the page it was found on. Offered whenever a research host exists; when the policy's `websites.fullAccess` (or `readLinkedPages`) is off, the call asks the user in chat to allow it (`website_full_access`) and continues with their answer; `save` is a write (refused in Plan and Ask turns). Activity row: `inspect` · "Reading a file from <host>" or `edit` · "Downloading a file from <host>". |
| `record_website {url, seconds, selector?, scroll?, width?, height?}` | Director, Motion, Research | Records one page of a linked site as an MP4 (real time, 1–30 s; `selector` records one element, `scroll` scrolls the page, `width`/`height` the viewport, even pixels) into `assets/web/<host>/recordings/` as a video asset for `edit_timeline`; a website reference, license unknown. Same ask-when-off full access; a write, so refused in Plan and Ask turns. Activity row: `edit` · "Recording <host>".                                                                                                                                                                                                                                                                                                                              |

- **Websites** (`read_website`, `get_website_file`, `record_website`;
  `src/research/{tools,executor,linkedSites,websiteResources,formatWebsite}.ts`; Studio routes
  `POST /api/projects/:id/research/{website,website/file,website/record}`, rendered by a headless-Chrome CLI child in
  the server). The runtime owns the **scope**: a URL is allowed only when its registrable domain (`www.` and subdomains
  included, `linkedSites`/`isLinkedSite`) was linked by the user — a URL, a `www.` address or a bare domain
  (`openvids.ai`; file names such as `index.html` or `Chrome Bounce.wav` are not links) in the chat's first prompt, a
  later message or a steering message (the turn's executors read user-role messages only; assistant text, search
  results and page contents never count). Anything else is refused before Studio is asked, with the instruction to ask
  the user for the link. Full access (`get_website_file`, `record_website`) adds an exact URL an earlier `read_website`
  of a linked site listed in the same chat (its resources, logo, favicon, og image or fonts, CDN hosts included; never an address without a domain name — such a file is refused up front, with no card) — a
  per-chat memory in the runtime (`WebsiteResourceLog`), kept as derived data in the chat's own directory
  (`website-resources.json`, a week, a damaged file reads as empty), so it survives a restart.
  The server enforces the user's switches (Settings → Asset Search → Websites, `policy.websites.readLinkedPages` and
  `websites.fullAccess`, refusal `blocked_by_policy`), http(s) only and public addresses only. When a switch a call
  needs is off the call does not fail: it asks the user from the chat (see **Permission requests** below) and continues
  with their answer; the turn's policy snapshot decides up front, and a `blocked_by_policy` refusal re-reads the policy
  so a change made in Settings mid-turn is honoured. `save` and `record_website` are writes (cancellable request id,
  awaited before the checkpoint closes like an import) and are refused in Plan and Ask turns; a plain read (and
  `get_website_file` mode `read`) is allowed there. `turnId` is sent on every website request (a "once" grant matches
  by it), and `agent`/`model` are set by the executor on the writing ones. The policy is read at the start of a turn
  whenever a research host exists; with a switch off, the Director's `<team>` block, a Motion task and Research's
  `<asset-search-policy>` block carry one line (`websiteAccessLine`) saying the tools are still there and that a call
  asks the user in chat. Unlike the asset tools, `read_website`, `get_website_file` and `record_website` do not need
  Research to be enabled or the policy to be readable: the Director, and Motion/Research when they are in the chat's
  team, get all three whenever a research host exists (`ToolAvailability.websites`); a Story rebuild turn offers
  none.
- **Availability** (`researchToolsFor`, `src/research/tools.ts`): Research gets the search/inspect/import/resolve/sources
  tools; the Director has `read_sources` and, when Research is NOT enabled in the chat, inherits every tool Research would
  have had (`withInheritedTools`: same policy, same download approvals, imports stamped with the Director as agent). A
  Story rebuild turn offers none; Jev and the other specialists never get them. The tools are offered whenever a research
  host exists; an unreadable policy at turn start is re-read by the first research call. `TurnResearch.execute`
  re-checks the caller against the same function.
- **Site scope**: Allow once on a website card covers that card's site only (per-site grants in the Studio server,
  `WebsiteGrantStore`); Turn on covers every site. Linked sites = deliberate links (scheme or `www.`) of the whole chat
  plus bare domains of the current turn, minus the user's `excludedSites` (`chatLinkedSites`, `src/research/linkedSites.ts`).
  A refusal from Studio for something the broker thought granted resets the answer and asks again once. The files a
  `read_website` listed are persisted per chat (`website-resources.json`, one week). Restricted-license imports ask a
  `restricted_asset` card per asset (the server refuses with `restricted_license` otherwise); at most 12 imports per
  turn; 429 answers are retried with backoff and fail as `rate_limited`; candidates survive a Studio restart for a week.
- **Permission requests** (`src/permissions.ts`, `PermissionBroker`; contract `PermissionRequest`/`PermissionPart` in
  `agent-protocol/src/types.ts`; kinds `read_linked_pages`, `website_full_access`, `asset_download`): when a website tool
  needs a setting that is off, or a download needs the user's approval, the call does not fail — the runtime
  publishes a pending `PermissionPart` in the **main conversation's** assistant message of the running turn (whichever
  agent asked, a specialist inside its run included) as a `permission.updated` chat event (SSE `event: chat`, folded by
  `applyChatEvent`, persisted in the chat's event log), so the chat shows the setting with "Allow once" / "Turn on" /
  "Don't allow". Studio answers `POST /v1/chats/:chatId/turns/:turnId/permissions/:permissionId` with `{decision}`
  (unknown chat/turn are `chat_not_found`/`turn_not_found`; anything no longer pending is `turn_not_active`). `once`
  posts a grant for the turn (`POST /api/projects/:id/research/website/grants {turnId, access: read|full}`), `always`
  switches the setting on (`PUT /api/research/policy {websites:{…}}`; full access also sets `readLinkedPages`), `deny`
  refuses every later call of that kind in the turn. Concurrent asks of the same kind share one request, and an answered
  kind is not asked again; an answered `website_full_access` request also covers reading, because full access includes
  it. `asset_download` is the third kind (the agents' Autonomy rule `askBeforeDownloads`, not an Asset Search setting): the
  request carries `asset` (`PermissionAsset`: title, source name or host, license as stated; taken from Research's
  remembered candidate or the URL host, never from model text), needs **no Studio grant** — `once` only approves
  downloads for the rest of this turn (runtime-only), `always` ("Don't ask again") switches the global setting
  `autonomy.askBeforeDownloads` off through `PermissionBrokerOptions.disableDownloadAsk` (wired to the settings store;
  when it fails the request stays pending) and approves, `deny` refuses every later download of the turn with a text
  telling the model the user declined (continue without outside material, do not retry, say what is missing). The
  same states are used (`allowed_once` / `enabled` / `denied` / `expired`). The waiting call resumes on the answer (its
  result tells the model the user allowed it once / turned it on; when the card was about a download or a recording
  (`asset_download` included), the answer also counts as the turn's `askBeforeDownloads` approval, an answer to an
  open/read card never does) or returns a refusal on deny/expiry ("continue without it, do not retry this turn"). The
  request never times out by itself: Stop, turn end or failure expires it (part updated) and revokes the turn's grant
  (best effort). When Studio cannot apply an `always`/`once` answer the request stays pending and the route fails, so
  the user can retry. The policy snapshot read at turn start decides up front, and a `blocked_by_policy` refusal
  re-reads the policy so a change made in Settings mid-turn is honoured. `FakeResearchHost` records
  `policyUpdates`/`grants`/`revokedGrants` for tests.
- **What the runtime owns.** `turnId`, `agent: "research"` and `model` (the model of the Research run, `provider/modelId`)
  are set by `src/research/executor.ts` on every import; whatever the model sends for them, or for a policy mode, is
  dropped. In a `resolve` turn with `storyOptions.missing`, `resolveMissing` / `resolve_missing_asset.missing` outside
  that list are refused by the executor.
- **Prompt.** At the start of a turn (whenever a research host exists) the runtime reads the policy: the Director's `<team>` block
  states the mode and the number of enabled trusted sources (or that the policy could not be read; with Research off it
  carries the policy, the enabled sources and the rules for the Director's own search work), and every task delegated to Research carries an `<asset-search-policy>` block with the mode, the enabled
  sources (id, name, kinds, license note) and the rules (stay within the policy, prefer clear > attribution > unknown
  licenses, match the node's need/kind/`neededDuration`, import only what will be used, resolve with `resolveMissing`,
  report source + license per asset, never invent license information) (`src/research/prompt.ts`). With Research off in the chat
  the same policy text, the source list and the working rules go into the Director's `<team>` block instead
  (`researchTeamLine`).
- **Resolve turns** (`storyAction: "resolve"`, Studio's "Find missing material"; `storyOptions.missing` limits the nodes):
  a checkpointed story-mode turn whose `<story-mode action="resolve">` block lists the unlocked Missing Asset nodes in
  scope. The Director delegates Research (batches of up to 4 nodes), nobody edits the story, builds or writes the
  timeline; Research has `read_story` plus the research tools. With Research off in the chat the Director does that work
  itself with the research tools it inherits (the prompt says so: `RESOLVE_SELF`); it does nothing only when Studio could
  not read the Asset Search policy, and says why.
  Afterwards the Director tells the user to Build Story / Rebuild affected sections.
- **Build and rebuild turns.** A build turn ("Build the video") offers the same research tools as a normal turn (Research:
  search/inspect/import/resolve/sources; Director: `read_sources`; the website tools as usual): the build produces the
  complete video, so Research fetches the music bed, sound effects and footage the graph's Missing Asset nodes ask for
  _before_ `build_story` and resolves them with `import_asset … resolveMissing`; the build then places them. Once
  `build_story` has succeeded in the turn the graph is frozen for Research too (the executor refuses `resolveMissing` and
  `resolve_missing_asset`); later material is imported without `resolveMissing` and placed with `edit_timeline`. A
  rebuild turn offers no research tool at all: `delegate` to Research is refused with a tool error, no `<asset-search-policy>`
  block is added, and the `<team>` roster says Research cannot search or import there (`researchTeamLine(…, action)`).
- **Export licenses.** After a successful `render_video`, `TurnEditing` calls `export-check` for the composition and appends
  the license warnings and credits to the tool result; the check never blocks, and a failed check is only noted.
- **Lifecycle.** Like the other executors, research calls go to a per-turn `TurnResearch` (refused when no turn is running
  or it is finalizing); `TurnRunner.finalize` awaits every started import/resolution (they write project files) before the
  checkpoint closes, so a turn's asset, provenance record and Story resolution are one revertable unit. The download
  cache sits outside history, so re-importing after a revert does not hit the network. Imports may take long (download +
  transcode): the HTTP host waits up to 15 minutes.
- **Stop during a write.** Every import/resolve carries a runtime-generated `requestId`. On abort (Stop, finalize) or
  timeout the host does not drop the connection: it sends `POST …/research/requests/:requestId/cancel` and keeps
  awaiting the original answer for up to 30 s. Studio decides at one synchronous commit point — cancelled before it, the
  request answers `cancelled` and nothing is written; once the commit started it finishes, and the result is returned
  because the write happened. A write that neither answers nor was acknowledged as cancelled fails `write_unsettled`;
  `TurnResearch.shutdown()` returns those as `unsettledWrites` and the turn's final message tells the user that such a
  file is not part of the checkpoint.
- `FakeResearchHost` (`src/testing`) is the in-memory host for tests (`importGate` holds an import in flight, recorded
  requests and signals); the runtime fixture wires it.

## Voiceover

Narration is spoken by a cloud text-to-speech provider the user connects with their own key (Gemini, OpenAI, OpenRouter,
ElevenLabs or one custom OpenAI-compatible server). Studio's voice service (`/api/voice` for the user's providers, saved
voices and dialects; `/api/projects/:id/voice` for the project's script, takes and synthesis; contract in
`packages/agent-protocol/src/voice.ts` and `voiceDialects.ts`) holds the keys and does every call — a key never reaches the
runtime or a model, and the agents name a saved voice (a preset) and send lines, never an address.

- **Voice host.** `main.ts` always wires the voice host. A runtime without one (a test fixture, another embedder) gives no
  agent a voice tool, and neither the role prompts (`VOICE_DIRECTOR` / `VOICE_AUDIO`, `RoleOptions.voice`) nor the plan
  mention narration. `ToolAvailability.voice` is that host's presence.
- **Host** (`src/voice/host.http.ts`, bound to one project): `presets` / `getPreset` (`GET /voice/presets`), `providers`
  (the user's "Rules for the agent" ride on each), `dialects`, `script` / `saveScript` / `setProjectVoice`
  (`GET|PUT …/voice/script`, `PUT …/voice/voice`), `check` (`POST …/voice/check`: dialect check and estimate, nothing
  paid) and `synthesize`. A synthesis is a **cancellable write** (`src/voice/transport.ts`, like an import): the request
  carries a runtime-generated `requestId`; on Stop the host posts `…/voice/requests/:id/cancel` and keeps waiting for the
  server's answer (a take may already be committing), failing `write_unsettled` only when the cancel was not acknowledged as
  `cancelled` and no answer came within the settle bound. Its progress is read from `GET …/voice/requests/:id` while it
  runs, and it has a 30-minute bound. Failures arrive as `VoiceToolError` with the service's code, `params`
  (`retryAfterSeconds`, `daily`, `contentType`, `body`) and `issues`; the executor turns them into text with what to do
  (`src/voice/format.ts`): `invalid_key` (tell the user, do not retry), `rate_limited` (with the retry time), `quota_exhausted`,
  `not_audio` (the server's answer, excerpted), `dialect_violation` (the issues), `not_configured` (call
  `request_voice_setup`).
- **Tools** (`src/voice/tools.ts`, executor `src/voice/executor.ts`): `request_voice_setup {language, sampleText,
suggestion}` (Director and Audio; the Director always has it) and `generate_voiceover {lines, lineIds?}` (Audio; the
  Director inherits it when Audio is off — `withInheritedTools`). Both change the project (and cost money): never in an Ask
  turn, refused after a plan proposal, in the Render QA review and in the final report, and in a design turn
  (`PROJECT_CHANGING_TOOLS`, `CHANGES_PROJECT`). They write takes and audio through the voice service, never a
  composition, so they take no write lease; a running generation is cancelled and awaited in `finalizeTurn` before the
  checkpoint closes (the service's takes file is history-tracked, so Revert undoes the turn's voiceover).
- **`request_voice_setup`.** The call publishes a `voice-setup` part (a `VoiceBroker`, cloned from the question broker with
  a structured answer, `src/voice/broker.ts`) and waits. The user answers `POST /v1/chats/:chatId/turns/:turnId/voice-setups/:id`
  with `{presetId}` or `{decline: true}`; an unknown preset is `invalid_request` (the card stays pending, checked with
  `host.getPreset`), an answered or expired card `turn_not_active`. On a preset the **runtime** sets the project's voice
  (`PUT …/voice/voice`) and returns the voice with its script dialect (`renderVoiceDialect(dialect, provider.agentRules)`:
  tags, pauses, style field, limits, vendor guidance and the user's own rules). A decline or an unanswered card (the turn
  ended) returns a refusal that says there is no voiceover and not to make speech another way.
- **`generate_voiceover`.** Updates the script, never replaces it (`upsertLines` in `src/voice/executor.ts`: reads
  `GET …/voice/script`, a line with an existing id is replaced in place, an id-less line with the exact text of an unclaimed
  existing line is that line, any other line is appended, every line the call does not carry stays untouched, then
  `PUT …/voice/script`; `lineIds` defaults to the lines of the call that have no current take), checks it
  (`POST …/voice/check`; an error goes back to the agent verbatim with the dialect rules, nothing is paid and no card is
  shown), asks `voice_generation` — a once-only permission card carrying `voice: {provider, model, lines, seconds,
usdCost}`, answered once per turn like `long_render`, skipped when every line is already cached —, generates the **first
  line needing generation** as the pilot and publishes a `voice-pilot` part (`POST …/voice-pilots/:id` with `{decision:
"approve"}` or `{decision: "change", feedback}`). Approved: the rest is generated in the same call and the result lists
  every line's id, file, range in the file and length, how to place them (`edit_timeline add_clip {voiceLine, start,
track}` — the clip takes the file, range and length from the line's selected take) and to duck the music
  (`duck_audio`); changes: the user's note is returned, nothing else was generated; a failure after the pilot keeps the
  pilot and says so. Server problems return as text (above); the call never retries by itself.
- **Prompts.** `VOICE_DIRECTOR`: call `request_voice_setup` first, write the script in the returned dialect, optionally show
  it with `propose_plan` (one step per line, the step title is the speaker text — Studio draws its tags as chips), then
  delegate to Audio with the script and the dialect rules in the task. `VOICE_AUDIO` (also in the Director's inherited
  work when Audio is off): voice → script → `generate_voiceover` → placement with `voiceLine` → `duck_audio` → verify.
- **Captions from the voiceover.** With the voice host on, `edit_timeline` also offers `captions_from_voiceover {preset?,
track?, lines?}` (schema in `editing/schemaMore.ts`, hidden by `editTimelineParameters(…, voice)` and absent from the
  description otherwise, so the tool reads exactly as before without a voice host): every clip placed with `add_clip
voiceLine` shows its line's own text timed by the words of the take it plays. `VOICE_CAPTIONS` (Audio and Editor, and the
  Director's inherited Editor work) tells the agents to place the narration first and never retype the script into
  `apply_captions`.
- Events and parts: `voiceSetup.updated` / `voicePilot.updated` (`messageId`, the request) fold into `voice-setup` /
  `voice-pilot` parts in the main message; a pending card is expired when the turn ends (`settleOpenPart`), like questions.
- Chat rows: `requesting_voice_setup`, `generating_voiceover {count}`.
- `FakeVoiceHost` (`src/testing/voice.ts`) is the in-memory host for tests; unlike the other fakes the runtime fixture does
  not wire it by default — pass `{ voice: () => host }` to `createRuntimeFixture`.
- **Narrated stories.** A Story Graph chapter has a `narration` field (the narrator's text; always editable). With the voice
  host on, the story prompt (`story/prompt.ts`) adds a step before `build_story`: for the chapters with narration, `request_voice_setup`
  when the project has no voice, then ONE `generate_voiceover` with a line `{id: "chapter-<chapterId>", text: <narration>}`
  per narrated chapter in story order; the plan/review rules let the Director write `narration` when the user asks for a
  narrated video; `edit_story` / `build_story` / `rebuild_story` descriptions carry a voice note, `read_story` shows each
  narration with "voice generated, <length>" or "voice not generated yet" (`StoryNodeFacts.narration`, dropped by
  `TurnStory` without the voice host), and the Audio step ducks music under the narration. Build Story itself reads
  `.hyperframes/voice/takes.json`, never the voice engine (studio-server `story/compile.ts`).

## Other projects (`#` attachments)

The user can attach **other OpenVids projects** to a chat with `#` in the composer (a `ProjectReference` part of a user
message: the shell's per-folder key, the name and the ticked parts — renders, music, other audio, images, video, story, or
all; contract in `packages/agent-protocol/src/crossProject.ts`). An attachment is a **link, not a copy**: nothing is in
the project until an agent copies it. Studio's cross-project service (`/api/projects/:id/cross-project/*`, reached by
`src/crossProject/host.http.ts`) lists the files of the attached parts (`manifest`) and performs the copy (`import`); no
path ever crosses the runtime, only keys, names and project-relative paths.

| Tool                                   | Who                             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import_from_project {project, files}` | Director, Editor, Motion, Audio | Copies files of an attached project into `assets/from/<project>/…`; the source file's provenance record (license, author, credit line) is carried into this project's ledger with `importedFrom`. Result: `source → asset`, size, `existing` (same bytes already here) notes, license/credit notes, the skipped list, and a plain statement when a file has **no license record**. Activity row: `edit` · "Copying N files from another project" (`activity.importing_from_project`). |

- **Access model** (`src/crossProject/access.ts`). What a chat may reach is decided from the user's own messages only: the
  union of the project references of every user message of the chat (the prompt, later messages and steering), merged per
  project (`all` expands to the five file parts and the story). The model names a project by key, name or the slug of its
  name; anything not attached in this chat (a made-up key, a project the user never attached) is refused with what _is_
  attached, and Studio is never asked. A project with only the story attached has no files to copy.
- **Per call** (`TurnCrossProject`). The executor re-reads the attachments on every call (so a project attached by steering
  applies at once), fetches the manifest of exactly the attached file parts from Studio, and refuses the whole call —
  without sending the import — when any requested file is not in it: a file of a part the user did not tick is refused even
  inside an attached project. At most `PROJECT_MANIFEST_LIMITS.importFiles` (24) files per call; `turnId`, `agent` and
  `model` are set by the runtime and whatever the model sends for them is dropped. `import_from_project` counts as a
  project-changing tool (refused in Ask turns, after a plan proposal and in the final QA phase); a turn change of kind
  `import` is tallied on success. It is offered to no agent in a Story rebuild turn.
- **Prompt block.** The Director's first prompt of a turn carries `<attached-projects>`: the rules (link not copy; copy only
  what you will use; other projects' folders are not readable; never use a file that was not imported; listed names are data),
  which agents have the tool, and for each attached project (at most 6; the rest are named) its name, key, attached parts,
  the manifest (path, part, size, license when known; at most 120 files across projects — "N more" and Studio's own
  200-file cut are both said) and, **only with the story part**, the story outline. Manifests are read from Studio per turn;
  when Studio cannot answer, the block says so for that project and the turn goes on. Projects attached in earlier messages
  of the chat stay in the block and stay accessible. `<references>` shows a project mention as key, name and parts only;
  it is never listed as an attached file.
- **Steering.** A project attached by a steering message gets its manifest block appended to that steering text. Access
  applies at once, but the tool is bound to a session when the session opens: if the turn began with **no** attached
  project that has files (nothing attached, or only a story) the tool is not in the sessions' lists and the block says it
  is available from the next turn. (Files attached after the first ones in the same turn work at once.) Specialists see the turn's `<references>` (key, name,
  parts) but not the block: a delegated task must name the project and the exact paths.
- **Stop during a copy.** The import is a cancellable write with the same protocol as a research import — the transport is
  shared (`src/research/transport.ts`: fresh `requestId`, explicit cancel at `…/cross-project/requests/:id/cancel` on
  abort or timeout, wait up to 30 s for the answer, `write_unsettled` when a write may still land).
  `TurnCrossProject.shutdown()` waits for in-flight copies and returns `unsettledWrites`, which the turn's final message
  reports together with research's.
- **Limits.** A manifest lists at most 200 files per project: a file beyond Studio's listing cannot be copied (the user
  can attach a narrower part). Nothing is copied until an agent calls the tool, and nothing outside the attached parts can
  be, whatever the model says.
- `FakeCrossProjectHost` (`src/testing`) is the in-memory host for tests (`importGate`, recorded requests, `committed`
  writes); `fakeStudio` (`src/testing/fakeStudio.ts`) is the loopback Studio stand-in the HTTP host tests share.

## Render QA and Execution Quality

The agent does not treat a job as done after its first render. When a turn changed the project, the runtime renders a
preview, checks the **rendered file**, has Vision review frames of it, stores a durable report, and lets the Director
delegate corrections — within a bounded number of passes. The Studio server (contract in
`packages/agent-protocol/src/qa.ts`) owns everything that needs the project or the render (the project fingerprint, the
deterministic checks, frame extraction, the reports in `<project>/.hyperframes/qa/`); the runtime reaches it over loopback
HTTP (`src/qa/host.http.ts`: `${studioOrigin}/api/projects/:id/qa/{state,check,check-timeline,frames,reports,accepted}`) and owns the loop and
Vision's review.

**Execution Quality** is the orchestration budget of a turn: `fast` | `balanced` (default) | `best` | `custom`
(`ExecutionBudget`: `qaPasses` 0–5, `qaFramesPerMinute`, `qaMaxFrames`, `critiqueRounds`, `analysisFramesPerSource`,
`researchCandidates`, `specialistThinking`). The global default lives in `settings.json` (`executionQuality`; a file from
before it existed reads as Balanced and gains it on the next write), a chat may override it (`PATCH` chat
`executionQuality`, `null` returns to the global default), and the turn records what it ran with
(`TurnSummary.execution = {preset, budget}`, resolved once at turn start by `resolveExecutionBudget`, custom budgets
clamped to their ranges). The Director's `<team>` block states the preset and the QA budget. Every field is **enforced**,
not suggested:

- `specialistThinking` → `applyThinkingPolicy` on every delegated specialist run (after routing) and on the Vision QA run:
  `economy` caps at `low`, `thorough` raises to at least `high`, `configured` leaves it alone.
- `researchCandidates` → `search_assets.limit` defaults to it and is clamped to it (`src/research/tools.ts`); the
  `<asset-search-policy>` block tells Research.
- `analysisFramesPerSource` → `TurnAnalysis` refuses `inspect_frames` calls that would extract more distinct frames per
  source in the turn (the refusal names the budget and what is left; a time already inspected is free).
  The same number is the per-turn budget of `inspect_composition` (composition frames; frames Studio serves from its
  cache are given back, so only changed or new moments cost).
- `qaMaxFrames`, `critiqueRounds`, 12 frames per call → `TurnQa` (`src/qa/executor.ts`) on the reviewer's `inspect_render`;
  `qaFramesPerMinute` / `qaMaxFrames` also go to the service to plan the frames Vision gets.

**The loop** (`src/qa/loop.ts`; the pass itself in `pass.ts`, the visual review in `review.ts`, the live state in
`state.ts`; run by the turn runner after the Director and its follow-ups finished). QA runs only when the Director's work
completed, the turn may write the timeline (normal turns and story `build` turns; a story `rebuild` turn is checked but
report-only — no correction: only `rebuild_story` may write there; story review/resolve turns are never checked) and
either the project fingerprint differs from the one at turn start (`QaHost.state`) or the turn rendered the main
composition (an export request on an unchanged project still gets its render checked). With `qaPasses` 0 the turn
records `skipped` ("Render QA is off") when the project changed. Each pass checks only as much as it needs
(`QaScope`, recorded on the pass, the report and the turn's QA with a `scopeNote`):

- `full`: render + deterministic checks + visual review.
- `timeline`: no render; `QaHost.checkTimeline` (flash clips, gaps, missing files, past-media, cuts inside words, story
  Missing Assets). Used for a composition over 180 s that the user did not ask to render in this turn, in words or by allowing the `long_render` card (`too_long`; the
  correction loop still runs on its findings), and as the fallback when the render checks time out (`check_timeout`:
  the render exists, its measured checks did not finish within the host's deadline, or the runtime's own fetch default
  fired first — `QaToolError` code `timeout`). The final report says the render was not looked at.
- `deterministic`: render + deterministic checks, the visual review skipped by the cheap-path rule. The rule compares
  the timeline with the timeline of the previous pass (pass 1: the timeline when the turn started, `startTimeline`),
  clip by clip (`src/qa/changeScope.ts`): only audio clips changed (`audio_only`: Vision cannot hear), or at most 2
  existing clips were only retimed / re-leveled with no new picture, source or text (`small_change`: the deterministic
  checks cover what a retiming breaks). A change nobody can size (captions or styles changed, no clip did; a different
  canvas), and a visual issue still waiting for its re-check (a fixable Vision issue open after the previous pass), get
  the full review.

Issues the pass did not look at stay open as **not re-checked** instead of being recorded fixed: the previous pass's
issues whose source this pass skipped (a visual review that did not run or failed, a timeline-only pass, a failed render,
a render-measured or layout check that did not run) are carried as `notRechecked` drafts — report-only (`fixable:
false`, never sent to a correction, listed apart in the correction and final prompts). When only such issues remain the
loop ends `issues_remain` / `not_rechecked`. Issues the user **marked intentional** (`QaHost.accepted`, the project's
`.hyperframes/qa/accepted.json`; a match is `findAcceptedQaIssue`: same composition, kind, overlapping time, same
subject) are left out of every pass — deterministic findings and Vision's alike — counted in `QaReport.suppressed` /
`QaPassState.suppressed`, told to Vision, the Director's correction and final prompts, and never asked for again.

Pass _k_ of _N_:

1. **Render** a preview (`draft`; when the user asked for a render, the quality of the Director's last `render_video`, else
   `standard`, so the last QA render is the deliverable; a re-render after a correction keeps the quality of the render it
   replaces). Pass 1 reuses the Director's own render of the same composition when the project had the same fingerprint
   before that render started as when QA starts (`TurnEditing.lastRender`). The render's progress goes to
   `QaPassState.progress` (published on a 3 % step or a second). A render failure is classified
   (`src/qa/renderFailure.ts`): one that names the machine or Studio (missing ffmpeg, full disk, dead browser, lost
   sidecar, Studio plumbing) ends QA at once as `failed` (`render_environment`, the real reason, no correction, no
   report); any other is stored as a report (`renderError` + a fixable `render_failed` issue owned by the Editor) and
   counts as a pass.
2. **Check** the render (`QaHost.check`: black/frozen frames, audio gaps, flash clips, missing files, layout) and get the
   frames to review. A check that times out falls back to the timeline checks (above).
3. **Visual review**: a runtime-started Vision run "Render QA · pass _k_" (`Orchestrator.runInternal`; an ordinary run in
   the chat, counted as reported so it never re-prompts the Director) with `inspect_render {times}` and
   `report_render_findings {findings}` — tools refused outside an open review and for anyone but its reviewer. When
   Vision is **off in the chat** the Director does the review (`qaToolsFor` applies the inherited-tools rule): the same
   task goes to the Director as a `<render-qa-review>` prompt in phase `review`, where every project-changing tool is
   refused; its text around the review is marked interim; `QaVisionRun.reviewer` is `director`. Findings are forced to
   source `vision` and deduplicated against the deterministic issues with `sameQaIssue` (kind + overlapping time +
   subject when both name one). The run failed or no findings reported → `vision.status` `failed` with a reason; the
   deterministic result stands and the Director is told.
4. **Compare** with the previous pass (`compareQaPass`: new / persisting / reappeared / fixed), **store** the report
   (`QaHost.saveReport`), emit `qa.updated` on every phase change and keep `turn.qa` current.
5. If fixable issues remain and _k_ < _N_: the Director gets a `<render-qa pass=… limit=…>` prompt (open issues by owner
   with ids, times, clips and suggestions; what was fixed, persists, reappeared, and what is new after its last correction
   — a regression; the not-re-checked and intentional ones apart; a "Look at" line per picture issue naming the moments
   to open with `inspect_composition`, to be put into the delegated task — a prompt carries text only; instruction to
   delegate to Editor/Motion/Audio/Research with self-contained tasks; a deterministic finding that is plainly
   intentional may be left, said so in the report) and its delegated runs are collected like after its first reply.
   `render_video` is refused during a correction (the runtime re-renders). A correction that leaves the project
   fingerprint unchanged ends the loop (`issues_remain`); the loop never exceeds _N_ renders (at most *N*−1 corrections).

**The Director does not announce "done" before QA.** When QA can apply to a turn (QA host available, `qaPasses` > 0,
`qaApplies(mode, action)`), the Director's first prompt and its follow-up prompts before QA end with a
`<render-qa-pending>` block: the reply is an interim progress note, not the answer. The guarantee does not depend on the
model obeying: when QA really starts, and again before the final prompt (so correction replies count too), the loop calls
`TurnEventWriter.markTextInterim()`, which emits `assistant.parts.interim {messageId, partIds}` for the Director's text
parts written so far (folded to `interim: true` on the text part; Studio labels them "Before render QA"). The
`<render-qa-final>` prompt's reply is the final answer. When QA is skipped after the Director was told a check follows
(Studio's QA service cannot say whether the project changed, or cannot be read), its reply is marked interim and a
`<render-qa-skipped>` prompt asks for the real answer with the reason. The same closing prompt follows when the
project ended **unchanged** but the Director (or its team) called a project-changing tool this turn
(`QaLoopDeps.workAttempted`): an edit that was refused or a teammate's work that did not land must not stay behind a
"checking now" reply; a turn that only answered gets nothing extra.

**Reverted turns.** The Director's session keeps the messages of a turn the user reverted; the next turn's first prompt
carries a `<reverted-turns>` block (`src/revertedTurns.ts`) listing the turns reverted since the previous turn started,
so the Director does not describe their edits as present.

**Forked projects.** The desktop shell copies chats when it forks or duplicates a project and writes `.hyperframes/agent/fork.json` (`{ "forkedAt": <epoch ms> }`). The history entries behind the checkpoints of turns that started earlier stay in the original's history (the copy gets its own, empty one), so `FileChatStore` (`src/store/forkMarker.ts`) drops those turns' checkpoints whenever it reads a chat log: no "Revert this turn" for them, replayed events included. A turn that was reverted before the fork keeps its "Reverted" mark without "Undo revert". The stored log is not rewritten by this. Turns started after the marker are ordinary.

Afterwards the Director gets one `<render-qa-final>` prompt (outcome, last render, fixed vs remaining issues) to report; in
it `edit_timeline`, `build_rough_cut`, `build_story`, `rebuild_story`, `edit_story`, `render_video`, `delegate`, `jev`,
`import_asset` and `resolve_missing_asset` are refused (`src/qa/phase.ts`). Steering sent during QA opens the next Director
prompt. Aborting anywhere in QA cancels the render/check/frames/Vision run, marks the pass `aborted`, stores no report for
it and finalizes the turn `aborted`; `TurnQa.shutdown` is awaited in `finalize` before the checkpoint closes.

**Cleanup.** Every QA pass that renders leaves a preview in `renders/`. When the QA session ends (any status: `passed`,
`issues_remain`, `failed`, or `aborted`) the loop calls `QaHost.finishSession` (`POST …/qa/sessions/:turnId/finish
{keep, produced?}`): `keep` is the latest render that succeeded (the file the final report names), `produced` lists the
previews QA itself rendered (so one a stopped pass made before its report was stored is not left behind). The Studio
server deletes the session's intermediate QA previews with their job sidecar and frame cache, never the kept one and
never a render a report records as the turn's own (`QaRenderInfo.origin: "turn"`, the Director's render pass 1 reuses),
then applies its report retention (`studio-server/src/qa/retention.ts`: the reports of the 20 most recent sessions, of
anything younger than 3 days and of a running session stay; older reports and orphaned frame caches go). The call uses
its own signal (not the turn's, so it runs after an abort), is bounded by the host's timeout, and its failure is
swallowed (`TurnQa.finishSession`): cleanup never fails a turn.
What the service deleted comes back in the finish answer, and the loop sets `QaPassState.renderKept` on every pass that
has a render: the card links only the renders that are still there (a report read later carries the derived
`renderAvailable`).

`FakeQaHost` (`src/testing`) is the in-memory host for tests (the project's `fingerprint` and `bump()`, queued check and
timeline-check results, `acceptedItems`, `finishRemoved`, `checkGate` / `framesGate` / `cancelDelay`, stored `reports`);
the runtime fixture wires it.

## Turns, checkpoints, concurrency

- One project-modifying turn at a time across all chats of a project (`chat_busy` / `project_busy`).
- The user's UI language rides with every start and steer request as `userLanguage` (a BCP-47 tag
  Studio takes from its i18n instance). `renderPromptContext` appends a `<user-language>` block
  with one English instruction ("Reply to the user in Russian; keep tool calls, file contents, code
  and identifiers unchanged") to the Director's prompt and to every specialist task; English or an
  unknown tag adds nothing, so the prompt is byte-identical to before. System prompts stay English.
- One prompt = one turn = one checkpoint. A checkpoint is a project-history window attributed to the
  `Director` agent (existing engine behind Undo); revert undoes the turn's entries newest first with
  `keep-later-edits` or `just-this`. If no checkpoint can be opened the turn does not start.
- Checkpoint lifecycle: the transaction opens before the prompt reaches the Director and stays open
  for the whole turn. The runtime renews its lease (`POST …/history/window/:id/renew`) every 20 s;
  the lease is 2 min, so pauses of any length between writes stay in the same transaction, while a
  dead runtime's transaction ends by itself within 2 min instead of absorbing later edits. It closes
  only when the turn completes, fails, is aborted or is found interrupted. If a renewal reports the
  transaction gone, the turn is stopped (failed) so no write escapes Revert. If closing fails (Studio
  unreachable), the checkpoint stays `active` with its `transactionId`, and `recoverCheckpoints()`
  closes it and collects its entries before the next turn or on the next project load; a turn left
  `running` by a crash becomes `interrupted` the same way.
- Edits Studio itself makes during a turn stay the user's own history entries; edits from other
  apps during a turn are attributed to the turn (existing history-engine semantics).
- Tests import `@hyperframes/studio-server` through its `node` (dist) condition: rebuild it
  (`bun run build`) before running this package's tests after history-engine changes.

## Agents (OMP adapter)

Every agent (Director, specialists, Jev) is a restricted OMP session, not the user's personal OMP
environment: project file tools `read`, `grep`, `glob`/`find`, `edit`, `write` plus the runtime's
host tools for that agent (no bash/eval/web/MCP/LSP/task); host tools are passed as SDK custom tools
(`allowRestrictedCustomTools`); orchestration calls are not reported as project activity (the runtime
emits its own events), editing tools report labelled activity rows. Role
instructions (system prompts) come from the runtime (`src/agents/roles.ts`). Edit mode is pinned to
path-based `replace`; skills and rules are empty; only `<project>/AGENTS.md` (or `CLAUDE.md`) is
loaded as context. Providers, auth and model catalog come from the user's existing OMP setup
(`~/.omp/agent`; the runtime stores no key or sign-in of its own there, see "What still writes to OMP's database") plus the API keys stored in OpenVids (see Providers and credentials). A `tool_call` guard (`src/omp/path-guard.ts`)
blocks every path outside the project or inside `.hyperframes/`, checks each target of OMP's `a;b` /
`a,b` / `a b` / brace path fan-out, and fails closed for `edit`/`write` calls whose target it cannot
read. The guard is bound through `preloadedPreparedExtensions`: OMP silently drops `extensions` when
`restrictToolNames` is set, so an inline `extensions` hook would not run. The same hook
(`src/omp/tool-guard.ts`) also keeps `edit`/`write` away from timeline-locked clips: for a project
HTML file that contains `data-timeline-locked` elements it computes the content the call would leave
(replace-mode `old_string`/`new_string`/`replace_all`, or the `write` content), and blocks the call if
any locked element (matched by `data-hf-id`, else `id`) would be removed, changed or unlocked, or if
the call cannot be interpreted (`src/omp/lock-guard.ts`).

The guard also knows who it guards. **Vision and Research may not `edit`/`write`** at all (a role refusal that names the
agent and says what to do instead), whatever the turn allows. **Write leases** (`src/writeLeases.ts`, one `WriteLeases` per
turn): before an `edit`/`write` of a composition file (`.html`) the guard asks `OpenBackendSessionInput.claimWriteFiles`;
a delegated run holds the files it writes until its run ends, another run's (and the Director's) write to a held file is
refused with the holder's name, and the Director itself never takes a lease. A session knows the run it serves (a
specialist's resumable session is rebound to each new run, an extra parallel session and a Jev session are opened for
one), so two runs of one specialist never share a lease, and a Jev run called by a specialist writes under that run's
lease instead of being refused by it (`Orchestrator.leaseWriterOf`). The editing service calls the same store
before `edit_timeline` applies to a composition. **Bundled skills** are readable: `read`/`grep`/`glob`/`find` may look
into the skills tree (`OPENVIDS_SKILLS_DIR`, else `<repo>/skills` in a source checkout, else
`<resources>/runtime/hyperframes/skills` in the packaged app; `src/omp/skills-root.ts`), never write or edit there, and the
session's system prompt names the folder. `tools.intentTracing` is off in the session settings: it adds an `i` argument to
every tool, which models were seen gluing onto tool names (`i_inspect_timeline`); the wire-only `_` prefix pi-ai puts on
tool names for Anthropic OAuth is the SDK's and cannot be changed here.

What the SDK does around a model call is visible. `auto_retry_start/end` and `auto_compaction_start/end` become labelled
activity rows (`provider_retry` with `attempt`, `maxAttempts`, `delaySeconds` and the provider's `reason`, trimmed and with
credentials masked, which the row shows under its label; `context_compaction`) from start to end (`src/omp/maintenance.ts`). A failed tool row carries `Activity.error` (`tool_failed` + the tool's own text, trimmed to 300
characters with anything credential-shaped masked). A provider failure rejects the prompt with a `RuntimeError` classified
from the message (`provider_auth`, `rate_limited`, `provider_overloaded`, `context_overflow`, else `agent_failed`; says so
when the SDK retried first; `src/omp/provider-errors.ts`) and `failureCode(error)` (errors.ts) gives the turn's error code.
Each finished model call becomes a `usage` backend event (tokens and cost of that call, plus the context fill after it);
`TurnEventWriter` sums them per agent into the cumulative `usage.updated` events. `AgentBackend.contextHash(projectDir)`
hashes the project context file as the agent sees it, so an edited `AGENTS.md` reopens the sessions.

**Context windows** follow the user's `AgentSettings.extendedContext` (Settings › Agents › Context, "Full context windows",
default on), never OMP's own `extendedContext`: the backend reads it on every `ensureServices` (each turn start reads the
catalog) and sets it on the registry's `Settings` as an in-memory override (`cfgExtendedContext.override`; the user's
`~/.omp/agent/config.yml` is never written), then `registry.reapplyModelPolicies()` rebuilds the windows from the cached
catalog. Off, OMP caps a model that has a premium long-context price tier at that tier's threshold (`cost.longContext.inputThreshold`:
Claude Haiku 5.5 100K of 1M, Codex GPT-5.6 272K) and Codex GPT-6/6.1 stay at 272K, so compaction runs before a request
costs more; on, every model gets the largest window its provider offers. A session binds its model afresh at every
prompt, so open chats take the new window from their next turn.

## Develop

```bash
bun run --cwd packages/agent-runtime typecheck
bun run --cwd packages/agent-runtime test        # fake backend + fake checkpoint host, no network
OPENVIDS_AGENT_TOKEN=dev bun packages/agent-runtime/src/main.ts
```

Vitest resolves `@hyperframes/agent-protocol` through its `node` export condition, so build it first
(`bun run --cwd packages/agent-protocol build`; the root `bun run build` does).

## Turn runner internals

`turns.ts` is the public `TurnRunner`; the work lives in `src/turn/`: `run.ts` (the Director's prompt loop), `executors.ts` (the turn's tool services and brokers), `dispatch.ts` (every host-tool call: intent/phase refusals, family routing), `gates.ts` (phase and file-write rules), `sessions.ts`, `prompt.ts`, `finalize.ts`, `reverts.ts`, `storyOffers.ts`, `changes.ts`, `watchdog.ts`. `designAction` / `designOptions` ride on `ActiveRun` like `storyAction`.

- **Stable sessions.** A Director/specialist session is opened with the union of the tools any kind of turn would give it (Ask/Edit, story actions, plan and Story offers) and keeps them; the turn's real rules are enforced at dispatch with a refusal that says why. The session signature also holds the project's context-file hash (`AgentBackend.contextHash`), so an edited `AGENTS.md` reopens it.
- **Director watchdog.** No backend event for `promptStallMs` (default 10 min) fails the turn with a clear error; the clock is held while one of the Director's own tools runs (render, analysis, a question to the user).
- **Long renders.** A composition over 3 minutes that the user did not ask to render shows a `long_render` card (once/deny); a request in words (tolerant EN/RU rule, negations cancel; a bare "render"/"export" counts only as an imperative or after a request opener, so a question or a remark like "the last render took forever" asks for nothing) skips it.
- **Phase gates.** `propose_plan`/`offer_story_mode` exclude each other and are refused in every Render QA phase; `request_input` is refused in QA; the final report starts no analysis job.
- **Plan staleness.** A proposal records `projectFingerprint`; an execute turn on a changed project gets a note to adapt the steps.
- **Steering** received during setup, while the Director is idle, still starting its prompt, or refused by the model is queued and opens the next Director prompt (never a 409 or a failed turn); `BackendSession.steer` rejects whatever it cannot take now and the backend never queues text itself. A completed turn that left delegated runs open says they were stopped.
- **`request_input`** asks the user one question (up to 6 options) and waits like a permission; the turn's end expires it, and so does cancelling the run that asked (only that question; the same holds for a `long_render` or download card a cancelled run is waiting on). Answer: `POST …/turns/:turnId/questions/:questionId`.
- **Routes.** `DELETE /chats/:chatId` (409 `chat_busy` while the chat runs a turn, is being reverted or is already being deleted; the chat is reserved before the first await), `POST …/runs/:runId/cancel`, `PATCH /chats/:id {excludedSites}`; `ChatSummary.linkedSites` is recomputed from the user's messages.
- **Change summary.** `TurnSummary.changes` counts what tools applied (`add_clip`, `remove_clip`, `move_clip`, `trim_clip`, `update_clip`, `captions`, `audio`, `canvas`, `story_edit`, `story_build`, `design_attach`, `rough_cut`, `import`, `web_save`, `file_edit`, `render`).
- **Editor context** goes in full once, in the Director's first prompt of a turn; specialist tasks and steering carry it without the clip list.
- **Carried-out plans.** A turn started from a proposal ("Carry out the plan") records the proposal's turn as `TurnSummary.executedPlanTurnId`.
- **Wiring facts the tests rely on.** `openTurnTools` (`src/turn/executors.ts`) opens, from the options the app passes (`editing`, `frames`, `analysis`, `story`, `research`, `qa`), one executor per family and the brokers; a family's tools are offered when its host exists (`ToolAvailability`), and the Director's own set grows with every specialist that is off. A run's write leases end with the run (`runSettle`) and the turn's with `finalizeTurn`; `claimWriteFiles` (`sessions.ts`) asks the same store for the `edit`/`write` guard, with the running run of the calling specialist. `failureCode(error)` gives a failed turn its error code. In tests a session's tool list says nothing about the turn: `usableTools` (`src/testing/usable.ts`) calls the tools from inside a prompt script and reports the ones dispatch does not refuse, and `isQaClosing` (`src/qa/harness.ts`) lets a script skip Render QA's closing prompt (`<render-qa-skipped>`), which would otherwise run it a second time.
