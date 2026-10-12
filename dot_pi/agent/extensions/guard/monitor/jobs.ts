/**
 * セッションが持つバックグラウンドのシェルジョブ。起動してすぐ返し、出力はログに貯め、終わり方を 1 つに決めて知らせる。
 *
 * 権限の境界ではない。渡された command / cwd / env をそのまま走らせるので、sandbox で包むのも許可を取るのも呼ぶ側。
 * Pi の SDK にも依らない (node: の組み込みだけ)。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type JobState = "running" | "succeeded" | "failed" | "stopped" | "interrupted" | "timed_out";

export interface JobSummary {
	id: string;
	command: string;
	state: JobState;
	exitCode?: number;
	signal?: string;
	reason?: string;
	startedAt: number;
	endedAt?: number;
	logPath: string;
}

export interface JobManagerOptions {
	maxRunning?: number;
	maxHistory?: number;
	maxLogBytes?: number;
	killGraceMs?: number;
	onEnd?: (job: JobSummary, tail: string) => void;
}

export interface JobManager {
	start(spec: { command: string; label?: string; cwd: string; env: NodeJS.ProcessEnv; timeoutSeconds?: number; signal?: AbortSignal }): Promise<JobSummary>;
	list(): JobSummary[];
	log(id: string): { job: JobSummary; tail: string };
	stop(id: string): Promise<JobSummary>;
	dispose(): Promise<void>;
}

const TAIL_BYTES = 8 * 1024;
const TAIL_LINES = 80;
/** setTimeout に渡せる上限。超えると Node は警告だけ出して 1ms に丸め、ジョブが即座に時間切れになる。 */
const MAX_TIMER_MS = 2_147_483_647;
/** シェルが終わってからパイプが閉じるのを待つ上限。グループを抜けた子孫 (setsid) がパイプを握ったままでも、ここで切る。 */
const DRAIN_GRACE_MS = 250;
/** グループの外の子孫が終わったかを見る間隔。 */
const STRAY_POLL_MS = 50;

interface Job {
	summary: JobSummary;
	child: ChildProcess;
	/** ログ。上限か書き込みの失敗で閉じた後は無し (以後の出力は捨てる)。 */
	fd?: number;
	bytes: number;
	tail: Buffer;
	/** こちらから止めた理由。最初の 1 つだけが残り、シェルの終わり方より優先する。 */
	cause?: { state: JobState; reason?: string };
	timers: Array<NodeJS.Timeout>;
	/** 止めるときに見つけた、グループの外の子孫。 */
	strays: number[];
	/** onEnd を呼ぶところまで済んだら決まる。 */
	done: Promise<JobSummary>;
}

/**
 * プロセスグループへ送る。失敗は捨てる。もう居ない (ESRCH) のは目的を果たした後で、それ以外でも打てる手が無い。
 * 呼ぶのはタイマーとイベントの中なので、投げると Pi ごと落ちる。
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	try {
		process.kill(-child.pid!, signal);
	} catch {}
}

function signalEach(pids: number[], signal: NodeJS.Signals | 0): boolean {
	let reached = false;
	for (const pid of pids) {
		try {
			process.kill(pid, signal);
			reached = true;
		} catch {}
	}
	return reached;
}

/**
 * シェルの子孫のうち、プロセスグループを抜けたもの。グループ宛てのシグナルは届かない。Linux だけ (/proc を読む)。
 * bubblewrap の中身がこれに当たる。`--new-session` で別のセッションになり、グループには launcher だけが残る。
 * launcher に SIGTERM を送ると中身は pid namespace ごと即座に消えるので、中身に先に送らないと `trap` の後始末が走らない。
 * 中身の先頭 (namespace の init になった bubblewrap) も数に入るが、init はハンドラの無いシグナルを外から受けても無視するので、
 * 送っても中身は消えない (bubblewrap 0.13.0 は SIGTERM のハンドラを持たない。/proc/<pid>/status の SigCgt で確かめた)。
 * 親が先に終わって init に引き取られたものは、もう子孫ではないので見つからない。
 */
function strays(shell: number): number[] {
	if (process.platform !== "linux") return [];
	const children = new Map<number, number[]>();
	const group = new Map<number, number>();
	try {
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name)) continue;
			try {
				const stat = readFileSync(`/proc/${name}/stat`, "utf8");
				// comm は空白も括弧も含められる。数えるのは最後の ")" の後ろから。
				const [, parent, pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ").map(Number);
				children.set(parent, [...(children.get(parent) ?? []), Number(name)]);
				group.set(Number(name), pgrp);
			} catch {}
		}
	} catch {}
	const found: number[] = [];
	for (const queue = [shell]; queue.length > 0; ) {
		for (const child of children.get(queue.shift()!) ?? []) {
			queue.push(child);
			if (group.get(child) !== shell) found.push(child);
		}
	}
	return found;
}

/**
 * コマンドの前に置くシェル断片。持ち主 (このプロセス) が後始末なしに死んだら、job のグループを止める。
 * 持ち主は fd 3 のパイプを開けたままにしていて、死ぬと閉じる。見張りはその EOF を待つだけで、ポーリングしない。
 * 端末が消えたときやクラッシュでは `session_shutdown` が来ないか、待ってもらえない。job は detached なので、何もしなければ残る。
 * SIGTERM を無視するのは、自分の送った SIGTERM で猶予の後の SIGKILL まで届かなくなるから。
 * fd 3 は見張りに渡したら閉じる。コマンドとその子に継がせると、それが生きている間 EOF が来ない。
 * 見張りを job のシェルの子として `&` で起こさない (外側の subshell を挟んで孫にし、すぐ手放す)。シェルの子のままだと、
 * コマンドの引数なしの `wait` が見張りまで待って終わらず、`jobs` と `$!` にも見張りが出る。グループは同じなので止め方は変わらない。
 */
const orphanWatch = (graceMs: number): string =>
	`( ( trap '' TERM; read -r -u 3; kill -s TERM -- -$$; sleep ${graceMs / 1000}; kill -s KILL -- -$$ ) >/dev/null 2>&1 & ); exec 3<&-`;

/** 文字列にするのは読むときだけ。Buffer のまま切れば、マルチバイト文字の途中に当たっても投げない。 */
export function renderTail(given: Buffer): string {
	const buffer = given.subarray(-TAIL_BYTES);
	let start = 0;
	for (let i = buffer.length - 2, lines = 0; i >= 0; i--) {
		if (buffer[i] === 0x0a && ++lines === TAIL_LINES) {
			start = i + 1;
			break;
		}
	}
	// バイト数で切った先頭に残る、文字の後ろ半分 (UTF-8 の継続バイト)。
	while ((buffer[start] & 0xc0) === 0x80) start++;
	return buffer.toString("utf8", start);
}

export function createJobManager(options: JobManagerOptions = {}): JobManager {
	const maxRunning = options.maxRunning ?? 4;
	const maxHistory = options.maxHistory ?? 16;
	const maxLogBytes = options.maxLogBytes ?? 10 * 1024 * 1024;
	const killGraceMs = options.killGraceMs ?? 2000;
	const jobs = new Map<string, Job>();
	/** onEnd まで済んでいないジョブ。履歴から落ちても dispose が待てるよう、jobs とは別に持つ。 */
	const active = new Set<Job>();
	/** spawn の結果を待っている start の数。数えないと、同時に呼ばれた start が揃って上限をすり抜ける。 */
	let starting = 0;
	let logDir: string | undefined;
	let disposed = false;

	const get = (id: string): Job => {
		const job = jobs.get(id);
		if (!job) throw new Error(`jobs: no job with id ${id}.`);
		return job;
	};

	const end = (job: Job, cause: NonNullable<Job["cause"]>) => {
		if (job.summary.state !== "running" || job.cause) return;
		job.cause = cause;
		const group = () => {
			signalGroup(job.child, "SIGTERM");
			job.timers.push(
				setTimeout(() => {
					signalGroup(job.child, "SIGKILL");
					signalEach(job.strays, "SIGKILL");
				}, killGraceMs),
			);
		};
		job.strays = strays(job.child.pid!);
		if (!signalEach(job.strays, "SIGTERM")) return group();
		// グループの外の子孫が終わるのを先に待つ。sandbox の中身はここで終わり、launcher とシェルも続いて終わる。
		const deadline = Date.now() + killGraceMs;
		const poll = setInterval(() => {
			if (Date.now() < deadline && signalEach(job.strays, 0)) return;
			clearInterval(poll);
			group();
		}, STRAY_POLL_MS);
		job.timers.push(poll);
	};

	// data のハンドラからも呼ぶ。投げると Pi ごと落ちる。
	const closeLog = (job: Job) => {
		try {
			if (job.fd !== undefined) closeSync(job.fd);
		} catch {}
		job.fd = undefined;
	};

	// 同期で書く。onEnd が呼ばれた時点でファイルが揃っていて、書き込みの失敗もその場で分かる。
	const append = (job: Job, chunk: Buffer) => {
		if (job.fd === undefined) return;
		const kept = chunk.subarray(0, maxLogBytes - job.bytes);
		try {
			writeSync(job.fd, kept);
		} catch (error) {
			closeLog(job);
			return end(job, { state: "failed", reason: `log write failed: ${(error as Error).message}` });
		}
		job.bytes += kept.length;
		job.tail = Buffer.concat([job.tail, kept]).subarray(-TAIL_BYTES);
		if (kept.length < chunk.length) {
			closeLog(job);
			end(job, { state: "failed", reason: `log exceeded ${maxLogBytes} bytes` });
		}
	};

	const forget = () => {
		const finished = [...jobs.values()].filter((job) => job.summary.state !== "running").sort((a, b) => a.summary.endedAt! - b.summary.endedAt!);
		for (const job of finished.slice(0, Math.max(0, finished.length - maxHistory))) jobs.delete(job.summary.id);
	};

	const track = (summary: JobSummary, child: ChildProcess, fd: number, timeoutSeconds: number | undefined): Job => {
		let settle!: (summary: JobSummary) => void;
		const job: Job = { summary, child, fd, bytes: 0, tail: Buffer.alloc(0), timers: [], strays: [], done: new Promise((resolve) => (settle = resolve)) };
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			for (const timer of job.timers) clearTimeout(timer);
			closeLog(job);
			// 見張りはグループごと止めた後。閉じないと job ごとに fd が 1 つ残る。
			child.stdio[3]?.destroy();
			active.delete(job);
			forget();
			settle({ ...summary });
			// 戻り値まで見るのは、async な onEnd の失敗が unhandled rejection になるから。
			try {
				Promise.resolve(options.onEnd?.({ ...summary }, renderTail(job.tail))).catch(() => {});
			} catch {}
		};
		for (const stream of [child.stdout!, child.stderr!]) {
			stream.on("data", (chunk: Buffer) => append(job, chunk));
			// 聞き手のいない error は未捕捉例外になる。読めなかった分は諦める。
			stream.on("error", () => {});
		}
		if (timeoutSeconds !== undefined) job.timers.push(setTimeout(() => end(job, { state: "timed_out" }), timeoutSeconds * 1000));
		// 終わり方は exit で決める。close はパイプを握った子孫が居るかぎり来ない。
		child.once("exit", (code, signal) => {
			for (const timer of job.timers) clearTimeout(timer);
			summary.state = job.cause?.state ?? (code === 0 ? "succeeded" : "failed");
			if (job.cause?.reason) summary.reason = job.cause.reason;
			if (code !== null) summary.exitCode = code;
			if (signal) summary.signal = signal;
			summary.endedAt = Date.now();
			// `sleep 100 &` のように残された子は、止めないと孤児になってパイプも閉じない。
			signalGroup(child, "SIGKILL");
			signalEach(job.strays, "SIGKILL");
			job.timers = [
				setTimeout(() => {
					child.stdout!.destroy();
					child.stderr!.destroy();
					finish();
				}, DRAIN_GRACE_MS),
			];
		});
		// 知らせるのは残りの出力を読み切ってから。exit の時点ではまだパイプに残っている。
		child.once("close", finish);
		return job;
	};

	/**
	 * 止めた job が終わるのを待つ。シグナルを送れない相手 (sudo で root になったシェル) は exit が来ないので、
	 * 上限で切る。Pi は session_shutdown を時間切れなしで待ち、ここで待ち続けると終了もセッションの切り替えもできなくなる。
	 */
	const ended = async (waited: Job[]) => {
		let timer: NodeJS.Timeout | undefined;
		const giveUp = new Promise((resolve) => (timer = setTimeout(resolve, 2 * killGraceMs + 4 * DRAIN_GRACE_MS)));
		await Promise.race([Promise.all(waited.map((job) => job.done)), giveUp]);
		clearTimeout(timer);
	};

	return {
		start(spec) {
			return new Promise((resolve, reject) => {
				const { timeoutSeconds, signal } = spec;
				if (process.platform === "win32") throw new Error("jobs: background jobs are not supported on win32.");
				if (!spec.command.trim()) throw new Error("jobs: command is empty.");
				if (timeoutSeconds !== undefined && !(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds * 1000 <= MAX_TIMER_MS)) {
					throw new Error(`jobs: timeoutSeconds must be a positive number of at most ${Math.floor(MAX_TIMER_MS / 1000)}, got ${timeoutSeconds}.`);
				}
				if (signal?.aborted) throw new Error("jobs: aborted before the job started.");
				if (disposed) throw new Error("jobs: the job manager is disposed.");
				const running = starting + [...jobs.values()].filter((job) => job.summary.state === "running").length;
				if (running >= maxRunning) throw new Error(`jobs: ${maxRunning} jobs are already running. Stop one or wait for one to end.`);

				logDir ??= mkdtempSync(join(tmpdir(), "pi-jobs-"));
				const id = randomUUID();
				const logPath = join(logDir, `${id}.log`);
				const fd = openSync(logPath, "wx", 0o600);
				starting++;
				let child: ChildProcess | undefined;
				let pending = true;
				const abandon = (error: Error) => {
					if (!pending) return;
					pending = false;
					starting--;
					signal?.removeEventListener("abort", onAbort);
					if (child?.pid) signalGroup(child, "SIGKILL");
					child?.stdio[3]?.destroy();
					closeSync(fd);
					rmSync(logPath, { force: true });
					reject(error);
				};
				const onAbort = () => abandon(new Error("jobs: aborted while the job was starting."));
				try {
					child = spawn("/bin/bash", ["-c", `${orphanWatch(killGraceMs)}\n${spec.command}`], { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] });
					// 書くことも読むこともない。こちらが死んだことを相手に伝えるためだけに開けておく。
					child.stdio[3]!.on("error", () => {});
				} catch (error) {
					return abandon(error as Error);
				}
				signal?.addEventListener("abort", onAbort, { once: true });
				// 無い cwd でも Node のメッセージは `spawn /bin/bash ENOENT` で、何が無いのか読み取れない。
				child.once("error", (error) => abandon(new Error(`jobs: failed to start in ${spec.cwd}: ${error.message}`)));
				child.once("spawn", () => {
					if (disposed) return abandon(new Error("jobs: the job manager is disposed."));
					if (!pending) return;
					pending = false;
					starting--;
					// ここから先の signal は見ない。ジョブはそれを起動したツール呼び出しより長く生きる。
					signal?.removeEventListener("abort", onAbort);
					const job = track({ id, command: spec.label ?? spec.command, state: "running", startedAt: Date.now(), logPath }, child, fd, timeoutSeconds);
					jobs.set(id, job);
					active.add(job);
					resolve({ ...job.summary });
				});
			});
		},
		list: () => [...jobs.values()].reverse().map((job) => ({ ...job.summary })),
		log(id) {
			const job = get(id);
			return { job: { ...job.summary }, tail: renderTail(job.tail) };
		},
		async stop(id) {
			const job = get(id);
			end(job, { state: "stopped" });
			await ended([job]);
			return { ...job.summary };
		},
		async dispose() {
			disposed = true;
			for (const job of active) end(job, { state: "interrupted" });
			await ended([...active]);
		},
	};
}
