import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatService } from "./chats.js";
import { renderPromptContext } from "./promptContext.js";
import { createRuntimeFixture } from "./testing/runtimeFixture.js";

describe("runtime persistence and prompt rendering", () => {
  it("round-trips events and ignores a torn final JSONL record", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({ title: "Persisted chat" });
      const eventFile = join(
        fixture.scope.projectDir,
        ".hyperframes",
        "agent",
        "chats",
        chat.id,
        "events.jsonl",
      );
      await appendFile(eventFile, '{"seq":2,"type":"chat.updated"', "utf8");

      const loaded = await fixture.store.load(chat.id);
      expect(loaded.events).toHaveLength(1);
      expect(loaded.state?.chat.title).toBe("Persisted chat");
      const reopened = await ChatService.open(fixture.scope, fixture.store, { now: fixture.now });
      expect(reopened.get(chat.id)).toEqual(loaded.state);
      await reopened.update(chat.id, { title: "Appended after recovery" });
      const afterAppend = await fixture.store.load(chat.id);
      expect(afterAppend.events).toHaveLength(2);
      expect(afterAppend.state?.chat.title).toBe("Appended after recovery");
      const stateDir = await fixture.store.stateDir(chat.id);
      expect(stateDir).toBe(
        join(fixture.scope.projectDir, ".hyperframes", "agent", "chats", chat.id, "backend"),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("drain waits for fire-and-forget emits so teardown can remove the directory", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const chat = await fixture.chats.create({ title: "Drain" });
      // The orchestrator's `onModel` path emits without awaiting: the write may still be in flight when the turn ends.
      const pending = fixture.chats.emit(chat.id, {
        type: "chat.updated",
        chat: { ...chat, title: "Late update" },
      });
      await fixture.chats.drain();
      await pending;
      expect(fixture.chats.get(chat.id)?.chat.title).toBe("Late update");
      const loaded = await fixture.store.load(chat.id);
      expect(loaded.state?.chat.title).toBe("Late update");
    } finally {
      await fixture.cleanup();
    }
  });

  it("renders editor context and references as explicit prompt blocks", () => {
    const rendered = renderPromptContext(
      "Make the intro shorter",
      {
        schemaVersion: 1,
        capturedAt: 4,
        project: { id: "project-one", title: "Launch video" },
        activeComposition: { path: "compositions/intro.html" },
        timeline: { duration: 20, elementCount: 0, elements: [] },
        playhead: { time: 3, playing: false },
        selection: { clips: [], assetPath: null, previewElement: null, range: null },
        renderSettings: null,
        storyGraph: null,
      },
      [{ kind: "asset", id: "asset-ref", path: "media/logo.svg" }],
    );
    expect(rendered).toContain("Make the intro shorter");
    expect(rendered).toContain("<editor-context>");
    expect(rendered).toContain("compositions/intro.html");
    expect(rendered).toContain("<references>");
    expect(rendered).toContain('"path":"media/logo.svg"');
  });
});
