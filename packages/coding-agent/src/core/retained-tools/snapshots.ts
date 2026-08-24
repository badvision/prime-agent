import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { getAgentDir } from "../../config.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import { atomicWriteFileSync, type ToolScope } from "./index.js";
import { parseRetainedMeta } from "./meta.js";
import { hashDescription } from "./rebuild.js";

/** Rotation keeps the 10 newest version files per tool (phase-b design). */
export const DEFAULT_SNAPSHOT_KEEP = 10;

export interface SnapshotPythonFile {
	/** posix path relative to the skill directory. */
	path: string;
	sha256: string;
}

/**
 * A retained tool's prior state, stored at
 * `<agentDir>/skills-versions/<scope>/<name>/<version>.json`.
 */
export interface SkillSnapshot {
	schema: 1;
	/** `retained.version` from the frontmatter at snapshot time; the file name. */
	version: number;
	created: string;
	description_hash: string;
	/** Complete raw SKILL.md text, frontmatter included, so restore is a pure write-back. */
	content: string;
	frontmatter: Record<string, unknown>;
	/** Python skills only: every non-SKILL.md file with its content hash. */
	python?: { files: SnapshotPythonFile[] };
}

export class SnapshotError extends Error {
	readonly reason: "not-found" | "corrupt";

	constructor(reason: "not-found" | "corrupt", message: string) {
		super(message);
		this.name = "SnapshotError";
		this.reason = reason;
	}
}

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

export function getSkillsVersionsDir(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), "skills-versions");
}

export function getSnapshotPath(versionsDir: string, scope: ToolScope, name: string, version: number): string {
	return join(versionsDir, scope, name, `${version}.json`);
}

/**
 * Resolve the canonical SKILL.md for a skill artifact: a directory skill is its
 * own directory (SKILL.md inside), a root-level file skill is the .md file itself.
 */
function resolveSkillFiles(skillPath: string): { skillMdPath: string; skillDir: string; isDirectorySkill: boolean } {
	if (statSync(skillPath).isDirectory()) {
		return { skillMdPath: join(skillPath, "SKILL.md"), skillDir: skillPath, isDirectorySkill: true };
	}
	return { skillMdPath: skillPath, skillDir: dirname(skillPath), isDirectorySkill: false };
}

function fileSha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Every non-SKILL.md file under a Python skill dir (detected by pyproject.toml,
 * same rule as the loader), sorted by posix path. Null for non-python skills.
 */
function collectPythonFiles(skillDir: string): SnapshotPythonFile[] | null {
	try {
		if (!statSync(join(skillDir, "pyproject.toml")).isFile()) {
			return null;
		}
	} catch {
		return null;
	}
	const files: SnapshotPythonFile[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				const relPath = toPosixPath(relative(skillDir, fullPath));
				if (relPath !== "SKILL.md") {
					files.push({ path: relPath, sha256: fileSha256(fullPath) });
				}
			}
		}
	};
	walk(skillDir);
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return files;
}

export interface TakeSkillSnapshotOptions {
	/** Agent dir root; the snapshot root defaults to `<agentDir>/skills-versions`. */
	agentDir?: string;
	/** Explicit snapshot root; takes precedence over `agentDir`. */
	versionsDir?: string;
	scope: ToolScope;
	/** Skill name (frontmatter name). */
	name: string;
	/** The skill dir for directory skills, or the .md file for root-level file skills. */
	skillPath: string;
}

/**
 * Snapshot the skill's current on-disk content at its current frontmatter
 * version (overwriting that version's file if present), then rotate to the
 * 10 newest. Returns the snapshot file path.
 */
export function takeSkillSnapshot(options: TakeSkillSnapshotOptions): string {
	const versionsDir = options.versionsDir ?? getSkillsVersionsDir(options.agentDir);
	const { skillMdPath, skillDir, isDirectorySkill } = resolveSkillFiles(options.skillPath);
	const content = readFileSync(skillMdPath, "utf8");
	const { frontmatter } = parseFrontmatter(content);
	const meta = parseRetainedMeta(frontmatter) ?? { version: 1, status: "active" };
	const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	const snapshot: SkillSnapshot = {
		schema: 1,
		version: meta.version,
		created: new Date().toISOString(),
		description_hash: hashDescription(description),
		content,
		frontmatter,
	};
	const pythonFiles = isDirectorySkill ? collectPythonFiles(skillDir) : null;
	if (pythonFiles !== null) {
		snapshot.python = { files: pythonFiles };
	}
	const snapshotPath = getSnapshotPath(versionsDir, options.scope, options.name, meta.version);
	atomicWriteFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
	rotateSkillSnapshots(versionsDir, options.scope, options.name, DEFAULT_SNAPSHOT_KEEP);
	return snapshotPath;
}

/**
 * Keep at most `keep` version files per tool, deleting the oldest (compared
 * numerically — "10.json" must sort above "9.json"). Files that do not match
 * `<version>.json` are ignored. Returns the deleted paths.
 */
export function rotateSkillSnapshots(
	versionsDir: string,
	scope: ToolScope,
	name: string,
	keep: number = DEFAULT_SNAPSHOT_KEEP,
): string[] {
	const toolDir = join(versionsDir, scope, name);
	let entries: string[];
	try {
		entries = readdirSync(toolDir);
	} catch {
		return [];
	}
	const versioned = entries
		.map((file) => {
			const match = /^(\d+)\.json$/.exec(file);
			return match ? { file, version: Number(match[1]) } : null;
		})
		.filter((entry): entry is { file: string; version: number } => entry !== null);
	if (versioned.length <= keep) {
		return [];
	}
	versioned.sort((a, b) => a.version - b.version);
	const deleted: string[] = [];
	for (const entry of versioned.slice(0, versioned.length - keep)) {
		const path = join(toolDir, entry.file);
		unlinkSync(path);
		deleted.push(path);
	}
	return deleted;
}

function isSkillSnapshot(value: unknown): value is SkillSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.schema !== 1) {
		return false;
	}
	if (typeof candidate.version !== "number") {
		return false;
	}
	if (typeof candidate.created !== "string") {
		return false;
	}
	if (typeof candidate.description_hash !== "string") {
		return false;
	}
	if (typeof candidate.content !== "string") {
		return false;
	}
	if (typeof candidate.frontmatter !== "object" || candidate.frontmatter === null) {
		return false;
	}
	const python = candidate.python;
	if (python !== undefined) {
		if (typeof python !== "object" || python === null || Array.isArray(python)) {
			return false;
		}
		const files = (python as Record<string, unknown>).files;
		if (!Array.isArray(files)) {
			return false;
		}
		for (const file of files) {
			if (typeof file !== "object" || file === null) {
				return false;
			}
			const fileEntry = file as Record<string, unknown>;
			if (typeof fileEntry.path !== "string" || typeof fileEntry.sha256 !== "string") {
				return false;
			}
		}
	}
	return true;
}

export interface RestoreSkillSnapshotOptions {
	/** Agent dir root; the snapshot root defaults to `<agentDir>/skills-versions`. */
	agentDir?: string;
	/** Explicit snapshot root; takes precedence over `agentDir`. */
	versionsDir?: string;
	scope: ToolScope;
	name: string;
	version: number;
	/** The skill dir for directory skills, or the .md file for root-level file skills. */
	skillPath: string;
}

/**
 * Write the snapshot's stored content back to the canonical SKILL.md
 * (SKILL.md only — Python package contents stay untouched at this stage).
 * Returns the restored content.
 */
export function restoreSkillSnapshot(options: RestoreSkillSnapshotOptions): string {
	const versionsDir = options.versionsDir ?? getSkillsVersionsDir(options.agentDir);
	const snapshotPath = getSnapshotPath(versionsDir, options.scope, options.name, options.version);
	if (!existsSync(snapshotPath)) {
		throw new SnapshotError(
			"not-found",
			`no snapshot for ${options.name} version ${options.version} at ${snapshotPath}`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(snapshotPath, "utf8"));
	} catch {
		throw new SnapshotError("corrupt", `snapshot at ${snapshotPath} is not valid JSON`);
	}
	if (!isSkillSnapshot(raw)) {
		throw new SnapshotError("corrupt", `snapshot at ${snapshotPath} does not match the snapshot schema`);
	}
	const { skillMdPath } = resolveSkillFiles(options.skillPath);
	atomicWriteFileSync(skillMdPath, raw.content);
	return raw.content;
}
