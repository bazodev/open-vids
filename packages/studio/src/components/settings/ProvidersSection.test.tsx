// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSettings, ListProvidersResponse } from "@hyperframes/agent-protocol";
import { AgentApiError } from "../../agent/agentClient";
import type { AgentStore } from "../../agent/agentStore";
import { SETTINGS, providerInfo } from "../../agent/agentTestHarness";
import { cleanupMounted } from "../ui/mountHost.testHelpers";
import { openSettings, useSettingsDialog } from "./settingsStore";
import {
  buttonNamed,
  click,
  labelled,
  mountSettings,
  resetDialog,
  resetPreferences,
  settle,
} from "./settingsDialog.testHelpers";

const SYNCED_AT = Date.now() - 2 * 60_000;

const PROVIDERS: ListProvidersResponse = {
  syncedAt: SYNCED_AT,
  providers: [
    providerInfo({ id: "anthropic", modelCount: 1 }),
    providerInfo({
      id: "openai",
      name: "OpenAI",
      authenticated: false,
      status: "signin_required",
      credentialSource: null,
      error: "Session expired on Sep 27",
      modelCount: 1,
    }),
    providerInfo({
      id: "google",
      status: "error",
      credentialSource: "api-key",
      error: "403 PERMISSION_DENIED\nThe model API is disabled for the project that owns this key.",
    }),
    providerInfo({
      id: "openrouter",
      name: "OpenRouter",
      authenticated: false,
      status: "not_configured",
      credentialSource: null,
      modelCount: 300,
    }),
    providerInfo({ id: "ollama", credentialSource: null, keyless: true, modelCount: 0 }),
    providerInfo({
      id: "zeta",
      authenticated: false,
      status: "not_configured",
      credentialSource: null,
    }),
  ],
};

let store: AgentStore | undefined;

beforeEach(() => resetPreferences());

afterEach(() => {
  store?.getState().dispose();
  store = undefined;
  resetDialog();
  cleanupMounted();
  vi.unstubAllGlobals();
});

async function mountProviders(settings: AgentSettings = SETTINGS) {
  const mounted = mountSettings(settings, (created) => (store = created));
  mounted.client.listProviders.mockImplementation(async () => PROVIDERS);
  mounted.client.refreshProviders.mockImplementation(async () => PROVIDERS);
  await act(async () => openSettings("providers"));
  await settle();
  return mounted;
}

const row = (id: string) => document.body.querySelector<HTMLElement>(`[data-provider="${id}"]`);
const text = (element: Element | null | undefined) => element?.textContent ?? "";

function type(input: HTMLInputElement | null | undefined, value: string) {
  if (!input) throw new Error("no input");
  // React tracks the value setter; going through the prototype makes onChange fire.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const keyInput = (id: string) =>
  row(id)?.querySelector<HTMLInputElement>('input[type="password"]') ?? null;

it("lists each provider with its state, counts the ones that need attention, and hides the long tail", async () => {
  await mountProviders();

  expect(text(row("anthropic"))).toContain("Connected");
  expect(text(row("anthropic"))).toContain("From your OMP setup · 1 model");
  expect(text(row("openai"))).toContain("Sign-in required");
  expect(text(row("openai"))).toContain("Session expired on Sep 27");
  expect(text(row("google"))).toContain("Error");
  expect(text(row("openrouter"))).toContain("Not configured");
  expect(text(row("ollama"))).toContain("Local, no key needed");

  // Two providers need the user (an expired sign-in, a failed check); "not set up" is a choice, not a problem.
  const nav = document.body.querySelector('nav [data-section="providers"]');
  expect(nav?.querySelector('[aria-label="2 need attention"]')?.textContent).toBe("2");
  expect(text(document.body)).toContain("2 of 6 connected");
  expect(text(document.body)).toContain("Synced 2 min ago");

  // The well-known providers lead in prototype order; the rest wait behind a disclosure.
  const order = [...document.body.querySelectorAll("[data-provider]")].map((element) =>
    element.getAttribute("data-provider"),
  );
  expect(order).toEqual(["anthropic", "openai", "google", "openrouter", "ollama"]);
  expect(row("zeta")).toBeNull();
  await click(buttonNamed("Show all providers1 more"));
  expect(row("zeta")).not.toBeNull();
});

it("saves a key with a busy state, never keeps it, and shows the provider as connected", async () => {
  const { client } = await mountProviders();
  let finish: (response: ListProvidersResponse) => void = () => {};
  client.setProviderApiKey.mockImplementation(
    () => new Promise<ListProvidersResponse>((resolve) => (finish = resolve)),
  );

  await click(buttonNamed("Set up", row("openrouter") ?? undefined));
  const input = keyInput("openrouter");
  expect(input?.type).toBe("password");
  expect(input?.autocomplete).toBe("off");
  // Stored where the product really stores it: its own file, not the system keychain, not shared with OMP.
  expect(text(row("openrouter"))).toContain("Not in the system keychain or credential store");

  type(input, "sk-or-secret-123");
  await click(buttonNamed("Connect", row("openrouter") ?? undefined));
  expect(client.setProviderApiKey).toHaveBeenCalledWith("openrouter", {
    apiKey: "sk-or-secret-123",
  });
  // The check can take ~10 s: the row says so and offers nothing else meanwhile.
  expect(row("openrouter")?.querySelector('[role="status"]')?.textContent).toBe("Connecting…");
  expect(buttonNamed("Set up", row("openrouter") ?? undefined)).toBeUndefined();

  const connected = PROVIDERS.providers.map((provider) =>
    provider.id === "openrouter"
      ? {
          ...provider,
          authenticated: true,
          status: "connected" as const,
          credentialSource: "api-key" as const,
        }
      : provider,
  );
  await act(async () => finish({ ...PROVIDERS, providers: connected }));
  await settle();

  expect(text(row("openrouter"))).toContain("Connected");
  expect(text(row("openrouter"))).toContain("API key saved in OpenVids");
  // Nothing of the key is left anywhere in the page.
  expect(keyInput("openrouter")).toBeNull();
  expect(document.body.innerHTML).not.toContain("sk-or-secret-123");
  expect(
    [...document.body.querySelectorAll("input")].every((field) => !field.value.includes("sk-or")),
  ).toBe(true);
});

it("shows a refused key inline, checks the field first, and keeps the provider as it was", async () => {
  const { client } = await mountProviders();
  await click(buttonNamed("Set up", row("openrouter") ?? undefined));

  await click(buttonNamed("Connect", row("openrouter") ?? undefined));
  expect(text(row("openrouter")?.querySelector('[role="alert"]'))).toBe("Paste an API key first.");
  type(keyInput("openrouter"), "sk or key");
  await click(buttonNamed("Connect", row("openrouter") ?? undefined));
  expect(text(row("openrouter")?.querySelector('[role="alert"]'))).toBe(
    "An API key can't contain spaces.",
  );
  expect(client.setProviderApiKey).not.toHaveBeenCalled();

  client.setProviderApiKey.mockRejectedValue(new AgentApiError("runtime_unavailable", "down", 503));
  type(keyInput("openrouter"), "sk-or-1234");
  await click(buttonNamed("Connect", row("openrouter") ?? undefined));
  expect(text(row("openrouter")?.querySelector('[role="alert"]'))).toBe(
    "The agent isn't running right now. Your project is untouched.",
  );
  expect(keyInput("openrouter")?.getAttribute("aria-invalid")).toBe("true");
  expect(text(row("openrouter"))).toContain("Not configured");
});

it("explains that sign-in happens in OMP and offers an API key and a refresh instead", async () => {
  const { client } = await mountProviders();
  expect(buttonNamed("Sign in…")).toBeUndefined();

  await click(buttonNamed("Use an API key", row("openai") ?? undefined));
  expect(text(row("openai"))).toContain("signed in through OMP, which OpenVids can only read");
  expect(keyInput("openai")).not.toBeNull();
  // The OMP-side credential cannot be removed from here.
  expect(buttonNamed("Remove API key", row("openai") ?? undefined)).toBeUndefined();

  await click(buttonNamed("Refresh", row("openai") ?? undefined));
  expect(client.refreshProviders).toHaveBeenCalledTimes(1);
});

it("shows the error detail, retries, and removes only a key OpenVids stored", async () => {
  const { client } = await mountProviders();

  await click(labelled("Show Google details"));
  expect(row("google")?.querySelector("pre")?.textContent).toContain("403 PERMISSION_DENIED");
  expect(keyInput("google")?.placeholder).toBe("Replace API key");

  await click(buttonNamed("Retry", row("google") ?? undefined));
  expect(client.refreshProviders).toHaveBeenCalledTimes(1);

  client.setProviderApiKey.mockImplementation(async () => PROVIDERS);
  await click(buttonNamed("Remove API key", row("google") ?? undefined));
  expect(client.setProviderApiKey).toHaveBeenCalledWith("google", { apiKey: null });

  // A connection that comes from OMP is only explained.
  await click(labelled("Show Anthropic details"));
  expect(buttonNamed("Remove API key", row("anthropic") ?? undefined)).toBeUndefined();
  expect(text(row("anthropic"))).toContain("can only be changed there");
});

it("lists the models of a connected provider with the agents that run them", async () => {
  await mountProviders();
  await click(labelled("Show Anthropic details"));

  const models = row("anthropic")?.querySelector("dl");
  expect(models?.querySelector("dt")?.textContent).toBe("Sonnet");
  // The Director and the specialists on in new chats all follow the default model.
  expect(models?.querySelector("dd")?.textContent).toBe("Director, Editor, Vision");
});

it("refreshes the providers and says when they last synced", async () => {
  const { client } = await mountProviders();
  let finish: (response: ListProvidersResponse) => void = () => {};
  client.refreshProviders.mockImplementation(
    () => new Promise<ListProvidersResponse>((resolve) => (finish = resolve)),
  );

  await click(buttonNamed("Refresh"));
  expect(text(document.body)).toContain("Syncing…");
  expect(buttonNamed("Refresh")?.disabled).toBe(true);
  await act(async () => finish({ ...PROVIDERS, syncedAt: Date.now() }));
  await settle();
  expect(text(document.body)).toContain("Synced just now");
  // New credentials change which models agents can pick: the catalog is read again.
  expect(client.listModels).toHaveBeenCalled();
});

it("opens the provider a Fix link points at, from Agents and from Jev", async () => {
  const withProblems: AgentSettings = {
    ...SETTINGS,
    specialists: {
      ...SETTINGS.specialists,
      editor: {
        ...SETTINGS.specialists.editor,
        model: { provider: "openai", modelId: "mini" },
      },
    },
    jev: { ...SETTINGS.jev, enabled: true, provider: "google", modelId: "flash" },
  };
  const { agentStore } = await mountProviders(withProblems);
  await act(async () => useSettingsDialog.getState().setSection("agents"));
  await settle();

  const editor = document.body.querySelector('[data-agent-row="editor"]');
  expect(text(editor)).toContain("OpenAI needs sign-in");
  // Only the row whose model has a problem warns.
  expect(
    buttonNamed("Fix", document.body.querySelector('[data-agent-row="vision"]') ?? undefined),
  ).toBeUndefined();
  await click(buttonNamed("Fix", editor ?? undefined));
  expect(useSettingsDialog.getState().section).toBe("providers");
  expect(row("openai")?.querySelector("input")).not.toBeNull();

  await act(async () => useSettingsDialog.getState().setSection("jev"));
  await settle();
  expect(text(document.body)).toContain("Google has an error");
  await click(buttonNamed("Fix"));
  expect(useSettingsDialog.getState().section).toBe("providers");
  expect(row("google")?.querySelector("pre")).not.toBeNull();
  expect(agentStore.getState().providers?.status).toBe("ready");
});

it("shows why the list is missing, with a way to try again", async () => {
  const mounted = mountSettings(undefined, (created) => (store = created));
  mounted.client.listProviders.mockRejectedValueOnce(
    new AgentApiError("runtime_unavailable", "down", 503),
  );
  await act(async () => openSettings("providers"));
  await settle();
  expect(text(document.body.querySelector("[role=status]"))).toContain("isn't running");

  mounted.client.listProviders.mockImplementation(async () => PROVIDERS);
  await click(buttonNamed("Try again"));
  expect(row("anthropic")).not.toBeNull();
});
