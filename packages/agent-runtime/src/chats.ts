import { randomUUID } from "node:crypto";
import type {
  ChatEvent,
  ChatEventPayload,
  ChatState,
  ChatSummary,
  CreateChatRequest,
  ProjectEvent,
  SpecialistId,
  UpdateChatRequest,
} from "@hyperframes/agent-protocol";
import { SPECIALIST_IDS, applyChatEvent, emptyChatState } from "@hyperframes/agent-protocol";
import type { ProjectScope } from "./checkpointHost.js";
import { FileChatStore } from "./store/index.js";

export interface ChatServiceOptions {
  now?: () => number;
  ids?: () => string;
}

interface StoredChat {
  events: ChatEvent[];
  state: ChatState;
}

export interface ChatEventSubscription {
  replay: ChatEvent[];
  unsubscribe: () => void;
}

/** Owns one project's durable chats, event sequencing and project notifications. */
export class ChatService {
  private readonly chats = new Map<string, StoredChat>();
  private readonly eventTails = new Map<string, Promise<void>>();
  private readonly chatListeners = new Map<string, Set<(event: ChatEvent) => void>>();
  private readonly projectListeners = new Set<(event: ProjectEvent) => void>();
  private readonly now: () => number;
  private readonly ids: () => string;

  private constructor(
    readonly scope: ProjectScope,
    readonly store: FileChatStore,
    options: ChatServiceOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? randomUUID;
  }

  static async open(
    scope: ProjectScope,
    store: FileChatStore,
    options: ChatServiceOptions = {},
  ): Promise<ChatService> {
    const service = new ChatService(scope, store, options);
    for (const chatId of await store.listChatIds()) {
      const { events, state } = await store.load(chatId);
      if (state) service.chats.set(chatId, { events, state });
    }
    return service;
  }

  /** `enabledAgents`: the specialists a new chat starts with (the global defaults). */
  async create(input: CreateChatRequest, enabledAgents: SpecialistId[] = []): Promise<ChatSummary> {
    const createdAt = this.now();
    const chat: ChatSummary = {
      id: this.ids(),
      projectId: this.scope.projectId,
      title: input.title ?? "New chat",
      createdAt,
      updatedAt: createdAt,
      status: "idle",
      lastTaskSummary: null,
      activeMode: "normal",
      mainAgentModel: input.model ?? null,
      thinking: input.thinking ?? null,
      enabledAgents: [...enabledAgents],
      agentOverrides: {},
    };
    this.chats.set(chat.id, { events: [], state: emptyChatState(chat) });
    try {
      await this.emit(chat.id, { type: "chat.created", chat });
      return chat;
    } catch (error) {
      this.chats.delete(chat.id);
      throw error;
    }
  }

  list(): ChatSummary[] {
    return [...this.chats.values()]
      .map((entry) => entry.state.chat)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  get(chatId: string): ChatState | null {
    return this.chats.get(chatId)?.state ?? null;
  }

  events(chatId: string): readonly ChatEvent[] {
    return this.chats.get(chatId)?.events ?? [];
  }

  async update(chatId: string, input: UpdateChatRequest): Promise<ChatSummary | null> {
    const record = this.chats.get(chatId);
    if (!record) return null;
    const current = record.state.chat;
    let agentOverrides = current.agentOverrides ?? {};
    if (input.agentOverrides) {
      agentOverrides = { ...agentOverrides };
      for (const id of SPECIALIST_IDS) {
        const override = input.agentOverrides[id];
        if (override === null) delete agentOverrides[id];
        else if (override) agentOverrides[id] = override;
      }
    }
    const chat: ChatSummary = {
      ...current,
      ...(input.title !== undefined && { title: input.title }),
      ...(input.model !== undefined && { mainAgentModel: input.model }),
      ...(input.thinking !== undefined && { thinking: input.thinking }),
      ...(input.enabledAgents !== undefined && { enabledAgents: [...input.enabledAgents] }),
      ...(input.activeMode !== undefined && { activeMode: input.activeMode }),
      ...(input.intent !== undefined && { intent: input.intent }),
      ...(input.executionQuality !== undefined && {
        executionQuality: input.executionQuality && structuredClone(input.executionQuality),
      }),
      agentOverrides,
      updatedAt: this.now(),
    };
    await this.emit(chatId, { type: "chat.updated", chat });
    return chat;
  }

  /**
   * Sets or clears the chat's "frame format still to be decided" flag (a start-from-chat project the agent must
   * pick the canvas for). Durable: it rides `chat.updated`, so a later turn of the same chat — plan now, edit
   * after the user approves the plan — still knows the format is open.
   */
  async setCanvasAuto(chatId: string, auto: boolean): Promise<void> {
    const record = this.chats.get(chatId);
    if (!record) return;
    const current = record.state.chat;
    if ((current.canvasAuto ?? false) === auto) return;
    const chat: ChatSummary = { ...current, updatedAt: this.now() };
    if (auto) chat.canvasAuto = true;
    else delete chat.canvasAuto;
    await this.emit(chatId, { type: "chat.updated", chat });
  }

  /**
   * Records that the user declined Story Mode in this chat: the runtime never offers it here again and tells the
   * Director so. Durable on the chat, like the offer cards themselves.
   */
  async setStoryDeclined(chatId: string): Promise<void> {
    const record = this.chats.get(chatId);
    if (!record) return;
    const current = record.state.chat;
    if (current.storyDeclined === true) return;
    await this.emit(chatId, {
      type: "chat.updated",
      chat: { ...current, storyDeclined: true, updatedAt: this.now() },
    });
  }

  async markWorking(chatId: string, prompt: string): Promise<ChatSummary> {
    const record = this.chats.get(chatId);
    if (!record) throw new Error("Chat does not exist");
    const current = record.state.chat;
    const chat: ChatSummary = {
      ...current,
      title: current.title === "New chat" ? truncate(prompt.trim(), 60) : current.title,
      updatedAt: this.now(),
      status: "working",
      lastTaskSummary: truncate(prompt.trim(), 120),
    };
    await this.emit(chatId, { type: "chat.updated", chat });
    return chat;
  }

  async markStatus(chatId: string, status: ChatSummary["status"]): Promise<ChatSummary> {
    const record = this.chats.get(chatId);
    if (!record) throw new Error("Chat does not exist");
    const chat: ChatSummary = { ...record.state.chat, status, updatedAt: this.now() };
    await this.emit(chatId, { type: "chat.updated", chat });
    return chat;
  }

  async emit(chatId: string, payload: ChatEventPayload): Promise<ChatEvent> {
    const previous = this.eventTails.get(chatId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const record = this.chats.get(chatId);
        if (!record) throw new Error("Chat does not exist");
        const event: ChatEvent = {
          ...payload,
          chatId,
          seq: record.state.lastSeq + 1,
          ts: this.now(),
        };
        await this.store.append(event);
        record.events.push(event);
        record.state = applyChatEvent(record.state, event);
        if (event.type === "chat.created" || event.type === "chat.updated") {
          this.publishProject({ type: "chat.upserted", chat: event.chat });
        }
        for (const listener of this.chatListeners.get(chatId) ?? []) {
          try {
            listener(event);
          } catch {}
        }
        return event;
      });
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.eventTails.set(chatId, settled);
    try {
      return await operation;
    } finally {
      if (this.eventTails.get(chatId) === settled) this.eventTails.delete(chatId);
    }
  }

  /**
   * Waits until every queued event (including fire-and-forget `onModel` updates) reached the store. Shutdown and
   * test teardown drain before deleting directories, so no append can still be in flight when its directory goes.
   */
  async drain(): Promise<void> {
    while (this.eventTails.size > 0) {
      await Promise.allSettled([...this.eventTails.values()]);
    }
    await this.store.drain();
  }

  subscribeChat(
    chatId: string,
    after: number,
    listener: (event: ChatEvent) => void,
  ): ChatEventSubscription {
    const record = this.chats.get(chatId);
    if (!record) return { replay: [], unsubscribe: () => undefined };
    const listeners = this.chatListeners.get(chatId) ?? new Set<(event: ChatEvent) => void>();
    listeners.add(listener);
    this.chatListeners.set(chatId, listeners);
    return {
      replay: record.events.filter((event) => event.seq > after),
      unsubscribe: () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.chatListeners.delete(chatId);
      },
    };
  }

  subscribeProject(listener: (event: ProjectEvent) => void): () => void {
    this.projectListeners.add(listener);
    return () => this.projectListeners.delete(listener);
  }

  publishProject(event: ProjectEvent): void {
    for (const listener of this.projectListeners) {
      try {
        listener(event);
      } catch {}
    }
  }
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}
