import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.js";
import type { DraftSkillFn } from "./draft.js";
import { appendRetainEvent, type RetainEvent } from "./events.js";
import { atomicWriteFileSync, getProjectToolsDir, type ToolIndexEntry, type ToolScope } from "./index.js";
import { refreshToolIndexes } from "./rebuild.js";
import { getSkillsVersionsDir, takeSkillSnapshot } from "./snapshots.js";

export type { DraftedSkill, DraftSkillFn, DraftSkillInput } from "./draft.js";

/**
 * Skill name validation, duplicated (not imported) from skills.ts's private
 * `validateName`/`MAX_NAME_LENGTH` (packages/coding-agent/src/core/skills.ts):
 * lowercase a-z, 0-9, hyphens only; max 64 chars; no leading/trailing or
 * consecutive hyphens. Keep this in sync with skills.ts if that rule changes.
 */
const MAX_RETAINED_NAME_LENGTH = 64;

function validateRetainedName(name: string): string[] {
	const errors: string[] = [];
	if (!name) {
		errors.push("name is empty");
		return errors;
	}
	if (name.length > MAX_RETAINED_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_RETAINED_NAME_LENGTH} characters (${name.length})`);
	}
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push("name must not start or end with a hyphen");
	}
	if (name.includes("--")) {
		errors.push("name must not contain consecutive hyphens");
	}
	return errors;
}

export interface MaterializeRetainOptions {
	/** The free-text "<what>" the user gave /retain. */
	what: string;
	scope: ToolScope;
	cwd: string;
	agentDir?: string;
	sessionId?: string;
	trajectoryText: string;
	draftSkill: DraftSkillFn;
	createdBy?: "user" | "refine" | "auto-proposal";
	now?: () => Date;
}

export type MaterializeRetainOutcome =
	| {
			kind: "created";
			name: string;
			scope: ToolScope;
			skillDir: string;
			version: 1;
			status: "active";
			indexEntry: ToolIndexEntry;
	  }
	| {
			kind: "collision";
			name: string;
			existingScope: ToolScope;
			existingPath: string;
			message: string;
	  }
	| {
			kind: "invalid-name";
			name: string;
			message: string;
	  };

function getScopeSkillsRoot(scope: ToolScope, cwd: string, agentDir: string): string {
	return scope === "global" ? join(agentDir, "skills") : resolve(cwd, CONFIG_DIR_NAME, "skills");
}

function oppositeScopeOf(scope: ToolScope): ToolScope {
	return scope === "global" ? "project" : "global";
}

function isoCompact(iso: string): string {
	return iso.replace(/[^0-9A-Za-z]/g, "");
}

/**
 * Materialize a solved procedure as a brand-new retained skill (markdown
 * path, SARK T07). Update-in-place for a name that collides with an existing
 * retained tool is explicitly out of scope here -- always returns a
 * `"collision"` outcome instead of writing.
 */
export async function materializeRetainedSkill(options: MaterializeRetainOptions): Promise<MaterializeRetainOutcome> {
	const drafted = await options.draftSkill({ what: options.what, trajectoryText: options.trajectoryText });
	const name = drafted.name.trim();

	const nameErrors = validateRetainedName(name);
	if (nameErrors.length > 0) {
		return { kind: "invalid-name", name, message: nameErrors.join("; ") };
	}

	const agentDir = options.agentDir ?? getAgentDir();
	const cwd = resolve(options.cwd);
	const requestedRoot = getScopeSkillsRoot(options.scope, cwd, agentDir);
	const oppositeScope = oppositeScopeOf(options.scope);
	const oppositeRoot = getScopeSkillsRoot(oppositeScope, cwd, agentDir);

	const targetDir = join(requestedRoot, name);
	const oppositeDir = join(oppositeRoot, name);

	if (existsSync(targetDir)) {
		return {
			kind: "collision",
			name,
			existingScope: options.scope,
			existingPath: targetDir,
			message: `a skill named "${name}" already exists (scope: ${options.scope}, path: ${targetDir})`,
		};
	}
	if (existsSync(oppositeDir)) {
		return {
			kind: "collision",
			name,
			existingScope: oppositeScope,
			existingPath: oppositeDir,
			message: `a skill named "${name}" already exists (scope: ${oppositeScope}, path: ${oppositeDir})`,
		};
	}

	const now = options.now ?? (() => new Date());
	const createdBy = options.createdBy ?? "user";
	const firstSeen = now().toISOString();
	const summary =
		drafted.summary.trim() || `Retained via /retain: "${options.what}" (session ${options.sessionId ?? "unknown"}).`;

	const provenance: Record<string, unknown> = {
		created_by: createdBy,
		first_seen: firstSeen,
		summary,
	};
	if (options.sessionId) {
		provenance.source_sessions = [options.sessionId];
	}

	const frontmatter = {
		name,
		description: drafted.description,
		metadata: {
			"prime-agent": {
				retained: {
					version: 1,
					status: "active",
					provenance,
				},
			},
		},
	};

	const yamlText = stringify(frontmatter);
	const fileContent = `---\n${yamlText}---\n\n${drafted.body.trim()}\n`;

	mkdirSync(targetDir, { recursive: true });
	atomicWriteFileSync(join(targetDir, "SKILL.md"), fileContent);

	// T06's lazy on-next-load snapshot mechanism explicitly skips first
	// appearances (rebuild.ts's `existing !== undefined` guard), but AC1
	// requires a version snapshot to exist immediately, so take it explicitly.
	takeSkillSnapshot({
		scope: options.scope,
		name,
		skillPath: targetDir,
		versionsDir: getSkillsVersionsDir(agentDir),
	});

	const refreshed = refreshToolIndexes({ cwd, agentDir });
	const scopeIndex = options.scope === "global" ? refreshed.global : refreshed.project;
	const indexEntry = scopeIndex.skills[name];
	if (!indexEntry) {
		throw new Error(`materializeRetainedSkill: index refresh did not produce an entry for "${name}"`);
	}

	const toolsDir = options.scope === "global" ? join(agentDir, "tools") : getProjectToolsDir(cwd);
	const event: RetainEvent = {
		id: `retain_${isoCompact(firstSeen)}`,
		at: firstSeen,
		action: "create",
		scope: options.scope,
		name,
		path: indexEntry.path,
		version: 1,
		created_by: createdBy,
		what: options.what,
	};
	appendRetainEvent(toolsDir, event);

	return {
		kind: "created",
		name,
		scope: options.scope,
		skillDir: targetDir,
		version: 1,
		status: "active",
		indexEntry,
	};
}
