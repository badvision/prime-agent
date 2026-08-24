import type { Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";

export interface DraftedSkill {
	name: string;
	description: string;
	body: string;
	summary: string;
}

export interface DraftSkillInput {
	what: string;
	trajectoryText: string;
}

export type DraftSkillFn = (input: DraftSkillInput) => Promise<DraftedSkill>;

export interface DraftRetainedSkillLlmOptions {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	maxTokens?: number;
}

/**
 * Cite the skill-creator naming/description rules directly so the drafted
 * name and description already satisfy skills.ts's loader validation
 * (packages/coding-agent/skills/skill-creator/SKILL.md, "Frontmatter" table).
 */
const DRAFT_SYSTEM_PROMPT = `You draft a Prime Agent skill directory from a solved session procedure.

Return ONLY a JSON object with these fields:
- "name": lowercase a-z, 0-9, and hyphens only. Max 64 characters. No leading, trailing, or consecutive hyphens. Short and specific (e.g. "deploy-staging-canary").
- "description": what the skill does and when to use it ("Use when ..."), max 1024 characters. This is the only text shown to a future session before it decides to load the skill, so name the concrete tasks and trigger phrases.
- "body": the SKILL.md markdown body (no frontmatter) documenting the procedure/call contract as reusable instructions.
- "summary": one or two sentences summarizing why this procedure was retained, for the frontmatter provenance record.

Return only the JSON object, no prose, no markdown code fences.`;

function isIncompleteJson(candidate: string): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const char of candidate) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") depth--;
	}
	return inString || depth > 0;
}

function parseJsonCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch (error) {
		if (isIncompleteJson(candidate)) {
			throw new Error("the model's reply was truncated before completing its JSON object");
		}
		throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Local, private JSON extraction: a trimmed copy of refinement.ts's
 * extractJsonObject covering the fenced-code-block and brace-slice cases.
 * refinement.ts's version is private and delicate; DraftedSkill's schema is
 * much smaller than RefinementProposal's, so this deliberately does not
 * import or export that helper.
 */
function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return parseJsonCandidate(trimmed);
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		return parseJsonCandidate(fenced[1].trim());
	}
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return parseJsonCandidate(trimmed.slice(start));
		}
	}
	if (isIncompleteJson(trimmed)) {
		throw new Error("the model's reply was truncated before completing its JSON object");
	}
	throw new Error("the model did not return a JSON object for the drafted skill");
}

function parseDraftedSkill(text: string): DraftedSkill {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Drafted skill JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || !record.name.trim()) {
		throw new Error('Drafted skill JSON is missing a non-empty "name"');
	}
	if (typeof record.body !== "string") {
		throw new Error('Drafted skill JSON is missing a "body"');
	}
	return {
		name: record.name.trim(),
		description: typeof record.description === "string" ? record.description : "",
		body: record.body,
		summary: typeof record.summary === "string" ? record.summary : "",
	};
}

/**
 * Draft a retained skill's name/description/body/summary from a free-text
 * "<what>" and the recent session trajectory, via one LLM call. Uses the same
 * completeSimple call shape refinement.ts already uses for its planning pass.
 */
export async function draftRetainedSkillContent(
	input: DraftSkillInput,
	llm: DraftRetainedSkillLlmOptions,
): Promise<DraftedSkill> {
	const userPrompt = [
		`<what>\n${input.what}\n</what>`,
		`<session_trajectory>\n${input.trajectoryText}\n</session_trajectory>`,
		"Return only the JSON object described in the system prompt.",
	].join("\n\n");

	const response = await completeSimple(
		llm.model,
		{
			systemPrompt: DRAFT_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{ maxTokens: llm.maxTokens ?? 4_000, signal: llm.signal, apiKey: llm.apiKey, headers: llm.headers },
	);

	if (response.stopReason === "error") {
		throw new Error(`Drafting the retained skill failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(
			"Drafting the retained skill failed: the model's reply was truncated before completing its JSON object",
		);
	}

	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return parseDraftedSkill(text);
}
