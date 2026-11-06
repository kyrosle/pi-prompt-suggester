import assert from "node:assert/strict";
import test from "node:test";
import { PiExtensionAdapter } from "../../../dist/infra/pi/extension-adapter.js";

test("plugin entrypoints report failures without rejecting Pi events or stopping user input", async () => {
	const events = new Map();
	const commands = new Map();
	const reported = [];
	const failure = new Error("429: upstream overloaded\nprivate fixture detail");
	const fail = async () => { throw failure; };
	const wiring = {
		onSessionStart: fail,
		onSessionShutdown: fail,
		onAgentEnd: fail,
		onUserSubmit: fail,
		onReseedCommand: fail,
		onStatusCommand: fail,
		onModelCommand: fail,
		onThinkingCommand: fail,
		onConfigCommand: fail,
		onInstructionCommand: fail,
		onVariantCommand: fail,
		onAbCommand: fail,
		onSettingsUiCommand: fail,
		onSeedTraceCommand: fail,
	};
	const ctx = {
		sessionManager: { getBranch: () => [], getLeafId: () => "leaf" },
		ui: { notify: () => assert.fail("Failure must not become a chat notification") },
	};
	const adapter = new PiExtensionAdapter({
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
	}, wiring, async (error, context) => { reported.push({ error, context }); });
	adapter.register();

	for (const name of ["session_start", "session_tree", "session_shutdown", "agent_end"]) {
		await events.get(name)({ messages: [] }, ctx);
	}
	assert.deepEqual(await events.get("input")({ text: "continue" }, ctx), { action: "continue" });
	for (const command of ["status", "reseed", "model", "thinking", "config", "instruction", "variant", "ab", "seed-trace"]) {
		await commands.get("suggester").handler(command, ctx);
	}
	await commands.get("suggesterSettings").handler("", ctx);
	assert.equal(reported.length, 15);
	assert.ok(reported.every(({ error, context }) => error === failure && context === ctx));

	wiring.onAgentEnd = async () => {};
	await events.get("agent_end")({ messages: [] }, ctx);
	assert.equal(reported.length, 15);
	wiring.onSessionStart = async () => { throw new Error("This extension ctx is stale after session replacement or reload."); };
	await events.get("session_start")({}, ctx);
	assert.equal(reported.length, 15);
});
