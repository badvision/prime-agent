import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendRetainEvent,
	getRetainEventsPath,
	loadRetainEvents,
	type RetainEvent,
} from "../../src/core/retained-tools/events.js";

describe("retain events log (SARK T07)", () => {
	let toolsDir: string;

	beforeEach(() => {
		toolsDir = mkdtempSync(join(tmpdir(), "prime-agent-retain-events-test-"));
	});

	afterEach(() => {
		rmSync(toolsDir, { recursive: true, force: true });
	});

	function event(overrides: Partial<RetainEvent> = {}): RetainEvent {
		return {
			id: "retain_20260101T000000000Z",
			at: "2026-01-01T00:00:00.000Z",
			action: "create",
			scope: "project",
			name: "deploy-staging-canary",
			path: ".prime/agent/skills/deploy-staging-canary",
			version: 1,
			created_by: "user",
			what: "deploy to staging with a canary",
			...overrides,
		};
	}

	it("getRetainEventsPath joins the tools dir with retain-events.jsonl", () => {
		expect(getRetainEventsPath(toolsDir)).toBe(join(toolsDir, "retain-events.jsonl"));
	});

	it("loadRetainEvents returns an empty array when the file does not exist", () => {
		expect(loadRetainEvents(toolsDir)).toEqual([]);
	});

	it("appendRetainEvent creates the tools dir and file, and round-trips one event", () => {
		const nestedToolsDir = join(toolsDir, "nested", "tools");
		const e = event();
		const path = appendRetainEvent(nestedToolsDir, e);
		expect(path).toBe(getRetainEventsPath(nestedToolsDir));
		expect(loadRetainEvents(nestedToolsDir)).toEqual([e]);
	});

	it("appends multiple events in order", () => {
		const first = event({ id: "retain_1", name: "tool-one" });
		const second = event({ id: "retain_2", name: "tool-two", created_by: "refine" });
		appendRetainEvent(toolsDir, first);
		appendRetainEvent(toolsDir, second);
		expect(loadRetainEvents(toolsDir)).toEqual([first, second]);
	});

	it("skips malformed and non-matching lines instead of throwing", () => {
		const path = getRetainEventsPath(toolsDir);
		const good = event();
		writeFileSync(
			path,
			[
				"not json at all {{{",
				JSON.stringify(good),
				JSON.stringify({ id: "missing-fields" }),
				JSON.stringify({ ...good, action: "rollback" }),
				"",
				JSON.stringify({ ...good, id: "retain_extra" }),
			].join("\n"),
		);
		const loaded = loadRetainEvents(toolsDir);
		expect(loaded).toEqual([good, { ...good, id: "retain_extra" }]);
	});

	it("tolerates a trailing newline and blank lines", () => {
		appendRetainEvent(toolsDir, event());
		const content = readFileSync(getRetainEventsPath(toolsDir), "utf8");
		writeFileSync(getRetainEventsPath(toolsDir), `${content}\n\n`);
		expect(loadRetainEvents(toolsDir)).toHaveLength(1);
	});
});
