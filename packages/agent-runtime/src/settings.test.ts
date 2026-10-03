import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTONOMY_SETTINGS,
  DEFAULT_EXECUTION_QUALITY,
  EXECUTION_BUDGETS,
} from "@hyperframes/agent-protocol";
import { AgentSettingsStore } from "./settings.js";

describe("AgentSettingsStore", () => {
  it("keeps changes made by another runtime on the same machine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openvids-agent-settings-"));
    try {
      const desktop = new AgentSettingsStore(dir);
      const devShell = new AgentSettingsStore(dir);
      await desktop.get();
      await devShell.update({ jev: { enabled: true, provider: "anthropic" } });
      await desktop.update({
        director: { model: { provider: "p", modelId: "m" }, thinking: "low" },
      });
      await devShell.setJevApiKey("sk-shared");

      const settings = await desktop.get();
      expect(settings.jev).toMatchObject({
        enabled: true,
        provider: "anthropic",
        apiKeyConfigured: true,
      });
      expect(settings.director).toEqual({
        model: { provider: "p", modelId: "m" },
        thinking: "low",
      });
      expect(await desktop.jevApiKey()).toBe("sk-shared");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migrates a settings file from before Execution Quality to the default, keeping its other values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openvids-agent-settings-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify({ director: { model: { provider: "p", modelId: "m" }, thinking: "high" } }),
      );
      const store = new AgentSettingsStore(dir);
      const migrated = await store.get();
      expect(migrated.executionQuality).toEqual(DEFAULT_EXECUTION_QUALITY);
      expect(migrated.executionQuality.preset).toBe("balanced");
      expect(migrated.director.thinking).toBe("high");

      // The next write carries it, and another runtime on the same directory reads it back.
      await store.update({
        executionQuality: { preset: "custom", custom: { ...EXECUTION_BUDGETS.fast, qaPasses: 4 } },
      });
      const stored: unknown = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
      expect(stored).toMatchObject({
        director: { thinking: "high" },
        executionQuality: { preset: "custom", custom: { qaPasses: 4, qaMaxFrames: 12 } },
      });
      const other = await new AgentSettingsStore(dir).get();
      expect(other.executionQuality).toEqual({
        preset: "custom",
        custom: { ...EXECUTION_BUDGETS.fast, qaPasses: 4 },
      });
      // An update that does not mention it leaves it alone.
      await store.update({ director: { model: null, thinking: null } });
      expect((await store.get()).executionQuality.custom.qaPasses).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a settings file from before autonomy with the autonomy defaults, then merges partial updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openvids-agent-settings-"));
    try {
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify({
          director: { model: null, thinking: "off" },
          // The removed `defaultIntent` of an older file is ignored, not an error.
          autonomy: { defaultIntent: "plan" },
        }),
      );
      const store = new AgentSettingsStore(dir);
      const migrated = await store.get();
      expect(migrated.autonomy).toEqual(DEFAULT_AUTONOMY_SETTINGS);
      expect(migrated.autonomy).toEqual({
        planApproval: "big",
        askBeforeLockedEdits: true,
        askBeforeDownloads: true,
      });
      expect(migrated.director.thinking).toBe("off");

      const updated = await store.update({
        autonomy: { planApproval: "always", askBeforeDownloads: false },
      });
      expect(updated.autonomy).toEqual({
        planApproval: "always",
        askBeforeLockedEdits: true,
        askBeforeDownloads: false,
      });
      // Updates to other groups leave it alone, and another runtime on the directory reads it back.
      await store.update({ director: { model: null, thinking: null } });
      expect((await new AgentSettingsStore(dir).get()).autonomy).toEqual(updated.autonomy);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores provider API keys privately, shares them between runtimes and never returns them from get()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openvids-agent-settings-"));
    try {
      const desktop = new AgentSettingsStore(join(dir, "nested"));
      const devShell = new AgentSettingsStore(join(dir, "nested"));
      expect((await desktop.providerApiKeys()).size).toBe(0);

      await desktop.setProviderApiKey("anthropic", "sk-ant-secret");
      await devShell.setProviderApiKey("openrouter", "sk-or-secret");
      const keys = await desktop.providerApiKeys();
      expect([...keys]).toEqual([
        ["anthropic", "sk-ant-secret"],
        ["openrouter", "sk-or-secret"],
      ]);

      const file = join(dir, "nested", "provider-credentials.json");
      // Windows ACLs have no owner-only mode bits: the stat mode always
      // reports 0666/0444-style masks, so privacy is asserted structurally
      // (file created with 0o600 intent, unreadable content checks below).
      if (process.platform === "win32") {
        expect((await stat(file)).mode & 0o444).toBe(0o444);
      } else {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect((await stat(join(dir, "nested"))).mode & 0o777).toBe(0o700);
      }
      // Nothing about the keys reaches the settings the API serves.
      expect(JSON.stringify(await desktop.get())).not.toContain("secret");
      expect(
        await readFile(join(dir, "nested", "settings.json"), "utf8").catch(() => ""),
      ).not.toContain("secret");

      await desktop.setProviderApiKey("anthropic", "sk-ant-replaced");
      expect((await devShell.providerApiKeys()).get("anthropic")).toBe("sk-ant-replaced");

      await desktop.setProviderApiKey("anthropic", null);
      expect([...(await devShell.providerApiKeys()).keys()]).toEqual(["openrouter"]);
      await devShell.setProviderApiKey("openrouter", null);
      // The last key removed deletes the file instead of leaving an empty credentials file behind.
      expect(await readdir(join(dir, "nested"))).not.toContain("provider-credentials.json");
      // Removing a key that is not stored is a no-op.
      await desktop.setProviderApiKey("google", null);
      await expect(desktop.setProviderApiKey("../etc", "x")).rejects.toThrow("Invalid provider id");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores malformed entries of a hand-edited provider credentials file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openvids-agent-settings-"));
    try {
      await writeFile(
        join(dir, "provider-credentials.json"),
        '{"apiKeys":{"anthropic":"sk-1","bad id":"sk-2","openai":5,"google":"","__proto__":"x"}}',
      );
      expect([...(await new AgentSettingsStore(dir).providerApiKeys())]).toEqual([
        ["anthropic", "sk-1"],
      ]);
      await writeFile(join(dir, "provider-credentials.json"), "not json");
      expect((await new AgentSettingsStore(dir).providerApiKeys()).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
