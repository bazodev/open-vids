import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createModelCatalog, isAgentProvider, preferredStartModel } from "./model-mapping.ts";

interface Choice {
  firstListed: string | null;
  ompDefault: string;
  shown: string | null;
  used: string | null;
}

const home = mkdtempSync(path.join(tmpdir(), "ov-start-model-"));

function runProbe(providers: string[]): Record<string, Choice> {
  const script = fileURLToPath(new URL("./start-model.probe.ts", import.meta.url));
  return JSON.parse(
    execFileSync("bun", [script, ...providers], {
      encoding: "utf8",
      timeout: 90_000,
      // The developer's own OMP config and model caches must not decide the answer.
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }),
  );
}

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("the model a new install starts on (OMP's real registry under Bun, no network)", () => {
  const choices = runProbe(["google", "anthropic"]);

  it("starts a new Gemini key on the current Flash, not on the first model listed", () => {
    const google = choices.google;
    expect(google?.used).toBe("gemini-3.8-flash");
    expect(google?.shown).toBe("gemini-3.8-flash");
    expect(google?.firstListed).not.toBe("gemini-3.8-flash");
  });

  it("uses OMP's default for a provider OpenVids has no opinion on, and shows the model it uses", () => {
    const anthropic = choices.anthropic;
    expect(anthropic?.used).toBe(anthropic?.ompDefault);
    expect(anthropic?.shown).toBe(anthropic?.used);
  });
});

describe("isAgentProvider", () => {
  it("leaves out Apple's on-device model, which is listed with nothing connected", () => {
    expect(isAgentProvider("apple")).toBe(false);
  });

  it.each(["google", "anthropic", "openai-codex", "openrouter", "ollama"])(
    "keeps %s",
    (provider) => {
      expect(isAgentProvider(provider)).toBe(true);
    },
  );
});

describe("preferredStartModel", () => {
  const model = (provider: string, id: string) => ({ provider, id });

  it("replaces OMP's pick with the provider's start model when it is available", () => {
    const picked = model("google", "gemini-preview");
    const flash = model("google", "gemini-3.8-flash");
    expect(preferredStartModel(picked, [picked, flash])).toBe(flash);
  });

  it("keeps OMP's pick when the start model is not available or the provider has none", () => {
    const google = model("google", "gemini-preview");
    expect(preferredStartModel(google, [google])).toBe(google);
    const other = model("anthropic", "claude");
    expect(preferredStartModel(other, [other, model("google", "gemini-3.8-flash")])).toBe(other);
  });
});

describe("createModelCatalog's start model", () => {
  const sources = ["a", "b"].map((modelId) => ({
    provider: "google",
    modelId,
    name: modelId,
    reasoning: true,
    supportedEfforts: ["high"],
  }));
  const start = { provider: "google", modelId: "b" };

  it("is the default when the OMP config names none, and carries no role thinking", () => {
    expect(createModelCatalog(sources, undefined, "high", start)).toMatchObject({
      defaultModel: start,
      defaultThinking: null,
    });
  });

  it("never replaces the user's own default", () => {
    expect(createModelCatalog(sources, "google/a:low", "low", start)).toMatchObject({
      defaultModel: { provider: "google", modelId: "a" },
      defaultThinking: "low",
    });
  });

  it("is ignored when it is not in the list", () => {
    const gone = { provider: "google", modelId: "gone" };
    expect(createModelCatalog(sources, undefined, null, gone).defaultModel).toBeNull();
  });
});
