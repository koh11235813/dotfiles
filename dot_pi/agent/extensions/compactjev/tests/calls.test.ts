import assert from "node:assert/strict";
import { test } from "node:test";
import compactjev from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

type Excerpt = { call: string; output: string; chars: number; failed: boolean };
type Reply = { stopReason: string; errorMessage?: string; answers: Record<string, { type: "bool"; probability: number }> };
type Compaction = { summary: string; firstKeptEntryId: string; tokensBefore: number; details: any };

/** 呼び出しごとの採点を `score` で返す Jev と、calls モードにしたセッション。 */
async function host(score: (call: Excerpt) => number, reply?: (calls: Excerpt[]) => Reply | undefined) {
	const app = extensionHost();
	const asked: Excerpt[][] = [];
	Object.assign(app.ctx, {
		modelRegistry: {
			findOfType: () => ({}),
			getProviderAuthStatus: () => ({ configured: true }),
			classify: async (_model: unknown, context: { state: { calls?: Excerpt[]; lines?: string[] } }): Promise<Reply> => {
				const calls = context.state.calls;
				// lines モードに落ちたときの行ごとの採点。
				if (!calls) return { stopReason: "stop", answers: Object.fromEntries(context.state.lines!.map((_, i) => [`l${i}`, { type: "bool", probability: 0.5 }])) };
				asked.push(calls);
				return reply?.(calls) ?? { stopReason: "stop", answers: Object.fromEntries(calls.map((call, i) => [`c${i}`, { type: "bool", probability: score(call) }])) };
			},
		},
	});
	compactjev(app.pi);
	await app.emit("session_start");
	await app.command("compactjev", "calls");
	/** 圧縮の hook を走らせ、hook の返り値と Pi の要約器に残るメッセージを返す。 */
	const compact = async (messages: unknown[], options: { reserveTokens?: number; previousSummary?: string; turnPrefix?: unknown[]; fileOps?: Record<"read" | "written" | "edited", Set<string>>; signal?: AbortSignal } = {}) => {
		const preparation = {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: [...messages],
			turnPrefixMessages: [...(options.turnPrefix ?? [])],
			tokensBefore: 12345,
			previousSummary: options.previousSummary,
			fileOps: options.fileOps ?? { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			settings: { enabled: true, reserveTokens: options.reserveTokens ?? 16384, keepRecentTokens: 20000 },
		};
		const result = (await app.emit("session_before_compact", { preparation, branchEntries: app.manager.getBranch(), signal: options.signal ?? new AbortController().signal })) as { compaction?: Compaction } | undefined;
		return { compaction: result?.compaction, preparation };
	};
	return { app, asked, compact };
}

function user(text: string) {
	return { role: "user", content: text, timestamp: 0 };
}

function call(id: string, args: Record<string, unknown>, text = "", name = "bash") {
	return { role: "assistant", content: [...(text ? [{ type: "text", text }] : []), { type: "toolCall", id, name, arguments: args }], timestamp: 0 };
}

function result(id: string, text: string, isError = false, name = "bash") {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: 0 };
}

const KEPT = `FAIL login.test.ts\n${"expected 200, got 500\n".repeat(150)}`;
const STALE = `${"├── left-pad@1.3.0\n".repeat(200)}└── done`;
const SESSION = [
	user("テストが落ちる原因を調べて"),
	call("c1", { command: "npm test" }, "まずテストを走らせます。"),
	result("c1", KEPT),
	call("c2", { command: "npm ls" }),
	result("c2", STALE),
];

test("calls モードでは呼び出しごとに採点し、残す呼び出しは原文のまま、落とす呼び出しは頭と印だけにした本文を要約として返す", async () => {
	const { asked, compact } = await host((call) => (call.call.includes("npm test") ? 0.9 : 0.1));
	const { compaction, preparation } = await compact(SESSION);
	assert.ok(compaction, "hook が compaction を返していない");
	assert.equal(compaction.firstKeptEntryId, "kept-1");
	assert.equal(compaction.tokensBefore, 12345);
	assert.ok(compaction.summary.includes("[User]: テストが落ちる原因を調べて"));
	assert.ok(compaction.summary.includes("[Assistant]: まずテストを走らせます。"));
	assert.ok(compaction.summary.includes(`[Tool call]: bash(command="npm test")\n[Tool result]: ${KEPT}`));
	assert.ok(compaction.summary.includes('[Tool call]: bash(command="npm ls")'));
	assert.ok(!compaction.summary.includes(STALE));
	assert.ok(compaction.summary.includes(`${STALE.slice(0, 300)}\n[… ${STALE.length - 300} chars dropped by compactjev; session_recall(id="c2") returns the whole result]`));
	assert.deepEqual(asked.map((calls) => calls.map((call) => call.call)), [['bash(command="npm test")', 'bash(command="npm ls")']]);
	assert.deepEqual(preparation.messagesToSummarize, SESSION);
});

test("予算 (reserveTokens の 4 倍の字数) に収まらない分は、残すと採点された呼び出しでも採点の低い順に畳む", async () => {
	const { compact } = await host((call) => (call.call.includes("npm test") ? 0.6 : 0.9));
	const { compaction } = await compact(SESSION, { reserveTokens: 1500 });
	assert.ok(compaction);
	assert.ok(compaction.summary.includes(STALE));
	assert.ok(!compaction.summary.includes(KEPT));
	assert.ok(compaction.summary.length <= 6000);
});

test("発言と畳んだ呼び出しだけで予算を超えるなら compaction を返さず、行を絞って Pi の要約に任せる", async () => {
	const { app, compact } = await host(() => 0.9);
	const { compaction, preparation } = await compact(SESSION, { reserveTokens: 100 });
	assert.equal(compaction, undefined);
	assert.equal(app.notices.filter((notice) => notice.includes("calls mode not used") && notice.includes("400 chars")).length, 1);
	assert.match((preparation.messagesToSummarize[2] as ReturnType<typeof result>).content[0].text, /dropped by compactjev/);
});

test("Jev の要求が失敗したら compaction を返さず、そのたびに警告して Pi の要約に任せる", async () => {
	const { app, compact } = await host(() => 0.9, () => ({ stopReason: "error", errorMessage: "boom", answers: {} }));
	for (const round of [1, 2]) {
		const { compaction } = await compact(SESSION);
		assert.equal(compaction, undefined);
		assert.equal(app.notices.filter((notice) => notice.includes("calls mode not used (Jev request failed: boom)")).length, round);
	}
});

test("並行した Jev の要求のうち先に 1 つ失敗したら、後から別の要求が成功しても compaction を返さない", async () => {
	const { app, asked, compact } = await host(() => 0.9, (calls) => (calls.some((call) => call.call.includes('"step 0"')) ? { stopReason: "error", errorMessage: "boom", answers: {} } : undefined));
	const many = Array.from({ length: 45 }, (_, i) => [call(`c${i}`, { command: `step ${i}` }), result(`c${i}`, "y".repeat(900))]).flat();
	assert.equal((await compact(many)).compaction, undefined);
	assert.equal(asked.length, 3);
	assert.equal(app.notices.filter((notice) => notice.includes("calls mode not used (Jev request failed: boom)")).length, 1);
});

test("Jev の要求が例外を投げたら、残りの要求を出すのをやめ、警告して行を絞るほうに落とす", async () => {
	const { app, asked, compact } = await host(() => 0.9, (calls) => {
		if (calls.some((call) => call.call.includes('"step 0"'))) throw new Error("boom");
		return undefined;
	});
	// 8 要求。同時に出る 4 つより多くないと、止めたかどうかが分からない。
	const many = Array.from({ length: 160 }, (_, i) => [call(`c${i}`, { command: `step ${i}` }), result(`c${i}`, "y\n".repeat(1500))]).flat();
	const { compaction, preparation } = await compact(many);
	assert.equal(compaction, undefined);
	assert.equal(asked.length, 4);
	assert.equal(app.notices.filter((notice) => notice.includes("calls mode not used (Jev request failed: boom)")).length, 1);
	assert.ok(!app.notices.some((notice) => notice.includes("compacting without log filter")));
	assert.match((preparation.messagesToSummarize[1] as ReturnType<typeof result>).content[0].text, /dropped by compactjev/);
});

test("採点の途中で中断されたら、採点の済んでいない呼び出しを畳んだ compaction を返さない", async () => {
	const abort = new AbortController();
	const { asked, compact } = await host(() => 0.9, () => {
		abort.abort();
		return undefined;
	});
	// 5 要求。畳んだ本文が予算に収まる数にしておかないと、中断と関係なく辞退して通ってしまう。
	const many = Array.from({ length: 100 }, (_, i) => [call(`c${i}`, { command: `step ${i}` }), result(`c${i}`, "y".repeat(900))]).flat();
	const { compaction, preparation } = await compact(many, { signal: abort.signal });
	assert.equal(compaction, undefined);
	assert.equal(asked.length, 1);
	assert.deepEqual(preparation.messagesToSummarize, many);
});

test("引数が長い呼び出しを畳んだ印にも、全文の引き方を書く", async () => {
	const { compact } = await host(() => 0.1);
	const content = "A".repeat(3600);
	const { compaction } = await compact([user("書いて"), call("w1", { path: "a.txt", content }, "", "write"), result("w1", "ok", false, "write")]);
	assert.ok(compaction);
	const whole = `write(path="a.txt", content="${content}")`;
	assert.ok(compaction.summary.endsWith(`[Tool call]: ${whole.slice(0, 500)} [… ${whole.length - 500} chars dropped by compactjev; session_recall(id="w1") returns the whole call]\n[Tool result]: ok`));
});

test("畳んでも短くならない呼び出しは Jev に訊かず、畳んだ数にも数えない", async () => {
	const { app, asked, compact } = await host(() => 0.1);
	// 失敗した結果は末尾 600 字を残すので、600 字の結果は印の分だけ長くなる。
	const failed = "e".repeat(600);
	const { compaction } = await compact([user("直して"), call("c1", { command: "x".repeat(300) }), result("c1", failed, true), call("c2", { command: "npm ls" }), result("c2", STALE)]);
	assert.ok(compaction);
	assert.deepEqual(asked.map((calls) => calls.map((call) => call.call)), [['bash(command="npm ls")']]);
	assert.ok(compaction.summary.includes(`[Tool result (error)]: ${failed}\n\n`));
	assert.deepEqual(compaction.details.compactjev.items.slice(1).map((item: { kept: boolean; probability?: number }) => [item.kept, item.probability]), [[true, undefined], [false, 0.1]]);
	assert.ok(app.notices.at(-1)!.endsWith("cut 1/1 scored tool calls"));
});

test("失敗した呼び出しを畳むときは、頭ではなく末尾 600 字を残す", async () => {
	const { compact } = await host(() => 0.1);
	const failed = `${"compiling…\n".repeat(300)}error TS2322: Type 'string' is not assignable to type 'number'.\n\nCommand exited with code 2`;
	const { compaction } = await compact([user("ビルドして"), call("c1", { command: "tsc" }), result("c1", failed, true)]);
	assert.ok(compaction);
	assert.ok(compaction.summary.endsWith(`[Tool result (error)]: [… ${failed.length - 600} chars dropped by compactjev; session_recall(id="c1") returns the whole result]\n${failed.slice(-600)}`));
});

test("引数と結果を合わせて 800 字以下の呼び出しは Jev に訊かずに残し、分割されたターンの前半も続けて並べる", async () => {
	const { asked, compact } = await host(() => 0.1);
	const { compaction } = await compact([user("版を確かめて"), call("c1", { command: "node -v" }), result("c1", "v22.0.0")], {
		turnPrefix: [user("次に一覧を"), call("c2", { command: "npm ls" }), result("c2", STALE)],
	});
	assert.ok(compaction);
	assert.deepEqual(asked.map((calls) => calls.map((call) => call.call)), [['bash(command="npm ls")']]);
	const body = compaction.summary.slice(compaction.summary.indexOf("[User]"));
	assert.ok(body.startsWith('[User]: 版を確かめて\n\n[Tool call]: bash(command="node -v")\n[Tool result]: v22.0.0\n\n[User]: 次に一覧を\n\n[Tool call]: bash(command="npm ls")\n[Tool result]: ├── left-pad'));
});

test("引数と結果を合わせて 800 字以下なら、畳めば短くなる呼び出しでも Jev に訊かずに原文のまま残す", async () => {
	const { asked, compact } = await host(() => 0.1);
	const output = "z".repeat(700);
	const { compaction } = await compact([user("見て"), call("c1", { command: "x".repeat(80) }), result("c1", output), call("c2", { command: "npm ls" }), result("c2", STALE)]);
	assert.ok(compaction);
	assert.deepEqual(asked.map((calls) => calls.map((call) => call.call)), [['bash(command="npm ls")']]);
	assert.ok(compaction.summary.includes(`[Tool result]: ${output}\n\n`));
});

test("ユーザーの依頼文は、長くても途中で切らずに原文のまま並べる", async () => {
	const { compact } = await host(() => 0.1);
	const request = `${"この行は依頼の一部で、どこも落としてはいけない。\n".repeat(200)}最後に: 設定は変えないこと。`;
	const { compaction } = await compact([user(request), call("c2", { command: "npm ls" }), result("c2", STALE)]);
	assert.ok(compaction);
	assert.ok(request.length > 5000);
	assert.ok(compaction.summary.includes(`\n\n[User]: ${request}\n\n[Tool call]: bash(command="npm ls")`));
});

test("採点する呼び出しが 300 を超えたら Jev に訊かず、Pi の要約に任せる", async () => {
	const { app, asked, compact } = await host(() => 0.9);
	const many = Array.from({ length: 301 }, (_, i) => [call(`c${i}`, { command: `step ${i}` }), result(`c${i}`, "y".repeat(900))]).flat();
	assert.equal((await compact(many)).compaction, undefined);
	assert.deepEqual(asked, []);
	assert.equal(app.notices.filter((notice) => notice.includes("301 tool calls to score, over the cap of 300")).length, 1);
});

/** Pi がするように、hook の返した compaction をセッションに書く。 */
function save(app: Awaited<ReturnType<typeof host>>["app"], compaction: Compaction, fromHook = true) {
	const firstKept = app.manager.appendMessage(user("続き") as never);
	app.manager.appendCompaction(compaction.summary, firstKept, compaction.tokensBefore, compaction.details, fromHook);
}

test("前回の結果を details に持ち、次の圧縮では前回残した呼び出しも採点し直して、ユーザーの依頼文は原文のまま並べ続ける", async () => {
	let round = 1;
	const { app, asked, compact } = await host((call) => (call.call.includes("npm test") ? (round === 1 ? 0.9 : 0.2) : call.call.includes("eslint") ? 0.8 : 0.1));
	const first = (await compact(SESSION)).compaction!;
	assert.equal(first.details.compactjev.version, 1);
	assert.deepEqual(
		first.details.compactjev.items.map((item: { kind: string; kept?: boolean; probability?: number }) => [item.kind, item.kept, item.probability]),
		[["user", undefined, undefined], ["assistant", undefined, undefined], ["call", true, 0.9], ["call", false, 0.1]],
	);
	assert.deepEqual(first.details.compactjev.items[3], { kind: "call", id: "c2", call: 'bash(command="npm ls")', result: first.details.compactjev.items[3].result, error: false, chars: 22 + STALE.length, kept: false, probability: 0.1 });
	save(app, first);

	round = 2;
	asked.length = 0;
	const lint = `${"src/a.ts:1:1 error no-unused-vars\n".repeat(100)}✖ 100 problems`;
	const request = "次は lint を直して。\nただし eslint の設定は変えないこと。";
	const second = (await compact([user(request), call("c3", { command: "npx eslint ." }), result("c3", lint, true)], { previousSummary: first.summary })).compaction!;
	assert.deepEqual(asked.map((calls) => calls.map((call) => call.call)), [['bash(command="npm test")', 'bash(command="npx eslint .")']]);
	assert.ok(!second.summary.includes(KEPT));
	assert.ok(second.summary.includes(`[Tool result (error)]: ${lint}`));
	const order = ["This is not a summary.", "[User]: テストが落ちる原因を調べて", '[Tool call]: bash(command="npm test")', '[Tool call]: bash(command="npm ls")', `[User]: ${request}`, '[Tool call]: bash(command="npx eslint .")'].map((text) => second.summary.indexOf(text));
	assert.deepEqual(order, [...order].sort((a, b) => a - b));
	assert.ok(order.every((index) => index >= 0));
	assert.equal(second.summary.split("This is not a summary.").length, 2);
	assert.deepEqual(second.details.compactjev.items.map((item: { kept?: boolean }) => item.kept), [undefined, undefined, false, false, undefined, true]);
});

test("前回の圧縮が Pi の要約なら、その本文を採点せずに先頭へ置く。details が壊れているときも同じ", async () => {
	const { app, compact } = await host(() => 0.1);
	const span = [user("続きを"), call("c9", { command: "ls" }), result("c9", "a.ts")];
	save(app, { summary: "## Goal\nログインを直す", firstKeptEntryId: "", tokensBefore: 1, details: { readFiles: ["a.ts"], modifiedFiles: [] } }, false);
	const fromPi = (await compact(span, { previousSummary: "## Goal\nログインを直す" })).compaction!;
	assert.ok(fromPi.summary.includes("\n\n[Earlier summary]: ## Goal\nログインを直す\n\n[User]: 続きを\n\n"));
	save(app, { summary: "壊れた記録", firstKeptEntryId: "", tokensBefore: 1, details: { compactjev: { version: 1, items: [{ kind: "call", id: 7 }] } } });
	const broken = (await compact(span, { previousSummary: "壊れた記録" })).compaction!;
	assert.ok(broken.summary.includes("\n\n[Earlier summary]: 壊れた記録\n\n[User]: 続きを\n\n"));
});

test("details のファイル一覧は、前回の自分の結果と今回の範囲を合わせたものにする", async () => {
	const { app, compact } = await host(() => 0.1);
	const ops = (read: string[], written: string[], edited: string[]) => ({ read: new Set(read), written: new Set(written), edited: new Set(edited) });
	const first = (await compact(SESSION, { fileOps: ops(["a.ts", "b.ts"], [], ["c.ts"]) })).compaction!;
	assert.deepEqual([first.details.readFiles, first.details.modifiedFiles], [["a.ts", "b.ts"], ["c.ts"]]);
	save(app, first);
	const second = (await compact(SESSION, { previousSummary: first.summary, fileOps: ops(["d.ts"], ["b.ts"], []) })).compaction!;
	assert.deepEqual([second.details.readFiles, second.details.modifiedFiles], [["a.ts", "d.ts"], ["b.ts", "c.ts"]]);
});

test("/compactjev は方式を示し、lines に戻すと compaction を返さない", async () => {
	const { app, compact } = await host(() => 0.9);
	assert.equal(app.notices.at(-1), "compactjev mode: calls");
	await app.command("compactjev", "nope");
	assert.equal(app.notices.at(-1), "Usage: /compactjev [lines|calls]");
	await app.command("compactjev", "lines");
	assert.equal(app.notices.at(-1), "compactjev mode: lines");
	assert.equal((await compact(SESSION)).compaction, undefined);
	await app.command("compactjev");
	assert.equal(app.notices.at(-1), "compactjev mode: lines");
});
