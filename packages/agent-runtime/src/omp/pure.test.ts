import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderOAuthInfo } from "@hyperframes/agent-protocol";
import type { HostTool } from "../backend.ts";
import { terminalEventResult, translateOmpEvent } from "./events.ts";
import { createModelCatalog, mapModelInfo, parseModelRole } from "./model-mapping.ts";
import { oauthLoginOptions, providerOAuthInfo } from "./oauth-support.ts";
import { guardToolCallPaths } from "./path-guard.ts";
import {
  isLostSignInCause,
  providerDisplayName,
  toProviderInfo,
  type ProviderFacts,
} from "./provider-status.ts";
import { hostToolContent } from "./tool-content.ts";

describe("OMP model mapping", () => {
  it("maps model metadata and excludes the non-controllable off effort", () => {
    expect(
      mapModelInfo({
        provider: "anthropic",
        modelId: "claude-sonnet",
        name: "Claude Sonnet",
        reasoning: true,
        contextWindow: 200_000,
        supportedEfforts: ["off", "low", "high", "future"],
      }),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet",
      name: "Claude Sonnet",
      reasoning: true,
      efforts: ["low", "high"],
      contextWindow: 200_000,
    });
  });

  it("derives a default selection and effort only from a matching role model", () => {
    const sources = [
      {
        provider: "google",
        modelId: "gemini-pro",
        name: "Gemini Pro",
        reasoning: true,
        supportedEfforts: ["low", "high"],
      },
    ];
    expect(createModelCatalog(sources, "google/gemini-pro:high", "high")).toEqual({
      models: [
        {
          provider: "google",
          modelId: "gemini-pro",
          name: "Gemini Pro",
          reasoning: true,
          efforts: ["low", "high"],
        },
      ],
      defaultModel: { provider: "google", modelId: "gemini-pro" },
      defaultThinking: "high",
    });
    expect(createModelCatalog(sources, "google/not-listed:high", "high")).toMatchObject({
      defaultModel: null,
      defaultThinking: null,
    });
  });

  it("parses effort suffixes without guessing unsupported selector formats", () => {
    expect(parseModelRole("anthropic/claude-sonnet:medium")).toEqual({
      model: { provider: "anthropic", modelId: "claude-sonnet" },
      thinking: "medium",
    });
    expect(parseModelRole("not-a-selector")).toBeNull();
    expect(parseModelRole("anthropic/claude-sonnet:unknown")).toEqual({
      model: { provider: "anthropic", modelId: "claude-sonnet:unknown" },
      thinking: null,
    });
  });
});

describe("OMP event translation", () => {
  it("translates only user-facing deltas and normalized tool events", () => {
    const projectDir = path.resolve("/project");
    expect(
      translateOmpEvent(
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Hello" },
        },
        projectDir,
      ),
    ).toEqual({ type: "text.delta", delta: "Hello" });
    expect(
      translateOmpEvent(
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
        },
        projectDir,
      ),
    ).toEqual({ type: "thinking.delta", delta: "reasoning" });
    expect(
      translateOmpEvent(
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_end" },
        },
        projectDir,
      ),
    ).toEqual({ type: "thinking.end" });
    expect(
      translateOmpEvent(
        {
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "read",
          args: { path: "src/index.html" },
        },
        projectDir,
      ),
    ).toEqual({
      type: "tool.start",
      toolCallId: "call-1",
      kind: "inspect",
      targets: ["src/index.html"],
    });
    expect(
      translateOmpEvent(
        {
          type: "tool_execution_start",
          toolCallId: "call-2",
          toolName: "find",
          args: { path: "src" },
        },
        projectDir,
      ),
    ).toMatchObject({ type: "tool.start", kind: "search" });
    expect(
      translateOmpEvent(
        {
          type: "tool_execution_start",
          toolCallId: "call-3",
          toolName: "write",
          args: { path: "src/index.html" },
        },
        projectDir,
      ),
    ).toMatchObject({ type: "tool.start", kind: "edit" });
    expect(
      translateOmpEvent(
        {
          type: "tool_execution_end",
          toolCallId: "call-3",
          isError: true,
        },
        projectDir,
      ),
    ).toEqual({ type: "tool.end", toolCallId: "call-3", ok: false });
    expect(translateOmpEvent({ type: "raw_omp_internal_event" }, projectDir)).toBeNull();
  });

  it("reports host tools only when they declare an activity, with their own label", () => {
    const projectDir = path.resolve("/project");
    const execute = async () => ({ text: "" });
    const hostTools = new Map<string, HostTool>([
      [
        "edit_timeline",
        {
          name: "edit_timeline",
          description: "",
          parameters: {},
          execute,
          activity: () => ({ category: "edit", label: "Editing the timeline · 1 change (trim)" }),
        },
      ],
      [
        "inspect_project",
        {
          name: "inspect_project",
          description: "",
          parameters: {},
          execute,
          activity: () => ({
            category: "inspect",
            label: "Inspecting the project",
            labelCode: "inspecting_project",
          }),
        },
      ],
      ["delegate", { name: "delegate", description: "", parameters: {}, execute }],
    ]);
    const start = (toolName: string) => ({
      type: "tool_execution_start",
      toolCallId: `call-${toolName}`,
      toolName,
      args: { path: "src/index.html" },
    });
    expect(translateOmpEvent(start("edit_timeline"), projectDir, hostTools)).toEqual({
      type: "tool.start",
      toolCallId: "call-edit_timeline",
      kind: "edit",
      targets: [],
      label: "Editing the timeline · 1 change (trim)",
    });
    expect(translateOmpEvent(start("inspect_project"), projectDir, hostTools)).toEqual({
      type: "tool.start",
      toolCallId: "call-inspect_project",
      kind: "inspect",
      targets: [],
      label: "Inspecting the project",
      labelCode: "inspecting_project",
    });
    expect(translateOmpEvent(start("delegate"), projectDir, hostTools)).toBeNull();
  });

  it("waits for terminal completion and extracts provider errors", () => {
    expect(terminalEventResult({ type: "agent_end", isTerminal: false, messages: [] })).toBeNull();
    expect(
      terminalEventResult({
        type: "agent_end",
        messages: [
          { role: "assistant", stopReason: "error", errorMessage: "Provider denied access" },
        ],
      }),
    ).toEqual({ aborted: false, error: "Provider denied access" });
    expect(
      terminalEventResult({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "aborted" }],
      }),
    ).toEqual({ aborted: true, error: null });
  });
});

describe("OMP project path boundary", () => {
  it("allows project paths and blocks traversal, external, symlink, and private-state paths", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "omp-project-boundary-"));
    const projectDir = path.join(tempRoot, "project");
    const outsideDir = path.join(tempRoot, "outside");
    await mkdir(projectDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await mkdir(path.join(projectDir, ".hyperframes"), { recursive: true });
    await writeFile(path.join(outsideDir, "secret.txt"), "secret");
    // Directory junctions need no privilege on Windows (unlike symlinks) and
    // resolve through realpath like the symlinked dir does on POSIX.
    await symlink(
      outsideDir,
      path.join(projectDir, "outside-link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    try {
      expect(await guardToolCallPaths(projectDir, { path: "src/index.html" })).toBeNull();
      expect(
        await guardToolCallPaths(projectDir, {
          path: path.join(projectDir, "absolute.html"),
        }),
      ).toBeNull();
      expect(await guardToolCallPaths(projectDir, { path: "../outside/secret.txt" })).toContain(
        "resolves outside this project",
      );
      expect(
        await guardToolCallPaths(projectDir, {
          path: path.join(outsideDir, "secret.txt"),
        }),
      ).toContain("resolves outside this project");
      expect(
        await guardToolCallPaths(projectDir, {
          path: "outside-link/secret.txt",
        }),
      ).toContain("resolves outside this project");
      expect(
        await guardToolCallPaths(projectDir, {
          path: ".hyperframes/agent/chats/chat/events.jsonl",
        }),
      ).toContain(".hyperframes directory");

      // read/grep/find fan one `path` string out into several targets
      for (const path of [
        "src;../outside/secret.txt",
        "src,../outside/secret.txt",
        "src ../outside/secret.txt",
        "{src,../outside}/secret.txt",
        "src/../../outside/secret.txt:1-5",
      ]) {
        expect(await guardToolCallPaths(projectDir, { path }, "read")).toContain("outside");
      }
      // real file names with spaces stay usable
      expect(await guardToolCallPaths(projectDir, { path: "my clip.mp4" }, "read")).toBeNull();
      expect(await guardToolCallPaths(projectDir, { path: "a/{b,c}.html" }, "grep")).toBeNull();

      // mutating calls fail closed when the target is not a checkable `path`
      const opaque = { input: "*** Add File: ../outside/x.txt\n+x" };
      expect(await guardToolCallPaths(projectDir, opaque, "edit")).toContain("cannot be checked");
      expect(await guardToolCallPaths(projectDir, {}, "write")).toContain("cannot be checked");
      expect(
        await guardToolCallPaths(
          projectDir,
          { path: "ok.html", input: "*** Move to: ../x" },
          "edit",
        ),
      ).toContain("cannot be checked");
      expect(
        await guardToolCallPaths(
          projectDir,
          { path: "a.html", edits: [{ op: "update", rename: "../outside/a.html" }] },
          "edit",
        ),
      ).toContain("outside");
      expect(
        await guardToolCallPaths(
          projectDir,
          { path: "a.html", old_string: "a", new_string: "b" },
          "edit",
        ),
      ).toBeNull();
      expect(
        await guardToolCallPaths(
          projectDir,
          { path: "{a,b,c,d,e,f,g,h}{a,b,c,d,e,f,g,h}{a,b,c}.txt" },
          "read",
        ),
      ).toContain("too broad");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("OMP tool result content", () => {
  it("puts the text first and every image after it, as OMP image content", () => {
    expect(
      hostToolContent({
        text: "2 frames attached",
        images: [
          { mimeType: "image/jpeg", data: "AAAA" },
          { mimeType: "image/jpeg", data: "BBBB" },
        ],
      }),
    ).toEqual([
      { type: "text", text: "2 frames attached" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "image", data: "BBBB", mimeType: "image/jpeg" },
    ]);
  });

  it("has only the text part for a result without images, and keeps an error's text", () => {
    expect(hostToolContent({ text: "failed: nope", isError: true })).toEqual([
      { type: "text", text: "failed: nope" },
    ]);
    expect(hostToolContent({ text: "none", images: [] })).toEqual([{ type: "text", text: "none" }]);
  });
});

describe("provider status", () => {
  const facts = (overrides: Partial<ProviderFacts> = {}): ProviderFacts => ({
    id: "anthropic",
    sdkName: "Anthropic (Claude Pro/Max)",
    modelCount: 27,
    authenticated: false,
    credential: null,
    signedInWithOpenVids: false,
    oauth: null,
    discovery: null,
    lostSignIn: null,
    ...overrides,
  });
  const live = { status: "ok", stale: false, source: "provider" } as const;
  const failed = { status: "unavailable", stale: true, source: "bundled" } as const;

  it("names providers plainly, falling back to the SDK label and then the id", () => {
    expect(providerDisplayName("anthropic", "Anthropic (Claude Pro/Max)")).toBe("Anthropic");
    expect(providerDisplayName("fireworks", "Fireworks")).toBe("Fireworks");
    expect(providerDisplayName("my-gateway", null)).toBe("my-gateway");
  });

  it("is not_configured without credentials and connected with them, saying where they come from", () => {
    expect(toProviderInfo(facts())).toMatchObject({
      name: "Anthropic",
      authenticated: false,
      status: "not_configured",
      credentialSource: null,
      error: null,
      keyless: false,
      verified: false,
      modelCount: 27,
    });
    // The key OpenVids stored is the SDK's runtime override; everything else is OMP's.
    expect(toProviderInfo(facts({ authenticated: true, credential: "runtime" }))).toMatchObject({
      status: "connected",
      credentialSource: "api-key",
    });
    for (const credential of ["oauth", "api_key", "env", "config"] as const) {
      expect(toProviderInfo(facts({ authenticated: true, credential }))).toMatchObject({
        status: "connected",
        credentialSource: "omp",
      });
    }
  });

  it("tells a sign-in made in OpenVids from OMP's, and an API key from both", () => {
    const base = { authenticated: true, signedInWithOpenVids: true } as const;
    expect(toProviderInfo(facts({ ...base, credential: "oauth" })).credentialSource).toBe("oauth");
    // A key the sign-in itself produced (OpenRouter's browser flow) is still a sign-in.
    expect(toProviderInfo(facts({ ...base, credential: "api_key" })).credentialSource).toBe(
      "oauth",
    );
    // An OpenVids API key overrides a sign-in; env and config are never OpenVids sign-ins.
    expect(toProviderInfo(facts({ ...base, credential: "runtime" })).credentialSource).toBe(
      "api-key",
    );
    expect(toProviderInfo(facts({ ...base, credential: "env" })).credentialSource).toBe("omp");
    expect(
      toProviderInfo(
        facts({ authenticated: true, credential: "oauth", signedInWithOpenVids: false }),
      ).credentialSource,
    ).toBe("omp");
  });

  it("passes the sign-in a provider offers through", () => {
    const oauth: ProviderOAuthInfo = {
      flows: [{ flow: "browser", callbackPort: 54545, fixedPort: false }],
    };
    expect(toProviderInfo(facts({ oauth })).oauth).toEqual(oauth);
    expect(toProviderInfo(facts()).oauth).toBeNull();
  });

  it("calls a provider authenticated with no credential keyless", () => {
    expect(toProviderInfo(facts({ id: "ollama", authenticated: true }))).toMatchObject({
      status: "connected",
      credentialSource: null,
      keyless: true,
    });
  });

  it("reports signin_required only for a sign-in the SDK tore down, never after a plain logout", () => {
    const lost = toProviderInfo(
      facts({ id: "openai-codex", lostSignIn: "oauth refresh failed: invalid_grant" }),
    );
    expect(lost).toMatchObject({ status: "signin_required", authenticated: false });
    expect(lost.error).toContain("invalid_grant");
    expect(lost.error).toContain("Sign in again");
    // Another credential (an API key in the environment) means the provider works: connected.
    expect(
      toProviderInfo(facts({ authenticated: true, credential: "env", lostSignIn: null })).status,
    ).toBe("connected");
    for (const cause of [
      "deleted by user",
      "logged out by user",
      "deduplicated duplicate credential",
    ])
      expect(isLostSignInCause(cause)).toBe(false);
    expect(isLostSignInCause("oauth refresh failed: Error: invalid_grant")).toBe(true);
    expect(isLostSignInCause("upstream reported invalidated OAuth token")).toBe(true);
  });

  it("marks a provider verified only after a live model list succeeded", () => {
    expect(
      toProviderInfo(facts({ authenticated: true, credential: "runtime", discovery: live })),
    ).toMatchObject({ status: "connected", verified: true, error: null });
    for (const discovery of [
      { status: "cached", stale: false, source: "cache" },
      { status: "idle", stale: false, source: "bundled" },
      { status: "ok", stale: true, source: "provider" },
    ] as const) {
      expect(
        toProviderInfo(facts({ authenticated: true, credential: "runtime", discovery })).verified,
      ).toBe(false);
    }
    expect(toProviderInfo(facts({ discovery: live })).verified).toBe(false);
  });

  it("flags a key stored in OpenVids whose live model list failed, but not OMP's credential for the same silent failure", () => {
    const stored = toProviderInfo(
      facts({ authenticated: true, credential: "runtime", discovery: failed }),
    );
    expect(stored.status).toBe("error");
    expect(stored.error).toContain("may be invalid or the provider unreachable");
    expect(stored.authenticated).toBe(true);
    // The SDK swallows HTTP errors of built-in providers, so offline looks like a bad key: too weak for OMP's own login.
    expect(
      toProviderInfo(facts({ authenticated: true, credential: "oauth", discovery: failed })),
    ).toMatchObject({ status: "connected", error: null });
  });

  it("reports an explicit discovery error or a rejected credential for any credential source", () => {
    const timeout = toProviderInfo(
      facts({
        authenticated: true,
        credential: "api_key",
        discovery: { ...failed, error: "model discovery timed out after 10000ms" },
      }),
    );
    expect(timeout).toMatchObject({
      status: "error",
      error: "model discovery timed out after 10000ms",
    });
    const rejected = toProviderInfo(
      facts({
        authenticated: true,
        credential: "config",
        discovery: { status: "unauthenticated", stale: true },
      }),
    );
    expect(rejected).toMatchObject({
      status: "error",
      error: "The provider rejected the credentials.",
    });
  });

  it("keeps an error message to one bounded line", () => {
    const info = toProviderInfo(
      facts({
        authenticated: true,
        credential: "api_key",
        discovery: { ...failed, error: `403 PERMISSION_DENIED\n${"x".repeat(500)}` },
      }),
    );
    expect(info.error).not.toContain("\n");
    expect(info.error?.length).toBeLessThanOrEqual(300);
  });
});

describe("which providers offer an in-app sign-in", () => {
  it("offers a browser flow with its loopback port, and says when the provider insists on that port", () => {
    expect(providerOAuthInfo("anthropic")).toEqual({
      flows: [{ flow: "browser", callbackPort: 54545, fixedPort: false }],
    });
    expect(providerOAuthInfo("openrouter")?.flows).toEqual([
      { flow: "browser", callbackPort: 54549, fixedPort: false },
    ]);
    expect(providerOAuthInfo("google-gemini-cli")?.flows[0]).toEqual({
      flow: "browser",
      callbackPort: 8085,
      fixedPort: false,
    });
  });

  it("lists a provider's own login first and its device alternative after it", () => {
    expect(providerOAuthInfo("openai-codex")).toEqual({
      flows: [
        { flow: "browser", callbackPort: 1455, fixedPort: true },
        { flow: "device", callbackPort: null, fixedPort: false },
      ],
    });
    // The device login is a different SDK login that stores under the same provider.
    expect(oauthLoginOptions("openai-codex").map((option) => option.loginId)).toEqual([
      "openai-codex",
      "openai-codex-device",
    ]);
  });

  it("offers device and paste flows where the provider works that way", () => {
    expect(providerOAuthInfo("github-copilot")?.flows).toEqual([
      { flow: "device", callbackPort: null, fixedPort: false },
    ]);
    expect(providerOAuthInfo("kimi-code")?.flows[0]?.flow).toBe("device");
    expect(providerOAuthInfo("xai-oauth")?.flows[0]?.flow).toBe("device");
    expect(providerOAuthInfo("gitlab-duo-agent")?.flows).toEqual([
      { flow: "paste", callbackPort: null, fixedPort: false },
    ]);
  });

  it("offers nothing for key-only providers, prompt-driven custom logins, native-scheme redirects and unknown ids", () => {
    for (const provider of [
      "openai",
      "google",
      "mistral",
      "groq",
      "ollama",
      "deepseek",
      "cloudflare-ai-gateway",
      "xiaomi",
      "perplexity",
      "zai",
      "no-such-provider",
    ]) {
      expect(providerOAuthInfo(provider), provider).toBeNull();
    }
  });
});
