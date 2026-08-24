import type * as PiAi from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { draftRetainedSkillContent } from "../../src/core/retained-tools/draft.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

beforeEach(() => {
	completeSimpleMock.mockReset();
});

function draftModel(): Model<"openai-completions"> {
	return {
		id: "openai/gpt-5.5",
		name: "GPT 5.5",
		api: "openai-completions",
		provider: "prime-inference",
		baseUrl: "https://inference.primeintellect.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "prime-inference",
		model: "openai/gpt-5.5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("draftRetainedSkillContent (SARK T07)", () => {
	it("parses a well-formed JSON reply into a DraftedSkill", async () => {
		completeSimpleMock.mockResolvedValueOnce(
			assistantText(
				JSON.stringify({
					name: "deploy-staging-canary",
					description: "Runs the staging canary deploy sequence. Use when deploying to staging.",
					body: "# Deploy staging canary\n\n1. Build.\n2. Tag.\n3. Roll out.",
					summary: "Retained after solving the staging canary deploy sequence.",
				}),
			),
		);

		const drafted = await draftRetainedSkillContent(
			{ what: "deploy to staging with a canary", trajectoryText: "user: ...\nassistant: ..." },
			{ model: draftModel(), apiKey: "api-key" },
		);

		expect(drafted).toEqual({
			name: "deploy-staging-canary",
			description: "Runs the staging canary deploy sequence. Use when deploying to staging.",
			body: "# Deploy staging canary\n\n1. Build.\n2. Tag.\n3. Roll out.",
			summary: "Retained after solving the staging canary deploy sequence.",
		});
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({ apiKey: "api-key" });
	});

	it("recovers JSON wrapped in a fenced code block", async () => {
		const fence = "```";
		completeSimpleMock.mockResolvedValueOnce(
			assistantText(
				`Here you go:\n${fence}json\n${JSON.stringify({
					name: "tool-x",
					description: "Does X. Use when doing X.",
					body: "Body.",
					summary: "Summary.",
				})}\n${fence}`,
			),
		);

		const drafted = await draftRetainedSkillContent(
			{ what: "do X", trajectoryText: "..." },
			{ model: draftModel(), apiKey: "api-key" },
		);
		expect(drafted.name).toBe("tool-x");
	});

	it("recovers JSON wrapped in prose via brace slicing", async () => {
		completeSimpleMock.mockResolvedValueOnce(
			assistantText(
				`Sure, here is the skill: ${JSON.stringify({
					name: "tool-y",
					description: "Does Y. Use when doing Y.",
					body: "Body.",
					summary: "Summary.",
				})} Hope that helps!`,
			),
		);

		const drafted = await draftRetainedSkillContent(
			{ what: "do Y", trajectoryText: "..." },
			{ model: draftModel(), apiKey: "api-key" },
		);
		expect(drafted.name).toBe("tool-y");
	});

	it("defaults description and summary to empty strings when absent", async () => {
		completeSimpleMock.mockResolvedValueOnce(assistantText(JSON.stringify({ name: "tool-z", body: "Body." })));

		const drafted = await draftRetainedSkillContent(
			{ what: "do Z", trajectoryText: "..." },
			{ model: draftModel(), apiKey: "api-key" },
		);
		expect(drafted).toEqual({ name: "tool-z", description: "", body: "Body.", summary: "" });
	});

	it("throws when the model reports a length stop reason", async () => {
		completeSimpleMock.mockResolvedValueOnce({ ...assistantText('{"name": "x"'), stopReason: "length" });

		await expect(
			draftRetainedSkillContent({ what: "x", trajectoryText: "..." }, { model: draftModel(), apiKey: "api-key" }),
		).rejects.toThrow(/truncated/);
	});

	it("throws when the model reports an error stop reason", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...assistantText(""),
			stopReason: "error",
			errorMessage: "boom",
		});

		await expect(
			draftRetainedSkillContent({ what: "x", trajectoryText: "..." }, { model: draftModel(), apiKey: "api-key" }),
		).rejects.toThrow(/boom/);
	});

	it("throws when the reply is not valid JSON", async () => {
		completeSimpleMock.mockResolvedValueOnce(assistantText("not json at all"));

		await expect(
			draftRetainedSkillContent({ what: "x", trajectoryText: "..." }, { model: draftModel(), apiKey: "api-key" }),
		).rejects.toThrow(/did not return a JSON object/);
	});

	it("throws when the JSON object is missing a name", async () => {
		completeSimpleMock.mockResolvedValueOnce(assistantText(JSON.stringify({ body: "Body." })));

		await expect(
			draftRetainedSkillContent({ what: "x", trajectoryText: "..." }, { model: draftModel(), apiKey: "api-key" }),
		).rejects.toThrow(/missing a non-empty "name"/);
	});
});
