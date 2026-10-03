import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  AGENT_HEADERS,
  AGENT_PROTOCOL_VERSION,
  encodeScopeHeader,
  EXECUTION_BUDGETS,
  isRecord,
  type ProviderInfo,
} from "@hyperframes/agent-protocol";
import { createRuntimeApp, type RuntimeApp } from "./server.js";
import { RuntimeError } from "./errors.js";
import { AgentSettingsStore } from "./settings.js";
import {
  FakeAnalysisHost,
  FakeCheckpointHost,
  FakeEditingHost,
  FakeQaHost,
  FakeResearchHost,
  FakeStoryHost,
} from "./testing/index.js";
import { ScriptedAgentBackend } from "./testing/backend.js";
import { researchPolicy } from "./testing/research.js";

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("Expected a JSON object response");
  return payload;
}

describe("runtime HTTP server", () => {
  it("authenticates requests and rejects invalid project scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-http-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const backend = new ScriptedAgentBackend();
    const app = createRuntimeApp({
      backend,
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      research: () => new FakeResearchHost(),
      qa: () => new FakeQaHost(),
      settings: new AgentSettingsStore(join(root, "settings")),
      token: "runtime-secret",
    });
    const headers = {
      [AGENT_HEADERS.token]: "Bearer runtime-secret",
      [AGENT_HEADERS.projectId]: "project-one",
      [AGENT_HEADERS.projectDir]: projectDir,
      [AGENT_HEADERS.studioOrigin]: "http://127.0.0.1:4173",
    };
    try {
      const unauthorized = await app.request("/v1/health");
      expect(unauthorized.status).toBe(401);
      const health = await app.request("/v1/health", {
        headers: { [AGENT_HEADERS.token]: "Bearer runtime-secret" },
      });
      expect(health.status).toBe(200);
      expect(await responseObject(health)).toMatchObject({
        ok: true,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        backend: "scripted",
      });
      const wrongToken = await app.request("/v1/health", {
        headers: { [AGENT_HEADERS.token]: "Bearer wrong" },
      });
      expect(wrongToken.status).toBe(401);
      const unscoped = await app.request("/v1/chats", {
        headers: { [AGENT_HEADERS.token]: "Bearer runtime-secret" },
      });
      expect(unscoped.status).toBe(400);
      // Global routes (Home calls them before any project is open) need only the token.
      const tokenOnly = { [AGENT_HEADERS.token]: "Bearer runtime-secret" };
      expect((await app.request("/v1/models", { headers: tokenOnly })).status).toBe(200);
      expect((await app.request("/v1/settings", { headers: tokenOnly })).status).toBe(200);
      expect((await app.request("/v1/settings")).status).toBe(401);

      const badDirectory = await app.request("/v1/chats", {
        headers: { ...headers, [AGENT_HEADERS.projectDir]: join(root, "missing") },
      });
      expect(badDirectory.status).toBe(400);
      const relativeDirectory = await app.request("/v1/chats", {
        headers: { ...headers, [AGENT_HEADERS.projectDir]: "relative-project" },
      });
      expect(relativeDirectory.status).toBe(400);
      const untrustedOrigin = await app.request("/v1/chats", {
        headers: { ...headers, [AGENT_HEADERS.studioOrigin]: "https://example.com" },
      });
      expect(untrustedOrigin.status).toBe(400);
      const validScope = await app.request("/v1/chats", { headers, method: "POST", body: "{}" });
      expect(validScope.status).toBe(201);
      const mismatchedProject = await app.request("/v1/chats", {
        headers: { ...headers, [AGENT_HEADERS.projectId]: "different-project" },
      });
      expect(mismatchedProject.status).toBe(400);
    } finally {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a percent-encoded project scope whose id and folder are not Latin-1", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-unicode-"));
    const projectDir = join(root, "Запуск ракеты");
    await mkdir(projectDir);
    const app = createRuntimeApp({
      backend: new ScriptedAgentBackend(),
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      research: () => new FakeResearchHost(),
      qa: () => new FakeQaHost(),
      settings: new AgentSettingsStore(join(root, "settings")),
      token: "runtime-secret",
    });
    try {
      const created = await app.request("/v1/chats", {
        method: "POST",
        body: "{}",
        headers: {
          [AGENT_HEADERS.token]: "Bearer runtime-secret",
          [AGENT_HEADERS.projectId]: encodeScopeHeader("Запуск ракеты"),
          [AGENT_HEADERS.projectDir]: encodeScopeHeader(projectDir),
          [AGENT_HEADERS.studioOrigin]: "http://127.0.0.1:4173",
        },
      });
      expect(created.status).toBe(201);
      expect(await responseObject(created)).toMatchObject({ projectId: "Запуск ракеты" });
    } finally {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("names a project over the token-only title route and passes validation failures through", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-title-"));
    const backend = new ScriptedAgentBackend();
    const app = createRuntimeApp({
      backend,
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      research: () => new FakeResearchHost(),
      qa: () => new FakeQaHost(),
      settings: new AgentSettingsStore(join(root, "settings")),
      token: "runtime-secret",
    });
    const token = { [AGENT_HEADERS.token]: "Bearer runtime-secret" };
    const call = (body?: unknown) =>
      app.request("/v1/project-title", {
        method: "POST",
        headers: { ...token, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    try {
      const unauthorized = await app.request("/v1/project-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Тизер интервью" }),
      });
      expect(unauthorized.status).toBe(401);
      expect((await call({ prompt: "Тизер интервью" })).status).toBe(200);
      expect(backend.titleRequests.at(-1)).toEqual({
        prompt: "Тизер интервью",
        files: [],
        model: null,
        language: null,
      });
      const named = await call({
        prompt: "Cut a teaser from the interview",
        files: ["interview.mov", "  ", "score.mp3"],
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
        language: "en",
      });
      expect(named.status).toBe(200);
      expect(await responseObject(named)).toEqual({ title: "Scripted Project" });
      expect(backend.titleRequests.at(-1)).toEqual({
        prompt: "Cut a teaser from the interview",
        files: ["interview.mov", "score.mp3"],
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
        language: "en",
      });
      // The route is global: a project scope is neither required nor read.
      expect((await call({ prompt: "x" })).status).toBe(200);

      expect((await call({})).status).toBe(400);
      expect((await call({ prompt: "  " })).status).toBe(400);
      expect((await call({ prompt: "x", files: "a.mov" })).status).toBe(400);
      expect((await call({ prompt: "x", model: { provider: "anthropic" } })).status).toBe(400);

      backend.projectTitle = async () => {
        throw new RuntimeError("model_unavailable", "No authenticated model", 503);
      };
      const refused = await call({ prompt: "x" });
      expect(refused.status).toBe(503);
      expect(await responseObject(refused)).toMatchObject({
        error: { code: "model_unavailable" },
      });
    } finally {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays chat events after the requested sequence and streams later events live", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-sse-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const app = createRuntimeApp({
      backend: new ScriptedAgentBackend(),
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      research: () => new FakeResearchHost(),
      qa: () => new FakeQaHost(),
      settings: new AgentSettingsStore(join(root, "settings")),
      token: "runtime-secret",
    });
    const headers = {
      [AGENT_HEADERS.token]: "Bearer runtime-secret",
      [AGENT_HEADERS.projectId]: "project-one",
      [AGENT_HEADERS.projectDir]: projectDir,
      [AGENT_HEADERS.studioOrigin]: "http://localhost:4173",
    };
    let replayReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let liveReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let projectReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const created = await app.request("/v1/chats", { method: "POST", headers, body: "{}" });
      const chat = await responseObject(created);
      if (!isRecord(chat) || typeof chat.id !== "string")
        throw new Error("Chat creation did not return an id");
      const chatId = chat.id;

      const replayResponse = await app.request(`/v1/chats/${chatId}/events?after=0`, { headers });
      replayReader = replayResponse.body?.getReader() ?? null;
      if (!replayReader) throw new Error("Chat event stream has no body");
      const replayed = await replayReader.read();
      expect(new TextDecoder().decode(replayed.value)).toContain("id: 1");
      expect(new TextDecoder().decode(replayed.value)).toContain("event: chat");
      await replayReader.cancel();
      replayReader = null;

      const liveResponse = await app.request(`/v1/chats/${chatId}/events`, {
        headers: { ...headers, "Last-Event-ID": "1" },
      });
      liveReader = liveResponse.body?.getReader() ?? null;
      if (!liveReader) throw new Error("Live chat stream has no body");
      const projectResponse = await app.request("/v1/events", { headers });
      projectReader = projectResponse.body?.getReader() ?? null;
      if (!projectReader) throw new Error("Project event stream has no body");
      const projectEvent = projectReader.read();
      const nextEvent = liveReader.read();
      const updated = await app.request(`/v1/chats/${chatId}`, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ title: "A new title" }),
      });
      expect(updated.status).toBe(200);
      const [liveChunk, projectChunk] = await Promise.all([nextEvent, projectEvent]);
      const liveFrame = new TextDecoder().decode(liveChunk.value);
      const projectFrame = new TextDecoder().decode(projectChunk.value);
      expect(liveFrame).toContain("id: 2");
      expect(liveFrame).toContain("A new title");
      expect(projectFrame).toContain("event: project");
      expect(projectFrame).toContain("chat.upserted");
    } finally {
      await replayReader?.cancel();
      await liveReader?.cancel();
      await projectReader?.cancel();
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves global agent settings, seeds new chats from them and never returns the Jev key", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-settings-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const settingsDir = join(root, "settings");
    const app = createRuntimeApp({
      backend: new ScriptedAgentBackend(),
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      research: () => new FakeResearchHost(),
      qa: () => new FakeQaHost(),
      settings: new AgentSettingsStore(settingsDir),
      token: "runtime-secret",
    });
    const headers = {
      [AGENT_HEADERS.token]: "Bearer runtime-secret",
      [AGENT_HEADERS.projectId]: "project-one",
      [AGENT_HEADERS.projectDir]: projectDir,
      [AGENT_HEADERS.studioOrigin]: "http://127.0.0.1:4173",
    };
    const call = (path: string, method = "GET", body?: unknown) =>
      app.request(path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    try {
      const disabled = await call("/v1/settings", "PATCH", {
        specialists: {
          audio: { model: null, thinking: null, allowedModels: [], enabledByDefault: false },
        },
      });
      expect(disabled.status).toBe(200);
      const created = await responseObject(await call("/v1/chats", "POST", {}));
      expect(created.enabledAgents).toEqual(["editor", "vision", "motion", "research"]);

      const patched = await call(`/v1/chats/${String(created.id)}`, "PATCH", {
        enabledAgents: ["vision"],
      });
      expect((await responseObject(patched)).enabledAgents).toEqual(["vision"]);
      expect(
        (await call(`/v1/chats/${String(created.id)}`, "PATCH", { enabledAgents: ["jev"] })).status,
      ).toBe(400);

      const keyed = await call("/v1/settings/jev/api-key", "POST", { apiKey: "sk-very-secret" });
      const keyedText = await keyed.text();
      expect(keyedText).not.toContain("sk-very-secret");
      expect(JSON.parse(keyedText)).toMatchObject({ jev: { apiKeyConfigured: true } });
      expect(await (await call("/v1/settings")).text()).not.toContain("sk-very-secret");
      // Windows ACLs have no owner-only mode bits (stat reports 0666-style
      // masks), so the privacy mode is asserted on POSIX only.
      if (process.platform !== "win32") {
        expect((await stat(join(settingsDir, "jev-credentials.json"))).mode & 0o777).toBe(0o600);
      }

      // Jev is still disabled: the test reports what is missing instead of calling a model.
      expect(await responseObject(await call("/v1/settings/jev/test", "POST", {}))).toMatchObject({
        ok: false,
      });

      const removed = await responseObject(
        await call("/v1/settings/jev/api-key", "POST", { apiKey: null }),
      );
      expect(removed.jev).toMatchObject({ apiKeyConfigured: false });
    } finally {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves the provider list, stores a provider key without a project and never returns it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-providers-"));
    const settingsDir = join(root, "settings");
    const settings = new AgentSettingsStore(settingsDir);
    const backend = new ScriptedAgentBackend();
    const provider = (id: string, status: ProviderInfo["status"]): ProviderInfo => ({
      id,
      name: id,
      authenticated: status === "connected",
      status,
      credentialSource: null,
      error: null,
      modelCount: 3,
      keyless: false,
      verified: false,
    });
    backend.providers = [provider("anthropic", "not_configured"), provider("openai", "connected")];
    backend.providersSyncedAt = 1_700_000_000_000;
    // The real backend reads the stored keys on refresh; the scripted one reflects them the same way.
    backend.onRefresh = async () => {
      const keys = await settings.providerApiKeys();
      backend.providers = backend.providers.map((entry) =>
        entry.id === "anthropic"
          ? keys.has("anthropic")
            ? { ...entry, authenticated: true, status: "connected", credentialSource: "api-key" }
            : provider("anthropic", "not_configured")
          : entry,
      );
      backend.providersSyncedAt = 1_700_000_001_000;
    };
    const app = createRuntimeApp({
      backend,
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      research: () => new FakeResearchHost(),
      qa: () => new FakeQaHost(),
      settings,
      token: "runtime-secret",
    });
    // Global routes: the token alone, no project headers.
    const call = (path: string, method = "GET", body?: unknown, token = "runtime-secret") =>
      app.request(path, {
        method,
        headers: { [AGENT_HEADERS.token]: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    try {
      const listed = await responseObject(await call("/v1/providers"));
      expect(listed.syncedAt).toBe(1_700_000_000_000);
      expect(listed.providers).toEqual(backend.providers);

      expect((await call("/v1/providers/anthropic/api-key", "POST", {}, "wrong")).status).toBe(401);
      expect((await call("/v1/providers/refresh", "POST", undefined, "wrong")).status).toBe(401);

      const saved = await call("/v1/providers/anthropic/api-key", "POST", {
        apiKey: "sk-ant-very-secret",
      });
      expect(saved.status).toBe(200);
      const savedText = await saved.text();
      expect(savedText).not.toContain("sk-ant-very-secret");
      expect(JSON.parse(savedText)).toMatchObject({
        syncedAt: 1_700_000_001_000,
        providers: [
          { id: "anthropic", status: "connected", credentialSource: "api-key" },
          { id: "openai", status: "connected" },
        ],
      });
      // The key is applied on top of OMP's credentials by the backend, which re-checked that provider live.
      expect(backend.refreshes).toEqual([{ provider: "anthropic" }]);
      expect((await settings.providerApiKeys()).get("anthropic")).toBe("sk-ant-very-secret");
      // Windows ACLs have no owner-only mode bits; asserted on POSIX only.
      if (process.platform !== "win32") {
        expect((await stat(join(settingsDir, "provider-credentials.json"))).mode & 0o777).toBe(
          0o600,
        );
      }
      for (const path of ["/v1/providers", "/v1/settings", "/v1/models"])
        expect(await (await call(path)).text()).not.toContain("sk-ant-very-secret");

      // A forced refresh asks the backend for everything.
      const refreshed = await call("/v1/providers/refresh", "POST");
      expect(refreshed.status).toBe(200);
      expect(backend.refreshes.at(-1)).toEqual({});

      // Removing a key needs no network.
      const removed = await responseObject(
        await call("/v1/providers/anthropic/api-key", "POST", { apiKey: null }),
      );
      expect(removed.providers).toMatchObject([
        { id: "anthropic", status: "not_configured", credentialSource: null },
        { id: "openai", status: "connected" },
      ]);
      expect(backend.refreshes.at(-1)).toEqual({ provider: "anthropic", offline: true });
      expect((await settings.providerApiKeys()).size).toBe(0);

      // Bad requests change nothing.
      const refreshCount = backend.refreshes.length;
      expect((await call("/v1/providers/anthropic/api-key", "POST", {})).status).toBe(400);
      expect(
        (await call("/v1/providers/anthropic/api-key", "POST", { apiKey: "a b" })).status,
      ).toBe(400);
      expect((await call("/v1/providers/anthropic/api-key", "POST", { apiKey: 5 })).status).toBe(
        400,
      );
      expect(
        (await call("/v1/providers/nonesuch/api-key", "POST", { apiKey: "sk-1" })).status,
      ).toBe(400);
      expect((await call("/v1/providers/.._x/api-key", "POST", { apiKey: "sk-1" })).status).toBe(
        400,
      );
      expect((await call("/v1/providers/anthropic/api-key", "GET")).status).toBe(404);
      expect((await settings.providerApiKeys()).size).toBe(0);
      expect(backend.refreshes.length).toBe(refreshCount);

      // The Jev check needs no project: global, and it still reports what is missing while Jev is off.
      expect(await responseObject(await call("/v1/settings/jev/test", "POST", {}))).toMatchObject({
        ok: false,
      });
    } finally {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drives an in-app sign-in over global routes: start, poll, answer, cancel, sign out, without echoing a code", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-oauth-"));
    const backend = new ScriptedAgentBackend();
    backend.oauthProviders.add("anthropic");
    backend.oauthProviders.add("github-copilot");
    const signedOut: string[] = [];
    backend.onSignOut = (provider) => void signedOut.push(provider);
    const listener = { open: false };
    const answers: string[] = [];
    backend.loginRunner = async (loginId, controller) => {
      listener.open = true;
      try {
        if (loginId === "github-copilot-login") {
          answers.push(await controller.onPrompt({ message: "GitHub Enterprise domain?" }));
          controller.onAuth({
            url: "https://github.example/device",
            instructions: "Enter code: ABCD-1234",
          });
        } else {
          controller.onAuth({ url: "https://claude.example/authorize?state=s" });
          answers.push(await controller.onPrompt({ message: "Paste the code", secret: true }));
        }
        await new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("stopped")), {
            once: true,
          }),
        );
      } finally {
        listener.open = false;
      }
    };
    const app = createRuntimeApp({
      backend,
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      research: () => new FakeResearchHost(),
      qa: () => new FakeQaHost(),
      settings: new AgentSettingsStore(join(root, "settings")),
      token: "runtime-secret",
    });
    // Global routes: the token alone, no project headers.
    const call = (path: string, method = "GET", body?: unknown, token = "runtime-secret") =>
      app.request(path, {
        method,
        headers: { [AGENT_HEADERS.token]: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    try {
      for (const [path, method] of [
        ["/v1/providers/anthropic/oauth/login", "POST"],
        ["/v1/providers/anthropic/oauth/logout", "POST"],
        ["/v1/oauth/logins/abcdefgh12345678", "GET"],
        ["/v1/oauth/logins/abcdefgh12345678/input", "POST"],
        ["/v1/oauth/logins/abcdefgh12345678/cancel", "POST"],
      ] as const)
        expect((await call(path, method, method === "GET" ? undefined : {}, "wrong")).status).toBe(
          401,
        );

      const started = await call("/v1/providers/anthropic/oauth/login", "POST");
      expect(started.status).toBe(200);
      const state = await responseObject(started);
      expect(state).toMatchObject({
        provider: "anthropic",
        status: "pending",
        flow: "browser",
        authUrl: "https://claude.example/authorize?state=s",
        prompt: { optional: true, secret: true },
        error: null,
      });
      const id = String(state.id);
      expect(listener.open).toBe(true);

      // Starting again while it runs returns the same sign-in.
      expect(
        (await responseObject(await call("/v1/providers/anthropic/oauth/login", "POST", {}))).id,
      ).toBe(id);
      expect(await responseObject(await call(`/v1/oauth/logins/${id}`))).toMatchObject({
        id,
        status: "pending",
      });

      // The pasted answer reaches the runner and is never sent back.
      const answered = await call(`/v1/oauth/logins/${id}/input`, "POST", {
        text: "pasted-secret-code-123",
      });
      expect(answered.status).toBe(200);
      expect(await answered.text()).not.toContain("pasted-secret-code-123");
      expect(answers).toEqual(["pasted-secret-code-123"]);
      expect(await (await call(`/v1/oauth/logins/${id}`)).text()).not.toContain(
        "pasted-secret-code-123",
      );
      // Nothing is waiting for another answer.
      expect((await call(`/v1/oauth/logins/${id}/input`, "POST", { text: "again" })).status).toBe(
        409,
      );
      expect((await call(`/v1/oauth/logins/${id}/input`, "POST", {})).status).toBe(400);
      expect((await call(`/v1/oauth/logins/${id}/input`, "POST", { text: 5 })).status).toBe(400);

      // Cancelling stops the runner and frees its listener before answering.
      const cancelled = await responseObject(await call(`/v1/oauth/logins/${id}/cancel`, "POST"));
      expect(cancelled).toMatchObject({ id, status: "cancelled", prompt: null });
      expect(listener.open).toBe(false);
      expect(
        (await responseObject(await call(`/v1/oauth/logins/${id}/cancel`, "POST"))).status,
      ).toBe("cancelled");

      // A required question comes first for a provider that asks one; the flow can be chosen.
      const asked = await responseObject(
        await call("/v1/providers/github-copilot/oauth/login", "POST", { flow: "device" }),
      );
      expect(asked).toMatchObject({ status: "needs_input", flow: "device", authUrl: null });
      expect((asked.prompt as Record<string, unknown>).optional).toBe(false);
      const next = await responseObject(
        await call(`/v1/oauth/logins/${String(asked.id)}/input`, "POST", { text: "corp.example" }),
      );
      expect(next.status).toBe("pending");
      await expect
        .poll(
          async () =>
            (await responseObject(await call(`/v1/oauth/logins/${String(asked.id)}`))).deviceCode,
        )
        .toBe("ABCD-1234");
      await call(`/v1/oauth/logins/${String(asked.id)}/cancel`, "POST");

      // Sign out answers with the fresh provider list.
      const out = await call("/v1/providers/anthropic/oauth/logout", "POST");
      expect(out.status).toBe(200);
      expect(await responseObject(out)).toHaveProperty("providers");
      expect(signedOut).toEqual(["anthropic"]);

      // Refusals.
      const unsupported = await call("/v1/providers/google/oauth/login", "POST");
      expect(unsupported.status).toBe(400);
      expect(await responseObject(unsupported)).toMatchObject({
        error: { code: "invalid_request" },
      });
      expect(
        (await call("/v1/providers/anthropic/oauth/login", "POST", { flow: "telepathy" })).status,
      ).toBe(400);
      expect((await call("/v1/providers/.._x/oauth/login", "POST")).status).toBe(400);
      expect((await call("/v1/providers/.._x/oauth/logout", "POST")).status).toBe(400);
      const unknown = await call("/v1/oauth/logins/abcdefgh12345678");
      expect(unknown.status).toBe(404);
      expect(await responseObject(unknown)).toMatchObject({ error: { code: "login_not_found" } });
      expect((await call("/v1/oauth/logins/x")).status).toBe(404);
      expect((await call("/v1/providers/anthropic/oauth/login", "GET")).status).toBe(404);
    } finally {
      await app.dispose();
      expect(listener.open).toBe(false);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes a sign-in's listener when the runtime shuts down", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-oauth-"));
    const backend = new ScriptedAgentBackend();
    backend.oauthProviders.add("anthropic");
    const listener = { open: false };
    backend.loginRunner = async (_id, controller) => {
      listener.open = true;
      controller.onAuth({ url: "https://claude.example/authorize" });
      try {
        await new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("stopped")), {
            once: true,
          }),
        );
      } finally {
        listener.open = false;
      }
    };
    const app = createRuntimeApp({
      backend,
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      research: () => new FakeResearchHost(),
      qa: () => new FakeQaHost(),
      settings: new AgentSettingsStore(join(root, "settings")),
      token: "runtime-secret",
    });
    try {
      const response = await app.request("/v1/providers/anthropic/oauth/login", {
        method: "POST",
        headers: { [AGENT_HEADERS.token]: "Bearer runtime-secret" },
      });
      expect(response.status).toBe(200);
      expect(listener.open).toBe(true);
    } finally {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
    expect(listener.open).toBe(false);
  });

  it("stores the autonomy settings group, merges partial updates and rejects bad values", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-autonomy-"));
    const app = createRuntimeApp({
      backend: new ScriptedAgentBackend(),
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      research: () => new FakeResearchHost(),
      qa: () => new FakeQaHost(),
      settings: new AgentSettingsStore(join(root, "settings")),
      token: "runtime-secret",
    });
    const call = (method: string, body?: unknown) =>
      app.request("/v1/settings", {
        method,
        headers: {
          [AGENT_HEADERS.token]: "Bearer runtime-secret",
          "content-type": "application/json",
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    try {
      expect((await responseObject(await call("GET"))).autonomy).toEqual({
        planApproval: "big",
        askBeforeLockedEdits: true,
        askBeforeDownloads: true,
      });
      const patched = await responseObject(
        await call("PATCH", { autonomy: { planApproval: "always", askBeforeLockedEdits: false } }),
      );
      expect(patched.autonomy).toEqual({
        planApproval: "always",
        askBeforeLockedEdits: false,
        askBeforeDownloads: true,
      });
      expect((await responseObject(await call("GET"))).autonomy).toEqual(patched.autonomy);
      expect((await call("PATCH", { autonomy: { planApproval: "sometimes" } })).status).toBe(400);
      expect((await call("PATCH", { autonomy: { askBeforeDownloads: "no" } })).status).toBe(400);
    } finally {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a chat's mode through PATCH across a restart and records a story turn's mode and action", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-mode-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const headers = {
      [AGENT_HEADERS.token]: "Bearer runtime-secret",
      [AGENT_HEADERS.projectId]: "project-one",
      [AGENT_HEADERS.projectDir]: projectDir,
      [AGENT_HEADERS.studioOrigin]: "http://127.0.0.1:4173",
    };
    const open = () =>
      createRuntimeApp({
        backend: new ScriptedAgentBackend(),
        checkpoints: new FakeCheckpointHost(),
        editing: () => new FakeEditingHost(),
        analysis: () => new FakeAnalysisHost(),
        story: () => new FakeStoryHost(),
        research: () => new FakeResearchHost(),
        qa: () => new FakeQaHost(),
        settings: new AgentSettingsStore(join(root, "settings")),
        token: "runtime-secret",
      });
    const call = (app: RuntimeApp, path: string, method = "GET", body?: unknown) =>
      app.request(path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    const first = open();
    let second: RuntimeApp | null = null;
    try {
      const created = await responseObject(await call(first, "/v1/chats", "POST", {}));
      const chatId = String(created.id);
      expect(created.activeMode).toBe("normal");

      expect(
        (await call(first, `/v1/chats/${chatId}`, "PATCH", { activeMode: "cinema" })).status,
      ).toBe(400);
      const patched = await responseObject(
        await call(first, `/v1/chats/${chatId}`, "PATCH", { activeMode: "story" }),
      );
      expect(patched.activeMode).toBe("story");

      expect(
        (
          await call(first, `/v1/chats/${chatId}/turns`, "POST", {
            prompt: "x",
            storyAction: "deploy",
          })
        ).status,
      ).toBe(400);
      // Options belong to build/rebuild only; a build takes nothing but the locked chapters the user allowed.
      for (const body of [
        { storyAction: "review", storyOptions: { allowLocked: ["ch1"] } },
        { storyAction: "build", storyOptions: { manualEdits: "replace" } },
      ]) {
        expect(
          (await call(first, `/v1/chats/${chatId}/turns`, "POST", { prompt: "x", ...body })).status,
        ).toBe(400);
      }
      const started = await call(first, `/v1/chats/${chatId}/turns`, "POST", {
        prompt: "Build the story",
        mode: "normal",
        storyAction: "build",
        storyOptions: { allowLocked: ["ch1"] },
      });
      expect(started.status).toBeLessThan(300);
      const turn = await responseObject(started);
      // A story action implies story mode whatever the request said.
      expect(turn).toMatchObject({
        turn: { mode: "story", storyAction: "build", storyOptions: { allowLocked: ["ch1"] } },
      });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const state = await responseObject(await call(first, `/v1/chats/${chatId}`));
        const turns = Array.isArray(state.turns) ? state.turns : [];
        if (turns.length === 1 && isRecord(turns[0]) && turns[0].status !== "running") break;
        // Polling a real HTTP surface backed by file I/O: there is no in-process event to await here.
        await delay(5);
      }
      await first.dispose();

      // After a restart the chat still has its mode and the turn its mode and action.
      second = open();
      const reloaded = await responseObject(await call(second, `/v1/chats/${chatId}`));
      expect(reloaded).toMatchObject({ chat: { activeMode: "story" } });
      expect(reloaded.turns).toMatchObject([
        { mode: "story", storyAction: "build", storyOptions: { allowLocked: ["ch1"] } },
      ]);
    } finally {
      await first.dispose().catch(() => undefined);
      await second?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips Execution Quality: the global default, a chat's own choice through PATCH (null clears), validation and the turn's record", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-quality-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const headers = {
      [AGENT_HEADERS.token]: "Bearer runtime-secret",
      [AGENT_HEADERS.projectId]: "project-one",
      [AGENT_HEADERS.projectDir]: projectDir,
      [AGENT_HEADERS.studioOrigin]: "http://127.0.0.1:4173",
    };
    const app = createRuntimeApp({
      backend: new ScriptedAgentBackend(),
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      research: () => new FakeResearchHost(),
      qa: () => new FakeQaHost(),
      settings: new AgentSettingsStore(join(root, "settings")),
      token: "runtime-secret",
    });
    const call = (path: string, method = "GET", body?: unknown) =>
      app.request(path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    const runTurn = async (chatId: string, prompt: string) => {
      const started = await responseObject(
        await call(`/v1/chats/${chatId}/turns`, "POST", { prompt }),
      );
      const turnId = isRecord(started.turn) ? String(started.turn.id) : "";
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const state = await responseObject(await call(`/v1/chats/${chatId}`));
        const turns = Array.isArray(state.turns) ? state.turns : [];
        const turn = turns.find((entry) => isRecord(entry) && entry.id === turnId);
        if (isRecord(turn) && turn.status !== "running") return turn;
        // Polling a real HTTP surface backed by file I/O: there is no in-process event to await here.
        await delay(5);
      }
      throw new Error("the turn did not end");
    };
    try {
      expect(await responseObject(await call("/v1/settings"))).toMatchObject({
        executionQuality: { preset: "balanced", custom: EXECUTION_BUDGETS.balanced },
      });
      const best = { preset: "best", custom: EXECUTION_BUDGETS.balanced };
      expect(
        await responseObject(await call("/v1/settings", "PATCH", { executionQuality: best })),
      ).toMatchObject({ executionQuality: best });

      const created = await responseObject(await call("/v1/chats", "POST", {}));
      const chatId = String(created.id);
      expect(created.executionQuality ?? null).toBeNull();
      expect(await runTurn(chatId, "one")).toMatchObject({
        execution: { preset: "best", budget: EXECUTION_BUDGETS.best },
      });

      const custom = {
        preset: "custom",
        custom: { ...EXECUTION_BUDGETS.fast, qaPasses: 3, specialistThinking: "thorough" },
      };
      expect(
        await responseObject(
          await call(`/v1/chats/${chatId}`, "PATCH", { executionQuality: custom }),
        ),
      ).toMatchObject({ executionQuality: custom });
      expect(await runTurn(chatId, "two")).toMatchObject({
        execution: { preset: "custom", budget: { qaPasses: 3, specialistThinking: "thorough" } },
      });
      expect(await responseObject(await call(`/v1/chats/${chatId}`))).toMatchObject({
        chat: { executionQuality: custom },
      });

      for (const bad of [
        { preset: "turbo", custom: EXECUTION_BUDGETS.fast },
        { preset: "custom", custom: { ...EXECUTION_BUDGETS.fast, qaPasses: 9 } },
        { preset: "custom" },
        "fast",
      ]) {
        expect((await call(`/v1/chats/${chatId}`, "PATCH", { executionQuality: bad })).status).toBe(
          400,
        );
      }
      expect(
        (await call("/v1/settings", "PATCH", { executionQuality: { preset: "x" } })).status,
      ).toBe(400);

      const cleared = await responseObject(
        await call(`/v1/chats/${chatId}`, "PATCH", { executionQuality: null }),
      );
      expect(cleared.executionQuality).toBeNull();
      expect(await runTurn(chatId, "three")).toMatchObject({
        execution: { preset: "best", budget: EXECUTION_BUDGETS.best },
      });
    } finally {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("answers a pending permission request over its route and rejects everything else", async () => {
    const root = await mkdtemp(join(tmpdir(), "openvids-agent-permissions-"));
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const research = new FakeResearchHost();
    research.policyResult = researchPolicy({
      websites: { readLinkedPages: false, fullAccess: false },
    });
    const backend = new ScriptedAgentBackend();
    const app = createRuntimeApp({
      backend,
      checkpoints: new FakeCheckpointHost(),
      editing: () => new FakeEditingHost(),
      analysis: () => new FakeAnalysisHost(),
      story: () => new FakeStoryHost(),
      research: () => research,
      qa: () => new FakeQaHost(),
      settings: new AgentSettingsStore(join(root, "settings")),
      token: "runtime-secret",
    });
    const headers = {
      [AGENT_HEADERS.token]: "Bearer runtime-secret",
      [AGENT_HEADERS.projectId]: "project-one",
      [AGENT_HEADERS.projectDir]: projectDir,
      [AGENT_HEADERS.studioOrigin]: "http://localhost:4173",
    };
    const permissionOf = async (chatId: string) => {
      const state = await responseObject(await app.request(`/v1/chats/${chatId}`, { headers }));
      const messages = Array.isArray(state.messages) ? state.messages : [];
      for (const message of messages) {
        if (!isRecord(message) || !Array.isArray(message.parts)) continue;
        for (const part of message.parts) {
          if (isRecord(part) && part.type === "permission" && isRecord(part.permission))
            return part.permission;
        }
      }
      return null;
    };
    try {
      const chat = await responseObject(
        await app.request("/v1/chats", { method: "POST", headers, body: "{}" }),
      );
      const chatId = typeof chat.id === "string" ? chat.id : "";
      backend.promptScript = async (_input, session) => {
        if (session.input.agent === "director")
          await session.callTool("read_website", { url: "https://linear.app" });
        return "completed";
      };
      const started = await responseObject(
        await app.request(`/v1/chats/${chatId}/turns`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: "вот ссылка https://linear.app — сделай интро" }),
        }),
      );
      const turnId =
        isRecord(started.turn) && typeof started.turn.id === "string" ? started.turn.id : "";

      let permission: Record<string, unknown> | null = null;
      for (let i = 0; i < 100 && permission === null; i += 1) {
        permission = await permissionOf(chatId);
        if (permission === null) await delay(20);
      }
      expect(permission).toMatchObject({ state: "pending", kind: "read_linked_pages" });
      const permissionId = typeof permission?.id === "string" ? permission.id : "";
      const answer = (path: string, body: unknown) =>
        app.request(path, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      // Validation, unknown chat, unknown turn and an unknown request all fail with the documented codes.
      expect(
        (await answer(`/v1/chats/${chatId}/turns/${turnId}/permissions/${permissionId}`, {}))
          .status,
      ).toBe(400);
      expect(
        (
          await answer(`/v1/chats/unknown/turns/${turnId}/permissions/${permissionId}`, {
            decision: "once",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await answer(`/v1/chats/${chatId}/turns/unknown/permissions/${permissionId}`, {
            decision: "once",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await answer(`/v1/chats/${chatId}/turns/${turnId}/permissions/unknown`, {
            decision: "once",
          })
        ).status,
      ).toBe(409);

      const allowed = await responseObject(
        await answer(`/v1/chats/${chatId}/turns/${turnId}/permissions/${permissionId}`, {
          decision: "once",
        }),
      );
      expect(allowed.permission).toMatchObject({ id: permissionId, state: "allowed_once" });
      // The waiting call resumed with the grant, and the request is not pending any more.
      expect(
        (
          await answer(`/v1/chats/${chatId}/turns/${turnId}/permissions/${permissionId}`, {
            decision: "deny",
          })
        ).status,
      ).toBe(409);
      for (let i = 0; i < 100; i += 1) {
        if (research.websiteRequests.length > 0) break;
        await delay(20);
      }
      expect(research.grants).toEqual([{ turnId, access: "read" }]);
      expect(research.websiteRequests).toEqual([{ url: "https://linear.app", turnId }]);
    } finally {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
