/**
 * `codex exec --json` を 1 回起こし、JSONL を読んで最後の答えと thread id を返す。Pi の SDK には依らない (node: の組み込みだけ)。
 *
 * ../verify/run.ts を import しないのは、あちらがシェルを通し、stdout と stderr を混ぜ、stdin を閉じたまま起こすため。
 */

import { spawn, spawnSync } from "node:child_process";

export interface CodexResult {
	ended: "exited" | "timed_out" | "cancelled";
	/** シグナルで死んだときと起動できなかったときは null。 */
	code: number | null;
	threadId?: string;
	/** 最後の agent_message。 */
	message?: string;
	completed: boolean;
	/** turn.failed とトップレベルの error。item.completed の error (非推奨の警告など) は入れない。 */
	failures: string[];
	stderrTail: string;
}

const STDERR_TAIL_BYTES = 4 * 1024;
/** 1 行も、答えも、この長さで打ち切る。改行の来ない stdout でメモリを食い潰させない。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 200_000;
const KILL_GRACE_MS = 2000;
const DRAIN_GRACE_MS = 250;

/** もう居ない (ESRCH) のは目的を果たした後なので、失敗は捨てる。タイマーの中で投げると Pi ごと落ちる。 */
function signal(pid: number, name: NodeJS.Signals) {
	try {
		process.kill(pid, name);
	} catch {}
}

/**
 * root の子孫の pid。codex はコマンドを別のセッション (setsid) で起こすので、プロセスグループへのシグナルは届かない。親子の糸を辿る。
 * codex が死ぬと子孫は init に付け替えられて糸が切れるので、codex が生きているうちに取る。
 * ps を名前で探さないのは、PATH にモデルが書ける場所があると、そこに置かれた ps が Pi の権限で走るため。
 */
function descendants(root: number): number[] {
	const listed = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout ?? "";
	const children = new Map<number, number[]>();
	for (const row of listed.split("\n")) {
		const [pid, ppid] = row.trim().split(/\s+/).map(Number);
		if (pid > 0 && ppid > 0) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
	}
	const found: number[] = [];
	for (let queue = [root]; queue.length; ) {
		for (const pid of children.get(queue.shift()!) ?? []) {
			found.push(pid);
			queue.push(pid);
		}
	}
	return found;
}

function describeFailure(event: Record<string, any>): string {
	const error = event.error ?? event;
	return typeof error?.message === "string" ? error.message : JSON.stringify(event);
}

export function runCodex(binary: string, args: string[], options: { cwd: string; prompt: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<CodexResult> {
	const result: CodexResult = { ended: "exited", code: null, completed: false, failures: [], stderrTail: "" };
	return new Promise((resolve) => {
		if (options.signal?.aborted) return resolve({ ...result, ended: "cancelled" });
		const timers: NodeJS.Timeout[] = [];
		let pending = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let finished = false;
		// detached にしないと、codex が起こしたコマンド (sandbox の中のシェルなど) にシグナルが届かない。
		const child = spawn(binary, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });

		const handle = (line: string) => {
			let event: Record<string, any>;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event?.type === "thread.started" && typeof event.thread_id === "string") result.threadId = event.thread_id;
			else if (event?.type === "turn.completed") result.completed = true;
			else if (event?.type === "turn.failed" || event?.type === "error") result.failures.push(describeFailure(event));
			else if (event?.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
				result.message = event.item.text.length > MAX_MESSAGE_CHARS ? `${event.item.text.slice(0, MAX_MESSAGE_CHARS)}\n[truncated]` : event.item.text;
			}
		};
		/** codex のグループと、別のセッションに出た子孫の 1 つずつ。 */
		const strike = (pids: Iterable<number>, name: NodeJS.Signals) => {
			signal(-child.pid!, name);
			for (const pid of pids) signal(pid, name);
		};
		const stop = (cause: CodexResult["ended"]) => {
			if (result.ended !== "exited") return;
			result.ended = cause;
			const seen = new Set(descendants(child.pid!));
			strike(seen, "SIGTERM");
			// finish で消さない (timers に入れない)。codex が TERM ですぐ死んで close が来ても、TERM を無視する子孫には KILL を届ける。
			// unref するので、返った後にこのタイマーが Pi の終了を引き留めることはない。
			setTimeout(() => {
				for (const pid of descendants(child.pid!)) seen.add(pid);
				strike(seen, "SIGKILL");
			}, KILL_GRACE_MS).unref();
		};
		const cancel = () => stop("cancelled");
		const finish = (code: number | null, error?: Error) => {
			if (finished) return;
			finished = true;
			for (const timer of timers) clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
			// close を待たずに返るとき、パイプを握った子孫が居るとハンドルが残る。close の後に呼んでも害は無い。
			child.stdin!.destroy();
			child.stdout!.destroy();
			child.stderr!.destroy();
			if (pending.length) handle(pending.toString("utf8"));
			result.code = code;
			// 文字列にするのは最後だけ。Buffer のまま切れば、マルチバイト文字の途中に当たっても壊れた文字が残らない。
			let start = 0;
			while ((stderr[start] & 0xc0) === 0x80) start++;
			let tail = stderr.toString("utf8", start).trimEnd();
			if (error) tail = `${tail}\n${error.message}`.trim();
			result.stderrTail = tail;
			resolve(result);
		};

		child.stdout!.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk]);
			for (let index = pending.indexOf(0x0a); index >= 0; index = pending.indexOf(0x0a)) {
				handle(pending.subarray(0, index).toString("utf8"));
				pending = pending.subarray(index + 1);
			}
			if (pending.length > MAX_LINE_BYTES) pending = Buffer.alloc(0);
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			stderr = Buffer.concat([stderr, chunk]);
			if (stderr.length > STDERR_TAIL_BYTES) stderr = stderr.subarray(stderr.length - STDERR_TAIL_BYTES);
		});
		// codex が stdin を読み切る前に死ぬと EPIPE になる。拾わないと Pi ごと落ちる。
		child.stdin!.on("error", () => {});
		child.stdin!.end(options.prompt);
		child.on("error", (error) => finish(null, error));
		// codex が終わっても、残った子がパイプを握っていると close が来ない。ここではもう子孫の糸を辿れない (init に付け替えられた) ので、
		// グループを抜けた子孫は止められない。待つのは少しだけ。
		child.on("exit", (code) => {
			signal(-child.pid!, "SIGKILL");
			timers.push(setTimeout(() => finish(code), DRAIN_GRACE_MS));
		});
		child.on("close", (code) => finish(code));
		options.signal?.addEventListener("abort", cancel);
		timers.push(setTimeout(() => stop("timed_out"), options.timeoutMs));
	});
}
