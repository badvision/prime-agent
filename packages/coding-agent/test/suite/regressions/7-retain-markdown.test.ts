import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../../../src/config.js";
import {
	SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
	type SessionSlashCommandResultMessage,
} from "../../../src/core/messages.js";
import { loadRetainEvents } from "../../../src/core/retained-tools/events.js";
import { getProjectToolsDir, loadToolIndex } from "../../../src/core/retained-tools/index.js";
import { getSkillsVersionsDir, type SkillSnapshot } from "../../../src/core/retained-tools/snapshots.js";
import { loadSkillsFromDir, type Skill } from "../../../src/core/skills.js";
import { parseFrontmatter } from "../../../src/utils/frontmatter.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * SARK T07 issue acceptance regression (docs/retained-tools/phase-b-retention.md,
 * issue #7 "/retain \"<what>\" -- markdown retention path"):
 *
 * (AC1) after solving task X in a session, `/retain "X procedure"` produces
 * `.prime/agent/skills/<name>/` (or the global equivalent) with retained
 * frontmatter, `status: active`, an index entry, and a version snapshot, and
 * a FRESH session's prompt includes the new tool's description.
 */
describe("issue #7: /retain markdown retention path (SARK T07)", () => {
	let agentDir: string;
	let harness: Harness | undefined;
	let skills: Skill[];

	beforeEach(async () => {
		const base = mkdtempSync(join(tmpdir(), "pi-retain-markdown-"));
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

	function latestResult(): SessionSlashCommandResultMessage {
		const results = harness!.session.messages.filter(
			(message): message is SessionSlashCommandResultMessage =>
				message.role === "custom" && message.customType === SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
		);
		expect(results.length).toBeGreaterThan(0);
		return results[results.length - 1];
	}

	function draftedSkillResponse(name: string, description: string, body: string, summary: string) {
		return fauxAssistantMessage(JSON.stringify({ name, description, body, summary }));
	}

	it("produces an active, indexed, snapshotted skill and a fresh session sees its description (AC1)", async () => {
		// Solve task X in this session first.
		harness!.setResponses([fauxAssistantMessage("Deployed to staging behind a canary.")]);
		await harness!.session.prompt("deploy to staging with a canary");

		// /retain "X procedure" --global: draft the skill, then materialize it.
		harness!.setResponses([
			draftedSkillResponse(
				"deploy-staging-canary",
				"Runs the staging canary deploy sequence. Use when deploying to staging.",
				"# Deploy staging canary\n\n1. Build.\n2. Tag.\n3. Roll out.",
				"Retained after solving the staging canary deploy sequence.",
			),
		]);
		await harness!.session.prompt('/retain "deploy to staging with a canary" --global');

		const result = latestResult();
		expect(result.details.success).toBe(true);
		expect(result.content).toContain('Retained tool "deploy-staging-canary"');
		expect(result.content).toContain("status: active, version: 1");

		// File on disk with correct frontmatter.
		const skillDir = join(agentDir, "skills", "deploy-staging-canary");
		const skillMdPath = join(skillDir, "SKILL.md");
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

		// Index entry.
		const globalIndex = loadToolIndex(join(agentDir, "tools"));
		const entry = globalIndex.skills["deploy-staging-canary"];
		expect(entry).toBeDefined();
		expect(entry.scope).toBe("global");
		expect(entry.status).toBe("active");
		expect(entry.version).toBe(1);
		expect(entry.path).toBe("skills/deploy-staging-canary");

		// Version snapshot exists immediately, byte-identical to the written SKILL.md.
		const snapshotPath = join(getSkillsVersionsDir(agentDir), "global", "deploy-staging-canary", "1.json");
		expect(existsSync(snapshotPath)).toBe(true);
		const snapshot: SkillSnapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
		expect(snapshot.content).toBe(raw);

		// Retain event recorded (not a continual-harness refinement event).
		const events = loadRetainEvents(join(agentDir, "tools"));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ action: "create", scope: "global", name: "deploy-staging-canary" });
		expect(existsSync(join(agentDir, "refinements.jsonl"))).toBe(false);
		expect(existsSync(join(agentDir, "harness_state.json"))).toBe(false);

		// A FRESH session/harness instance built after the write includes the
		// new tool's description in its rendered <available_skills> prompt block.
		const { skills: freshSkills, diagnostics } = loadSkillsFromDir({
			dir: join(agentDir, "skills"),
			source: "user",
		});
		expect(diagnostics).toHaveLength(0);
		const freshHarness = await createHarness({
			resourceLoader: createTestResourceLoader({ skills: freshSkills }),
		});
		try {
			const prompt = freshHarness.session.systemPrompt;
			expect(prompt).toContain("<name>deploy-staging-canary</name>");
			expect(prompt).toContain("Runs the staging canary deploy sequence. Use when deploying to staging.");
		} finally {
			freshHarness.cleanup();
		}
	});

	it("blocks on a project-scope name collision and leaves the existing skill untouched", async () => {
		mkdirSync(join(harness!.tempDir, CONFIG_DIR_NAME, "skills", "existing-tool"), { recursive: true });

		harness!.setResponses([draftedSkillResponse("existing-tool", "Existing tool.", "Body.", "Summary.")]);
		await harness!.session.prompt('/retain "do the existing thing"');

		const result = latestResult();
		expect(result.details.success).toBe(true);
		expect(result.content).toBe(
			'Retain blocked: a skill named "existing-tool" already exists (scope: project, path: ' +
				join(harness!.tempDir, CONFIG_DIR_NAME, "skills", "existing-tool") +
				"). Rerun /retain with different wording, or rename the existing skill manually.",
		);
		expect(existsSync(join(harness!.tempDir, CONFIG_DIR_NAME, "skills", "existing-tool", "SKILL.md"))).toBe(false);
		const projectIndex = loadToolIndex(getProjectToolsDir(harness!.tempDir));
		expect(projectIndex.skills["existing-tool"]).toBeUndefined();
	});

	it("rejects malformed /retain input with the usage line and never calls the model", async () => {
		harness!.setResponses([]);
		await harness!.session.prompt("/retain deploy to staging");

		const result = latestResult();
		expect(result.details.success).toBe(false);
		expect(result.content).toBe('Command failed: Usage: /retain "<what>" [--global]');
		expect(harness!.getPendingResponseCount()).toBe(0);
	});
});
