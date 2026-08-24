import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { hashDescription, refreshToolIndexes } from "../../../src/core/retained-tools/rebuild.js";
import {
	getSkillsVersionsDir,
	restoreSkillSnapshot,
	type SkillSnapshot,
} from "../../../src/core/retained-tools/snapshots.js";
import { loadSkillsFromDir, type Skill } from "../../../src/core/skills.js";
import { parseFrontmatter } from "../../../src/utils/frontmatter.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * SARK T06 issue acceptance regressions (docs/retained-tools/phase-b-retention.md,
 * "Snapshot store: `skills-versions` + rotation + restore (#6)"):
 *
 * 1. (AC1) restore round-trip: mutate -> rollback -> content hash equals the
 *    snapshot.
 * 2. (AC2) rotation: 11 versions -> exactly the latest 10 remain (12 load
 *    cycles: the first load takes no snapshot, loads 2..12 take 2.json..12.json,
 *    rotation keeps 3.json..12.json).
 */
describe("issue #6: snapshot restore + rotation (SARK T06)", () => {
	let agentDir: string;
	let harness: Harness | undefined;
	let skills: Skill[];

	beforeEach(async () => {
		const base = mkdtempSync(join(tmpdir(), "pi-snapshot-store-"));
		agentDir = join(base, "agent");
		mkdirSync(agentDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
		skills = [];
		harness = await createHarness({
			resourceLoader: createTestResourceLoader({ skills }),
		});
	});

	afterEach(() => {
		delete process.env[ENV_AGENT_DIR];
		harness?.cleanup();
		harness = undefined;
		rmSync(dirname(agentDir), { recursive: true, force: true });
	});

	function sha256(data: string | Buffer): string {
		return createHash("sha256").update(data).digest("hex");
	}

	function globalSkillsRoot(): string {
		return join(agentDir, "skills");
	}

	function writeGlobalSkill(name: string, description: string, version: number): string {
		const skillDir = join(globalSkillsRoot(), name);
		mkdirSync(skillDir, { recursive: true });
		const filePath = join(skillDir, "SKILL.md");
		const body = [
			"---",
			`name: ${name}`,
			`description: ${description}`,
			"metadata:",
			"  prime-agent:",
			"    retained:",
			`      version: ${version}`,
			"      status: active",
			"---",
			"",
			`# ${name}`,
			`Body revision ${version}.`,
		].join("\n");
		writeFileSync(filePath, body);
		return filePath;
	}

	/** One load cycle: read the global skill dirs from disk and refresh both scope indexes. */
	function loadFromDisk(): void {
		const { skills: loaded, diagnostics } = loadSkillsFromDir({ dir: globalSkillsRoot(), source: "user" });
		expect(diagnostics).toHaveLength(0);
		skills.length = 0;
		skills.push(...loaded);
		refreshToolIndexes({ cwd: harness!.tempDir, agentDir });
	}

	function snapshotToolDir(name: string): string {
		return join(getSkillsVersionsDir(agentDir), "global", name);
	}

	function readSnapshot(name: string, version: number): SkillSnapshot {
		return JSON.parse(readFileSync(join(snapshotToolDir(name), `${version}.json`), "utf8")) as SkillSnapshot;
	}

	it("restore round-trip: mutate, rollback, content hash equals the snapshot (acceptance 1)", () => {
		const name = "deploy-staging-canary";
		const filePath = writeGlobalSkill(name, "Deploy to staging behind a canary.", 1);
		loadFromDisk(); // first load: no snapshot
		expect(readdirSync(globalSkillsRoot())).toEqual([name]);
		expect(existsSync(snapshotToolDir(name))).toBe(false);

		// Mutate to version 2; the next load snapshots the changed content.
		writeGlobalSkill(name, "Deploy to staging with rollback support.", 2);
		loadFromDisk();
		expect(readdirSync(snapshotToolDir(name))).toEqual(["2.json"]);
		const snapshot2 = readSnapshot(name, 2);
		expect(snapshot2.version).toBe(2);
		expect(snapshot2.description_hash).toBe(hashDescription("Deploy to staging with rollback support."));

		// Mutate again to version 3, then roll back to version 2.
		writeGlobalSkill(name, "Deploy to staging with dry-run first.", 3);
		loadFromDisk();
		expect(readdirSync(snapshotToolDir(name)).sort()).toEqual(["2.json", "3.json"]);

		const restored = restoreSkillSnapshot({
			agentDir,
			scope: "global",
			name,
			version: 2,
			skillPath: dirname(filePath),
		});

		// The canonical SKILL.md is byte-identical to the snapshot content.
		expect(restored).toBe(snapshot2.content);
		expect(sha256(readFileSync(filePath))).toBe(sha256(snapshot2.content));
		const restoredDescription = String(parseFrontmatter(readFileSync(filePath, "utf8")).frontmatter.description);
		expect(hashDescription(restoredDescription)).toBe(snapshot2.description_hash);
	});

	it("rotation: 11 versions, exactly the latest 10 remain (acceptance 2)", () => {
		const name = "retained-rotation-tool";
		const filePath = writeGlobalSkill(name, "Rotation check version 1.", 1);
		loadFromDisk(); // load 1: no snapshot (no prior index entry)

		for (let version = 2; version <= 12; version++) {
			// Each load cycle mutates the description and bumps the frontmatter
			// version, so each cycle lazily snapshots the new version.
			writeGlobalSkill(name, `Rotation check version ${version}.`, version);
			loadFromDisk();
		}

		const remaining = readdirSync(snapshotToolDir(name));
		expect(remaining).toHaveLength(10);
		expect(remaining.sort()).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((v) => `${v}.json`).sort());
		// Surviving snapshots still parse and match their on-disk version.
		expect(readSnapshot(name, 3).description_hash).toBe(hashDescription("Rotation check version 3."));
		expect(readSnapshot(name, 12).description_hash).toBe(hashDescription("Rotation check version 12."));
		expect(readSnapshot(name, 12).content).toBe(readFileSync(filePath, "utf8"));
	});
});
