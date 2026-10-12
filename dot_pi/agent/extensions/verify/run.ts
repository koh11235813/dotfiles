/**
 * 検証コマンドを 1 つ走らせ、終わり方と出力の末尾を返す。Pi の SDK には依らない (node: の組み込みだけ)。
 *
 * pi.exec を使わないのは、stdout と stderr を届いた順に 1 本で残せず、孫プロセスまで止められないため。
 */

import { type ChildProcess, spawn } from "node:child_process";

export interface RunResult {
	/** こちらから止めたときは、シェルの終わり方より優先する。 */
	ended: "exited" | "timed_out" | "cancelled";
	/** シグナルで死んだときと起動できなかったときは null。 */
	code: number | null;
	tail: string;
}

const TAIL_BYTES = 8 * 1024;
const TAIL_LINES = 80;
const KILL_GRACE_MS = 2000;
const DRAIN_GRACE_MS = 250;

/** 文字列にするのは最後だけ。Buffer のまま切れば、マルチバイト文字の途中に当たっても壊れた文字が残らない。 */
function renderTail(buffer: Buffer): string {
	let start = 0;
	for (let i = buffer.length - 2, lines = 0; i >= 0; i--) {
		if (buffer[i] === 0x0a && ++lines === TAIL_LINES) {
			start = i + 1;
			break;
		}
	}
	while ((buffer[start] & 0xc0) === 0x80) start++;
	return buffer.toString("utf8", start).trimEnd();
}

/** プロセスグループへ送る。もう居ない (ESRCH) のは目的を果たした後なので、失敗は捨てる。タイマーの中で投げると Pi ごと落ちる。 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
	try {
		process.kill(-child.pid!, signal);
	} catch {}
}

export function run(command: string, cwd: string, options: { timeoutMs: number; signal: AbortSignal }): Promise<RunResult> {
	return new Promise((resolve) => {
		if (options.signal.aborted) return resolve({ ended: "cancelled", code: null, tail: "" });
		let tail: Buffer = Buffer.alloc(0);
		let ended: RunResult["ended"] = "exited";
		const timers: NodeJS.Timeout[] = [];
		// detached にしないと、シェルが起こした子 (テストランナーの worker など) にシグナルが届かない。
		const child = spawn("/bin/bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const stop = (cause: RunResult["ended"]) => {
			if (ended !== "exited") return;
			ended = cause;
			signalGroup(child, "SIGTERM");
			timers.push(setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS));
		};
		const cancel = () => stop("cancelled");
		const finish = (code: number | null, text: string) => {
			for (const timer of timers) clearTimeout(timer);
			options.signal.removeEventListener("abort", cancel);
			resolve({ ended, code, tail: text });
		};
		const collect = (chunk: Buffer) => {
			tail = Buffer.concat([tail, chunk]);
			if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
		};
		child.stdout!.on("data", collect);
		child.stderr!.on("data", collect);
		child.on("error", (error) => finish(null, String(error)));
		// シェルが終わっても、残った子 (`cmd &`) がパイプを握っていると close が来ない。
		// グループを抜けた子孫 (setsid) には SIGKILL も届かないので、待つのは DRAIN_GRACE_MS まで。
		child.on("exit", (code) => {
			signalGroup(child, "SIGKILL");
			timers.push(setTimeout(() => finish(code, renderTail(tail)), DRAIN_GRACE_MS));
		});
		child.on("close", (code) => finish(code, renderTail(tail)));
		options.signal.addEventListener("abort", cancel);
		timers.push(setTimeout(() => stop("timed_out"), options.timeoutMs));
	});
}
