import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { createAppComposition, type AppComposition } from "./composition/root.js";
import { buildLatestHistoricalTurnContext, extractUserText } from "./app/services/conversation-signals.js";
import { toInvocationThinkingLevel } from "./config/inference.js";
import { PiExtensionAdapter } from "./infra/pi/extension-adapter.js";
import { GhostSuggestionEditor } from "./infra/pi/ghost-suggestion-editor.js";
import { getGhostEditorSyncAction, type GhostEditorInstallState } from "./infra/pi/ghost-editor-installation.js";
import {
	handleConfigCommand,
	handleInstructionCommand,
	handleModelCommand,
	handleSeedTraceCommand,
	handleSettingsUiCommand,
	handleThinkingCommand,
	handleVariantCommand,
	handleAbCommand,
	renderStatus,
} from "./infra/pi/command-handlers.js";
import { acceptWidgetSuggestion, refreshSuggesterUi } from "./infra/pi/ui-adapter.js";
import { createUiContext, type UiContextLike } from "./infra/pi/ui-context.js";
import type { DraftExpansion } from "./infra/pi/runtime-ref.js";

export default function suggester(pi: ExtensionAPI) {
	let compositionPromise: Promise<AppComposition> | undefined;
	let ghostEditorInstallState: GhostEditorInstallState | undefined;

	function syncGhostEditorInstallation(ctx: ExtensionContext, composition: AppComposition): void {
		if (!ctx.hasUI) return;
		const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		switch (getGhostEditorSyncAction({
			state: ghostEditorInstallState,
			context: ctx,
			displayMode: composition.config.suggestion.displayMode,
			sessionFile,
		})) {
			case "noop":
				return;
			case "uninstall":
				ctx.ui.setEditorComponent(undefined);
				ghostEditorInstallState = undefined;
				return;
			case "install":
				break;
		}

		ctx.ui.setEditorComponent((tui, theme, kb) =>
			new GhostSuggestionEditor(
				tui,
				theme,
				kb,
				() => composition.runtimeRef.getSuggestion(),
				() => composition.runtimeRef.getSuggestionRevision(),
				composition.config.suggestion.ghostAcceptKeys,
				() => composition.runtimeRef.getEditorHistoryState(),
				(state) => composition.runtimeRef.setEditorHistoryState(state),
			),
		);
		ghostEditorInstallState = { context: ctx, sessionFile };
	}

	async function getComposition(): Promise<AppComposition> {
		if (!compositionPromise) {
			compositionPromise = createAppComposition(pi).catch((error) => {
				compositionPromise = undefined;
				throw error;
			});
		}
		return await compositionPromise;
	}

	async function setRuntimeContext(ctx: ExtensionContext): Promise<AppComposition> {
		const composition = await getComposition();
		composition.runtimeRef.setContext(ctx);
		return composition;
	}

	function getUiContext(composition: AppComposition): UiContextLike {
		return createUiContext({
			runtimeRef: composition.runtimeRef,
			config: composition.config,
			variantStore: composition.stores.variantStore,
			getSessionThinkingLevel: () => pi.getThinkingLevel(),
		});
	}

	function syncSuggestionUi(ctx: ExtensionContext, composition: AppComposition): void {
		if (!ctx.hasUI) return;
		syncGhostEditorInstallation(ctx, composition);
		refreshSuggesterUi(getUiContext(composition));
	}

	pi.registerShortcut("f2", {
		description: "Accept prompt suggestion",
		handler: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			const result = acceptWidgetSuggestion(getUiContext(composition));
			if (result === "mismatch") {
				ctx.ui.notify("Current editor text no longer matches the suggestion.", "warning");
			}
		},
	});

	pi.registerShortcut("f3", {
		description: "Expand the current draft",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const draft = ctx.ui.getEditorText();
			if (!draft.trim()) {
				ctx.ui.notify("Type a draft before pressing F3.", "info");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait for Pi to finish before expanding the draft.", "info");
				return;
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const leafId = ctx.sessionManager.getLeafId();
			const composition = await getComposition();
			const { runtimeRef, stores } = composition;
			const isCurrentBranch = () => {
				const session = runtimeRef.getContext()?.sessionManager;
				return session?.getSessionId() === sessionId && session.getLeafId() === leafId;
			};
			if (!isCurrentBranch() || ctx.ui.getEditorText() !== draft || !ctx.isIdle() || ctx.hasPendingMessages()) return;
			const previous = runtimeRef.getDraftExpansion();
			if (previous?.draft === draft && previous.text === undefined) return;

			const recentConversation: { role: "user" | "assistant"; text: string }[] = [];
			const branch = ctx.sessionManager.getBranch();
			for (let index = branch.length - 1; index >= 0 && recentConversation.length < 4; index -= 1) {
				const entry = branch[index];
				if (entry.type !== "message") continue;
				const { message } = entry;
				if (message.role !== "user" && message.role !== "assistant") continue;
				const text = extractUserText(message).slice(0, 1500);
				if (text) recentConversation.unshift({ role: message.role, text });
			}
			const { inference } = stores.variantStore.getEffectiveConfig(composition.config);
			const expansion: DraftExpansion = { draft, controller: new AbortController() };
			runtimeRef.setDraftExpansion(expansion);
			const ui = getUiContext(composition);
			refreshSuggesterUi(ui);

			try {
				const result = await composition.modelClient.expandDraft(ctx, draft, recentConversation, {
					modelRef: inference.suggesterModel === "session-default" ? undefined : inference.suggesterModel,
					thinkingLevel: toInvocationThinkingLevel(inference.suggesterThinking),
				}, expansion.controller.signal);
				if (expansion.controller.signal.aborted || !isCurrentBranch()) return;
				if (result.usage) await stores.stateStore.recordUsage("suggester", result.usage);
				if (expansion.controller.signal.aborted || !isCurrentBranch()) return;
				if (ctx.ui.getEditorText() !== draft || !ctx.isIdle() || ctx.hasPendingMessages()) return;
				expansion.text = stripVTControlCharacters(result.text)
					.replace(/\r\n?/g, "\n")
					.replace(/\p{Cc}/gu, (char) => char === "\n" || char === "\t" ? char : "")
					.trim() || undefined;
				if (!expansion.text) ctx.ui.notify("The model returned an empty draft expansion.", "warning");
			} catch (error) {
				if (!expansion.controller.signal.aborted && isCurrentBranch() && ctx.ui.getEditorText() === draft) {
					const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error));
					ctx.ui.notify(`Draft expansion failed. ${message}`, "error");
				}
			} finally {
				if (runtimeRef.getDraftExpansion() === expansion) {
					if (!expansion.text) runtimeRef.setDraftExpansion(undefined);
					refreshSuggesterUi(ui);
				}
			}
		},
	});

	const adapter = new PiExtensionAdapter(pi, {
		onSessionStart: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			const generationId = composition.runtimeRef.bumpEpoch();
			syncSuggestionUi(ctx, composition);
			await composition.orchestrators.sessionStart.handle();

			const sourceLeafId = ctx.sessionManager.getLeafId() ?? `turn-${Date.now()}`;
			if (composition.runtimeRef.getLastBootstrappedLeafId() === sourceLeafId) return;

			const state = await composition.stores.stateStore.load();
			if (state.lastSuggestion?.turnId === sourceLeafId) {
				composition.runtimeRef.markBootstrappedLeafId(sourceLeafId);
				return;
			}

			const branchEntries = ctx.sessionManager
				.getBranch()
				.filter((entry): entry is ReturnType<typeof ctx.sessionManager.getBranch>[number] & { type: "message" } =>
					entry.type === "message"
				);
			const historicalTurn = buildLatestHistoricalTurnContext({ branchEntries });
			if (!historicalTurn) return;

			composition.runtimeRef.markBootstrappedLeafId(sourceLeafId);
			composition.runtimeRef.setLastTurnContext(historicalTurn);
			await composition.orchestrators.agentEnd.handle(historicalTurn, generationId);
		},
		onSessionShutdown: async (ctx) => {
			const composition = await getComposition();
			composition.orchestrators.reseedRunner.cancelPending();
			composition.runtimeRef.setDraftExpansion(undefined);
			composition.runtimeRef.clearContext(ctx);
		},
		onAgentEnd: async (turn, ctx) => {
			if (!turn) return;
			const composition = await setRuntimeContext(ctx);
			composition.runtimeRef.setLastTurnContext(turn);
			const generationId = composition.runtimeRef.bumpEpoch();
			syncSuggestionUi(ctx, composition);
			await composition.orchestrators.agentEnd.handle(turn, generationId);
		},
		onUserSubmit: async (event: InputEvent, ctx) => {
			const composition = await setRuntimeContext(ctx);
			composition.runtimeRef.bumpEpoch();
			syncSuggestionUi(ctx, composition);
			await composition.orchestrators.userSubmit.handle({
				turnId: ctx.sessionManager.getLeafId() ?? `input-${Date.now()}`,
				userPrompt: event.text,
				source: event.source,
			});
		},
		onReseedCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			await composition.orchestrators.reseedRunner.trigger({
				reason: "manual",
				changedFiles: [],
			});
			ctx.ui.notify("suggester reseed queued", "info");
		},
		onStatusCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			const [seed, state] = await Promise.all([
				composition.stores.seedStore.load(),
				composition.stores.stateStore.load(),
			]);
			const effectiveConfig = composition.stores.variantStore.getEffectiveConfig(composition.config);
			pi.sendMessage(
				{
					customType: "prompt-suggester-status",
					content: renderStatus(
						seed,
						state,
						effectiveConfig,
						ctx,
						composition.stores.variantStore.getActiveVariantName(),
						composition.paths.eventLogPath,
					),
					display: true,
				},
				{ triggerTurn: false },
			);
		},
		onModelCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleModelCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onThinkingCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleThinkingCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onConfigCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleConfigCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onInstructionCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleInstructionCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onVariantCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleVariantCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onAbCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleAbCommand(args, ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onSettingsUiCommand: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleSettingsUiCommand(ctx, composition);
			syncSuggestionUi(ctx, composition);
		},
		onSeedTraceCommand: async (args, ctx) => {
			const composition = await setRuntimeContext(ctx);
			await handleSeedTraceCommand(args, pi, composition);
			ctx.ui.notify("suggester seed trace sent to chat", "info");
		},
	});

	adapter.register();
}
