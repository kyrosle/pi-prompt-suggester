import test from "node:test";
import assert from "node:assert/strict";
import { PiModelClient } from "../../../dist/infra/model/pi-model-client.js";

const activeModel = { api: "openai-completions", provider: "openai", id: "model-1" };
const seedInput = { reseedTrigger: { reason: "manual", changedFiles: [] }, previousSeed: null };

function createClient(responses, { models = [activeModel], logger } = {}) {
	const calls = [];
	const client = new PiModelClient({
		getContext() {
			return {
				model: activeModel,
				sessionManager: { getSessionId: () => "pi-session" },
				modelRegistry: {
					getAll: () => models,
					streamSimple(model, context, options) {
						const response = responses[calls.length];
						assert.ok(response, "Unexpected model request");
						calls.push({ model, context, options });
						return { result: async () => response };
					},
				},
			};
		},
	}, logger);
	return { client, calls };
}

function suggestionContext() {
	return {
		latestAssistantTurn: "I can do that.",
		turnStatus: "success",
		intentSeed: null,
		recentUserPrompts: ["Fix the tests"],
		toolSignals: [],
		touchedFiles: [],
		unresolvedQuestions: [],
		recentChanged: [],
		customInstruction: "",
		noSuggestionToken: "[no suggestion]",
		maxSuggestionChars: 200,
	};
}

function reply(text) {
	return {
		stopReason: "stop",
		content: [{ type: "text", text }],
		usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: { total: 0.01 } },
	};
}

test("PiModelClient uses the session registry for the configured provider and reasoning", async () => {
	const configured = { api: "test-extension-api", provider: "extension-provider", id: "model-1" };
	const { client, calls } = createClient([reply("Run the tests.")], { models: [activeModel, configured] });

	const result = await client.generateSuggestion(suggestionContext(), {
		modelRef: "extension-provider/model-1",
		thinkingLevel: "low",
	});

	assert.equal(calls.length, 1);
	assert.equal(calls[0].model, configured);
	assert.equal(calls[0].options.reasoning, "low");
	assert.equal(calls[0].context.messages[0].role, "user");
	assert.match(calls[0].context.messages[0].content[0].text, /Fix the tests/);
	assert.deepEqual(result, {
		text: "Run the tests.",
		usage: {
			inputTokens: 2,
			outputTokens: 3,
			cacheReadTokens: 4,
			cacheWriteTokens: 5,
			totalTokens: 14,
			costTotal: 0.01,
		},
	});
});

test("PiModelClient keeps separate stable session IDs for seed and compact suggestion requests", async () => {
	const seedReply = reply(JSON.stringify({
		type: "final",
		seed: {
			projectIntentSummary: "Keep tests reliable.",
			objectivesSummary: "Cover the model client.",
			constraintsSummary: "Use no network.",
			principlesGuidelinesSummary: "Use deterministic fixtures.",
			implementationStatusSummary: "The client has regression tests.",
			keyFiles: [{ path: "README.md" }],
			categoryFindings: {
				vision: { found: false, rationale: "No separate vision file." },
				architecture: { found: false, rationale: "No separate architecture file." },
				principles_guidelines: { found: false, rationale: "No separate guidelines file." },
			},
		},
	}));
	const { client, calls } = createClient([reply("Run the tests."), seedReply, reply("Review the output."), seedReply]);

	await client.generateSuggestion(suggestionContext());
	await client.generateSeed(seedInput);
	await client.generateSuggestion(suggestionContext());
	await client.generateSeed(seedInput);

	assert.equal(calls.length, 4);
	assert.ok(calls.every(({ model }) => model === activeModel));
	const [suggestionId, seedId, nextSuggestionId, nextSeedId] = calls.map(({ options }) => options.sessionId);
	assert.ok(suggestionId);
	assert.ok(seedId);
	assert.notEqual(suggestionId, "pi-session");
	assert.notEqual(seedId, "pi-session");
	assert.notEqual(suggestionId, seedId);
	assert.equal(nextSuggestionId, suggestionId);
	assert.equal(nextSeedId, seedId);
});

test("PiModelClient preserves the transcript session ID and messages", async () => {
	const { client, calls } = createClient([reply("Review the result.")]);
	const original = { role: "user", content: "Run the tests", timestamp: 1 };

	await client.generateSuggestion({
		...suggestionContext(),
		systemPrompt: "Original system prompt.",
		sessionId: "transcript-session",
		transcriptMessages: [original],
		transcriptMessageCount: 1,
	});

	assert.equal(calls.length, 1);
	assert.equal(calls[0].options.sessionId, "transcript-session");
	assert.equal(calls[0].context.systemPrompt, "Original system prompt.");
	assert.equal(calls[0].context.messages[0], original);
	assert.equal(calls[0].context.messages.length, 2);
});

test("PiModelClient rejects provider errors instead of returning an empty suggestion or seed", async () => {
	const failed = { stopReason: "error", errorMessage: "400 MissingSessionID", content: [] };
	const model = { api: "openai-completions", provider: "opencode-go", id: "deepseek-v4.1-flash" };
	const settings = { modelRef: "opencode-go/deepseek-v4.1-flash" };
	const errors = [];
	const { client, calls } = createClient([failed, failed], {
		models: [activeModel, model],
		logger: {
			debug() {},
			info() {},
			warn() {},
			error(event, fields) {
				errors.push({ event, ...fields });
			},
		},
	});

	await assert.rejects(() => client.generateSuggestion(suggestionContext(), settings), /400 MissingSessionID/);
	await assert.rejects(() => client.generateSeed({ ...seedInput, settings }), /400 MissingSessionID/);
	assert.equal(calls.length, 2);
	assert.deepEqual(
		errors,
		["suggestion", "seed"].map((kind) => ({
			event: "model.request.failed",
			kind,
			provider: "opencode-go",
			model: "deepseek-v4.1-flash",
			error: "400 MissingSessionID",
		})),
	);
});

test("PiModelClient rejects aborted replies even when partial text was received", async () => {
	const aborted = { ...reply("Incomplete reply"), stopReason: "aborted", errorMessage: "Request aborted" };
	const { client } = createClient([aborted]);

	await assert.rejects(() => client.generateSuggestion(suggestionContext()), /aborted/i);
});

test("PiModelClient accepts a successful empty suggestion and rejects a successful empty seed", async () => {
	const empty = { ...reply("   "), usage: { input: 2, output: 0, totalTokens: 2 } };
	const { client } = createClient([empty, empty]);

	const result = await client.generateSuggestion(suggestionContext());
	assert.equal(result.text, "");
	assert.equal(result.usage?.totalTokens, 2);
	await assert.rejects(() => client.generateSeed(seedInput), /Model returned empty text/);
});
