/**
 * `codex exec --json` を 1 回起こし、JSONL を読んで最後の答えと thread id を返す。Pi の SDK には依らない (node: の組み込みだけ)。
 *
 * ../verify/run.ts を import しないのは、あちらがシェルを通し、stdout と stderr を混ぜ、stdin を閉じたまま起こすため。
 */

import { type ChildProcess, spawn } from "node:child_process";

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
function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
	try {
		process.kill(-child.pid!, signal);
	} catch {}
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
		const stop = (cause: CodexResult["ended"]) => {
			if (result.ended !== "exited") return;
			result.ended = cause;
			signalGroup(child, "SIGTERM");
			timers.push(setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS));
		};
		const cancel = () => stop("cancelled");
		const finish = (code: number | null, error?: Error) => {
			if (finished) return;
			finished = true;
			for (const timer of timers) clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
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
		// codex が終わっても、残った子がパイプを握っていると close が来ない。グループを抜けた子孫には SIGKILL も届かないので、待つのは少しだけ。
		child.on("exit", (code) => {
			signalGroup(child, "SIGKILL");
			timers.push(setTimeout(() => finish(code), DRAIN_GRACE_MS));
		});
		child.on("close", (code) => finish(code));
		options.signal?.addEventListener("abort", cancel);
		timers.push(setTimeout(() => stop("timed_out"), options.timeoutMs));
	});
}
