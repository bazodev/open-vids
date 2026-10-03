import { appendFile, mkdir, readFile, readdir, truncate } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ChatEvent, SpecialistId } from "@hyperframes/agent-protocol";
import { foldChatEvents, isRecord } from "@hyperframes/agent-protocol";

const agentRoot = (projectDir: string) => join(projectDir, ".hyperframes", "agent", "chats");
const chatDirectory = (projectDir: string, chatId: string) => {
  if (
    !chatId ||
    chatId === "." ||
    chatId === ".." ||
    chatId.includes(sep) ||
    chatId.includes("/")
  ) {
    throw new Error("Invalid chat id");
  }
  return join(agentRoot(projectDir), chatId);
};

/** Project-scoped append-only chat event storage. */
export class FileChatStore {
  private readonly appendTails = new Map<string, Promise<void>>();

  constructor(readonly projectDir: string) {}

  async listChatIds(): Promise<string[]> {
    const root = agentRoot(this.projectDir);
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  async load(chatId: string) {
    const file = join(chatDirectory(this.projectDir, chatId), "events.jsonl");
    const contents = await readFile(file, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return "";
      throw error;
    });
    const lines = contents.split("\n");
    const completeLineCount = lines.length - 1;
    if (contents.length > 0 && !contents.endsWith("\n")) {
      const lastNewline = contents.lastIndexOf("\n");
      const completeBytes = Buffer.byteLength(contents.slice(0, lastNewline + 1));
      await truncate(file, completeBytes);
    }
    const events: ChatEvent[] = [];
    for (let index = 0; index < completeLineCount; index += 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isChatEvent(value)) events.push(value);
        else throw new Error(`Invalid chat event at line ${index + 1}`);
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new Error(`Invalid chat event at line ${index + 1}`, { cause: error });
        throw error;
      }
    }
    return { events, state: foldChatEvents(events) };
  }

  async append(event: ChatEvent): Promise<void> {
    const directory = chatDirectory(this.projectDir, event.chatId);
    const file = join(directory, "events.jsonl");
    const previous = this.appendTails.get(event.chatId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
      });
    this.appendTails.set(event.chatId, write);
    try {
      await write;
    } finally {
      if (this.appendTails.get(event.chatId) === write) this.appendTails.delete(event.chatId);
    }
  }

  /**
   * Waits until every in-flight append reached the event log. Shutdown and test teardown drain before deleting
   * directories, so a still-running write cannot race the removal (on Windows the removal, or the write, fails).
   */
  async drain(): Promise<void> {
    while (this.appendTails.size > 0) {
      await Promise.allSettled([...this.appendTails.values()]);
    }
  }

  /** Creates and returns the private backend state directory for a chat's Director. */
  async stateDir(chatId: string): Promise<string> {
    const directory = resolve(chatDirectory(this.projectDir, chatId), "backend");
    await mkdir(directory, { recursive: true });
    return directory;
  }

  /** The private backend state directory of one specialist in a chat, beside (not inside) the Director's. */
  async agentStateDir(chatId: string, agent: SpecialistId): Promise<string> {
    const directory = resolve(chatDirectory(this.projectDir, chatId), "agents", agent);
    await mkdir(directory, { recursive: true });
    return directory;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isChatEvent(value: unknown): value is ChatEvent {
  if (
    !isRecord(value) ||
    typeof value.chatId !== "string" ||
    typeof value.seq !== "number" ||
    !Number.isInteger(value.seq) ||
    typeof value.ts !== "number"
  )
    return false;
  switch (value.type) {
    case "chat.created":
    case "chat.updated":
      return isRecord(value.chat);
    case "turn.started":
      return (
        isRecord(value.turn) && isRecord(value.promptMessage) && isRecord(value.assistantMessage)
      );
    case "message.appended":
      return isRecord(value.message);
    case "assistant.text.delta":
      return (
        typeof value.messageId === "string" &&
        typeof value.partId === "string" &&
        typeof value.delta === "string"
      );
    case "assistant.parts.interim":
      return (
        typeof value.messageId === "string" &&
        Array.isArray(value.partIds) &&
        value.partIds.every((id) => typeof id === "string")
      );
    case "thinking.updated":
      return (
        typeof value.messageId === "string" &&
        typeof value.partId === "string" &&
        typeof value.delta === "string" &&
        typeof value.done === "boolean"
      );
    case "activity.updated":
      return typeof value.messageId === "string" && isRecord(value.activity);
    case "permission.updated":
      return typeof value.messageId === "string" && isRecord(value.permission);
    case "message.completed":
      return typeof value.messageId === "string" && typeof value.status === "string";
    case "checkpoint.updated":
      return typeof value.turnId === "string" && isRecord(value.checkpoint);
    case "plan.updated":
      return typeof value.turnId === "string" && isRecord(value.plan);
    case "qa.updated":
      return typeof value.turnId === "string" && isRecord(value.qa);
    case "agent.started":
      return (
        isRecord(value.run) &&
        typeof value.parentMessageId === "string" &&
        isRecord(value.taskMessage) &&
        isRecord(value.assistantMessage)
      );
    case "agent.updated":
    case "agent.completed":
      return isRecord(value.run);
    case "turn.completed":
    case "turn.aborted":
      return isRecord(value.turn);
    case "turn.failed":
      return isRecord(value.turn) && isRecord(value.error);
    default:
      return false;
  }
}
