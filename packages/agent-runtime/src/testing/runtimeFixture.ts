import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectScope } from "../checkpointHost.js";
import { ChatService } from "../chats.js";
import { AgentSettingsStore } from "../settings.js";
import { FileChatStore } from "../store/index.js";
import { TurnRunner, type TurnRunnerOptions } from "../turns.js";
import { FakeCheckpointHost } from "./index.js";
import { FakeAnalysisHost } from "./analysis.js";
import { FakeEditingHost } from "./editing.js";
import { FakeStoryHost } from "./story.js";
import { FakeResearchHost } from "./research.js";
import { FakeQaHost } from "./qa.js";
import { ScriptedAgentBackend } from "./backend.js";

export interface RuntimeFixture {
  root: string;
  scope: ProjectScope;
  store: FileChatStore;
  settings: AgentSettingsStore;
  chats: ChatService;
  turns: TurnRunner;
  backend: ScriptedAgentBackend;
  checkpoints: FakeCheckpointHost;
  editing: FakeEditingHost;
  analysis: FakeAnalysisHost;
  story: FakeStoryHost;
  research: FakeResearchHost;
  qa: FakeQaHost;
  now: () => number;
  setNow: (value: number) => void;
  cleanup: () => Promise<void>;
}

export async function createRuntimeFixture(
  options: TurnRunnerOptions = {},
): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), "openvids-agent-runtime-"));
  const projectDir = join(root, "project");
  await mkdir(projectDir);
  let timestamp = 1_700_000_000_000;
  let id = 0;
  const now = () => timestamp++;
  const ids = () => `id-${++id}`;
  const scope: ProjectScope = {
    projectId: "project-one",
    projectDir,
    studioOrigin: "http://127.0.0.1:4173",
  };
  const store = new FileChatStore(projectDir);
  const settings = new AgentSettingsStore(join(root, "settings"));
  const backend = new ScriptedAgentBackend();
  const checkpoints = new FakeCheckpointHost(now);
  const editing = new FakeEditingHost();
  const analysis = new FakeAnalysisHost();
  const story = new FakeStoryHost();
  const research = new FakeResearchHost();
  const qa = new FakeQaHost();
  const chats = await ChatService.open(scope, store, { now, ids });
  const turns = new TurnRunner(chats, backend, checkpoints, store, settings, {
    editing: () => editing,
    analysis: () => analysis,
    story: () => story,
    research: () => research,
    qa: () => qa,
    analysisPollMs: 1,
    ...options,
    now,
    ids,
  });
  return {
    root,
    scope,
    store,
    settings,
    chats,
    turns,
    backend,
    checkpoints,
    editing,
    analysis,
    story,
    research,
    qa,
    now,
    setNow: (value) => {
      timestamp = value;
    },
    cleanup: async () => {
      await turns.dispose();
      await backend.dispose();
      // `turns.dispose()` already drains, but belt and suspenders: the directory must only go once no store write
      // is still in flight (Windows fails the removal, or the write, when they overlap).
      await chats.drain();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Polls `predicate`; `timeoutMs` bounds tests that cross real I/O (HTTP, ffprobe) instead of in-memory fakes. */
export async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs?: number,
): Promise<void> {
  const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  for (let attempt = 0; deadline !== null || attempt < 200; attempt += 1) {
    if (predicate()) return;
    if (deadline !== null && Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
