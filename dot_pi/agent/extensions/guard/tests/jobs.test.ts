import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJobManager, type JobManager, type JobManagerOptions, type JobSummary } from "../monitor/jobs.ts";

// ログの置き場 (os.tmpdir() の下) ごと最後に消せるよう、一時ディレクトリをこのファイル専用の場所へ向ける。
const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-jobs-")));
process.env.TMPDIR = base;

const managers: JobManager[] = [];
after(async () => {
	await Promise.all(managers.map((manager) => manager.dispose()));
	rmSync(base, { recursive: true, force: true });
});

/** onEnd を id ごとの待ち合わせに変えた manager。calls は onEnd が呼ばれた順の記録。 */
function make(options: JobManagerOptions = {}) {
	const calls: Array<{ job: JobSummary; tail: string }> = [];
	const waiting = new Map<string, (call: { job: JobSummary; tail: string }) => void>();
	const manager = createJobManager({
		...options,
		onEnd: (job, tail) => {
			calls.push({ job, tail });
			waiting.get(job.id)?.({ job, tail });
			return options.onEnd?.(job, tail);
		},
	});
	managers.push(manager);
	const ended = (id: string) =>
		new Promise<{ job: JobSummary; tail: string }>((resolve) => {
			const done = calls.find((call) => call.job.id === id);
			if (done) resolve(done);
			else waiting.set(id, resolve);
		});
	const start = (command: string, spec: { env?: NodeJS.ProcessEnv; cwd?: string; label?: string; timeoutSeconds?: number; signal?: AbortSignal } = {}) =>
		manager.start({ command, cwd: base, ...spec, env: { ...process.env, ...spec.env } });
	return { manager, calls, ended, start };
}

let gates = 0;
const gatePath = () => join(base, `gate-${gates++}`);
/** GATE のファイルができるまで待つシェル断片。sleep の長さに順序を賭けない。 */
const waitGate = 'while [ ! -e "$GATE" ]; do sleep 0.02; done';

async function until(condition: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${what}`);
}

// 親を失ったプロセスは init が回収するまで zombie で残り、その間は kill(pid, 0) が通る。すぐには確かめられない。
const gone = (pid: number) =>
	until(() => {
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	}, `pid ${pid} to exit`);

const pidIn = async (path: string): Promise<number> => {
	await until(() => existsSync(path) && readFileSync(path, "utf8").endsWith("\n"), path);
	return Number(readFileSync(path, "utf8"));
};

test("startはコマンドの完了を待たずにrunningで返り、終わるとstdoutとstderrと終了コードが取れる", async () => {
	const { manager, ended, start } = make();
	const gate = gatePath();
	const job = await start(`${waitGate}; echo out; echo err >&2`, { env: { GATE: gate } });
	assert.equal(job.state, "running");
	assert.match(job.id, /^[0-9a-f-]{36}$/);
	assert.equal(job.endedAt, undefined);
	assert.deepEqual(manager.list(), [job]);
	writeFileSync(gate, "");
	const end = await ended(job.id);
	assert.equal(end.job.state, "succeeded");
	assert.equal(end.job.exitCode, 0);
	assert.equal(end.job.signal, undefined);
	assert.ok(end.job.endedAt! >= job.startedAt);
	assert.deepEqual(end.tail.split("\n").sort(), ["", "err", "out"]);
	assert.equal(readFileSync(job.logPath, "utf8"), end.tail);
	assert.deepEqual(manager.log(job.id), end);
	assert.deepEqual(manager.list(), [end.job]);
});

test("0以外の終了コードはfailed", async () => {
	const { ended, start } = make();
	const { job } = await ended((await start("exit 3")).id);
	assert.equal(job.state, "failed");
	assert.equal(job.exitCode, 3);
	assert.equal(job.reason, undefined);
});

test("自分が送っていないシグナルで死んだらfailedで、signalが残る", async () => {
	const { ended, start } = make();
	const { job } = await ended((await start("kill -TERM $$")).id);
	assert.equal(job.state, "failed");
	assert.equal(job.signal, "SIGTERM");
	assert.equal(job.exitCode, undefined);
});

test("stopは終わるまで待ってstoppedで返す。終わったジョブへのstopはそのまま返し、知らないidは失敗する", async () => {
	const { manager, calls, start } = make();
	const job = await start("sleep 30");
	const stopped = await manager.stop(job.id);
	assert.equal(stopped.state, "stopped");
	assert.equal(stopped.signal, "SIGTERM");
	assert.deepEqual(calls.map((call) => call.job), [stopped]);
	assert.deepEqual(await manager.stop(job.id), stopped);
	const done = await start("true");
	await until(() => calls.length === 2, "onEnd");
	assert.equal((await manager.stop(done.id)).state, "succeeded");
	await assert.rejects(manager.stop("missing"), /no job/);
	assert.throws(() => manager.log("missing"), /no job/);
});

test("SIGTERMを無視するコマンドはkillGraceMsの後にSIGKILLで止める", async () => {
	const { manager, start } = make({ killGraceMs: 100 });
	const gate = gatePath();
	const job = await start(`trap '' TERM; echo ready > "$GATE"; while :; do sleep 0.05; done`, { env: { GATE: gate } });
	await until(() => existsSync(gate), "trap");
	const before = Date.now();
	const stopped = await manager.stop(job.id);
	assert.equal(stopped.state, "stopped");
	assert.equal(stopped.signal, "SIGKILL");
	assert.ok(Date.now() - before >= 90);
});

test("timeoutSecondsを過ぎたらtimed_outで止める", async () => {
	const { ended, start } = make();
	const { job } = await ended((await start("sleep 30", { timeoutSeconds: 0.1 })).id);
	assert.equal(job.state, "timed_out");
	assert.ok(job.endedAt! - job.startedAt < 5000);
});

test("シェルが終わったら、バックグラウンドに残した子も止める", async () => {
	const { ended, start } = make();
	const pidFile = gatePath();
	const { job } = await ended((await start('sleep 30 & echo $! > "$PIDFILE"', { env: { PIDFILE: pidFile } })).id);
	assert.equal(job.state, "succeeded");
	assert.ok(job.endedAt! - job.startedAt < 5000);
	await gone(await pidIn(pidFile));
});

test("stopはバックグラウンドの子ごと止める", async () => {
	const { manager, start } = make();
	const pidFile = gatePath();
	const job = await start('sleep 30 & echo $! > "$PIDFILE"; wait', { env: { PIDFILE: pidFile } });
	const pid = await pidIn(pidFile);
	assert.equal((await manager.stop(job.id)).state, "stopped");
	await gone(pid);
});

test("disposeは動いているジョブを全部interruptedで止めてから返り、その後のstartは失敗する。ログは残る", async () => {
	const { manager, calls, start } = make();
	const pidFile = gatePath();
	const jobs = [await start('echo $$ > "$PIDFILE"; echo kept; sleep 30', { env: { PIDFILE: pidFile } }), await start("sleep 30")];
	const pid = await pidIn(pidFile);
	await until(() => manager.log(jobs[0].id).tail === "kept\n", "output");
	await manager.dispose();
	assert.deepEqual(calls.map((call) => call.job.state), ["interrupted", "interrupted"]);
	assert.deepEqual(manager.list().map((job) => job.state), ["interrupted", "interrupted"]);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	await manager.dispose();
	assert.equal(calls.length, 2);
	await assert.rejects(start("true"), /disposed/);
	assert.equal(manager.list().length, 2);
	assert.equal(manager.log(jobs[0].id).tail, "kept\n");
	assert.equal(readFileSync(jobs[0].logPath, "utf8"), "kept\n");
	assert.equal(statSync(jobs[0].logPath).mode & 0o777, 0o600);
	assert.equal(statSync(join(jobs[0].logPath, "..")).mode & 0o777, 0o700);
	assert.match(jobs[0].logPath, new RegExp(`^${base}/pi-jobs-[^/]+/${jobs[0].id}\\.log$`));
});

test("commandにはlabelがあればそれを見せる", async () => {
	const { manager, start } = make();
	const job = await start("sleep 30", { label: "npm run dev" });
	assert.equal(job.command, "npm run dev");
	assert.equal((await start("true")).command, "true");
	await manager.stop(job.id);
});

test("起動に失敗したらstartが失敗し、ジョブもログも残さない", async () => {
	const { manager, calls, start } = make({ maxRunning: 1 });
	await assert.rejects(start("true", { cwd: join(base, "missing") }), /failed to start.*ENOENT/);
	assert.deepEqual(manager.list(), []);
	const job = await start("sleep 30");
	assert.deepEqual(readdirSync(join(job.logPath, "..")), [`${job.id}.log`]);
	await manager.stop(job.id);
	assert.equal(calls.length, 1);
});

test("空のコマンドと、正の有限値でないかタイマーの上限を超えるtimeoutSecondsは受け付けない", async () => {
	const { manager, start } = make();
	for (const command of ["", " \n\t"]) await assert.rejects(start(command), /command/);
	for (const timeoutSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_484]) await assert.rejects(start("true", { timeoutSeconds }), /timeoutSeconds/, String(timeoutSeconds));
	assert.deepEqual(manager.list(), []);
	const job = await start("sleep 30", { timeoutSeconds: 2_147_483 });
	assert.equal((await manager.stop(job.id)).state, "stopped");
});

test("POSIXでないOSでは起動しない", async () => {
	const { start } = make();
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: "win32" });
	try {
		await assert.rejects(start("true"), /win32/);
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
});

test("中断済みのsignalでは起動せず、起動の途中で中断されたらプロセスを残さない", async () => {
	const { manager, calls, start } = make({ maxRunning: 1 });
	const abort = new AbortController();
	const marker = `guard-jobs-${process.pid}-abort`;
	const starting = start(`: ${marker}; sleep 30`, { signal: abort.signal });
	abort.abort();
	await assert.rejects(starting, /aborted/);
	await assert.rejects(start(`: ${marker}; sleep 30`, { signal: abort.signal }), /aborted/);
	await until(() => spawnSync("pgrep", ["-f", marker]).status === 1, "aborted process to exit");
	assert.deepEqual(manager.list(), []);
	const job = await start("sleep 30");
	assert.deepEqual(readdirSync(join(job.logPath, "..")), [`${job.id}.log`]);
	await manager.stop(job.id);
	assert.equal(calls.length, 1);
});

test("startが返った後のsignalはジョブを止めない", async () => {
	const { manager, start } = make();
	const abort = new AbortController();
	const pidFile = gatePath();
	const job = await start('echo $$ > "$PIDFILE"; sleep 30', { signal: abort.signal, env: { PIDFILE: pidFile } });
	const pid = await pidIn(pidFile);
	abort.abort();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.doesNotThrow(() => process.kill(pid, 0));
	assert.equal(manager.list()[0].state, "running");
	await manager.stop(job.id);
});

test("maxRunningを超えるstartは失敗し、空けば起動できる", async () => {
	const { manager, start } = make({ maxRunning: 2 });
	const results = await Promise.allSettled([start("sleep 30"), start("sleep 30"), start("sleep 30")]);
	assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled", "rejected"]);
	assert.match(String((results[2] as PromiseRejectedResult).reason), /2 jobs are already running/);
	await assert.rejects(start("true"), /already running/);
	await manager.stop(manager.list()[0].id);
	const job = await start("sleep 30");
	assert.equal(job.state, "running");
});

test("終わったジョブはmaxHistoryを超えた古いものから忘れる。動いているジョブとログは残る", async () => {
	const { manager, ended, start } = make({ maxHistory: 2 });
	const running = await start("sleep 30");
	const finished = [];
	for (const text of ["a", "b", "c"]) finished.push((await ended((await start(`echo ${text}`)).id)).job);
	assert.deepEqual(manager.list().map((job) => job.id), [finished[2].id, finished[1].id, running.id]);
	assert.throws(() => manager.log(finished[0].id), /no job/);
	assert.equal(readFileSync(finished[0].logPath, "utf8"), "a\n");
	await manager.stop(running.id);
	assert.deepEqual(manager.list().map((job) => job.id), [finished[2].id, running.id]);
});

test("すぐ終わるコマンドでも、startが返ってからonEndが1度だけ呼ばれる", async () => {
	const order: string[] = [];
	const { calls, ended, start } = make({ onEnd: (job) => order.push(`end ${job.id}`) });
	const expected: string[] = [];
	for (let i = 0; i < 10; i++) {
		const job = await start("exit 0");
		order.push(`start ${job.id}`);
		expected.push(`start ${job.id}`, `end ${job.id}`);
		await ended(job.id);
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(order, expected);
	assert.equal(calls.length, 10);
});

test("onEndが投げても、非同期に失敗しても、外には漏れない", async () => {
	for (const onEnd of [
		() => {
			throw new Error("onEnd failed");
		},
		(async () => {
			throw new Error("onEnd rejected");
		}) as () => void,
	]) {
		const { manager, ended, start } = make({ onEnd });
		assert.equal((await ended((await start("true")).id)).job.state, "succeeded");
		const job = await start("sleep 30");
		assert.equal((await manager.stop(job.id)).state, "stopped");
		await manager.dispose();
	}
});

test("ログがmaxLogBytesに達したら止めてfailedにし、理由を残す", async () => {
	const { ended, start } = make({ maxLogBytes: 1000 });
	const { job } = await ended((await start("while :; do echo xxxxxxxxxx; done")).id);
	assert.equal(job.state, "failed");
	assert.match(job.reason!, /log exceeded 1000 bytes/);
	assert.equal(statSync(job.logPath).size, 1000);
});

test("tailは最後の80行と8KiBまでで、マルチバイト文字の途中で切っても壊れない", async () => {
	const { ended, start } = make();
	const lines = await ended((await start("for i in $(seq 1 200); do echo $i; done")).id);
	assert.equal(lines.tail, Array.from({ length: 80 }, (_, i) => `${i + 121}\n`).join(""));
	const bytes = await ended((await start("head -c 20000 /dev/zero | tr '\\0' a")).id);
	assert.equal(bytes.tail, "a".repeat(8192));
	assert.equal(statSync(bytes.job.logPath).size, 20000);
	// 15000 バイト。8KiB で切ると「あ」(3 バイト) の途中に当たる。
	const multibyte = await ended((await start("printf 'あ%.0s' {1..5000}")).id);
	assert.equal(multibyte.tail, "あ".repeat(2730));
});

test("グループを抜けた子孫がパイプを握っていても、シェルが終われば待ち続けない", { skip: !existsSync("/usr/bin/perl") }, async () => {
	const { ended, start } = make();
	const pidFile = gatePath();
	const escape = `/usr/bin/perl -MPOSIX -e 'setsid(); open(F, ">", $ENV{PIDFILE}); print F "$$\\n"; close F; sleep 30'`;
	const job = await start(`${escape} & while [ ! -s "$PIDFILE" ]; do sleep 0.02; done; echo done`, { env: { PIDFILE: pidFile } });
	const pid = await pidIn(pidFile);
	try {
		const end = await ended(job.id);
		assert.equal(end.job.state, "succeeded");
		assert.equal(end.tail, "done\n");
		assert.doesNotThrow(() => process.kill(pid, 0));
	} finally {
		process.kill(pid, "SIGKILL");
	}
});

test("後始末なしに持ち主のプロセスが死んでも、jobは残らない", async () => {
	const pidFile = join(base, "orphan.pid");
	const script = join(base, "owner.mjs");
	writeFileSync(
		script,
		`import { createJobManager } from ${JSON.stringify(join(import.meta.dirname, "../monitor/jobs.ts"))};
await createJobManager().start({ command: "echo $$ > ${pidFile}; sleep 30", cwd: ${JSON.stringify(base)}, env: process.env });
setInterval(() => {}, 1000);`,
	);
	const owner = spawn(process.execPath, ["--no-warnings", script], { stdio: "ignore" });
	try {
		await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"), "the job to start");
		const pid = Number(readFileSync(pidFile, "utf8"));
		// SIGKILL は捕まえられない。session_shutdown も exit のハンドラも走らない終わり方。
		owner.kill("SIGKILL");
		await gone(pid);
	} finally {
		owner.kill("SIGKILL");
	}
});

test("引数なしのwaitは自分の起こした子だけを待ち、見張りはコマンドから見えない", async () => {
	const { manager, start } = make();
	const job = await start('echo "last=${!:-none}"; sleep 0.1 & sleep 0.15 & wait; echo all-done; echo "jobs=$(jobs -p | wc -l)"; (echo >&3) 2>/dev/null && echo fd3-open || echo fd3-closed');
	await until(() => manager.list()[0].state !== "running", "the job to get past wait");
	assert.equal(manager.list()[0].state, "succeeded");
	// fd 3 が開いたままコマンドとその子に継がれると、それが生きている間は持ち主が死んでも見張りに EOF が来ない。
	assert.equal(manager.log(job.id).tail.replace(/ +/g, ""), "last=none\nall-done\njobs=0\nfd3-closed\n");
});

test("stopは、グループを抜けた子孫も止める", { skip: process.platform !== "linux" || !existsSync("/usr/bin/perl") }, async () => {
	const { manager, start } = make();
	const pidFile = gatePath();
	const escape = `/usr/bin/perl -MPOSIX -e 'setsid(); open(F, ">", $ENV{PIDFILE}); print F "$$\\n"; close F; sleep 30'`;
	const job = await start(`${escape} & sleep 30`, { env: { PIDFILE: pidFile } });
	const pid = await pidIn(pidFile);
	try {
		assert.equal((await manager.stop(job.id)).state, "stopped");
		await gone(pid);
	} finally {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
});

test("stopは、グループを抜けてSIGTERMを無視する子孫も、シェルが終わった時点で止める", { skip: process.platform !== "linux" || !existsSync("/usr/bin/perl") }, async () => {
	// シェルが終わると、猶予の後の SIGKILL のタイマーは消える。そこで送らないと、この子孫は誰にも止められない。
	const { manager, start } = make({ killGraceMs: 200 });
	const pidFile = gatePath();
	const escape = `/usr/bin/perl -MPOSIX -e 'setsid(); $SIG{TERM} = "IGNORE"; open(F, ">", $ENV{PIDFILE}); print F "$$\\n"; close F; sleep 30'`;
	const job = await start(`${escape} & sleep 30`, { env: { PIDFILE: pidFile } });
	const pid = await pidIn(pidFile);
	try {
		assert.equal((await manager.stop(job.id)).state, "stopped");
		await gone(pid);
	} finally {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
});
