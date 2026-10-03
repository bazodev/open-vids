import { randomUUID } from "node:crypto";
import {
  isAgentRunTerminal,
  isChapter,
  normalizeChatIntent,
  type ActiveTurnInfo,
  type AgentId,
  type AgentModelCatalog,
  type AnswerPermissionResponse,
  type AnswerStoryOfferResponse,
  type AssistantMessage,
  type AssistantMessageStatus,
  type ChatIntent,
  type ChatMode,
  type ChatState,
  type MessageReference,
  type PermissionDecision,
  type PlanApproval,
  type PlanStep,
  type StoryAction,
  type StoryActionOptions,
  type StoryOffer,
  type StoryOfferDecision,
  type StoryOfferPart,
  type UserPart,
  type UserMessage,
  type ChatSummary,
  type RevertMode,
  type RevertTurnResponse,
  type SpecialistId,
  type StartTurnRequest,
  type SteerTurnRequest,
  type TurnCheckpoint,
  type TurnSummary,
} from "@hyperframes/agent-protocol";
import type {
  AgentBackend,
  BackendPromptOutcome,
  BackendSession,
  HostToolResult,
} from "./backend.js";
import { Orchestrator, type TurnAgentSetup } from "./agents/orchestrator.js";
import { directorInstructions, jevInstructions, specialistInstructions } from "./agents/roles.js";
import { renderTeam, resolveTurnSetup } from "./agents/setup.js";
import { isLockRefusal, lockedEditAdvice } from "./autonomy.js";
import {
  buildHostTools,
  parseStoryOfferArgs,
  TOOL_NAMES,
  type ToolAvailability,
} from "./agents/tools.js";
import { TurnEditing } from "./editing/executor.js";
import { isEditingToolName } from "./editing/tools.js";
import { TurnAnalysis } from "./analysis/executor.js";
import { isAnalysisToolName } from "./analysis/tools.js";
import { TurnStory } from "./story/executor.js";
import { renderStoryBlocks } from "./story/prompt.js";
import { isStoryToolName, storyToolsFor, timelineWritesAllowed } from "./story/tools.js";
import { StoryToolError } from "./story/host.js";
import {
  renderStoryDeclinedBlock,
  renderStoryOfferBlock,
  storyOfferOperations,
} from "./storyOffer.js";
import { TurnResearch } from "./research/executor.js";
import { isResearchToolName, type ResearchAccess } from "./research/tools.js";
import { WebsiteResourceLog } from "./research/websiteResources.js";
import { PermissionBroker } from "./permissions.js";
import { TurnQa } from "./qa/executor.js";
import { QaLoop, qaApplies, type QaPhase } from "./qa/loop.js";
import { qaPhaseRefusal } from "./qa/phase.js";
import { renderInterimInstruction } from "./qa/prompt.js";
import { isQaToolName } from "./qa/tools.js";
import { RuntimeError, errorMessage } from "./errors.js";
import type { CheckpointHandle, CheckpointHost, RevertOutcome } from "./checkpointHost.js";
import {
  intentRefusal,
  renderExecutePlanBlock,
  renderIntentBlock,
  renderPlanApprovalBlock,
} from "./intent.js";
import { ChatService } from "./chats.js";
import {
  renderCanvasAutoBlock,
  renderCanvasAutoPlanBlock,
  renderPromptContext,
} from "./promptContext.js";
import { renderRevertedTurns, revertedSinceLastPrompt } from "./revertedTurns.js";
import { SessionManager } from "./sessionManager.js";
import type { AgentSettingsStore } from "./settings.js";
import { FileChatStore } from "./store/index.js";
import { TurnEventWriter, type StreamTimerApi, type StreamTimerHandle } from "./turnStream.js";
import {
  STORY_TURN_TIMELINE_REFUSAL,
  checkpointLabel as labelFor,
  cloneTurn,
  createDeferredVoid,
  sameIds,
  writesTimeline,
  type TurnRunnerOptions,
} from "./turnSupport.js";
export type { TurnRunnerOptions } from "./turnSupport.js";

const DEFAULT_IDLE_MS = 15 * 60_000;
const DEFAULT_RENEW_MS = 20_000;
/** How many times the Director is re-prompted with results of runs it finished without collecting. */
const MAX_FOLLOW_UPS = 3;

interface ChatTurnTarget {
  turn: TurnSummary;
  checkpoint: TurnCheckpoint | null;
}

interface ActiveRun {
  chatId: string;
  turn: TurnSummary;
  assistantMessage: AssistantMessage;
  controller: AbortController;
  checkpoint: CheckpointHandle | null;
  session: BackendSession | null;
  setup: TurnAgentSetup | null;
  orchestrator: Orchestrator | null;
  /** The turn's editing tools; closed and awaited before the checkpoint ends. */
  editing: TurnEditing | null;
  /** The turn's analysis tools; closed (jobs cancelled, calls awaited) before the checkpoint ends. */
  analysis: TurnAnalysis | null;
  /** The turn's story tools; closed (in-flight edits/builds awaited) before the checkpoint ends. */
  story: TurnStory | null;
  /** The turn's research tools; closed (in-flight imports and resolutions awaited) before the checkpoint ends. */
  research: TurnResearch | null;
  /**
   * The turn's permission requests: a website tool whose setting is off asks the user from the chat and waits here.
   * Expired at the turn's end so no waiting call hangs; the turn's grant is revoked then too.
   */
  permissions: PermissionBroker | null;
  /** The turn's render QA (service calls and Vision's review tools); closed and awaited before the checkpoint ends. */
  qa: TurnQa | null;
  /** Where the turn is in render QA: tools are refused accordingly (see qa/phase.ts). */
  qaPhase: QaPhase;
  /** The mode the turn runs in (a story action implies `story`). */
  mode: ChatMode;
  /** What the user wants from the turn: an Ask turn never changes the project. */
  intent: ChatIntent;
  /** The user's plan-approval setting for this turn (from the global settings as the turn started). */
  planApproval: PlanApproval;
  /** The approved plan this turn carries out, if the user started it from a proposal; the steps as proposed. */
  executePlan: { turnId: string; steps: PlanStep[] } | null;
  /** The Story workspace action the turn runs, if any. */
  storyAction: StoryAction | null;
  /** The user's choices for a build/rebuild action (scope, manual-edit policy, locked chapters), if any. */
  storyOptions: StoryActionOptions | null;
  /** Whether this turn may offer Story Mode at all (the tool and the prompt block go together). */
  storyOfferEligible: boolean;
  /** The offer this turn published, if any: another one is refused and project changes stop until answered. */
  storyOffer: StoryOffer | null;
  /** The Director's prompt has ended but the turn is still collecting delegated work. */
  directorIdle: boolean;
  /** Steering received while the Director was idle; it opens the next Director prompt. */
  pendingSteering: string[];
  promptStarted: Promise<void>;
  markPromptStarted: () => void;
  task: Promise<void> | null;
  forcedError: unknown | null;
  finalizing: boolean;
  heartbeat: StreamTimerHandle | null;
}

/** Serializes all project mutations: one Director turn at a time, with its delegated runs, per project. */
export class TurnRunner {
  private readonly now: () => number;
  private readonly ids: () => string;
  private readonly idleMs: number;
  private readonly renewIntervalMs: number;
  private readonly stopGraceMs: number | undefined;
  private readonly editingFactory: TurnRunnerOptions["editing"];
  private readonly analysisFactory: TurnRunnerOptions["analysis"];
  private readonly storyFactory: TurnRunnerOptions["story"];
  private readonly researchFactory: TurnRunnerOptions["research"];
  private readonly qaFactory: TurnRunnerOptions["qa"];
  private readonly analysisPollMs: number | undefined;
  private readonly timers: StreamTimerApi;
  private readonly sessionManager: SessionManager;
  /** Files the linked sites' reads listed, per chat: full access may fetch exactly these (see websiteResources.ts). */
  private readonly websiteResources = new WebsiteResourceLog();
  private active: ActiveRun | null = null;
  private revertingChatId: string | null = null;

  constructor(
    private readonly chats: ChatService,
    private readonly backend: AgentBackend,
    private readonly checkpoints: CheckpointHost,
    private readonly store: FileChatStore,
    private readonly settings: AgentSettingsStore,
    options: TurnRunnerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ids = options.ids ?? randomUUID;
    this.idleMs = options.sessionIdleMs ?? DEFAULT_IDLE_MS;
    this.renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_MS;
    this.stopGraceMs = options.stopGraceMs;
    this.editingFactory = options.editing;
    this.analysisFactory = options.analysis;
    this.storyFactory = options.story;
    this.researchFactory = options.research;
    this.qaFactory = options.qa;
    this.analysisPollMs = options.analysisPollMs;
    this.timers = options.timers ?? {
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: (timer) => globalThis.clearTimeout(timer),
    };
    this.sessionManager = new SessionManager(
      backend,
      this.idleMs,
      this.timers,
      (chatId) => this.active?.chatId === chatId,
    );
  }

  get activeTurn(): ActiveTurnInfo | null {
    return this.active ? this.info(this.active) : null;
  }

  async start(chatId: string, input: StartTurnRequest): Promise<TurnSummary> {
    if (!input.prompt.trim())
      throw new RuntimeError("invalid_request", "prompt must not be empty", 400);
    if (input.storyAction && !this.storyFactory)
      throw new RuntimeError("invalid_request", "Story Mode is not available in this runtime", 400);
    const chatState = this.chats.get(chatId);
    if (!chatState) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    if (this.active) {
      if (this.active.chatId === chatId)
        throw new RuntimeError("chat_busy", "This chat already has a running turn", 409);
      throw new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
        activeTurn: this.info(this.active),
      });
    }

    if (this.revertingChatId) {
      if (this.revertingChatId === chatId)
        throw new RuntimeError("chat_busy", "This chat is being reverted", 409);
      throw new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
        activeTurn: null,
      });
    }
    // A new user turn moves the chat on: a Story Mode offer still waiting for its answer is expired. (The offer of
    // the turn that just ended stays answerable, so this is the only place a pending offer is taken down.)
    await this.expireStoryOffers(chatId);
    // A start-from-chat project on Auto: the format stays open across turns (a proposal now, the edit later) until
    // an edit sets the canvas. Durable on the chat, so a restart does not lose the choice.
    if (input.canvas === "auto") await this.chats.setCanvasAuto(chatId, true);
    // "Carry out the plan": the proposal must exist on the chat before anything is reserved.
    const executePlan = this.resolveExecutePlan(chatState, input);
    // A Story workspace action is always a story-mode turn; a plan is carried out in a normal turn; otherwise the
    // request's mode, else the chat's.
    const mode: ChatMode = input.storyAction
      ? "story"
      : executePlan
        ? "normal"
        : (input.mode ?? chatState.chat.activeMode);
    // A Story workspace action and an approved plan always act; otherwise the request's intent, else the chat's
    // (an old chat may still store the removed `plan`, read as `edit`), else Edit.
    const intent: ChatIntent =
      input.storyAction || executePlan
        ? "edit"
        : (input.intent ?? normalizeChatIntent(chatState.chat.intent) ?? "edit");
    const startedAt = this.now();
    const turnId = this.ids();
    const promptMessageId = this.ids();
    const assistantMessageId = this.ids();
    const turn: TurnSummary = {
      id: turnId,
      chatId,
      status: "running",
      startedAt,
      promptMessageId,
      assistantMessageId,
      model: chatState.chat.mainAgentModel,
      thinking: chatState.chat.thinking,
      checkpoint: { status: "active", entryIds: [], createdAt: startedAt },
      mode,
      intent,
      ...(input.storyAction && { storyAction: input.storyAction }),
      ...(input.storyOptions && { storyOptions: input.storyOptions }),
    };
    const referenceParts = this.referenceParts(input.references);
    const promptMessage: UserMessage = {
      id: promptMessageId,
      chatId,
      turnId,
      createdAt: startedAt,
      role: "user",
      steering: false,
      parts: [{ type: "text", id: this.ids(), text: input.prompt }, ...referenceParts],
    };
    const assistantMessage: AssistantMessage = {
      id: assistantMessageId,
      chatId,
      turnId,
      createdAt: startedAt,
      role: "assistant",
      parts: [],
      status: "streaming",
      model: turn.model,
    };
    const checkpointLabel = labelFor(input.prompt);
    const started = createDeferredVoid();
    const reservation: ActiveRun = {
      chatId,
      turn: cloneTurn(turn),
      assistantMessage,
      controller: new AbortController(),
      checkpoint: null,
      session: null,
      setup: null,
      orchestrator: null,
      editing: null,
      analysis: null,
      story: null,
      research: null,
      permissions: null,
      qa: null,
      qaPhase: null,
      mode,
      intent,
      planApproval: "never",
      executePlan,
      storyAction: input.storyAction ?? null,
      storyOptions: input.storyOptions ?? null,
      storyOfferEligible: false,
      storyOffer: null,
      directorIdle: false,
      pendingSteering: [],
      promptStarted: started.promise,
      markPromptStarted: () => started.resolve(),
      task: null,
      forcedError: null,
      finalizing: false,
      heartbeat: null,
    };
    this.active = reservation;

    // The team and the Director's model are fixed for the whole turn, from the chat and the global defaults.
    const prepared = await this.prepareTurn(chatState.chat, input);
    reservation.setup = prepared.setup;
    reservation.planApproval = prepared.setup.autonomy.planApproval;
    turn.model = prepared.model;
    turn.thinking = prepared.thinking;
    reservation.turn.model = prepared.model;
    reservation.turn.thinking = prepared.thinking;
    assistantMessage.model = prepared.model;
    const execution = prepared.setup.execution;
    turn.execution = { preset: execution.preset, budget: { ...execution.budget } };
    reservation.turn.execution = { preset: execution.preset, budget: { ...execution.budget } };

    try {
      await this.recoverCheckpoints();
      reservation.checkpoint = await this.checkpoints.begin(this.chats.scope, checkpointLabel);
      const checkpoint: TurnCheckpoint = {
        status: "active",
        entryIds: [],
        createdAt: reservation.checkpoint.startedAt,
        transactionId: reservation.checkpoint.transactionId,
      };
      turn.checkpoint = checkpoint;
      reservation.turn.checkpoint = { ...checkpoint, entryIds: [] };
      this.scheduleRenew(reservation);
    } catch (error) {
      if (this.active === reservation) this.active = null;
      throw new RuntimeError(
        "checkpoint_unavailable",
        errorMessage(error, "Could not open a project checkpoint"),
        409,
      );
    }

    try {
      await this.chats.emit(chatId, {
        type: "turn.started",
        turn,
        promptMessage,
        assistantMessage,
      });
      await this.chats.markWorking(chatId, input.prompt);
      this.chats.publishProject({ type: "project.activeTurn", activeTurn: this.info(reservation) });
      reservation.task = this.runTurn(reservation, input);
      return turn;
    } catch (error) {
      await this.finalize(reservation, "failed", error);
      throw error;
    }
  }

  private referenceParts(references: readonly MessageReference[] = []): UserPart[] {
    return references.map(
      (reference): UserPart => ({ type: "reference", id: this.ids(), reference }),
    );
  }

  async steer(chatId: string, turnId: string, input: SteerTurnRequest): Promise<string> {
    const run = this.active;
    if (!run || run.chatId !== chatId || run.turn.id !== turnId || run.finalizing) {
      throw new RuntimeError("turn_not_active", "Turn is not active", 409);
    }
    const messageId = this.ids();
    const message: UserMessage = {
      id: messageId,
      chatId,
      turnId,
      createdAt: this.now(),
      role: "user",
      steering: true,
      parts: [
        { type: "text", id: this.ids(), text: input.text },
        ...this.referenceParts(input.references),
      ],
    };
    await this.chats.emit(chatId, { type: "message.appended", message });
    await run.promptStarted;
    run.editing?.noteUserRequest(input.text);
    if (this.active !== run || run.finalizing || !run.session) {
      throw new RuntimeError("turn_not_active", "Turn is no longer active", 409);
    }
    const text = renderPromptContext(
      input.text,
      input.editorContext,
      input.references,
      input.userLanguage,
    );
    if (run.directorIdle) {
      // The Director is between prompts, waiting for delegated runs: the instruction opens its next prompt.
      run.pendingSteering.push(text);
      run.orchestrator?.notifySteer();
      return messageId;
    }
    try {
      await run.session.steer(text);
      // A Director blocked in wait_for_agents returns now, so the instruction reaches it promptly.
      run.orchestrator?.notifySteer();
      return messageId;
    } catch (error) {
      run.forcedError = error;
      run.controller.abort();
      throw new RuntimeError(
        "agent_failed",
        errorMessage(error, "The agent could not apply the steering instruction"),
        502,
      );
    }
  }

  abort(chatId: string, turnId: string): void {
    const run = this.active;
    if (run && run.chatId === chatId && run.turn.id === turnId && !run.finalizing)
      run.controller.abort();
  }

  /**
   * The user's answer to a permission request of the running turn (the chat's "Allow once" / "Turn on" / "Don't
   * allow"): the request is published in its new state and the tool call waiting on it resumes. Unknown chat or turn
   * are `chat_not_found` / `turn_not_found`; a turn that is not running, or a request that is no longer pending, is
   * `turn_not_active`. When Studio cannot apply an `always` or `once` answer the request stays pending and the
   * failure is answered, so the user can retry.
   */
  async answerPermission(
    chatId: string,
    turnId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): Promise<AnswerPermissionResponse> {
    const state = this.chats.get(chatId);
    if (!state) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    if (!state.turns.some((turn) => turn.id === turnId))
      throw new RuntimeError("turn_not_found", "Turn was not found", 404);
    const run = this.active;
    if (
      !run ||
      run.chatId !== chatId ||
      run.turn.id !== turnId ||
      run.finalizing ||
      !run.permissions
    )
      throw new RuntimeError("turn_not_active", "Turn is not active", 409);
    return { permission: await run.permissions.answer(permissionId, decision) };
  }

  /**
   * The user's answer to a Story Mode offer card. Unlike a permission, the offer stays answerable after its own turn
   * ended, so it is read from the chat and only a turn running right now is refused. `accept` writes the chapters
   * into the Story Graph through the story service (no model) and marks the offer accepted — refused when the graph
   * changed meanwhile or already has chapters; `decline` records the decline on the chat, so it is never offered
   * there again, and marks the offer declined.
   */
  async answerStoryOffer(
    chatId: string,
    turnId: string,
    offerId: string,
    decision: StoryOfferDecision,
    signal?: AbortSignal,
  ): Promise<AnswerStoryOfferResponse> {
    const state = this.chats.get(chatId);
    if (!state) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    const found = this.storyOfferTarget(state, turnId, offerId);
    if (found.offer.state !== "pending")
      throw new RuntimeError("turn_not_active", "This Story Mode offer was already answered", 409);
    if (this.active) {
      if (this.active.chatId === chatId)
        throw new RuntimeError("chat_busy", "This chat has a running turn", 409);
      throw new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
        activeTurn: this.info(this.active),
      });
    }
    if (this.revertingChatId) {
      if (this.revertingChatId === chatId)
        throw new RuntimeError("chat_busy", "This chat is being reverted", 409);
      throw new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
        activeTurn: null,
      });
    }
    if (decision === "decline") {
      await this.chats.setStoryDeclined(chatId);
      const declined: StoryOffer = {
        ...found.offer,
        state: "declined",
        answeredAt: this.now(),
      };
      await this.chats.emit(chatId, {
        type: "storyOffer.updated",
        messageId: found.messageId,
        offer: declined,
      });
      return { offer: declined };
    }
    if (!this.storyFactory)
      throw new RuntimeError("invalid_request", "Story Mode is not available in this runtime", 400);
    const host = this.storyFactory(this.chats.scope);
    const callSignal = signal ?? new AbortController().signal;
    let accepted: StoryOffer;
    try {
      const view = await host.view(callSignal);
      if (view.graph?.nodes.some(isChapter))
        throw new RuntimeError(
          "story_offer_conflict",
          "The story gained chapters while the offer was waiting, so it cannot be applied.",
          409,
        );
      await host.edit(
        {
          ...(view.version !== null && { baseVersion: view.version }),
          operations: storyOfferOperations(found.offer.chapters),
        },
        callSignal,
      );
      accepted = { ...found.offer, state: "accepted", answeredAt: this.now() };
    } catch (error) {
      throw this.storyOfferFailure(error);
    }
    await this.chats.emit(chatId, {
      type: "storyOffer.updated",
      messageId: found.messageId,
      offer: accepted,
    });
    return { offer: accepted };
  }

  /** Where a turn's Story Mode offer card lives and what it says; unknown turns and offers are refused. */
  private storyOfferTarget(
    state: ChatState,
    turnId: string,
    offerId: string,
  ): { messageId: string; offer: StoryOffer } {
    const turn = state.turns.find((entry) => entry.id === turnId);
    if (!turn) throw new RuntimeError("turn_not_found", "Turn was not found", 404);
    const message = state.messages.find((entry) => entry.id === turn.assistantMessageId);
    if (message?.role !== "assistant")
      throw new RuntimeError("invalid_request", "This turn has no such Story Mode offer", 400);
    const part = message.parts.find(
      (entry): entry is StoryOfferPart => entry.type === "story-offer" && entry.id === offerId,
    );
    if (!part)
      throw new RuntimeError("invalid_request", "This turn has no such Story Mode offer", 400);
    return { messageId: message.id, offer: part.offer };
  }

  /** A story failure of the offer write, as the runtime answers it: a graph that moved on is a conflict. */
  private storyOfferFailure(error: unknown): RuntimeError {
    if (error instanceof RuntimeError) return error;
    if (error instanceof StoryToolError) {
      if (error.code === "conflict")
        return new RuntimeError(
          "story_offer_conflict",
          "The story changed while the offer was waiting, so it cannot be applied.",
          409,
        );
      if (error.code === "unavailable" || error.code === "aborted")
        return new RuntimeError(
          "runtime_unavailable",
          errorMessage(error, "The story service could not be reached"),
          503,
        );
      return new RuntimeError("story_offer_conflict", error.message, 409);
    }
    return new RuntimeError(
      "runtime_unavailable",
      errorMessage(error, "The story service could not be reached"),
      503,
    );
  }

  /**
   * Expires every pending Story Mode offer of a chat that has no running turn. Called when a new user turn starts:
   * that is what makes a pending offer unanswerable, while the end of its own turn leaves it pending.
   */
  private async expireStoryOffers(chatId: string): Promise<void> {
    const state = this.chats.get(chatId);
    if (!state) return;
    for (const message of state.messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (part.type !== "story-offer" || part.offer.state !== "pending") continue;
        const expired: StoryOffer = {
          ...part.offer,
          state: "expired",
          answeredAt: this.now(),
        };
        await this.chats
          .emit(chatId, { type: "storyOffer.updated", messageId: message.id, offer: expired })
          .catch(() => undefined);
      }
    }
  }

  /**
   * Reverts a finished turn's checkpoint. Without a mode, files changed after the turn stop it with a conflict (the
   * user then chooses `keep-later-edits` or `just-this`).
   */
  async revert(chatId: string, turnId: string, mode?: RevertMode): Promise<RevertTurnResponse> {
    const { turn, checkpoint } = this.revertTarget(chatId, turnId);
    if (checkpoint?.status !== "ready" || checkpoint.entryIds.length === 0) {
      throw new RuntimeError("revert_unavailable", "This turn has no reversible checkpoint", 409);
    }
    return this.whileReverting(chatId, async () => {
      const outcome = await this.undoEntries(
        checkpoint.entryIds,
        mode,
        "Could not revert this turn",
      );
      const undoEntryIds = [...(checkpoint.revertEntryIds ?? []), ...(outcome.undoEntryIds ?? [])];
      if (!outcome.ok) {
        const remaining = outcome.remainingEntryIds;
        if (remaining && !sameIds(checkpoint.entryIds, remaining)) {
          // The newer entries were reverted before the conflict: only the older ones remain to revert.
          await this.emitCheckpoint(chatId, turnId, {
            ...checkpoint,
            entryIds: remaining,
            revertedEntryIds: [
              ...checkpoint.entryIds.slice(remaining.length),
              ...(checkpoint.revertedEntryIds ?? []),
            ],
            revertEntryIds: undoEntryIds,
          });
        }
        return { ok: false, conflict: outcome.conflict };
      }
      // Revert untouched files leaves the files that changed later as they are: the turn's files no undo touched.
      let keptFiles: string[] = [];
      if (mode === "keep-later-edits" && checkpoint.files) {
        const undone = await this.checkpoints
          .files(this.chats.scope, undoEntryIds)
          .catch((): string[] | null => null);
        if (undone) keptFiles = checkpoint.files.filter((file) => !undone.includes(file));
      }
      const updated: TurnCheckpoint = {
        ...checkpoint,
        status: "reverted",
        revertedAt: this.now(),
        revertedEntryIds: [...checkpoint.entryIds, ...(checkpoint.revertedEntryIds ?? [])],
        revertEntryIds: undoEntryIds,
        ...(keptFiles.length > 0 && { keptFiles }),
      };
      await this.emitCheckpoint(chatId, turnId, updated);
      return { ok: true, turn: { ...turn, checkpoint: updated } };
    });
  }

  /** Undo revert: undoes the entries the revert wrote, so the turn's changes are back and revertable again. */
  async unrevert(chatId: string, turnId: string, mode?: RevertMode): Promise<RevertTurnResponse> {
    const { turn, checkpoint } = this.revertTarget(chatId, turnId);
    const undoEntryIds = checkpoint?.revertEntryIds ?? [];
    if (checkpoint?.status !== "reverted" || undoEntryIds.length === 0) {
      throw new RuntimeError("revert_unavailable", "This revert cannot be undone", 409);
    }
    return this.whileReverting(chatId, async () => {
      const outcome = await this.undoEntries(undoEntryIds, mode, "Could not undo the revert");
      if (!outcome.ok) {
        const remaining = outcome.remainingEntryIds;
        if (remaining && !sameIds(undoEntryIds, remaining)) {
          await this.emitCheckpoint(chatId, turnId, { ...checkpoint, revertEntryIds: remaining });
        }
        return { ok: false, conflict: outcome.conflict };
      }
      const restored: TurnCheckpoint = {
        status: "ready",
        entryIds: checkpoint.revertedEntryIds ?? checkpoint.entryIds,
        createdAt: checkpoint.createdAt,
        ...(checkpoint.closedAt !== undefined && { closedAt: checkpoint.closedAt }),
        ...(checkpoint.files && { files: checkpoint.files }),
      };
      await this.emitCheckpoint(chatId, turnId, restored);
      return { ok: true, turn: { ...turn, checkpoint: restored } };
    });
  }

  /** The turn a revert (or undo of one) targets; refused while any turn or revert of the project runs. */
  private revertTarget(chatId: string, turnId: string): ChatTurnTarget {
    if (this.active) {
      if (this.active.chatId === chatId)
        throw new RuntimeError("chat_busy", "This chat has a running turn", 409);
      throw new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
        activeTurn: this.info(this.active),
      });
    }
    if (this.revertingChatId) {
      if (this.revertingChatId === chatId)
        throw new RuntimeError("chat_busy", "This chat is being reverted", 409);
      throw new RuntimeError("project_busy", "Another chat is modifying this project", 409, {
        activeTurn: null,
      });
    }
    const state = this.chats.get(chatId);
    if (!state) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
    const turn = state.turns.find((entry) => entry.id === turnId);
    if (!turn) throw new RuntimeError("turn_not_found", "Turn was not found", 404);
    if (state.chat.status === "working")
      throw new RuntimeError("chat_busy", "This chat has a running turn", 409);
    return { turn, checkpoint: turn.checkpoint };
  }

  private async whileReverting<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    this.revertingChatId = chatId;
    try {
      return await work();
    } finally {
      this.revertingChatId = null;
    }
  }

  private async undoEntries(
    entryIds: readonly string[],
    mode: RevertMode | undefined,
    failure: string,
  ): Promise<RevertOutcome> {
    try {
      return await this.checkpoints.revert(this.chats.scope, entryIds, mode);
    } catch (error) {
      throw new RuntimeError("runtime_unavailable", errorMessage(error, failure), 503);
    }
  }

  private async emitCheckpoint(
    chatId: string,
    turnId: string,
    checkpoint: TurnCheckpoint,
  ): Promise<void> {
    await this.chats.emit(chatId, { type: "checkpoint.updated", turnId, checkpoint });
  }

  /** The files a closed checkpoint's entries changed; nothing when Studio cannot say (the footer then omits them). */
  private async checkpointFiles(entryIds: readonly string[]): Promise<{ files?: string[] }> {
    try {
      return { files: await this.checkpoints.files(this.chats.scope, entryIds) };
    } catch {
      return {};
    }
  }

  /**
   * The plan proposal an execute turn carries out: the request names the turn whose plan the user approved. Missing
   * or unproposed turns are refused; the steps are the proposal's own, so a revise turn cannot change them.
   */
  private resolveExecutePlan(
    chatState: ChatState,
    input: StartTurnRequest,
  ): { turnId: string; steps: PlanStep[] } | null {
    const requested = input.executePlan;
    if (!requested) return null;
    const source = chatState.turns.find((turn) => turn.id === requested.turnId);
    const steps = source?.plan?.proposal ? source.plan.steps : null;
    if (!steps || steps.length === 0)
      throw new RuntimeError(
        "invalid_request",
        "That turn has no plan proposal to carry out; propose one first",
        400,
      );
    return { turnId: requested.turnId, steps };
  }

  /** Whether the running turn's Director may propose a plan (the prompt block and `propose_plan` go together). */
  private planProposalOffered(run: ActiveRun): boolean {
    return (
      run.intent === "edit" &&
      run.mode !== "story" &&
      run.executePlan === null &&
      run.planApproval !== "never"
    );
  }

  /** Whether the running turn already published a plan proposal (everything project-changing is refused then). */
  private planProposed(run: ActiveRun): boolean {
    return run.turn.plan?.proposal === true;
  }

  /**
   * Whether the turn may offer Story Mode: an ordinary Edit turn (not a story-mode or execute-plan one), in a chat
   * that has not declined an offer, while the project's Story graph has no chapters. False when the story could not
   * be read — the accept would fail the same way.
   */
  private async storyOfferOpen(run: ActiveRun, signal: AbortSignal): Promise<boolean> {
    if (!run.story || run.mode !== "normal" || run.intent !== "edit" || run.executePlan !== null)
      return false;
    if (this.chats.get(run.chatId)?.chat.storyDeclined === true) return false;
    const snapshot = await run.story.snapshot(signal);
    if (snapshot.view === null) return false;
    return !(snapshot.view.graph?.nodes.some(isChapter) ?? false);
  }

  /** Whether this turn already published a Story Mode offer (everything project-changing is refused then). */
  private storyOffered(run: ActiveRun): boolean {
    return run.storyOffer !== null;
  }

  /** The harness's own file writes (edit/write) are refused in an Ask turn and after a plan or story offer. */
  private fileWriteRefusal(chatId: string, toolName: string): string | null {
    const run = this.active;
    if (!run || run.chatId !== chatId) return null;
    return intentRefusal(run.intent, toolName, this.planProposed(run), this.storyOffered(run));
  }

  /** The user's "ask before changing locked sections" setting for the turn that is running (true when none is). */
  private askBeforeLockedEdits(chatId: string): boolean {
    const run = this.active;
    if (!run || run.chatId !== chatId) return true;
    return run.setup?.autonomy.askBeforeLockedEdits ?? true;
  }

  /**
   * Closes every transaction a previous run could not: turns still "running" in the log (the runtime died mid-turn)
   * become "interrupted", and checkpoints still "active" (a turn ended while Studio was unreachable) are closed and
   * given their entries. Delegated runs left open by a dead runtime are closed as "interrupted" first, so no run
   * outlives its turn. Runs on project load and before each new turn.
   */
  async recoverCheckpoints(): Promise<void> {
    for (const chat of this.chats.list()) {
      const orphans = this.chats
        .get(chat.id)
        ?.runs.filter(
          (run) => !isAgentRunTerminal(run.status) && run.turnId !== this.active?.turn.id,
        );
      for (const orphan of orphans ?? []) {
        await this.chats.emit(chat.id, {
          type: "agent.completed",
          run: { ...orphan, status: "interrupted", endedAt: this.now() },
        });
      }
      const state = this.chats.get(chat.id);
      if (!state) continue;
      for (const previous of state.turns) {
        if (this.active?.turn.id === previous.id) continue;
        const crashed = previous.status === "running";
        if (!crashed && previous.checkpoint?.status !== "active") continue;
        const promptMessage = state.messages.find(
          (message) =>
            message.role === "user" && message.turnId === previous.id && !message.steering,
        );
        const prompt = promptMessage?.parts.find((part) => part.type === "text")?.text ?? "";
        const createdAt = previous.checkpoint?.createdAt ?? previous.startedAt;
        let entryIds: string[];
        try {
          entryIds = await this.checkpoints.recover(this.chats.scope, {
            label: labelFor(prompt),
            startedAt: createdAt,
            ...(previous.checkpoint?.transactionId && {
              transactionId: previous.checkpoint.transactionId,
            }),
          });
        } catch {
          // Studio is unreachable: leave it pending for the next attempt rather than record "no changes".
          if (!crashed) continue;
          entryIds = [];
        }
        const checkpoint: TurnCheckpoint = {
          status: "ready",
          entryIds,
          ...(await this.checkpointFiles(entryIds)),
          createdAt,
          closedAt: this.now(),
        };
        await this.chats.emit(chat.id, {
          type: "checkpoint.updated",
          turnId: previous.id,
          checkpoint,
        });
        if (!crashed) continue;
        const turn: TurnSummary = {
          ...previous,
          status: "interrupted",
          endedAt: this.now(),
          checkpoint,
        };
        await this.chats.markStatus(chat.id, "interrupted");
        await this.chats.emit(chat.id, { type: "turn.aborted", turn });
      }
    }
  }

  async dispose(): Promise<void> {
    const active = this.active;
    if (active) {
      active.controller.abort();
      await active.task?.catch(() => undefined);
    }
    await this.sessionManager.dispose();
    // The turn's fire-and-forget `onModel` updates may still be appending when the run ended: await them before the
    // caller deletes the project directory, or the write races the removal (ENOENT/ENOTEMPTY on Windows).
    await this.chats.drain();
  }

  /** Heartbeat: keeps the turn's transaction open for the whole turn, however long it pauses between writes. */
  private scheduleRenew(run: ActiveRun): void {
    run.heartbeat = this.timers.setTimeout(() => void this.renew(run), this.renewIntervalMs);
  }

  private async renew(run: ActiveRun): Promise<void> {
    if (!run.checkpoint || run.finalizing) return;
    let open = true;
    try {
      open = await run.checkpoint.renew();
    } catch {
      // Studio did not answer this beat; the next one retries well within the host's lease.
    }
    if (run.finalizing) return;
    if (!open) {
      // Its later writes would no longer be this turn's, so Revert this turn could not undo them: stop here.
      run.forcedError ??= new Error(
        "The project checkpoint for this turn ended unexpectedly, so the agent was stopped to keep every change of this turn revertable.",
      );
      run.controller.abort();
      return;
    }
    this.scheduleRenew(run);
  }

  private async runTurn(run: ActiveRun, input: StartTurnRequest): Promise<void> {
    let writer: TurnEventWriter | null = null;
    try {
      const setup = run.setup;
      if (!setup) throw new Error("The turn has no agent setup.");
      const signal = run.controller.signal;
      const editingFactory = this.editingFactory;
      const editingHost = editingFactory ? editingFactory(this.chats.scope) : null;
      const researchFactory = this.researchFactory;
      const researchHost = researchFactory ? researchFactory(this.chats.scope) : null;
      const qaFactory = this.qaFactory;
      const qa =
        qaFactory && editingHost
          ? new TurnQa({ host: qaFactory(this.chats.scope), turnSignal: signal })
          : null;
      run.qa = qa;
      run.editing =
        editingFactory && editingHost
          ? new TurnEditing({
              host: editingHost,
              editorContext: setup.editorContext,
              turnSignal: signal,
              userRequests: [input.prompt],
              turnId: run.turn.id,
              // The canvas is set: the chat no longer needs the format decided before the next build.
              onCanvasSet: () =>
                void this.chats.setCanvasAuto(run.chatId, false).catch(() => undefined),
              ...(researchHost && { research: researchHost }),
              fingerprint: qa
                ? (callSignal) => qa.fingerprint(callSignal).catch(() => null)
                : undefined,
            })
          : null;
      const analysisFactory = this.analysisFactory;
      run.analysis = analysisFactory
        ? new TurnAnalysis({
            host: analysisFactory(this.chats.scope),
            editing: editingHost,
            turnSignal: signal,
            turnId: run.turn.id,
            framesPerSource: setup.execution.budget.analysisFramesPerSource,
            ...(this.analysisPollMs !== undefined && { pollMs: this.analysisPollMs }),
          })
        : null;
      const storyFactory = this.storyFactory;
      run.story = storyFactory
        ? new TurnStory({
            host: storyFactory(this.chats.scope),
            turnId: run.turn.id,
            turnSignal: signal,
            storyOptions: run.storyOptions,
          })
        : null;
      // The user's Asset Search policy decides what Research may do and whether full access to the sites the user
      // links is offered; it is read whenever a research host exists (the Director and Motion read websites even with
      // Research off). When Studio cannot say, research fails closed and the website tools stay read-only.
      if (researchHost) {
        const policy = await researchHost.policy(signal).catch(() => null);
        setup.research = policy
          ? { status: "ready", policy }
          : { status: "unavailable", reason: "Studio's research service did not answer" };
      }
      const researchAccess: ResearchAccess = {
        assets: researchHost !== null && setup.research?.status === "ready",
        websites: researchHost !== null,
        websiteFiles:
          researchHost !== null &&
          setup.research?.status === "ready" &&
          setup.research.policy.websites.readLinkedPages &&
          setup.research.policy.websites.fullAccess,
      };
      const websiteSettings =
        setup.research?.status === "ready"
          ? {
              readLinkedPages: setup.research.policy.websites.readLinkedPages,
              fullAccess: setup.research.policy.websites.fullAccess,
            }
          : null;
      // A website tool whose setting is off asks the user from the chat: the card lives in the main message of the
      // turn, whatever agent asked, and the answer reaches Studio through the same research host.
      run.permissions = researchHost
        ? new PermissionBroker({
            turnId: run.turn.id,
            host: researchHost,
            publish: (permission) =>
              this.chats
                .emit(run.chatId, {
                  type: "permission.updated",
                  messageId: run.assistantMessage.id,
                  permission,
                })
                .then(() => undefined),
            signal,
            now: this.now,
            ids: this.ids,
          })
        : null;
      run.research = researchHost
        ? new TurnResearch({
            host: researchHost,
            turnId: run.turn.id,
            turnSignal: signal,
            enabled: setup.enabled,
            turn: { mode: run.mode, action: run.storyAction },
            storyOptions: run.storyOptions,
            intent: run.intent,
            access: researchAccess,
            websiteSettings,
            permissions: run.permissions,
            websites: { chatId: run.chatId, resources: this.websiteResources },
            userTexts: () => this.userTexts(run.chatId),
            turnUserTexts: () => this.userTexts(run.chatId, run.turn.id),
            askBeforeDownloads: setup.autonomy.askBeforeDownloads,
            model: () => this.researchModel(run, setup),
          })
        : null;
      // What the project is when the turn starts: render QA runs only when the turn changed it.
      const startFingerprint = qa ? await qa.fingerprint(signal).catch(() => null) : null;
      // Story Mode is offered from an ordinary Edit turn while the graph is still empty and the chat has not
      // declined it. The graph is read once, here: an unreadable story means no offer (a failed accept is worse than
      // a missed suggestion), and one turn at a time means it cannot gain chapters mid-turn.
      run.storyOfferEligible = await this.storyOfferOpen(run, signal);
      const availability: ToolAvailability = {
        enabled: setup.enabled,
        jev: setup.jev !== null,
        editing: run.editing !== null,
        analysis: run.analysis !== null,
        story: run.story !== null,
        research:
          researchHost !== null &&
          setup.research?.status === "ready" &&
          setup.enabled.includes("research"),
        websites: researchHost !== null,
        websiteFiles: researchAccess.websiteFiles,
        researchCandidate: (id) => this.active?.research?.candidate(id),
        researchSourceName: (id) =>
          setup.research?.status === "ready"
            ? setup.research.policy.sources.find((source) => source.id === id)?.name
            : undefined,
        researchCandidates: setup.execution.budget.researchCandidates,
        qa: qa !== null,
        mode: run.mode,
        intent: run.intent,
        planProposal: this.planProposalOffered(run),
        storyOffer: run.storyOfferEligible,
        storyAction: run.storyAction,
        planClips: (plan) => this.active?.analysis?.planClips(plan),
      };
      const session = await this.agentSession(run.chatId, "director", availability);
      if (run.finalizing) return;
      run.session = session;
      const orchestrator = new Orchestrator({
        chats: this.chats,
        chatId: run.chatId,
        turn: run.turn,
        directorMessageId: run.assistantMessage.id,
        setup,
        signal,
        now: this.now,
        ids: this.ids,
        timers: this.timers,
        ...(this.stopGraceMs !== undefined && { stopGraceMs: this.stopGraceMs }),
        specialistSession: (agent) => this.agentSession(run.chatId, agent, availability),
        jevSession: () => this.jevSession(run.chatId, setup),
        closeSpecialist: (agent) => this.sessionManager.disposeAgent(run.chatId, agent),
      });
      run.orchestrator = orchestrator;
      const activeWriter = new TurnEventWriter({
        chats: this.chats,
        chatId: run.chatId,
        messageId: run.assistantMessage.id,
        turn: run.turn,
        now: this.now,
        ids: this.ids,
        timers: this.timers,
        onModel: (event) => {
          run.turn.model = event.model;
          run.turn.thinking = event.thinking;
        },
      });
      writer = activeWriter;
      const promptDirector = (text: string) =>
        session.prompt({
          text,
          model: run.turn.model,
          thinking: run.turn.thinking,
          signal,
          onEvent: (event) => activeWriter.accept(event),
        });
      /** A Director prompt after the first: the reply starts a new part of the same message. */
      const promptAgain = async (text: string): Promise<BackendPromptOutcome> => {
        run.directorIdle = false;
        activeWriter.startPrompt();
        const outcome = await promptDirector(text);
        run.directorIdle = true;
        return outcome;
      };
      /**
       * The Director must hear back from every run it started, and from steering sent while it was idle: while either
       * is pending it is re-prompted (a bounded number of times) until it finishes with a reply.
       */
      const settleDirector = async (
        first: BackendPromptOutcome,
        beforeQa = false,
      ): Promise<BackendPromptOutcome> => {
        let outcome = first;
        let followUps = 0;
        while (
          outcome === "completed" &&
          !run.forcedError &&
          !signal.aborted &&
          followUps < MAX_FOLLOW_UPS &&
          (run.pendingSteering.length > 0 || orchestrator.hasUnreported())
        ) {
          const results =
            run.pendingSteering.length > 0 ? "" : await orchestrator.collectUnreported(signal);
          if (signal.aborted) break;
          const steering = run.pendingSteering.splice(0);
          if (steering.length === 0) followUps += 1;
          const blocks = [
            results &&
              `<delegated-results>\n${results}\n</delegated-results>\nThese delegated runs reported after your last reply.`,
            ...steering.map((text) => `<user-steering>\n${text}\n</user-steering>`),
            "Continue: adjust the plan and delegated work if needed, wait for any runs still working, then finish the user's request with a short reply.",
            beforeQa && renderInterimInstruction(),
          ].filter(Boolean);
          outcome = await promptAgain(blocks.join("\n\n"));
        }
        return outcome;
      };
      const intentBlock = renderIntentBlock(run.intent);
      // An execute turn carries the approved steps; a turn that may propose carries when to propose. Never both.
      const planBlocks = run.executePlan
        ? `\n\n${renderExecutePlanBlock(run.executePlan.steps)}`
        : this.planProposalOffered(run)
          ? `\n\n${renderPlanApprovalBlock(run.planApproval)}`
          : "";
      // The frame format is still open (the project was started with it on Auto): every turn of that chat carries a
      // canvas instruction until a successful edit sets it — a turn that acts sets it, an Ask turn states the choice.
      const canvasAuto =
        input.canvas === "auto" || (this.chats.get(run.chatId)?.chat.canvasAuto ?? false);
      const canvasBlock = canvasAuto
        ? `\n\n${run.intent === "edit" ? renderCanvasAutoBlock() : renderCanvasAutoPlanBlock()}`
        : "";
      const storyBlocks =
        run.mode === "story" && run.story
          ? `\n\n${renderStoryBlocks(await this.storyBlockInput(run, setup, run.story))}`
          : "";
      // The turn may offer Story Mode (the tool is there): its block says when that is what the user's request is,
      // and takes precedence over the plan-approval block. A chat that already declined one is told so in words.
      const offerBlocks = run.storyOfferEligible ? `\n\n${renderStoryOfferBlock()}` : "";
      const chatState = this.chats.get(run.chatId);
      const declinedBlocks =
        chatState?.chat.storyDeclined === true && run.mode === "normal"
          ? `\n\n${renderStoryDeclinedBlock()}`
          : "";
      // Earlier turns the user reverted since the Director's session last saw this chat: their edits are gone.
      const revertedBlock = chatState
        ? renderRevertedTurns(
            revertedSinceLastPrompt(chatState.turns, chatState.messages, run.turn.id),
            this.now(),
          )
        : "";
      const revertedBlocks = revertedBlock ? `\n\n${revertedBlock}` : "";
      // Render QA will apply to this turn (it runs only if the project changed): every Director reply before it is interim.
      const qaWillApply =
        run.intent === "edit" &&
        qa !== null &&
        editingHost !== null &&
        setup.execution.budget.qaPasses > 0 &&
        qaApplies(run.mode, run.storyAction);
      const promptPromise = promptDirector(
        `${renderTeam(setup)}\n\n${renderPromptContext(input.prompt, input.editorContext, input.references, input.userLanguage)}${intentBlock ? `\n\n${intentBlock}` : ""}${planBlocks}${offerBlocks}${declinedBlocks}${canvasBlock}${storyBlocks}${revertedBlocks}${qaWillApply ? `\n\n${renderInterimInstruction()}` : ""}`,
      );
      run.markPromptStarted();
      let outcome = await promptPromise;
      run.directorIdle = true;
      outcome = await settleDirector(outcome, qaWillApply);

      // The Director's work is done: render QA renders, checks and (while passes are left) has the Director correct.
      if (
        run.intent === "edit" &&
        qa &&
        editingHost &&
        outcome === "completed" &&
        !run.forcedError &&
        !signal.aborted
      ) {
        outcome = await new QaLoop({
          chats: this.chats,
          chatId: run.chatId,
          turn: run.turn,
          qa,
          editing: editingHost,
          renders: {
            asked: () => run.editing?.userAskedForRender() ?? false,
            last: () => run.editing?.lastRender() ?? null,
          },
          orchestrator,
          setup,
          mode: run.mode,
          action: run.storyAction,
          startFingerprint,
          instructed: qaWillApply,
          director: {
            prompt: promptAgain,
            settle: (after) => settleDirector(after),
            markInterim: () => activeWriter.markTextInterim(),
            takeSteering: () => run.pendingSteering.splice(0),
            setPhase: (phase) => {
              run.qaPhase = phase;
            },
          },
          signal,
          now: this.now,
        }).run(outcome);
      }

      if (run.forcedError) {
        await activeWriter.finish("failed");
        await this.finalize(run, "failed", run.forcedError);
      } else if (outcome === "aborted" || signal.aborted) {
        await activeWriter.finish("aborted");
        await this.finalize(run, "aborted");
      } else {
        await activeWriter.finish("complete");
        await this.finalize(run, "completed");
      }
    } catch (error) {
      run.markPromptStarted();
      await writer?.finish("failed").catch(() => undefined);
      if (run.controller.signal.aborted && !run.forcedError) await this.finalize(run, "aborted");
      else await this.finalize(run, "failed", run.forcedError ?? error);
    }
  }

  /** Resolves the Director's model and the team for a new turn. Never throws: missing data means defaults. */
  private async prepareTurn(
    chat: ChatSummary,
    input: StartTurnRequest,
  ): Promise<{
    setup: TurnAgentSetup;
    model: TurnSummary["model"];
    thinking: TurnSummary["thinking"];
  }> {
    const settings = await this.settings.get();
    const jevApiKey = await this.settings.jevApiKey();
    let catalog: AgentModelCatalog = { models: [], defaultModel: null, defaultThinking: null };
    try {
      catalog = await this.backend.listModels();
    } catch {
      // No catalog: routing to other models and provider-login Jev are unavailable this turn; defaults still run.
    }
    return {
      setup: resolveTurnSetup({
        qaAvailable: this.qaFactory !== undefined && this.editingFactory !== undefined,
        chat,
        settings,
        jevApiKey,
        catalog,
        ...(input.editorContext && { editorContext: input.editorContext }),
        ...(input.userLanguage && { userLanguage: input.userLanguage }),
      }),
      model: chat.mainAgentModel ?? settings.director.model,
      thinking: chat.thinking ?? settings.director.thinking,
    };
  }

  /** What the story-mode blocks of the turn's prompt are made from. */
  private async storyBlockInput(run: ActiveRun, setup: TurnAgentSetup, story: TurnStory) {
    const snapshot = await story.snapshot(run.controller.signal);
    return {
      action: run.storyAction,
      editorEnabled: setup.enabled.includes("editor"),
      storyOptions: run.storyOptions,
      graph: snapshot.graph,
      view: snapshot.view,
      researchReady:
        run.research !== null &&
        setup.research?.status === "ready" &&
        setup.enabled.includes("research"),
    };
  }

  /** The model the Research run uses now (`provider/modelId`), recorded in the provenance of what it imports. */
  /**
   * Everything the user wrote in the chat (first prompts and steering of every turn): the links they sent. With a
   * `turnId`, only what they wrote in that turn (its prompt and steering).
   */
  private userTexts(chatId: string, turnId?: string): string[] {
    const messages = this.chats.get(chatId)?.messages ?? [];
    return messages.flatMap((message) =>
      message.role === "user" && (turnId === undefined || message.turnId === turnId)
        ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    );
  }

  private researchModel(run: ActiveRun, setup: TurnAgentSetup): string | null {
    const running = run.orchestrator?.modelOf("research");
    if (running) return running;
    const configured = setup.specialists.research.model;
    return configured ? `${configured.provider}/${configured.modelId}` : null;
  }

  /** The chat's resumable session for the Director or a specialist, with the tools this turn allows it. */
  private agentSession(
    chatId: string,
    agent: "director" | SpecialistId,
    availability: ToolAvailability,
  ): Promise<BackendSession> {
    const hostTools = buildHostTools(agent, availability, (name, args, signal, progress) =>
      this.dispatchTool(chatId, agent, name, args, signal, progress),
    );
    const instructions =
      agent === "director" ? directorInstructions() : specialistInstructions(agent);
    return this.sessionManager.get({
      chatId,
      agent,
      signature: JSON.stringify([
        instructions,
        hostTools.map((tool) => [tool.name, tool.description, tool.parameters]),
      ]),
      open: async () => ({
        chatId,
        agent,
        projectDir: this.chats.scope.projectDir,
        stateDir:
          agent === "director"
            ? await this.store.stateDir(chatId)
            : await this.store.agentStateDir(chatId, agent),
        instructions,
        hostTools,
        fileWriteRefusal: (toolName: string) => this.fileWriteRefusal(chatId, toolName),
        askBeforeLockedEdits: () => this.askBeforeLockedEdits(chatId),
      }),
    });
  }

  private jevSession(chatId: string, setup: TurnAgentSetup): Promise<BackendSession> {
    const credentials = setup.jev?.credentials;
    return this.backend.openSession({
      chatId,
      agent: "jev",
      projectDir: this.chats.scope.projectDir,
      stateDir: null,
      instructions: jevInstructions(),
      hostTools: [],
      fileWriteRefusal: (toolName: string) => this.fileWriteRefusal(chatId, toolName),
      askBeforeLockedEdits: () => this.askBeforeLockedEdits(chatId),
      ...(credentials && { credentials }),
    });
  }

  /**
   * Host tools are bound to a session for many turns; each call goes to the orchestrator of the running turn. A
   * refusal the editing or story service made because of a lock or a user decision carries the user's instruction for
   * such items (stop and ask, or leave it and report; see autonomy.ts).
   */
  private async dispatchTool(
    chatId: string,
    caller: AgentId,
    name: string,
    args: unknown,
    signal: AbortSignal,
    progress?: (percent: number) => void,
  ): Promise<HostToolResult> {
    const result = await this.dispatchToolCall(chatId, caller, name, args, signal, progress);
    if (!result.isError || !isLockRefusal(result.text)) return result;
    return {
      ...result,
      text: `${result.text}\n\n${lockedEditAdvice(this.askBeforeLockedEdits(chatId))}`,
    };
  }

  private async dispatchToolCall(
    chatId: string,
    caller: AgentId,
    name: string,
    args: unknown,
    signal: AbortSignal,
    progress?: (percent: number) => void,
  ): Promise<HostToolResult> {
    const run = this.active;
    if (!run || run.chatId !== chatId || run.finalizing)
      return { text: "There is no running turn for this tool call.", isError: true };
    const refusal =
      qaPhaseRefusal(run.qaPhase, name) ??
      intentRefusal(run.intent, name, this.planProposed(run), run.storyOffer !== null);
    if (refusal) return { text: refusal, isError: true };
    // A reused session keeps its old tool list: propose_plan is refused unless this turn actually offers it.
    if (
      name === TOOL_NAMES.propose &&
      (caller !== "director" || !this.planProposalOffered(run) || run.storyOffer !== null)
    )
      return {
        text: "Proposing a plan is not available in this turn: do the work, or finish with your reply.",
        isError: true,
      };
    if (name === TOOL_NAMES.offerStory) {
      if (caller !== "director" || !run.storyOfferEligible)
        return {
          text: "Offering Story Mode is not available in this turn: do the work, or finish with your reply.",
          isError: true,
        };
      if (run.storyOffer)
        return {
          text: "Story Mode is already offered in this turn: end it with a short reply about the offer.",
          isError: true,
        };
      const parsed = parseStoryOfferArgs(args);
      if (!parsed.ok) return { text: parsed.message, isError: true };
      const offer: StoryOffer = {
        id: this.ids(),
        chapters: parsed.value.chapters,
        state: "pending",
        requestedAt: this.now(),
      };
      run.storyOffer = offer;
      await this.chats.emit(chatId, {
        type: "storyOffer.updated",
        messageId: run.assistantMessage.id,
        offer,
      });
      return {
        text: `The Story Mode offer with ${offer.chapters.length} chapters is on screen: the user can open the Story workspace or decline (labelled in the user's language; do not quote button names). Every project-changing tool is refused for the rest of this turn — write one or two sentences about what the story would do with these chapters, in the user's language, and end the turn.`,
      };
    }
    if (isQaToolName(name)) {
      if (!run.qa) return { text: "Render QA is not available in this runtime.", isError: true };
      return run.qa.execute(caller, name, args, signal);
    }
    if (isResearchToolName(name)) {
      if (!run.research)
        return { text: "Research is not available in this runtime.", isError: true };
      return run.research.execute(caller, name, args, signal);
    }
    if (isStoryToolName(name)) {
      if (!run.story)
        return { text: "Story Mode is not available in this runtime.", isError: true };
      const allowed = storyToolsFor(caller, run.setup?.enabled ?? [], {
        mode: run.mode,
        action: run.storyAction,
      });
      if (!allowed.some((tool) => tool === name))
        return { text: `${name} is not available to you in this turn.`, isError: true };
      return run.story.execute(name, args, signal);
    }
    if (!timelineWritesAllowed({ mode: run.mode, action: run.storyAction }) && writesTimeline(name))
      return { text: STORY_TURN_TIMELINE_REFUSAL, isError: true };
    if (isEditingToolName(name)) {
      if (!run.editing) return { text: "Editing is not available in this runtime.", isError: true };
      return run.editing.execute(name, args, signal, progress);
    }
    if (isAnalysisToolName(name)) {
      if (!run.analysis)
        return { text: "Analysis is not available in this runtime.", isError: true };
      return run.analysis.execute(name, args, signal);
    }
    if (!run.orchestrator)
      return { text: "There is no running turn for this tool call.", isError: true };
    return run.orchestrator.execute(caller, name, args, signal);
  }

  private async finalize(
    run: ActiveRun,
    status: TurnSummary["status"],
    error?: unknown,
  ): Promise<void> {
    if (run.finalizing) return;
    run.finalizing = true;
    // A call waiting on the user's permission answer must return before anything awaits the run: the pending
    // requests become expired (their parts update) and the turn's one-time grant is revoked.
    await run.permissions?.expireAll().catch(() => undefined);
    await run.permissions?.revokeGrant().catch(() => undefined);
    // Every delegated run must be over before the checkpoint closes, or its later writes would escape Revert.
    await run.orchestrator?.shutdown(status === "completed").catch(() => undefined);
    // Render QA's checks, frame extractions and report writes end here too (the QA loop itself has already returned).
    await run.qa?.shutdown().catch(() => undefined);
    // Editing calls still running (or a render) end here too: no editing write may land after the checkpoint closes.
    // Analysis jobs are cancelled and a rough cut already sent to the editing service is awaited for the same reason;
    // a story edit or build already sent to the story service is awaited too (it is atomic there).
    const research = await run.research?.shutdown().catch(() => null);
    await run.story?.shutdown().catch(() => undefined);
    await run.analysis?.shutdown().catch(() => undefined);
    await run.editing?.shutdown().catch(() => undefined);
    if (run.heartbeat) this.timers.clearTimeout(run.heartbeat);
    const createdAt = run.turn.checkpoint?.createdAt ?? run.turn.startedAt;
    const closedAt = this.now();
    let checkpoint: TurnCheckpoint = { status: "ready", entryIds: [], createdAt, closedAt };
    if (run.checkpoint) {
      try {
        const entryIds = await run.checkpoint.end();
        checkpoint = { ...checkpoint, entryIds, ...(await this.checkpointFiles(entryIds)) };
      } catch {
        // Studio could not be reached (shutting down, restarting). The transaction is not lost: it stays "active"
        // with its id, and recoverCheckpoints() closes it and collects its entries on the next turn or project load.
        checkpoint = {
          status: "active",
          entryIds: [],
          createdAt,
          transactionId: run.checkpoint.transactionId,
        };
      }
    }
    run.turn.checkpoint = checkpoint;
    run.turn.status = status;
    run.turn.endedAt = closedAt;
    if (status === "failed") {
      run.turn.error = {
        code: "agent_failed",
        message: errorMessage(error, "The agent failed to complete this turn"),
      };
    }
    // A cancelled import Studio never settled may still write after this checkpoint closed: the user must hear it.
    const unsettled = research?.unsettledWrites ?? [];
    if (unsettled.length > 0) {
      await this.bestEffort(() =>
        this.chats.emit(run.chatId, {
          type: "assistant.text.delta",
          messageId: run.assistantMessage.id,
          partId: this.ids(),
          delta: `\n\nNote: Studio did not confirm whether ${unsettled.length === 1 ? "an asset import or website save" : `${unsettled.length} asset imports or website saves`} stopped with this turn wrote anything (${unsettled.join(", ")}). A file that still appears in assets/research or assets/web is not part of this turn's checkpoint; check the Sources panel.`,
        }),
      );
    }
    const assistantStatus: AssistantMessageStatus =
      status === "completed" ? "complete" : status === "failed" ? "failed" : "aborted";
    await this.bestEffort(() =>
      this.chats.emit(run.chatId, {
        type: "message.completed",
        messageId: run.assistantMessage.id,
        status: assistantStatus,
      }),
    );
    await this.bestEffort(() =>
      this.chats.emit(run.chatId, {
        type: "checkpoint.updated",
        turnId: run.turn.id,
        checkpoint,
      }),
    );
    const chatStatus: ChatSummary["status"] =
      status === "completed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : status === "interrupted"
            ? "interrupted"
            : "idle";
    await this.bestEffort(() =>
      this.chats.markStatus(run.chatId, chatStatus).then(() => undefined),
    );
    if (status === "failed") {
      await this.bestEffort(() =>
        this.chats.emit(run.chatId, {
          type: "turn.failed",
          turn: run.turn,
          error: run.turn.error ?? {
            code: "agent_failed",
            message: "The agent failed to complete this turn",
          },
        }),
      );
    } else if (status === "completed") {
      await this.bestEffort(() =>
        this.chats.emit(run.chatId, { type: "turn.completed", turn: run.turn }),
      );
    } else {
      await this.bestEffort(() =>
        this.chats.emit(run.chatId, { type: "turn.aborted", turn: run.turn }),
      );
    }
    this.sessionManager.scheduleDisposal(run.chatId);
    if (this.active === run) {
      this.chats.publishProject({ type: "project.activeTurn", activeTurn: null });
      this.active = null;
    }
  }

  private info(run: ActiveRun): ActiveTurnInfo {
    return { chatId: run.chatId, turnId: run.turn.id, startedAt: run.turn.startedAt };
  }

  private async bestEffort(operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch {}
  }
}
