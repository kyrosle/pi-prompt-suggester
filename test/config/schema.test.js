import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeOverrideConfig, validateConfig } from "../../dist/config/schema.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultConfig = JSON.parse(
	await readFile(path.join(repoRoot, "config", "prompt-suggester.config.json"), "utf8"),
);

test("validateConfig accepts shipped defaults", () => {
	assert.equal(validateConfig(defaultConfig), true);
});

test("config normalization preserves max thinking for both helper models", () => {
	const override = {
		schemaVersion: defaultConfig.schemaVersion,
		inference: {
			seederThinking: "max",
			suggesterThinking: "max",
		},
	};
	assert.deepEqual(normalizeOverrideConfig(override, defaultConfig), { config: override, changed: false });
	assert.equal(validateConfig({
		...defaultConfig,
		inference: { ...defaultConfig.inference, ...override.inference },
	}), true);
});

test("validateConfig rejects unknown keys and invalid values", () => {
	assert.equal(validateConfig({ ...defaultConfig, extra: true }), false);
	assert.equal(
		validateConfig({
			...defaultConfig,
			suggestion: { ...defaultConfig.suggestion, maxSuggestionChars: 0 },
		}),
		false,
	);
	assert.equal(
		validateConfig({
			...defaultConfig,
			suggestion: { ...defaultConfig.suggestion, ghostAcceptKeys: [] },
		}),
		false,
	);
	assert.equal(
		validateConfig({
			...defaultConfig,
			suggestion: { ...defaultConfig.suggestion, ghostAcceptKeys: ["space", "tab"] },
		}),
		false,
	);
});

test("validateConfig accepts supported ghost accept key combinations", () => {
	assert.equal(
		validateConfig({
			...defaultConfig,
			suggestion: { ...defaultConfig.suggestion, ghostAcceptKeys: ["space"] },
		}),
		true,
	);
	assert.equal(
		validateConfig({
			...defaultConfig,
			suggestion: { ...defaultConfig.suggestion, ghostAcceptKeys: ["right"] },
		}),
		true,
	);
	assert.equal(
		validateConfig({
			...defaultConfig,
			suggestion: { ...defaultConfig.suggestion, ghostAcceptKeys: ["space", "right"] },
		}),
		true,
	);
});

test("normalizeOverrideConfig drops invalid fields and preserves valid overrides", () => {
	const { config, changed } = normalizeOverrideConfig(
		{
			schemaVersion: defaultConfig.schemaVersion,
			suggestion: {
				maxSuggestionChars: 333,
				ghostAcceptKeys: ["space", "right"],
				maxRecentUserPrompts: -5,
				unknown: true,
			},
			logging: "bad",
			extra: 1,
		},
		defaultConfig,
	);

	assert.equal(changed, true);
	assert.deepEqual(config, {
		schemaVersion: defaultConfig.schemaVersion,
		suggestion: {
			ghostAcceptKeys: ["space", "right"],
			maxSuggestionChars: 333,
		},
	});
});

test("normalizeOverrideConfig drops invalid ghost accept key overrides", () => {
	const { config, changed } = normalizeOverrideConfig(
		{
			schemaVersion: defaultConfig.schemaVersion,
			suggestion: {
				ghostAcceptKeys: ["space", "space"],
			},
		},
		defaultConfig,
	);

	assert.equal(changed, true);
	assert.deepEqual(config, {
		schemaVersion: defaultConfig.schemaVersion,
	});
});
