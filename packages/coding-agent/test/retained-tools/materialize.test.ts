import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.js";
import type { DraftedSkill } from "../../src/core/retained-tools/draft.js";
import { getRetainEventsPath, loadRetainEvents } from "../../src/core/retained-tools/events.js";
import { getProjectToolsDir } from "../../src/core/retained-tools/index.js";
import { type MaterializeRetainOptions, materializeRetainedSkill } from "../../src/core/retained-tools/materialize.js";
import { getSkillsVersionsDir, type SkillSnapshot } from "../../src/core/retained-tools/snapshots.js";
import { parseFrontmatter } from "../../src/utils/frontmatter.js";

describe("materializeRetainedSkill (SARK T07)", () => {
	let base: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "prime-agent-materialize-test-"));
		cwd = join(base, "project");
		agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	function drafted(overrides: Partial<DraftedSkill> = {}): DraftedSkill {
		return {
			name: "deploy-staging-canary",
			description: "Runs the staging canary deploy sequence. Use when deploying to staging.",
			body: "# Deploy staging canary\n\n1. Build.\n2. Tag.\n3. Roll out.",
			summary: "Retained after solving the staging canary deploy sequence.",
			...overrides,
		};
	}

	function baseOptions(overrides: Partial<MaterializeRetainOptions> = {}): MaterializeRetainOptions {
		return {
			what: "deploy to staging with a canary",
			scope: "project",
			cwd,
			agentDir,
			sessionId: "01a0205d-0b6f-74f8-94f4-ad4cde6226c8",
			trajectoryText: "user: deploy it\nassistant: done",
			draftSkill: async () => drafted(),
			now: () => new Date("2026-01-01T00:00:00.000Z"),
			...overrides,
		};
	}

	function projectSkillDir(name: string): string {
		return join(cwd, CONFIG_DIR_NAME, "skills", name);
	}

	function globalSkillDir(name: string): string {
		return join(agentDir, "skills", name);
	}

	it("creates a project-scope skill with correct frontmatter, index entry, and snapshot (AC1)", async () => {
		const outcome = await materializeRetainedSkill(baseOptions());

		expect(outcome.kind).toBe("created");
		if (outcome.kind !== "created") throw new Error("expected created outcome");
		expect(outcome.name).toBe("deploy-staging-canary");
		expect(outcome.scope).toBe("project");
		expect(outcome.version).toBe(1);
		expect(outcome.status).toBe("active");
		expect(outcome.skillDir).toBe(projectSkillDir("deploy-staging-canary"));

		const skillMdPath = join(outcome.skillDir, "SKILL.md");
		expect(existsSync(skillMdPath)).toBe(true);
		const raw = readFileSync(skillMdPath, "utf8");
		const { frontmatter, body } = parseFrontmatter(raw);
		expect(frontmatter.name).toBe("deploy-staging-canary");
		expect(frontmatter.description).toBe("Runs the staging canary deploy sequence. Use when deploying to staging.");
		expect(body.trim()).toBe("# Deploy staging canary\n\n1. Build.\n2. Tag.\n3. Roll out.");
		const retained = (frontmatter.metadata as any)["prime-agent"].retained;
		expect(retained.version).toBe(1);
		expect(retained.status).toBe("active");
		expect(retained.provenance.created_by).toBe("user");
		expect(retained.provenance.source_sessions).toEqual(["01a0205d-0b6f-74f8-94f4-ad4cde6226c8"]);
		expect(retained.provenance.first_seen).toBe("2026-01-01T00:00:00.000Z");
		expect(retained.provenance.summary).toBe("Retained after solving the staging canary deploy sequence.");

		// index entry (status: active) exists for the correct scope
		expect(outcome.indexEntry.scope).toBe("project");
		expect(outcome.indexEntry.status).toBe("active");
		expect(outcome.indexEntry.version).toBe(1);
		expect(outcome.indexEntry.path).toBe(".prime/agent/skills/deploy-staging-canary");

		// version snapshot exists immediately (T06's lazy first-load skip is bypassed)
		const snapshotPath = join(getSkillsVersionsDir(agentDir), "project", "deploy-staging-canary", "1.json");
		expect(existsSync(snapshotPath)).toBe(true);
		const snapshot: SkillSnapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
		expect(snapshot.version).toBe(1);
		expect(snapshot.content).toBe(raw);

		// retain event recorded
		const toolsDir = getProjectToolsDir(cwd);
		const events = loadRetainEvents(toolsDir);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			action: "create",
			scope: "project",
			name: "deploy-staging-canary",
			version: 1,
			created_by: "user",
			what: "deploy to staging with a canary",
		});
	});

	it("creates a global-scope skill under agentDir/skills", async () => {
		const outcome = await materializeRetainedSkill(baseOptions({ scope: "global" }));
		expect(outcome.kind).toBe("created");
		if (outcome.kind !== "created") throw new Error("expected created outcome");
		expect(outcome.skillDir).toBe(globalSkillDir("deploy-staging-canary"));
		expect(existsSync(join(outcome.skillDir, "SKILL.md"))).toBe(true);
		expect(outcome.indexEntry.scope).toBe("global");

		const events = loadRetainEvents(join(agentDir, "tools"));
		expect(events).toHaveLength(1);
		expect(events[0].scope).toBe("global");
	});

	it("omits source_sessions when no sessionId is provided", async () => {
		const outcome = await materializeRetainedSkill(baseOptions({ sessionId: undefined }));
		if (outcome.kind !== "created") throw new Error("expected created outcome");
		const { frontmatter } = parseFrontmatter(readFileSync(join(outcome.skillDir, "SKILL.md"), "utf8"));
		const retained = (frontmatter.metadata as any)["prime-agent"].retained;
		expect(retained.provenance.source_sessions).toBeUndefined();
	});

	it("uses '(session unknown)' in the fallback summary when neither summary nor sessionId are provided", async () => {
		const outcome = await materializeRetainedSkill(
			baseOptions({ sessionId: undefined, draftSkill: async () => drafted({ summary: "" }) }),
		);
		if (outcome.kind !== "created") throw new Error("expected created outcome");
		const { frontmatter } = parseFrontmatter(readFileSync(join(outcome.skillDir, "SKILL.md"), "utf8"));
		const retained = (frontmatter.metadata as any)["prime-agent"].retained;
		expect(retained.provenance.summary).toContain("(session unknown)");
	});

	it("falls back to a template summary when the drafted summary is blank", async () => {
		const outcome = await materializeRetainedSkill(
			baseOptions({ draftSkill: async () => drafted({ summary: "   " }) }),
		);
		if (outcome.kind !== "created") throw new Error("expected created outcome");
		const { frontmatter } = parseFrontmatter(readFileSync(join(outcome.skillDir, "SKILL.md"), "utf8"));
		const retained = (frontmatter.metadata as any)["prime-agent"].retained;
		expect(retained.provenance.summary).toBe(
			'Retained via /retain: "deploy to staging with a canary" (session 01a0205d-0b6f-74f8-94f4-ad4cde6226c8).',
		);
	});

	it("returns a collision outcome when the name already exists in the same scope, without writing", async () => {
		mkdirSync(projectSkillDir("deploy-staging-canary"), { recursive: true });
		const before = existsSync(join(projectSkillDir("deploy-staging-canary"), "SKILL.md"));

		const outcome = await materializeRetainedSkill(baseOptions());
		expect(outcome.kind).toBe("collision");
		if (outcome.kind !== "collision") throw new Error("expected collision outcome");
		expect(outcome.name).toBe("deploy-staging-canary");
		expect(outcome.existingScope).toBe("project");
		expect(existsSync(join(projectSkillDir("deploy-staging-canary"), "SKILL.md"))).toBe(before);
		expect(loadRetainEvents(getProjectToolsDir(cwd))).toHaveLength(0);
	});

	it("returns a collision outcome when the name exists in the opposite scope, without writing", async () => {
		mkdirSync(globalSkillDir("deploy-staging-canary"), { recursive: true });

		const outcome = await materializeRetainedSkill(baseOptions({ scope: "project" }));
		expect(outcome.kind).toBe("collision");
		if (outcome.kind !== "collision") throw new Error("expected collision outcome");
		expect(outcome.existingScope).toBe("global");
		expect(existsSync(projectSkillDir("deploy-staging-canary"))).toBe(false);
		expect(loadRetainEvents(getProjectToolsDir(cwd))).toHaveLength(0);
	});

	it("returns an invalid-name outcome for a drafted name with disallowed characters, without writing", async () => {
		const outcome = await materializeRetainedSkill(
			baseOptions({ draftSkill: async () => drafted({ name: "Deploy Staging!" }) }),
		);
		expect(outcome.kind).toBe("invalid-name");
		if (outcome.kind !== "invalid-name") throw new Error("expected invalid-name outcome");
		expect(outcome.name).toBe("Deploy Staging!");
		expect(existsSync(join(cwd, CONFIG_DIR_NAME, "skills"))).toBe(false);
	});

	it("returns an invalid-name outcome for consecutive or leading/trailing hyphens", async () => {
		for (const badName of ["-bad-name", "bad-name-", "bad--name"]) {
			const outcome = await materializeRetainedSkill(
				baseOptions({ draftSkill: async () => drafted({ name: badName }) }),
			);
			expect(outcome.kind).toBe("invalid-name");
		}
	});

	it("never touches refinements.jsonl or harness_state.json (regression guard)", async () => {
		await materializeRetainedSkill(baseOptions());
		expect(existsSync(join(agentDir, "refinements.jsonl"))).toBe(false);
		expect(existsSync(join(agentDir, "harness_state.json"))).toBe(false);
		expect(existsSync(join(cwd, CONFIG_DIR_NAME, "refinements.jsonl"))).toBe(false);
		expect(existsSync(join(cwd, CONFIG_DIR_NAME, "harness_state.json"))).toBe(false);
	});

	it("passes createdBy through when explicitly provided", async () => {
		const outcome = await materializeRetainedSkill(baseOptions({ createdBy: "refine" }));
		if (outcome.kind !== "created") throw new Error("expected created outcome");
		const { frontmatter } = parseFrontmatter(readFileSync(join(outcome.skillDir, "SKILL.md"), "utf8"));
		const retained = (frontmatter.metadata as any)["prime-agent"].retained;
		expect(retained.provenance.created_by).toBe("refine");
		const events = loadRetainEvents(getProjectToolsDir(cwd));
		expect(events[0].created_by).toBe("refine");
	});

	it("retain-events.jsonl path matches the scope tools dir", async () => {
		await materializeRetainedSkill(baseOptions());
		const expectedPath = getRetainEventsPath(getProjectToolsDir(cwd));
		expect(existsSync(expectedPath)).toBe(true);
	});
});
