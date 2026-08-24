import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolScope } from "./index.js";

/**
 * A retention-related event, recorded in a retained-tools-scoped JSONL log so
 * `/tools rollback` (#9) has a purpose-built place to read from. This is
 * deliberately NOT a continual-harness refinement event (see ADR-2,
 * docs/retained-tools/risks-and-decisions.md): retained tools and the
 * continual harness are disjoint systems that happen to share the word
 * "skill".
 */
export interface RetainEvent {
	id: string;
	at: string;
	/** T07 only ever creates; #9 may add "rollback" later. */
	action: "create";
	scope: ToolScope;
	name: string;
	/** posix path relative to the scope root, matches the tool index entry. */
	path: string;
	version: number;
	created_by: "user" | "refine" | "auto-proposal";
	/** The free-text "<what>" the user (or refine pass) gave /retain. */
	what: string;
	note?: string;
}

export function getRetainEventsPath(toolsDir: string): string {
	return join(toolsDir, "retain-events.jsonl");
}

export function appendRetainEvent(toolsDir: string, event: RetainEvent): string {
	const path = getRetainEventsPath(toolsDir);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
	return path;
}

function isRetainEvent(value: unknown): value is RetainEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.at === "string" &&
		candidate.action === "create" &&
		(candidate.scope === "global" || candidate.scope === "project") &&
		typeof candidate.name === "string" &&
		typeof candidate.path === "string" &&
		typeof candidate.version === "number" &&
		(candidate.created_by === "user" ||
			candidate.created_by === "refine" ||
			candidate.created_by === "auto-proposal") &&
		typeof candidate.what === "string"
	);
}

/**
 * Tolerant line-by-line JSON parse: malformed or non-matching lines are
 * skipped rather than throwing, mirroring loadGlobalRefinementHistory's
 * tolerance style (refinement.ts). A missing file yields an empty list.
 */
export function loadRetainEvents(toolsDir: string): RetainEvent[] {
	const path = getRetainEventsPath(toolsDir);
	if (!existsSync(path)) {
		return [];
	}
	const events: RetainEvent[] = [];
	const raw = readFileSync(path, "utf8");
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (isRetainEvent(parsed)) {
				events.push(parsed);
			}
		} catch {
			// Malformed lines are skipped, never fatal.
		}
	}
	return events;
}
