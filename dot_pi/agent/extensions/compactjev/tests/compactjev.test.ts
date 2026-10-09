import assert from "node:assert/strict";
import { test } from "node:test";
import compactjev, { readGoal } from "../index.ts";
import goal from "../../goal/index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

type Reply = { stopReason: string; errorMessage?: string; answers: Record<string, { type: "bool"; probability: number }> };

/** Jev's reply for a request, with `score` as each line's keep-probability. */
function answer(lines: string[], score: (line: string) => number): Reply {
	return { stopReason: "stop", answers: Object.fromEntries(lines.map((line, i) => [`l${i}`, { type: "bool", probability: score(line) }])) };
}

/** A host with both extensions loaded and a Jev that records the goal of every request. */
async function host(reply: (lines: string[]) => Reply = (lines) => answer(lines, () => 0.5)) {
	const app = extensionHost();
	const goals: string[] = [];
	Object.assign(app.ctx, {
		modelRegistry: {
			findOfType: () => ({}),
			getProviderAuthStatus: () => ({ configured: true }),
			classify: async (_model: unknown, context: { state: { goal: string; lines: string[] } }) => {
				goals.push(context.state.goal);
				return reply(context.state.lines);
			},
		},
	});
	goal(app.pi);
	compactjev(app.pi);
	await app.emit("session_start");
	const compact = async (lastUserText: string, customInstructions?: string) => {
		goals.length = 0;
		await app.emit("session_before_compact", {
			preparation: {
				messagesToSummarize: [
					{ role: "user", content: lastUserText },
					{ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "building…\n".repeat(300) }] },
				],
				turnPrefixMessages: [],
			},
			branchEntries: app.manager.getBranch(),
			customInstructions,
			signal: new AbortController().signal,
		});
		assert.ok(goals.length > 0, "Jev was not asked");
		assert.equal(new Set(goals).size, 1);
		return goals[0];
	};
	/** Run the compaction hook over `messages` and return what is left for Pi's summarizer. */
	const filter = async (messages: unknown[]) => {
		const preparation = { messagesToSummarize: [...messages], turnPrefixMessages: [] };
		await app.emit("session_before_compact", { preparation, branchEntries: [], signal: new AbortController().signal });
		return preparation.messagesToSummarize;
	};
	return { app, compact, filter };
}

function toolResult(toolName: string, text: string) {
	return { role: "toolResult", toolCallId: `call-${toolName}`, toolName, content: [{ type: "text", text }] };
}

function textOf(message: unknown): string {
	return (message as ReturnType<typeof toolResult>).content[0].text;
}

/** 100 numbered lines, over Pi's 2000-character cut, spanning three Jev requests. */
const LOG = Array.from({ length: 100 }, (_, i) => `step ${i}: compiling module number ${i}`).join("\n");

test("readGoal は最後に設定された目的を返し、未設定と clear 後は空文字を返す", async () => {
	const { app } = await host();
	assert.equal(readGoal(app.manager.getBranch()), "");
	await app.command("goal", "First goal");
	assert.equal(readGoal(app.manager.getBranch()), "First goal");
	await app.command("goal", "Second goal");
	assert.equal(readGoal(app.manager.getBranch()), "Second goal");
	await app.command("goal", "clear");
	assert.equal(readGoal(app.manager.getBranch()), "");
});

test("/goal の目的が Jev に渡り、直近のユーザー発言は混ざらない", async () => {
	const { app, compact } = await host();
	await app.command("goal", "ログインを修正。APIは変更しない。");
	assert.equal(await compact("continue"), "ログインを修正。APIは変更しない。");
});

test("/compact の指示は /goal の目的の後ろに足されて Jev に渡る", async () => {
	const { app, compact } = await host();
	assert.equal(await compact("continue", "テスト結果を残す"), "テスト結果を残す");
	await app.command("goal", "ログインを修正");
	assert.equal(await compact("continue", "テスト結果を残す"), "ログインを修正\nテスト結果を残す");
});

test("目的も /compact の指示も無いときだけ直近のユーザー発言が Jev に渡る", async () => {
	const { app, compact } = await host();
	assert.equal(await compact("ビルドが落ちる原因を調べて"), "ビルドが落ちる原因を調べて");
	await app.command("goal", "ログインを修正");
	await app.command("goal", "clear");
	assert.equal(await compact("ビルドが落ちる原因を調べて"), "ビルドが落ちる原因を調べて");
});

test("予算に収まらない長い行は消さず、切り詰めた印を付けて残す", async () => {
	const { filter } = await host((lines) => answer(lines, (line) => (line.startsWith("ERROR") ? 0.9 : 0.1)));
	const [single] = await filter([toolResult("bash", "x".repeat(5000))]);
	assert.ok(textOf(single).startsWith("x".repeat(1500)));
	assert.match(textOf(single), /chars dropped by compactjev\]$/);
	assert.ok(textOf(single).length <= 2000);
	const [mixed] = await filter([toolResult("bash", `${LOG}\nERROR ${"e".repeat(3000)}\n${LOG}`)]);
	assert.match(textOf(mixed), /ERROR e{1500,}/);
	assert.ok(textOf(mixed).length <= 2000);
});

test("! で実行したコマンドの出力は Pi が切らないので絞らない", async () => {
	const { filter } = await host();
	const bang = { role: "bashExecution", command: "make", output: LOG, exitCode: 0, cancelled: false, truncated: false };
	const [left, filtered] = await filter([bang, toolResult("bash", LOG)]);
	assert.equal(left, bang);
	assert.match(textOf(filtered), /dropped by compactjev/);
});

test("Jev の採点が一部でも欠けたツール出力は絞らない", async () => {
	const failing = await host((lines) => (lines.includes("step 50: compiling module number 50") ? { stopReason: "error", errorMessage: "boom", answers: {} } : answer(lines, () => 0.5)));
	const failed = toolResult("bash", LOG);
	assert.deepEqual(await failing.filter([failed]), [failed]);
	const partial = await host((lines) => {
		const reply = answer(lines, () => 0.5);
		if (lines.includes("step 50: compiling module number 50")) delete reply.answers.l0;
		return reply;
	});
	const unanswered = toolResult("bash", LOG);
	const [left, filtered] = await partial.filter([unanswered, toolResult("other", LOG.replaceAll("step", "phase"))]);
	assert.equal(left, unanswered);
	assert.match(textOf(filtered), /dropped by compactjev/);
});

test("read・grep・find・ls の結果は絞らず、それ以外のツールの結果は絞る", async () => {
	const { filter } = await host();
	const readers = ["read", "grep", "find", "ls"].map((name) => toolResult(name, LOG));
	const others = ["bash", "subagent", "mcp_search"].map((name) => toolResult(name, LOG));
	const left = await filter([...readers, ...others]);
	assert.deepEqual(left.slice(0, 4), readers);
	for (const message of left.slice(4)) assert.match(textOf(message), /dropped by compactjev/);
});
