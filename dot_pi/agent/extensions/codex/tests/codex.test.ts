import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import codex from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

// 本物の codex は起こさない。PI_CODEX_BIN を、ここに置いた偽物に向ける。
const base = realpathSync(mkdtempSync(join(tmpdir(), "codex-ext-")));
const work = join(base, "work");
mkdirSync(join(work, "sub"), { recursive: true });
const fake = join(base, "codex");
/**
 * 偽の codex。引数・cwd・stdin・pid を FAKE_CODEX_DIR に書き、そこにある out.jsonl を出して code で終わる。
 * delay があればその秒数待ってから出す。hang があれば、子を 1 つ残して返らない (本物が考えている状態)。
 */
writeFileSync(
	fake,
	`#!/bin/bash
d="$FAKE_CODEX_DIR"
echo "start $$" >> "$d/log"
echo "$$" > "$d/pid"
pwd -P > "$d/cwd"
printf '%s\\n' "$@" > "$d/args"
cat > "$d/stdin"
echo "2026-01-01 ERROR codex_core: unrelated log line" >&2
[ -f "$d/delay" ] && sleep "$(cat "$d/delay")"
if [ -f "$d/hang" ]; then
	head -c 60 "$d/out.jsonl"; sleep 0.1; tail -c +61 "$d/out.jsonl"
	sleep 30 & echo $! > "$d/child"
	exec sleep 30
fi
cat "$d/out.jsonl"
echo "end $$" >> "$d/log"
exit "$(cat "$d/code" 2>/dev/null || echo 0)"
`,
);
chmodSync(fake, 0o755);
process.env.PI_CODEX_BIN = fake;

after(() => rmSync(base, { recursive: true, force: true }));

const THREAD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const STARTED = line({ type: "thread.started", thread_id: THREAD });
const WARNING = line({ type: "item.completed", item: { id: "item_0", type: "error", message: "`foo` is deprecated" } });
const answerLine = (text: string) => line({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
const COMPLETED = line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });

let count = 0;
/** 1 回分の偽 codex の置き場。out.jsonl の中身と終了コードを決めておく。 */
function scenario(out: string, options: { code?: number; hang?: boolean; delay?: number } = {}) {
	const dir = join(base, `run-${++count}`);
	mkdirSync(dir);
	writeFileSync(join(dir, "out.jsonl"), out);
	if (options.code !== undefined) writeFileSync(join(dir, "code"), String(options.code));
	if (options.hang) writeFileSync(join(dir, "hang"), "");
	if (options.delay) writeFileSync(join(dir, "delay"), String(options.delay));
	process.env.FAKE_CODEX_DIR = dir;
	const read = (name: string) => readFileSync(join(dir, name), "utf8");
	return { dir, read, args: () => read("args").trimEnd().split("\n"), log: () => (existsSync(join(dir, "log")) ? read("log").trim().split("\n") : []) };
}

function session() {
	const app = extensionHost();
	codex(app.pi);
	app.ctx.cwd = work;
	const call = (name: string, params: Record<string, unknown>, signal = new AbortController().signal) =>
		app.registeredTools.get(name)!.execute("call-1", params, signal, () => {}, app.ctx) as Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
	return { app, call };
}

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("成功すると最後の答えと threadId を返し、sandbox と承認を明示して起こし、プロンプトは stdin で渡す", async () => {
	const fakeRun = scenario(STARTED + line({ type: "turn.started" }) + answerLine("first") + answerLine("OK") + COMPLETED);
	const { call } = session();
	const result = await call("codex", { prompt: "reply with exactly OK" });

	assert.equal(result.content[0].text, `OK\n\nthreadId: ${THREAD}`);
	assert.deepEqual(result.details, { threadId: THREAD, cwd: work, sandbox: "read-only", model: undefined, effort: undefined });
	assert.deepEqual(fakeRun.args(), ["exec", "--json", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "--skip-git-repo-check", "--", "-"]);
	assert.equal(fakeRun.read("stdin"), "reply with exactly OK");
	assert.equal(fakeRun.read("cwd").trim(), work);
});

test("codex_reply は thread の cwd・sandbox・model・effort を戻し、-s と -C を使わずに id を明示して続ける", async () => {
	scenario(STARTED + answerLine("one") + COMPLETED);
	const { call } = session();
	await call("codex", { prompt: "first", cwd: "sub", sandbox: "workspace-write", model: "gpt-test", effort: "high" });

	const fakeRun = scenario(answerLine("two") + COMPLETED);
	const result = await call("codex_reply", { threadId: THREAD, prompt: "again" });

	assert.equal(result.content[0].text, `two\n\nthreadId: ${THREAD}`);
	assert.deepEqual(fakeRun.args(), ["exec", "resume", "--json", "-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"', "-c", 'model_reasoning_effort="high"', "-m", "gpt-test", "--", THREAD, "-"]);
	assert.equal(fakeRun.read("cwd").trim(), join(work, "sub"));
	assert.equal(fakeRun.read("stdin"), "again");
	assert.ok(!fakeRun.args().includes("--last") && !fakeRun.args().includes("--ephemeral"));
});

test("codex_reply は、別のプロセスで始めた thread の設定をセッションの枝の結果から引く", async () => {
	const { app, call } = session();
	app.manager.appendMessage({
		role: "toolResult",
		toolCallId: "call-0",
		toolName: "codex",
		content: [{ type: "text", text: "earlier" }],
		details: { threadId: THREAD, cwd: join(work, "sub"), sandbox: "workspace-write", effort: "low" },
		isError: false,
		timestamp: Date.now(),
	} as never);
	const fakeRun = scenario(answerLine("restored") + COMPLETED);
	await call("codex_reply", { threadId: THREAD, prompt: "go on" });

	assert.ok(fakeRun.args().includes('sandbox_mode="workspace-write"'));
	assert.ok(fakeRun.args().includes('model_reasoning_effort="low"'));
	assert.equal(fakeRun.read("cwd").trim(), join(work, "sub"));
});

test("知らない threadId は codex を起こさずに断る", async () => {
	const fakeRun = scenario(answerLine("x") + COMPLETED);
	const { call } = session();
	await assert.rejects(call("codex_reply", { threadId: "nope", prompt: "x" }), /unknown threadId nope/);
	assert.ok(!existsSync(join(fakeRun.dir, "args")));
});

test("同じ thread への codex_reply は 1 つずつ走る", async () => {
	scenario(STARTED + answerLine("one") + COMPLETED);
	const { call } = session();
	await call("codex", { prompt: "first" });

	const fakeRun = scenario(answerLine("next") + COMPLETED, { delay: 0.3 });
	await Promise.all([call("codex_reply", { threadId: THREAD, prompt: "a" }), call("codex_reply", { threadId: THREAD, prompt: "b" })]);
	assert.deepEqual(
		fakeRun.log().map((entry) => entry.split(" ")[0]),
		["start", "end", "start", "end"],
	);
});

test("item.completed の error (警告) と JSON でない行では失敗しない", async () => {
	scenario(STARTED + WARNING + "not json\n" + answerLine("fine") + COMPLETED);
	const { call } = session();
	const result = await call("codex", { prompt: "x" });
	assert.equal(result.content[0].text, `fine\n\nthreadId: ${THREAD}`);
});

test("turn.failed は失敗で、理由と stderr の末尾と threadId を出す", async () => {
	scenario(STARTED + line({ type: "turn.failed", error: { message: "model overloaded" } }));
	const { call } = session();
	await assert.rejects(call("codex", { prompt: "x" }), (error: Error) => {
		assert.match(error.message, /model overloaded/);
		assert.match(error.message, new RegExp(`threadId: ${THREAD}`));
		assert.match(error.message, /stderr tail:\n.*unrelated log line/);
		return true;
	});
});

test("トップレベルの error は、答えと turn.completed があっても失敗", async () => {
	scenario(STARTED + line({ type: "error", message: "stream disconnected" }) + answerLine("partial") + COMPLETED);
	const { call } = session();
	await assert.rejects(call("codex", { prompt: "x" }), /stream disconnected/);
});

test("終了コードが 0 でなければ、答えがあっても失敗", async () => {
	scenario(STARTED + answerLine("OK") + COMPLETED, { code: 3 });
	const { call } = session();
	await assert.rejects(call("codex", { prompt: "x" }), /exit code 3/);
});

test("agent_message が無ければ失敗", async () => {
	scenario(STARTED + COMPLETED);
	const { call } = session();
	await assert.rejects(call("codex", { prompt: "x" }), /no final agent message/);
});

test("turn.completed が無ければ失敗", async () => {
	scenario(STARTED + answerLine("OK"));
	const { call } = session();
	await assert.rejects(call("codex", { prompt: "x" }), /no turn\.completed event/);
});

test("codex を起こせなければ失敗", async () => {
	scenario("");
	const { call } = session();
	process.env.PI_CODEX_BIN = join(base, "missing-codex");
	try {
		await assert.rejects(call("codex", { prompt: "x" }), /could not start/);
	} finally {
		process.env.PI_CODEX_BIN = fake;
	}
});

test("作業ディレクトリの外の cwd は、symlink を通しても断る", async () => {
	const fakeRun = scenario(STARTED + answerLine("OK") + COMPLETED);
	symlinkSync(base, join(work, "escape"));
	const { call } = session();
	await assert.rejects(call("codex", { prompt: "x", cwd: ".." }), /must be inside the working directory/);
	await assert.rejects(call("codex", { prompt: "x", cwd: "/" }), /must be inside the working directory/);
	await assert.rejects(call("codex", { prompt: "x", cwd: "escape" }), /must be inside the working directory/);
	await assert.rejects(call("codex", { prompt: "x", cwd: "missing" }), /cwd does not exist/);
	assert.ok(!existsSync(join(fakeRun.dir, "args")));
});

test("中断すると codex をその子ごと止め、止まり切ってから返る", async () => {
	const fakeRun = scenario(STARTED, { hang: true });
	const { call } = session();
	const controller = new AbortController();
	const pending = call("codex", { prompt: "x" }, controller.signal);
	for (let i = 0; !existsSync(join(fakeRun.dir, "child")); i++) {
		if (i > 300) throw new Error("fake codex did not start");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	controller.abort();
	await assert.rejects(pending, new RegExp(`cancelled \\(threadId: ${THREAD}\\)`));
	assert.equal(alive(Number(fakeRun.read("pid"))), false);
	assert.equal(alive(Number(fakeRun.read("child"))), false);
});

test("PI_CODEX_TIMEOUT_MS を過ぎると止めて失敗にし、その thread は codex_reply で続けられる", async () => {
	const fakeRun = scenario(STARTED, { hang: true });
	const { call } = session();
	process.env.PI_CODEX_TIMEOUT_MS = "500";
	try {
		await assert.rejects(call("codex", { prompt: "x" }), /timed out after 500 ms/);
	} finally {
		delete process.env.PI_CODEX_TIMEOUT_MS;
	}
	assert.equal(alive(Number(fakeRun.read("pid"))), false);
	assert.equal(alive(Number(fakeRun.read("child"))), false);

	scenario(answerLine("resumed") + COMPLETED);
	const result = await call("codex_reply", { threadId: THREAD, prompt: "continue" });
	assert.equal(result.content[0].text, `resumed\n\nthreadId: ${THREAD}`);
});

test("session_shutdown は走っている codex を止め、止まり切るのを待つ", async () => {
	const fakeRun = scenario(STARTED, { hang: true });
	const { app, call } = session();
	const pending = call("codex", { prompt: "x" }).catch((error: Error) => error);
	for (let i = 0; !existsSync(join(fakeRun.dir, "child")); i++) {
		if (i > 300) throw new Error("fake codex did not start");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	await app.emit("session_shutdown", { reason: "quit" });
	assert.equal(alive(Number(fakeRun.read("pid"))), false);
	assert.match(String(await pending), /cancelled/);
});
