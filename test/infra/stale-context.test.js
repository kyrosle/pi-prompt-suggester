import test from "node:test";
import assert from "node:assert/strict";
import { ConsoleLogger } from "../../dist/infra/logging/console-logger.js";
import { refreshSuggesterUi } from "../../dist/infra/pi/ui-adapter.js";

function createStaleContext() {
	return {
		get hasUI() {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	};
}

function createStaleUiContext() {
	return {
		hasUI: true,
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
			setWidget: () => {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
		},
	};
}

function createUiRuntime(ctx) {
	return {
		getContext: () => ctx,
		suggestionDisplayMode: "panel",
		showPanelStatus: true,
		showUsageInPanel: true,
		getSuggestion: () => undefined,
		getPanelSuggestionStatus: () => undefined,
		getPanelUsageStatus: () => undefined,
		getPanelLogStatus: () => undefined,
	};
}

test("refreshSuggesterUi ignores stale Pi contexts during session teardown", () => {
	assert.doesNotThrow(
		() => refreshSuggesterUi(createUiRuntime(createStaleContext())),
		/stale after session replacement/,
	);
});

test("refreshSuggesterUi ignores stale Pi UI writes during session teardown", () => {
	assert.doesNotThrow(
		() => refreshSuggesterUi(createUiRuntime(createStaleUiContext())),
		/stale after session replacement/,
	);
});

test("ConsoleLogger ignores stale widget status updates during session teardown", () => {
	const logger = new ConsoleLogger("debug", {
		getContext: () => createStaleContext(),
		mirrorToConsoleWhenNoUi: false,
		setWidgetLogStatus: () => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	});

	assert.doesNotThrow(
		() => logger.error("reseed.failed", { reason: "session-start" }),
		/stale after session replacement/,
	);
});

test("ConsoleLogger ignores stale footer status writes during session teardown", () => {
	const logger = new ConsoleLogger("debug", {
		getContext: () => createStaleUiContext(),
		mirrorToConsoleWhenNoUi: false,
	});

	assert.doesNotThrow(
		() => logger.error("reseed.failed", { reason: "session-start" }),
		/stale after session replacement/,
	);
});

test("ConsoleLogger keeps error details in the log and renders only a sanitized first line", () => {
	const events = [];
	let status;
	const error = "429: \u001b[31mupstream overloaded\u001b[0m\nprivate detail\n    at fixture.js:12";
	const logger = new ConsoleLogger("info", {
		mirrorToConsoleWhenNoUi: false,
		eventLog: { append: async (entry) => { events.push(entry); } },
		setWidgetLogStatus: (value) => { status = value; },
	});
	logger.error("operation.failed", { error, stack: "Full fixture stack" });
	assert.deepEqual(status, { level: "error", text: "[suggester error] operation.failed · 429: upstream overloaded" });
	assert.equal(events[0].meta.error, error);
	assert.equal(events[0].meta.stack, "Full fixture stack");
});
