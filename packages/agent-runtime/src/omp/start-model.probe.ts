/**
 * Which model a new install starts on, read from OMP's real registry with a fake key for one provider and no network.
 * Only Bun can load OMP; `start-model.test.ts` starts this file with `bun` and checks the printed choice.
 *
 * Usage: bun start-model.probe.ts <provider>...
 */
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import type { KnownProvider } from "@oh-my-pi/pi-catalog/types";
import { AuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { availableModels, chooseBackendModel, createCatalog } from "./catalog.ts";

function isKnownProvider(provider: string): provider is KnownProvider {
  return provider in DEFAULT_MODEL_PER_PROVIDER;
}

const choices: Record<string, unknown> = {};
for (const provider of process.argv.slice(2)) {
  if (!isKnownProvider(provider)) throw new Error(`unknown provider: ${provider}`);
  const auth = await AuthStorage.create(":memory:");
  auth.keys.setRuntime(provider, "probe-not-a-real-key");
  const settings = Settings.isolated({});
  const registry = new ModelRegistry(auth, undefined, { settings });
  const catalog = createCatalog(registry, settings);
  choices[provider] = {
    firstListed: availableModels(registry)[0]?.id ?? null,
    ompDefault: DEFAULT_MODEL_PER_PROVIDER[provider],
    shown: catalog.defaultModel?.modelId ?? null,
    used: chooseBackendModel(registry, catalog)?.id ?? null,
  };
  auth.close();
}
process.stdout.write(JSON.stringify(choices));
