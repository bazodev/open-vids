import { ThinkingLevel } from "@google/genai";
import { describe, expect, it } from "vitest";
import { GEMINI_VISION_MODEL, leastThinking } from "./geminiVision.js";

describe("leastThinking", () => {
  it("uses the minimal level on the default model", () => {
    expect(leastThinking(GEMINI_VISION_MODEL, ThinkingLevel)).toEqual({
      thinkingLevel: ThinkingLevel.MINIMAL,
    });
  });

  it.each([
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
    "models/gemini-3.5-flash-lite",
  ])("uses minimal on %s, which lists it", (model) => {
    expect(leastThinking(model, ThinkingLevel)).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
  });

  it.each(["gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-4-carbon", "gemini-4-neon"])(
    "uses low on %s, which has no minimal level",
    (model) => {
      expect(leastThinking(model, ThinkingLevel)).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    },
  );

  it("turns thinking off by budget on Gemini 2", () => {
    expect(leastThinking("gemini-2.5-flash-lite", ThinkingLevel)).toEqual({ thinkingBudget: 0 });
  });

  it("sets nothing on a model that is not Gemini", () => {
    expect(leastThinking("gemma-4-31b-it", ThinkingLevel)).toBeUndefined();
  });
});
