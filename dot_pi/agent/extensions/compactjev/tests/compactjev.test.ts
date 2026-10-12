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
	const { app, filter } = await host((lines) => answer(lines, (line) => (line.startsWith("ERROR") ? 0.9 : 0.1)));
	const [mixed] = await filter([toolResult("bash", `${LOG}\nERROR ${"e".repeat(3000)}\n${LOG}`)]);
	assert.match(textOf(mixed), /ERROR e{1500,}/);
	assert.match(textOf(mixed), /chars dropped by compactjev\]/);
	assert.ok(textOf(mixed).length <= 2000);
	assert.deepEqual(records(app).at(-1).outputs[0].lines[100], { chars: 3006, probability: 0.9, kept: true });
});

/** 失敗したツール結果。Pi は bash の失敗・中断・時間切れと、例外を投げたツールに isError を立てる。 */
function failedResult(text: string) {
	return { ...toolResult("bash", text), isError: true };
}

test("失敗したコマンドの出力は、末尾 600 字に収まる行を Jev に訊かずに残す", async () => {
	const seen: string[] = [];
	const { app, filter } = await host((lines) => {
		seen.push(...lines);
		return answer(lines, (line) => (line.startsWith("step 0:") ? 0.9 : 0.1));
	});
	const tail = [...LOG.split("\n").slice(-15), "error: build failed", "Command exited with code 1"];
	const [filtered] = await filter([failedResult(`${LOG}\n${LOG}\nerror: build failed\n\nCommand exited with code 1`)]);
	assert.ok(textOf(filtered).startsWith("step 0: compiling module number 0\n"));
	assert.ok(textOf(filtered).endsWith(`lines dropped by compactjev]\n${tail.join("\n")}`));
	assert.ok(textOf(filtered).length <= 2000);
	assert.equal(seen.length, 200 - 15);
	const { lines } = records(app).at(-1).outputs[0];
	assert.deepEqual(lines.at(-1), { chars: 26, probability: 1, kept: true, pinned: true });
	assert.equal(lines.filter((line: { pinned?: boolean }) => line.pinned).length, 17);
});

test("失敗したコマンドの長い 1 行は頭を切り詰め、Jev に訊かずに終了状態の行を残す", async () => {
	let asked = 0;
	const { filter } = await host((lines) => {
		asked++;
		return answer(lines, () => 0.5);
	});
	for (const status of ["Command exited with code 1", "Command aborted", "Command timed out after 30 seconds", "Command terminated without an exit code"]) {
		const [filtered] = await filter([failedResult(`${"x".repeat(5000)}\n\n${status}`)]);
		assert.match(textOf(filtered), new RegExp(`^x{1500,} \\[… \\d+ chars dropped by compactjev\\]\n${status}$`));
		assert.ok(textOf(filtered).length <= 2000);
	}
	assert.equal(asked, 0);
});

test("失敗した出力の最後の行だけで 600 字を超えるなら、その行の終わりを残す", async () => {
	const { filter } = await host();
	const [filtered] = await filter([failedResult(`${LOG}\nError: ${"e".repeat(3000)} at END`)]);
	assert.match(textOf(filtered), /\n\[… 2\d\d\d chars dropped by compactjev\] e{400,} at END$/);
	assert.ok(textOf(filtered).length <= 2000);
});

test("失敗した出力が長い 1 行だけなら、終わりに加えて頭も残し、Pi の頭 2000 字より減らしすぎない", async () => {
	const { filter } = await host();
	const [filtered] = await filter([failedResult(`HEAD-${"x".repeat(5000)}-TAIL\n`)]);
	assert.match(textOf(filtered), /^HEAD-x{1000,} \[… \d+ chars dropped by compactjev\] x{400,}-TAIL$/);
	assert.ok(textOf(filtered).length > 1700 && textOf(filtered).length <= 2000);
});

test("失敗した出力は Jev の採点が欠けても、頭と末尾を残して絞る", async () => {
	const { app, filter } = await host((lines) => (lines.includes("step 50: compiling module number 50") ? { stopReason: "error", errorMessage: "boom", answers: {} } : answer(lines, () => 0.5)));
	const succeeded = toolResult("bash", LOG);
	const [left, filtered] = await filter([succeeded, failedResult(`${LOG}\n${LOG}\n\nCommand exited with code 1`), toolResult("other", LOG.replaceAll("step", "phase"))]);
	assert.equal(left, succeeded);
	assert.ok(textOf(filtered).startsWith("step 0: compiling module number 0\nstep 1: compiling module number 1\n"));
	assert.ok(textOf(filtered).endsWith("step 99: compiling module number 99\nCommand exited with code 1"));
	assert.ok(textOf(filtered).length <= 2000);
	const record = records(app).at(-1);
	assert.deepEqual(record.unfiltered.map((output: { toolCallId: string }) => output.toolCallId), ["call-bash"]);
	assert.equal(record.outputs[0].failed, 2);
});

test("空行を除いて 1 行しかない出力は Jev に訊かず、Pi の 2000 字切りに任せる", async () => {
	let asked = 0;
	const { app, filter } = await host((lines) => {
		asked++;
		return answer(lines, () => 0.5);
	});
	const single = toolResult("bash", `\n${"x".repeat(5000)}\n`);
	assert.deepEqual(await filter([single]), [single]);
	assert.equal(asked, 0);
	const [left, filtered] = await filter([single, toolResult("other", LOG)]);
	assert.equal(left, single);
	assert.match(textOf(filtered), /dropped by compactjev/);
	assert.deepEqual(records(app).at(-1).unfiltered, []);
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

test("一部の Jev 要求が失敗した圧縮が 2 回続いたら一度だけ警告し、成功を挟むまで繰り返さない", async () => {
	let broken = true;
	const { app, filter } = await host((lines) => (broken && lines.includes("step 50: compiling module number 50") ? { stopReason: "error", errorMessage: "boom", answers: {} } : answer(lines, () => 0.5)));
	const compact = () => filter([toolResult("bash", LOG), toolResult("other", LOG.replaceAll("step", "phase"))]);
	const warnings = () => app.notices.filter((notice) => notice.includes("in a row"));
	await compact();
	assert.deepEqual(warnings(), []);
	await compact();
	assert.deepEqual(warnings(), ["compactjev: Jev requests failed in 2 compactions in a row (boom); the tool outputs they covered are not being filtered"]);
	await compact();
	assert.equal(warnings().length, 1);
	broken = false;
	await compact();
	broken = true;
	await compact();
	assert.equal(warnings().length, 1);
	await compact();
	assert.equal(warnings().length, 2);
});

test("Jev の要求が全滅した圧縮も連続に数え、次の圧縮が一部失敗なら警告する", async () => {
	let mode: "all" | "partial" = "all";
	const { app, filter } = await host((lines) => (mode === "all" || lines.includes("step 50: compiling module number 50") ? { stopReason: "error", errorMessage: "boom", answers: {} } : answer(lines, () => 0.5)));
	const compact = () => filter([toolResult("bash", LOG), toolResult("other", LOG.replaceAll("step", "phase"))]);
	await compact();
	assert.equal(app.notices.filter((notice) => notice.includes("all 6 Jev requests failed")).length, 1);
	assert.deepEqual(app.notices.filter((notice) => notice.includes("in a row")), []);
	mode = "partial";
	await compact();
	assert.equal(app.notices.filter((notice) => notice.includes("in 2 compactions in a row")).length, 1);
});

test("記録を書けなくても絞った結果は渡し、絞らなかったとは知らせない", async () => {
	const { app, filter } = await host();
	app.pi.appendEntry = () => {
		throw new Error("disk full");
	};
	const [filtered] = await filter([toolResult("bash", LOG)]);
	assert.match(textOf(filtered), /dropped by compactjev/);
	assert.deepEqual(app.notices.filter((notice) => notice.includes("without log filter")), []);
	assert.deepEqual(app.notices.filter((notice) => notice.includes("disk full")), ["compactjev: loss record not saved: disk full"]);
});

test("Jev の要求が全滅しても、失敗した出力だけは頭と末尾を残して絞る", async () => {
	const { app, filter } = await host(() => ({ stopReason: "error", errorMessage: "boom", answers: {} }));
	const succeeded = toolResult("other", LOG);
	const [left, filtered] = await filter([succeeded, failedResult(`${LOG}\n${LOG}\n\nCommand exited with code 1`)]);
	assert.equal(left, succeeded);
	assert.ok(textOf(filtered).endsWith("step 99: compiling module number 99\nCommand exited with code 1"));
	assert.ok(textOf(filtered).length <= 2000);
	assert.deepEqual(app.notices.filter((notice) => notice.includes("all 8 Jev requests failed")), ["compactjev: all 8 Jev requests failed (boom) — keeping only the head and tail of failed tool outputs"]);
	await filter([succeeded, failedResult(`${LOG}\n${LOG}\n\nCommand exited with code 1`)]);
	assert.deepEqual(app.notices.filter((notice) => notice.includes("in a row")), []);
});

test("Jev に訊かなかった圧縮は、連続失敗の数を変えない", async () => {
	let broken = true;
	const { app, filter } = await host((lines) => (broken && lines.includes("step 50: compiling module number 50") ? { stopReason: "error", errorMessage: "boom", answers: {} } : answer(lines, () => 0.5)));
	const compact = () => filter([toolResult("bash", LOG), toolResult("other", LOG.replaceAll("step", "phase"))]);
	await compact();
	await filter([failedResult(`${"x".repeat(5000)}\n\nCommand exited with code 1`)]);
	await compact();
	assert.equal(app.notices.filter((notice) => notice.includes("in 2 compactions in a row")).length, 1);
});

/** そのセッションに残った compactjev の記録。 */
function records(app: Awaited<ReturnType<typeof host>>["app"]) {
	return app.manager.getEntries().flatMap((entry) => (entry.type === "custom" && entry.customType === "compactjev" ? [entry.data as any] : []));
}

test("絞った出力ごとに、落とした行の本文と各行の採点、絞った後の本文をセッションに記録する", async () => {
	const { app, filter } = await host((lines) => answer(lines, (line) => (line.startsWith("ERROR") ? 0.9 : 0.1)));
	const long = `ERROR ${"e".repeat(400)}`;
	const [filtered] = await filter([toolResult("bash", `${LOG}\n\n${long}\nERROR short\n${LOG}`)]);
	const [record, ...rest] = records(app);
	assert.deepEqual(rest, []);
	assert.equal(record.version, 1);
	const [output] = record.outputs;
	assert.equal(output.toolCallId, "call-bash");
	assert.equal(output.command, "bash");
	assert.equal(output.after, textOf(filtered));
	assert.equal(output.blankLines, 1);
	assert.equal(output.batches, 6);
	assert.equal(output.lines.length, 202);
	assert.deepEqual(output.lines[100], { chars: long.length, probability: 0.9, kept: true });
	assert.deepEqual(output.lines[101], { chars: 11, probability: 0.9, kept: true });
	const dropped = output.lines.filter((line: { kept: boolean }) => !line.kept);
	assert.ok(dropped.length > 100);
	const last = "step 99: compiling module number 99";
	assert.deepEqual(dropped.at(-1), { chars: last.length, probability: 0.1, kept: false, text: last });
});

test("落とした行の本文は Jev に見せた長さまでしか記録しない", async () => {
	const { app, filter } = await host((lines) => answer(lines, (line) => (line.startsWith("noise") ? 0.1 : 0.9)));
	await filter([toolResult("bash", `noise ${"n".repeat(5000)}\n${LOG}`)]);
	const [{ lineChars, batchLines, outputs: [output] }] = records(app);
	assert.equal(lineChars, 300);
	assert.equal(batchLines, 40);
	assert.equal(output.before, 5006 + 1 + LOG.length);
	assert.deepEqual(output.lines[0], { chars: 5006, probability: 0.1, kept: false, text: `noise ${"n".repeat(294)}` });
});

test("採点が欠けて絞らなかった出力は、本文を持たずに大きさと失敗数だけ記録する", async () => {
	const { app, filter } = await host((lines) => (lines.includes("step 50: compiling module number 50") ? { stopReason: "error", errorMessage: "boom", answers: {} } : answer(lines, () => 0.5)));
	await filter([toolResult("bash", LOG), toolResult("other", LOG.replaceAll("step", "phase"))]);
	const [record] = records(app);
	assert.deepEqual(record.unfiltered, [{ toolCallId: "call-bash", command: "bash", chars: LOG.length, batches: 3, failed: 1 }]);
	assert.equal(record.outputs.length, 1);
});
