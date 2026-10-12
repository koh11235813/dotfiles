import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import guard from "../index.ts";
import type { JobSummary } from "../monitor/jobs.ts";
import { EXTRA_WRITE_PATHS, sandbox, sandboxAvailable } from "../sandbox.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

// 実物の sandbox が動くかは、下で判定を固定する前に確かめておく。
const cannotRun = process.platform === "linux" ? !sandboxAvailable() : process.platform !== "darwin";

// 本物の HOME と一時ディレクトリを root にしない (permissions.test.ts と同じ理由)。job のログもこの下に出る。
EXTRA_WRITE_PATHS.splice(0, 2);
const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-monitor-")));
const dir = (...parts: string[]) => {
	const path = join(base, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
};
process.env.TMPDIR = dir("tmp");
process.env.HOME = dir("home");
delete process.env.PI_GUARD;
sandbox.available = true;

type App = ReturnType<typeof extensionHost>;
const apps: App[] = [];
after(async () => {
	for (const app of apps) await app.emit("session_shutdown", { reason: "quit" });
	rmSync(base, { recursive: true, force: true });
});

/** guard を載せたセッション。sandbox の実物に左右されない検証は full で job を走らせる。 */
async function session(mode = "full") {
	const app = extensionHost();
	apps.push(app);
	guard(app.pi);
	app.ctx.cwd = dir("work", String(apps.length));
	await app.emit("session_start");
	await app.command("permissions", mode);
	const tool = (name: string) => app.registeredTools.get(name)!;
	return {
		app,
		start: async (command: string, extra: Record<string, unknown> = {}) =>
			(await tool("monitor").execute("call-1", { command, ...extra }, undefined, undefined, app.ctx)).details as JobSummary,
		jobs: async (action: string, id?: string): Promise<string> =>
			(await tool("jobs").execute("call-2", { action, id }, undefined, undefined, app.ctx)).content[0].text,
	};
}

const call = (toolName: string, input: Record<string, unknown> = {}) => ({ toolName, toolCallId: "call-1", input });
const blocked = (result: unknown) => (result as { block?: boolean } | undefined)?.block === true;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (condition()) return;
		await pause(10);
	}
	assert.fail(`timed out waiting for ${what}`);
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** pid を書いてから居座るコマンドと、その pid。 */
async function sleeper(start: (command: string) => Promise<JobSummary>, cwd: string) {
	const job = await start("echo $$ > pid; echo started; sleep 30");
	await until(() => existsSync(join(cwd, "pid")) && readFileSync(join(cwd, "pid"), "utf8").endsWith("\n"), "the job to write its pid");
	return { job, pid: Number(readFileSync(join(cwd, "pid"), "utf8")) };
}

test("monitorは終了を待たずにjobを返し、終わると知らせが1度だけ届く", async () => {
	const { app, start } = await session();
	process.env.PI_SESSION_ID = "inherited-from-parent";
	const gate = join(app.ctx.cwd, "gate");
	const job = await start(`while [ ! -e ${gate} ]; do sleep 0.02; done; echo "session=$PI_SESSION_ID"; echo oops >&2; exit 3`);
	delete process.env.PI_SESSION_ID;
	assert.equal(job.state, "running");
	assert.equal(app.messages.length, 0);

	writeFileSync(gate, "");
	await until(() => app.messages.length > 0, "the notification");
	const { message, options } = app.messages[0];
	assert.equal(message.customType, "monitor-job");
	assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
	const text = message.content as string;
	assert.match(text, new RegExp(`${job.id}  failed \\(exit 3\\)`));
	assert.ok(text.includes(job.logPath));
	// 親から継いだ値ではなく、このセッションの id が渡る。
	assert.ok(text.includes(`session=${app.manager.getSessionId()}\noops\n`), text);
	assert.match(text, /untrusted command data/);
	assert.equal((message.details as JobSummary).exitCode, 3);
	await pause(50);
	assert.equal(app.messages.length, 1);
});

test("monitorにはbashと同じ固定禁止・sandboxの有無・モードの判定が掛かる", async () => {
	const { app } = await session();
	const monitor = (command: string) => app.emit("tool_call", call("monitor", { command }));
	// 自己申告のヒントでは読み取り専用にならない。
	app.tools.push({ name: "monitor", annotations: { readOnlyHint: true } }, { name: "jobs" });
	assert.equal(await monitor("make build"), undefined);
	for (const mode of ["full", "normal", "ask", "readonly"]) {
		await app.command("permissions", mode);
		app.approve(true);
		const forced = await monitor("git push --force origin main") as { block: boolean; reason: string };
		assert.equal(forced?.block, true, mode);
		assert.match(forced.reason, /guard\[git-force-push\]/);
	}

	await app.command("permissions", "ask");
	app.approve(false);
	assert.ok(blocked(await monitor("make build")));
	assert.match(app.confirmations.at(-1)!, /monitor/);
	app.approve(true);
	assert.equal(await monitor("make build"), undefined);
	// 一覧・ログ・停止は確認なしで通る。
	const asked = app.confirmations.length;
	assert.equal(await app.emit("tool_call", call("jobs", { action: "stop", id: "x" })), undefined);
	assert.equal(app.confirmations.length, asked);
	app.ctx.hasUI = false;
	assert.match((await monitor("make build") as { reason: string }).reason, /no user can be asked/);
	app.ctx.hasUI = true;

	await app.command("permissions", "readonly");
	assert.equal(await monitor("make build"), undefined);
	assert.equal(await app.emit("tool_call", call("jobs", { action: "list" })), undefined);

	sandbox.available = false;
	try {
		for (const mode of ["normal", "ask", "readonly"]) {
			await app.command("permissions", mode);
			assert.match((await monitor("pwd") as { reason: string }).reason, /guard\[sandbox\]/, mode);
		}
	} finally {
		sandbox.available = true;
	}
});

test("monitorのjobはbashと同じsandboxの中で走る", { skip: cannotRun }, async () => {
	const { app, start } = await session("normal");
	const outside = dir("outside");
	await start(`echo in > inside.txt; echo out > ${outside}/normal.txt; echo done`);
	await until(() => app.messages.length === 1, "the normal job");
	assert.equal(readFileSync(join(app.ctx.cwd, "inside.txt"), "utf8"), "in\n");
	assert.equal(existsSync(join(outside, "normal.txt")), false);

	await app.command("permissions", "readonly");
	await start('echo ro > readonly.txt; echo tmp > "$TMPDIR/scratch.txt" && echo scratch-ok');
	await until(() => app.messages.length === 2, "the readonly job");
	assert.equal(existsSync(join(app.ctx.cwd, "readonly.txt")), false);
	assert.match(app.messages[1].message.content as string, /scratch-ok/);
});

test("1回きりのprint/jsonモードではmonitorを起動しない", async () => {
	const { app, start, jobs } = await session();
	for (const mode of ["print", "json"]) {
		(app.ctx as { mode: string }).mode = mode;
		await assert.rejects(start("sleep 30"), /print\/json/);
	}
	assert.match(await jobs("list"), /No background jobs/);
});

test("jobsツールと/jobsは、このセッションのjobの一覧・ログ・停止だけを扱う", async () => {
	const { app, start, jobs } = await session();
	assert.match(await jobs("list"), /No background jobs/);
	await app.command("monitor");
	assert.match(app.notices.at(-1)!, /No background jobs/);
	const { job, pid } = await sleeper(start, app.ctx.cwd);
	await app.command("monitor");
	assert.equal(
		app.notices.at(-1)!.replace(/Running for: \d+s/, "Running for: <n>s"),
		["Background jobs: 1 running, 0 ended", "", `Job ${job.id}`, "State: running", "Running for: <n>s", "Command: echo $$ > pid; echo started; sleep 30", `Log: ${job.logPath}`].join("\n"),
	);
	assert.match(await jobs("list"), new RegExp(`${job.id}  running  echo \\$\\$ > pid`));
	const log = await jobs("log", job.id);
	assert.ok(log.includes(job.logPath));
	assert.match(log, /started\n$/);
	await app.command("jobs");
	assert.match(app.notices.at(-1)!, /running/);
	await app.command("jobs", `log ${job.id}`);
	assert.match(app.notices.at(-1)!, /started\n$/);

	await assert.rejects(jobs("stop", "no-such-job"), /no job with id/);
	await assert.rejects(jobs("stop"), /Usage/);
	await assert.rejects(jobs("kill", job.id), /Usage/);
	await app.command("jobs", "stop");
	assert.match(app.notices.at(-1)!, /Usage/);

	await app.command("jobs", `stop ${job.id}`);
	assert.match(app.notices.at(-1)!, /stopped/);
	assert.equal(alive(pid), false);
	assert.match(await jobs("list"), /stopped/);
	await app.command("monitor");
	assert.match(app.notices.at(-1)!, /^Background jobs: 0 running, 1 ended\n\nJob \S+\nState: stopped \(SIGTERM\)\nRan for: \d+s\n/);
	// 止めた結果は次のターンに添えるだけで、頼まれていないターンは起こさない。
	await until(() => app.messages.length === 1, "the stop notification");
	assert.deepEqual(app.messages[0].options, { deliverAs: "nextTurn" });
});

test("セッションの終わりとtreeの移動はjobが止まるのを待ち、止めたjobの知らせは届けない", async () => {
	for (const event of ["session_shutdown", "session_tree"]) {
		const { app, start, jobs } = await session();
		const { pid } = await sleeper(start, app.ctx.cwd);
		await app.emit(event, { reason: "new" });
		assert.equal(alive(pid), false, event);
		assert.match(await jobs("list"), /No background jobs/, event);
		await pause(50);
		assert.equal(app.messages.length, 0, event);
	}
});

test("/permissionsで厳しい側へ移ると走っているjobを止め、同じか緩い側では止めない", { skip: cannotRun }, async () => {
	const { app, start, jobs } = await session("ask");
	// Linux の sandbox は pid namespace を分けるので、中で書いた pid は外から見えない。鼓動が進むかで生死を見る。
	const beat = join(app.ctx.cwd, "beat");
	const beats = () => (existsSync(beat) ? readFileSync(beat, "utf8").length : 0);
	const beating = async () => {
		const before = beats();
		await pause(200);
		return beats() > before;
	};
	const job = await start("while :; do printf . >> beat; sleep 0.02; done");
	for (const mode of ["ask", "normal", "full"]) {
		await app.command("permissions", mode);
		assert.equal(await beating(), true, mode);
	}
	await app.command("permissions", "normal");
	assert.match(await jobs("list"), new RegExp(`${job.id}  stopped`));
	assert.equal(await beating(), false);
});

test("ターンや圧縮の途中 (idleでない間) は知らせを送らず、idleになってから届ける", async () => {
	const { app, start } = await session();
	app.idle(false);
	await start("echo first");
	await pause(200);
	assert.equal(app.messages.length, 0);
	app.idle(true);
	await until(() => app.messages.length === 1, "the delayed notification");
	assert.deepEqual(app.messages[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("知らせを送れなくても例外は漏れず、結果はjobsで読める", async () => {
	const { app, start, jobs } = await session();
	(app.pi as { sendMessage: unknown }).sendMessage = () => {
		throw new Error("This extension ctx is stale");
	};
	const job = await start("echo kept");
	await until(() => app.notices.some((notice) => notice.includes("could not deliver")), "the delivery warning");
	assert.match(await jobs("log", job.id), /succeeded[\s\S]*kept\n$/);
});
