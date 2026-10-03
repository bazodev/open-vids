// The Director row is text, not a switch: Main cannot be turned off, so a
// disabled switch next to the "Always on" text reads as a broken control.

// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStore } from "../../agent/agentStore";
import { cleanupMounted } from "../ui/mountHost.testHelpers";
import { openSettings } from "./settingsStore";
import { mountSettings, resetDialog, resetPreferences, settle } from "./settingsDialog.testHelpers";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let store: AgentStore | undefined;

beforeEach(() => resetPreferences());

afterEach(() => {
  store?.getState().dispose();
  store = undefined;
  resetDialog();
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe("AgentsSection Director row", () => {
  it("says Always on with no switch", async () => {
    mountSettings(undefined, (created) => (store = created));
    await act(async () => openSettings("agents"));
    await settle();

    const row = document.body.querySelector('[data-agent-row="director"]');
    if (!row) throw new Error("director row did not render");
    expect(row.textContent).toContain("Always on");
    expect(row.querySelector('[role="switch"]')).toBeNull();
  });
});
