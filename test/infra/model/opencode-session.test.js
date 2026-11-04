import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { PiModelClient } from "../../../dist/infra/model/pi-model-client.js";
import { ModelRuntime } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";

test("Pi dispatches OpenCode Go helper requests with separate session headers", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-suggester-opencode-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const requests = [];
	const modelId = "suggester-fixture";
	const server = createServer((request, response) => {
		requests.push({
			url: request.url,
			sessionId: request.headers["x-opencode-session"],
			auth: request.headers.authorization,
		});
		request.resume();
		if (!request.headers["x-opencode-session"] || requests.length === 2) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: requests.length === 2 ? "Fixture rejected seed" : "MissingSessionID" } }));
			return;
		}
		const chunk = (delta, finish_reason) => `data: ${JSON.stringify({
			id: "fixture",
			object: "chat.completion.chunk",
			model: modelId,
			choices: [{ index: 0, delta, finish_reason }],
		})}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(chunk({ role: "assistant", content: "Run the isolated test." }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const registry = new ModelRegistry(runtime);
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	registry.registerProvider("opencode-go", {
		api: "openai-completions",
		apiKey: "fixture-key",
		baseUrl,
		models: [{
			id: modelId,
			name: modelId,
			baseUrl,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: false,
			contextWindow: 16000,
			maxTokens: 1024,
		}],
	});
	const model = registry.find("opencode-go", modelId);
	assert.ok(model);
	const client = new PiModelClient({
		getContext: () => ({ model, modelRegistry: registry, sessionManager: { getSessionId: () => "fixture-session" } }),
	});
	const result = await client.generateSuggestion({
		latestAssistantTurn: "The fixture is ready.",
		turnStatus: "success",
		intentSeed: null,
		recentUserPrompts: [],
		toolSignals: [],
		touchedFiles: [],
		unresolvedQuestions: [],
		recentChanged: [],
		customInstruction: "",
		noSuggestionToken: "[no suggestion]",
		maxSuggestionChars: 200,
	});
	assert.equal(result.text, "Run the isolated test.");
	await assert.rejects(
		() => client.generateSeed({ reseedTrigger: { reason: "manual", changedFiles: [] }, previousSeed: null }),
		/Fixture rejected seed/,
	);
	assert.deepEqual(requests, [
		{ url: "/v1/chat/completions", sessionId: "suggester:suggestion:fixture-session", auth: "Bearer fixture-key" },
		{ url: "/v1/chat/completions", sessionId: "suggester:seed:fixture-session", auth: "Bearer fixture-key" },
	]);
});
