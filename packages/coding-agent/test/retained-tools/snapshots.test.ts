import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getAgentDir } from "../../src/config.js";
import { hashDescription, refreshToolIndexes } from "../../src/core/retained-tools/rebuild.js";
import {
	getSkillsVersionsDir,
	getSnapshotPath,
	restoreSkillSnapshot,
	rotateSkillSnapshots,
	type SkillSnapshot,
	SnapshotError,
	takeSkillSnapshot,
} from "../../src/core/retained-tools/snapshots.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(join(tmpdir(), "prime-agent-retained-snapshots-test-"));
	tempDirs.push(dir);
	return dir;
}

function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Write a directory skill (dir + SKILL.md) under skillRoot; returns the SKILL.md path. */
function writeSkill(skillRoot: string, name: string, description: string, version = 1): string {
	const skillDir = join(skillRoot, name);
	fs.mkdirSync(skillDir, { recursive: true });
	const filePath = join(skillDir, "SKILL.md");
	const retained =
		version === 1
			? ""
			: `metadata:\n  prime-agent:\n    retained:\n      version: ${version}\n      status: active\n`;
	fs.writeFileSync(
		filePath,
		`---\nname: ${name}\ndescription: ${description}\n${retained}---\nBody of ${name} v${version}.`,
	);
	return filePath;
}

function readSnapshot(path: string): SkillSnapshot {
	return JSON.parse(fs.readFileSync(path, "utf8")) as SkillSnapshot;
}

/** Seed raw version files directly (rotation keys on filenames only). */
function seedVersions(versionsDir: string, scope: "global" | "project", name: string, versions: number[]): string {
	const toolDir = join(versionsDir, scope, name);
	fs.mkdirSync(toolDir, { recursive: true });
	for (const version of versions) {
		fs.writeFileSync(
			join(toolDir, `${version}.json`),
			JSON.stringify({ schema: 1, version, content: `v${version}` }),
		);
	}
	return toolDir;
}

function listFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir).sort((a, b) => {
		const av = /^(\d+)\.json$/.exec(a);
		const bv = /^(\d+)\.json$/.exec(b);
		if (av && bv) {
			return Number(av[1]) - Number(bv[1]);
		}
		return a < b ? -1 : a > b ? 1 : 0;
	});
}

describe("snapshot path helpers", () => {
	it("getSkillsVersionsDir resolves under the given agent dir", () => {
		const agentDir = makeTempDir();
		expect(getSkillsVersionsDir(agentDir)).toBe(join(agentDir, "skills-versions"));
	});

	it("getSkillsVersionsDir defaults to the active agent dir (ENV_AGENT_DIR)", () => {
		const agentDir = makeTempDir();
		const previous = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			expect(getAgentDir()).toBe(agentDir);
			expect(getSkillsVersionsDir()).toBe(join(agentDir, "skills-versions"));
		} finally {
			if (previous === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previous;
			}
		}
	});

	it("getSnapshotPath is <versionsDir>/<scope>/<name>/<version>.json", () => {
		const versionsDir = join(makeTempDir(), "skills-versions");
		expect(getSnapshotPath(versionsDir, "global", "alpha", 7)).toBe(join(versionsDir, "global", "alpha", "7.json"));
		expect(getSnapshotPath(versionsDir, "project", "beta", 1)).toBe(join(versionsDir, "project", "beta", "1.json"));
	});
});

describe("takeSkillSnapshot (schema + write)", () => {
	it("writes a markdown snapshot with exactly the fixed shape", () => {
		const agentDir = makeTempDir();
		const filePath = writeSkill(join(agentDir, "skills"), "alpha", "Alpha description.", 2);
		const raw = fs.readFileSync(filePath, "utf8");

		const snapshotPath = takeSkillSnapshot({
			agentDir,
			scope: "global",
			name: "alpha",
			skillPath: dirname(filePath),
		});

		expect(snapshotPath).toBe(getSnapshotPath(getSkillsVersionsDir(agentDir), "global", "alpha", 2));
		expect(fs.existsSync(snapshotPath)).toBe(true);
		const snapshot = readSnapshot(snapshotPath);
		// Fixed field set for a markdown skill: no python key.
		expect(Object.keys(snapshot).sort()).toEqual([
			"content",
			"created",
			"description_hash",
			"frontmatter",
			"schema",
			"version",
		]);
		expect(snapshot.schema).toBe(1);
		expect(snapshot.version).toBe(2);
		expect(Number.isNaN(new Date(snapshot.created).getTime())).toBe(false);
		expect(snapshot.description_hash).toBe(hashDescription("Alpha description."));
		expect(snapshot.content).toBe(raw);
		expect(snapshot.frontmatter).toEqual({
			name: "alpha",
			description: "Alpha description.",
			metadata: { "prime-agent": { retained: { version: 2, status: "active" } } },
		});
		expect(fs.readdirSync(dirname(snapshotPath))).not.toContain(expect.stringMatching(/\.tmp$/));
	});

	it("defaults to version 1 for a skill without retained frontmatter", () => {
		const agentDir = makeTempDir();
		writeSkill(join(agentDir, "skills"), "plain", "Plain description.");

		const snapshotPath = takeSkillSnapshot({
			agentDir,
			scope: "project",
			name: "plain",
			skillPath: join(agentDir, "skills", "plain"),
		});

		expect(snapshotPath).toBe(getSnapshotPath(getSkillsVersionsDir(agentDir), "project", "plain", 1));
		expect(readSnapshot(snapshotPath).version).toBe(1);
	});

	it("accepts the SKILL.md file path as skillPath", () => {
		const agentDir = makeTempDir();
		const filePath = writeSkill(join(agentDir, "skills"), "alpha", "Alpha description.", 3);
		const raw = fs.readFileSync(filePath, "utf8");

		const byDir = takeSkillSnapshot({ agentDir, scope: "global", name: "alpha", skillPath: dirname(filePath) });
		const byFile = takeSkillSnapshot({ agentDir, scope: "global", name: "alpha", skillPath: filePath });

		expect(byDir).toBe(byFile);
		expect(readSnapshot(byFile).content).toBe(raw);
		expect(readSnapshot(byFile).version).toBe(3);
	});

	it("snapshots a root-level .md file skill using the file itself as content", () => {
		const agentDir = makeTempDir();
		const skillsRoot = join(agentDir, "skills");
		fs.mkdirSync(skillsRoot, { recursive: true });
		const filePath = join(skillsRoot, "rooted.md");
		fs.writeFileSync(filePath, "---\nname: rooted\ndescription: Rooted description.\n---\nBody.");

		const snapshotPath = takeSkillSnapshot({ agentDir, scope: "global", name: "rooted", skillPath: filePath });

		expect(snapshotPath).toBe(getSnapshotPath(getSkillsVersionsDir(agentDir), "global", "rooted", 1));
		expect(readSnapshot(snapshotPath).content).toBe(fs.readFileSync(filePath, "utf8"));
	});

	it("leaves no temp residue after a successful write", () => {
		const agentDir = makeTempDir();
		const skillPath = writeSkill(join(agentDir, "skills"), "alpha", "Alpha description.");
		takeSkillSnapshot({ agentDir, scope: "global", name: "alpha", skillPath: dirname(skillPath) });
		const toolDir = join(getSkillsVersionsDir(agentDir), "global", "alpha");
		expect(fs.readdirSync(toolDir)).not.toContain(expect.stringMatching(/\.tmp$/));
	});
});

describe("rotateSkillSnapshots (keep 10, numeric order)", () => {
	it("deletes the oldest version when 11 files are present", () => {
		const agentDir = makeTempDir();
		const versionsDir = getSkillsVersionsDir(agentDir);
		const toolDir = seedVersions(versionsDir, "global", "alpha", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

		const deleted = rotateSkillSnapshots(versionsDir, "global", "alpha");

		expect(deleted).toEqual([join(toolDir, "1.json")]);
		expect(listFiles(toolDir)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((v) => `${v}.json`));
	});

	it("deletes nothing when exactly 10 files are present", () => {
		const agentDir = makeTempDir();
		const versionsDir = getSkillsVersionsDir(agentDir);
		const toolDir = seedVersions(versionsDir, "global", "alpha", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

		expect(rotateSkillSnapshots(versionsDir, "global", "alpha")).toEqual([]);
		expect(listFiles(toolDir)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => `${v}.json`));
	});

	it("orders versions numerically: 9, 10, 11 with keep=2 deletes 9.json, not 10.json", () => {
		const agentDir = makeTempDir();
		const versionsDir = getSkillsVersionsDir(agentDir);
		const toolDir = seedVersions(versionsDir, "global", "alpha", [9, 10, 11]);

		const deleted = rotateSkillSnapshots(versionsDir, "global", "alpha", 2);

		// Lexicographic order would call "10.json" < "9.json" and delete the wrong file.
		expect(deleted).toEqual([join(toolDir, "9.json")]);
		expect(listFiles(toolDir)).toEqual(["10.json", "11.json"]);
	});

	it("ignores files that do not match <version>.json", () => {
		const agentDir = makeTempDir();
		const versionsDir = getSkillsVersionsDir(agentDir);
		const toolDir = seedVersions(versionsDir, "global", "alpha", [9, 10, 11]);
		fs.writeFileSync(join(toolDir, "latest.json"), "{}");
		fs.mkdirSync(join(toolDir, "subdir"));

		const deleted = rotateSkillSnapshots(versionsDir, "global", "alpha", 2);

		expect(deleted).toEqual([join(toolDir, "9.json")]);
		expect(fs.existsSync(join(toolDir, "latest.json"))).toBe(true);
		expect(fs.existsSync(join(toolDir, "subdir"))).toBe(true);
	});

	it("takes no action when the tool dir does not exist", () => {
		const versionsDir = getSkillsVersionsDir(makeTempDir());
		expect(rotateSkillSnapshots(versionsDir, "global", "absent")).toEqual([]);
	});

	it("takeSkillSnapshot auto-rotates when the 11th version lands", () => {
		const agentDir = makeTempDir();
		const versionsDir = getSkillsVersionsDir(agentDir);
		seedVersions(versionsDir, "global", "alpha", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		const skillPath = writeSkill(join(agentDir, "skills"), "alpha", "Eleventh version.", 11);

		takeSkillSnapshot({ agentDir, scope: "global", name: "alpha", skillPath: dirname(skillPath) });

		const toolDir = join(versionsDir, "global", "alpha");
		expect(listFiles(toolDir)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((v) => `${v}.json`));
		expect(readSnapshot(join(toolDir, "11.json")).version).toBe(11);
	});

	it("same-version overwrite does not change the file count", () => {
		const agentDir = makeTempDir();
		const skillPath = writeSkill(join(agentDir, "skills"), "alpha", "First description.");
		const first = takeSkillSnapshot({ agentDir, scope: "global", name: "alpha", skillPath: dirname(skillPath) });
		fs.writeFileSync(skillPath, `${fs.readFileSync(skillPath, "utf8")}\nEdited.`);
		const second = takeSkillSnapshot({ agentDir, scope: "global", name: "alpha", skillPath: dirname(skillPath) });

		expect(second).toBe(first);
		const toolDir = join(getSkillsVersionsDir(agentDir), "global", "alpha");
		expect(listFiles(toolDir)).toEqual(["1.json"]);
		expect(readSnapshot(first).content).toContain("Edited.");
	});
});

describe("restoreSkillSnapshot (round-trip)", () => {
	it("restores the exact snapshot bytes for each version", () => {
		const agentDir = makeTempDir();
		const skillPath = writeSkill(join(agentDir, "skills"), "alpha", "Original description.");
		const v1Bytes = fs.readFileSync(skillPath);
		const v1Path = takeSkillSnapshot({ agentDir, scope: "global", name: "alpha", skillPath: dirname(skillPath) });

		writeSkill(join(agentDir, "skills"), "alpha", "Changed description.", 2);
		const v2Bytes = fs.readFileSync(skillPath);
		const v2Path = takeSkillSnapshot({ agentDir, scope: "global", name: "alpha", skillPath: dirname(skillPath) });

		const restoredV2 = restoreSkillSnapshot({
			agentDir,
			scope: "global",
			name: "alpha",
			version: 2,
			skillPath: dirname(skillPath),
		});
		expect(restoredV2).toBe(readSnapshot(v2Path).content);
		expect(sha256(fs.readFileSync(skillPath))).toBe(sha256(v2Bytes));

		const restoredV1 = restoreSkillSnapshot({
			agentDir,
			scope: "global",
			name: "alpha",
			version: 1,
			skillPath: dirname(skillPath),
		});
		expect(restoredV1).toBe(readSnapshot(v1Path).content);
		expect(sha256(fs.readFileSync(skillPath))).toBe(sha256(v1Bytes));
	});

	it("throws SnapshotError(not-found) for a missing version", () => {
		const agentDir = makeTempDir();
		const skillPath = writeSkill(join(agentDir, "skills"), "alpha", "Original description.");
		takeSkillSnapshot({ agentDir, scope: "global", name: "alpha", skillPath: dirname(skillPath) });

		let caught: unknown;
		try {
			restoreSkillSnapshot({ agentDir, scope: "global", name: "alpha", version: 99, skillPath: dirname(skillPath) });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SnapshotError);
		expect((caught as SnapshotError).reason).toBe("not-found");
	});

	it("throws SnapshotError(corrupt) for invalid JSON on disk", () => {
		const agentDir = makeTempDir();
		const versionsDir = getSkillsVersionsDir(agentDir);
		const toolDir = join(versionsDir, "global", "alpha");
		fs.mkdirSync(toolDir, { recursive: true });
		fs.writeFileSync(join(toolDir, "3.json"), "{ not json");

		let caught: unknown;
		try {
			restoreSkillSnapshot({
				agentDir,
				scope: "global",
				name: "alpha",
				version: 3,
				skillPath: join(agentDir, "skills", "alpha"),
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SnapshotError);
		expect((caught as SnapshotError).reason).toBe("corrupt");
	});

	it("throws SnapshotError(corrupt) for valid JSON with the wrong shape", () => {
		const agentDir = makeTempDir();
		const versionsDir = getSkillsVersionsDir(agentDir);
		const toolDir = join(versionsDir, "global", "alpha");
		fs.mkdirSync(toolDir, { recursive: true });
		fs.writeFileSync(join(toolDir, "3.json"), JSON.stringify({ schema: 1 }));

		let caught: unknown;
		try {
			restoreSkillSnapshot({
				agentDir,
				scope: "global",
				name: "alpha",
				version: 3,
				skillPath: join(agentDir, "skills", "alpha"),
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SnapshotError);
		expect((caught as SnapshotError).reason).toBe("corrupt");
	});
});

describe("python skill snapshot payload", () => {
	function writePythonSkill(skillRoot: string, name: string, description: string, version = 1): string {
		const skillDir = join(skillRoot, name);
		fs.mkdirSync(join(skillDir, "src", name), { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		const retained =
			version === 1
				? ""
				: `metadata:\n  prime-agent:\n    retained:\n      version: ${version}\n      status: active\n`;
		fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n${retained}---\nBody.`);
		fs.writeFileSync(join(skillDir, "pyproject.toml"), `[project]\nname = "${name}"\nversion = "0.1.0"\n`);
		fs.writeFileSync(join(skillDir, "src", name, "__init__.py"), "async def run():\n    return 'ok'\n");
		return filePath;
	}

	it("lists every non-SKILL.md file with sorted posix paths and sha256s", () => {
		const agentDir = makeTempDir();
		const skillPath = writePythonSkill(join(agentDir, "skills"), "alpha-tool", "Python description.", 1);
		const pyproject = fs.readFileSync(join(dirname(skillPath), "pyproject.toml"), "utf8");
		const init = fs.readFileSync(join(dirname(skillPath), "src", "alpha-tool", "__init__.py"), "utf8");

		const snapshotPath = takeSkillSnapshot({
			agentDir,
			scope: "global",
			name: "alpha-tool",
			skillPath: dirname(skillPath),
		});
		const snapshot = readSnapshot(snapshotPath);

		expect(snapshot.python).toEqual({
			files: [
				{ path: "pyproject.toml", sha256: sha256(pyproject) },
				{ path: "src/alpha-tool/__init__.py", sha256: sha256(init) },
			],
		});
	});

	it("omits the python key for markdown skills", () => {
		const agentDir = makeTempDir();
		const skillPath = writeSkill(join(agentDir, "skills"), "alpha", "Markdown description.");
		const snapshot = readSnapshot(
			takeSkillSnapshot({ agentDir, scope: "global", name: "alpha", skillPath: dirname(skillPath) }),
		);
		expect(snapshot.python).toBeUndefined();
	});

	it("restore rewrites SKILL.md only; python package files stay untouched", () => {
		const agentDir = makeTempDir();
		const skillDir = join(agentDir, "skills", "alpha-tool");
		const skillPath = writePythonSkill(join(agentDir, "skills"), "alpha-tool", "Python description.");
		takeSkillSnapshot({ agentDir, scope: "global", name: "alpha-tool", skillPath: skillDir });
		const originalSkillMd = fs.readFileSync(skillPath, "utf8");

		const initPath = join(skillDir, "src", "alpha-tool", "__init__.py");
		fs.writeFileSync(skillPath, originalSkillMd.replace("Python description.", "Python description v2."));
		fs.writeFileSync(initPath, "# deliberately mutated, not restored at T06\n");

		restoreSkillSnapshot({ agentDir, scope: "global", name: "alpha-tool", version: 1, skillPath: skillDir });

		expect(fs.readFileSync(skillPath, "utf8")).toBe(originalSkillMd);
		expect(fs.readFileSync(initPath, "utf8")).toBe("# deliberately mutated, not restored at T06\n");
	});
});

describe("lazy snapshot trigger at load (refreshToolIndexes)", () => {
	function versionFiles(agentDir: string, name: string): string[] {
		return listFiles(join(getSkillsVersionsDir(agentDir), "global", name));
	}

	it("takes no snapshot on the first load of a retained skill", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		writeSkill(join(agentDir, "skills"), "alpha", "Original description.", 1);

		refreshToolIndexes({ cwd, agentDir });

		expect(versionFiles(agentDir, "alpha")).toEqual([]);
		expect(fs.existsSync(getSkillsVersionsDir(agentDir))).toBe(false);
	});

	it("snapshots the changed content at the current version on the next load", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		const skillFile = writeSkill(join(agentDir, "skills"), "alpha", "Original description.", 1);
		refreshToolIndexes({ cwd, agentDir });

		writeSkill(join(agentDir, "skills"), "alpha", "Changed description.", 2);
		const mutated = fs.readFileSync(skillFile, "utf8");
		const index = refreshToolIndexes({ cwd, agentDir });

		expect(index.global.skills.alpha.description_hash).toBe(hashDescription("Changed description."));
		expect(versionFiles(agentDir, "alpha")).toEqual(["2.json"]);
		const snapshot = readSnapshot(getSnapshotPath(getSkillsVersionsDir(agentDir), "global", "alpha", 2));
		expect(snapshot.version).toBe(2);
		expect(snapshot.content).toBe(mutated);
		expect(snapshot.description_hash).toBe(hashDescription("Changed description."));
	});

	it("takes no new snapshot when the description hash is unchanged", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		writeSkill(join(agentDir, "skills"), "alpha", "Original description.", 1);
		refreshToolIndexes({ cwd, agentDir });
		writeSkill(join(agentDir, "skills"), "alpha", "Changed description.", 2);
		refreshToolIndexes({ cwd, agentDir });
		refreshToolIndexes({ cwd, agentDir });

		expect(versionFiles(agentDir, "alpha")).toEqual(["2.json"]);
	});

	it("never snapshots plain (non-retained) skills, even when mutated", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		const skillFile = writeSkill(join(agentDir, "skills"), "plain", "Plain description.");
		refreshToolIndexes({ cwd, agentDir });

		fs.writeFileSync(
			skillFile,
			fs.readFileSync(skillFile, "utf8").replace("Plain description.", "Plain description v2."),
		);
		refreshToolIndexes({ cwd, agentDir });

		expect(versionFiles(agentDir, "plain")).toEqual([]);
		expect(fs.existsSync(getSkillsVersionsDir(agentDir))).toBe(false);
	});

	it("keeps the index refresh correct when the snapshot dir is unwritable", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		writeSkill(join(agentDir, "skills"), "alpha", "Original description.", 1);
		refreshToolIndexes({ cwd, agentDir });
		const versionsDir = getSkillsVersionsDir(agentDir);
		fs.mkdirSync(versionsDir, { recursive: true });
		fs.chmodSync(versionsDir, 0o500);
		try {
			writeSkill(join(agentDir, "skills"), "alpha", "Changed description.", 2);
			const index = refreshToolIndexes({ cwd, agentDir });

			expect(index.global.skills.alpha.description_hash).toBe(hashDescription("Changed description."));
			expect(index.global.skills.alpha.version).toBe(2);
			expect(fs.existsSync(join(versionsDir, "global"))).toBe(false);
		} finally {
			fs.chmodSync(versionsDir, 0o755);
		}
	});
});
