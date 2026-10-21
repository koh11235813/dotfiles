/**
 * Codex に仕事を頼む 2 つのツール: `codex` (新しい thread) と `codex_reply` (同じ thread の続き)。どちらも `codex exec --json` を
 * 1 回起こして終わる。app-server も MCP も使わない (README)。
 *
 * sandbox と承認は起こすたびに明示する。~/.codex/config.toml の既定 (on-request + workspace-write) を引き継がないため。
 * guard はこのツールを sandbox に入れない (guard/index.ts の「覆っていないもの」)。境界は Codex 自身の sandbox だけ。
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CodexResult, runCodex } from "./run.ts";

const SANDBOXES = ["read-only", "workspace-write"] as const;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const TOOLS = ["codex", "codex_reply"];

type Sandbox = (typeof SANDBOXES)[number];
/** thread を続けるときに戻す設定。両ツールの結果の details にも載せるので、セッションを開き直しても枝から引ける。 */
export interface Thread {
	threadId: string;
	cwd: string;
	sandbox: Sandbox;
	model?: string;
	effort?: string;
}

const binary = () => process.env.PI_CODEX_BIN || "codex";
/** 呼ぶたびに読む。テストが短くするのと、Pi を起こし直さずに変えられるように。 */
function timeoutMs(): number {
	const value = Number(process.env.PI_CODEX_TIMEOUT_MS);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** child が parent と同じか、その中にある。 */
function within(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** symlink を解いてから比べる。解かないと、root の中の symlink から外へ出られる。 */
function workdir(root: string, given: string | undefined): string {
	let base: string;
	let target: string;
	try {
		base = realpathSync(root);
		target = realpathSync(resolve(root, given ?? "."));
	} catch {
		throw new Error(`codex: cwd does not exist: ${given}`);
	}
	if (!within(base, target)) throw new Error(`codex: cwd must be inside the working directory (${base}): ${given}`);
	return target;
}

/**
 * 起こすときも続けるときも同じ形。resume は `-s` と `-C` を受け付けないので、sandbox は `-c` で、cwd は spawn の cwd で渡す。
 * `-c` の値は TOML として読まれるので、文字列は引用符ごと渡す。effort は列挙から選ばせているので、引用符を破る値は来ない。
 * `--last` は使わない。同じ cwd で別の thread が走っていると、違う thread を続けてしまう。
 */
export function codexArgs(thread: Omit<Thread, "threadId" | "cwd">, resumeId?: string): string[] {
	const args = ["exec", ...(resumeId ? ["resume"] : []), "--json", "-c", `sandbox_mode="${thread.sandbox}"`, "-c", 'approval_policy="never"'];
	if (thread.effort) args.push("-c", `model_reasoning_effort="${thread.effort}"`);
	if (thread.model) args.push("-m", thread.model);
	// git の確認は、取り消せない書き込みから守るためのもの。read-only では書けないので外し、git の外のディレクトリでも訊けるようにする。
	if (thread.sandbox === "read-only") args.push("--skip-git-repo-check");
	// プロンプトは `-` で stdin から。argv に載せると ps に出て、長さの上限にも当たる。
	args.push("--", ...(resumeId ? [resumeId] : []), "-");
	return args;
}

/** 成功の条件は、終了コード 0、turn.completed、最後の agent_message、thread id の全部。stderr は成功しても ERROR の行を出すので、判定には使わない。 */
function answer(result: CodexResult, timeout: number): string {
	const where = result.threadId ? ` (threadId: ${result.threadId})` : "";
	if (result.ended === "cancelled") throw new Error(`codex: cancelled${where}`);
	const problems = [...result.failures];
	if (result.ended === "timed_out") problems.push(`timed out after ${timeout} ms (PI_CODEX_TIMEOUT_MS)`);
	else if (result.code !== 0) problems.push(result.code === null ? "could not start, or ended by a signal" : `exit code ${result.code}`);
	if (!result.threadId) problems.push("no thread.started event");
	if (!result.completed && result.ended === "exited") problems.push("no turn.completed event");
	if (result.message === undefined && result.ended === "exited") problems.push("no final agent message");
	if (!problems.length) return result.message!;
	const tail = result.stderrTail ? `\nstderr tail:\n${result.stderrTail}` : "";
	throw new Error(`codex failed${where}: ${problems.join("; ")}${tail}`);
}

export default function (pi: ExtensionAPI) {
	/** このプロセスで始めた thread。枝に結果が無い (失敗で終わった、テストが execute を直に呼ぶ) ときもここから引ける。 */
	const threads = new Map<string, Thread>();
	/** thread ごとの直列化。同じ thread を 2 つの codex が同時に書くと、履歴が混ざる。 */
	const queues = new Map<string, Promise<void>>();
	const running = new Set<{ controller: AbortController; done: Promise<unknown> }>();

	function find(ctx: ExtensionContext, threadId: string): Thread | undefined {
		const known = threads.get(threadId);
		if (known) return known;
		for (const entry of ctx.sessionManager.getBranch() as Array<{ type: string; message?: { role?: string; toolName?: string; details?: Thread } }>) {
			const message = entry.type === "message" ? entry.message : undefined;
			const details = message?.role === "toolResult" && TOOLS.includes(message.toolName!) ? message.details : undefined;
			// 枝の中身は列挙で縛られていない。知らない sandbox や、`-c` の引用符を破る effort はそのまま渡さない。
			if (details?.threadId === threadId && SANDBOXES.includes(details.sandbox) && (details.effort === undefined || (EFFORTS as readonly string[]).includes(details.effort))) return details;
		}
		return undefined;
	}

	async function launch(settings: Omit<Thread, "threadId">, prompt: string, signal: AbortSignal | undefined, resumeId?: string) {
		const controller = new AbortController();
		const forward = () => controller.abort();
		signal?.addEventListener("abort", forward);
		if (signal?.aborted) controller.abort();
		const timeout = timeoutMs();
		const done = runCodex(binary(), codexArgs(settings, resumeId), { cwd: settings.cwd, prompt, timeoutMs: timeout, signal: controller.signal });
		const handle = { controller, done };
		running.add(handle);
		try {
			const result = await done;
			// 失敗しても thread id が出ていれば覚える。timeout した thread も codex_reply で続けられる。
			// 続けるときは、id はこちらが渡したもの。resume が thread.started を出すかには頼らない。
			const threadId = resumeId ?? result.threadId;
			if (threadId) threads.set(threadId, { ...settings, threadId });
			const text = answer({ ...result, threadId }, timeout);
			const thread: Thread = { ...settings, threadId: threadId! };
			return { content: [{ type: "text" as const, text: `${text}\n\nthreadId: ${thread.threadId}` }], details: thread };
		} finally {
			signal?.removeEventListener("abort", forward);
			running.delete(handle);
		}
	}

	async function serialized<T>(threadId: string, work: () => Promise<T>): Promise<T> {
		const current = (queues.get(threadId) ?? Promise.resolve()).then(work);
		const settled = current.then(
			() => {},
			() => {},
		);
		queues.set(threadId, settled);
		try {
			return await current;
		} finally {
			if (queues.get(threadId) === settled) queues.delete(threadId);
		}
	}

	// 止まり切るのを待つ。待たずに Pi が終わると、SIGTERM を無視する codex に SIGKILL を送る前に手が離れる。
	pi.on("session_shutdown", async () => {
		for (const handle of running) handle.controller.abort();
		await Promise.all([...running].map((handle) => handle.done));
	});

	// readOnlyHint は付けない。workspace-write では Codex が cwd の中を書き換える。
	pi.registerTool({
		name: "codex",
		label: "codex",
		description:
			"Start a new Codex thread with `codex exec` and return Codex's final message and the threadId. Codex works on its own inside its own sandbox: read-only (default) can read files and run read-only commands; workspace-write can also modify files under cwd. Approval requests are never shown and never escalated. Use codex_reply with the threadId to continue the same thread.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Instructions for Codex" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for Codex, inside the current working directory (default: the current working directory)" })),
			sandbox: Type.Optional(StringEnum(SANDBOXES, { description: "read-only (default) or workspace-write" })),
			model: Type.Optional(Type.String({ description: "Codex model (default: Codex's configured model)" })),
			effort: Type.Optional(StringEnum(EFFORTS, { description: "Reasoning effort (default: Codex's configured effort)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const settings = { cwd: workdir(ctx.cwd, params.cwd), sandbox: params.sandbox ?? "read-only", model: params.model, effort: params.effort };
			return launch(settings, params.prompt, signal);
		},
	});

	pi.registerTool({
		name: "codex_reply",
		label: "codex_reply",
		description:
			"Continue a Codex thread started by the codex tool in this session, with the same cwd, sandbox, model and effort. Returns Codex's final message. Calls to the same thread run one at a time.",
		parameters: Type.Object({
			threadId: Type.String({ description: "threadId returned by codex" }),
			prompt: Type.String({ description: "Next message to Codex" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const thread = find(ctx, params.threadId);
			if (!thread) throw new Error(`codex_reply: unknown threadId ${params.threadId}. Only threads started by the codex tool in this session can be continued.`);
			const { threadId, ...settings } = thread;
			// 枝から引いた cwd も確かめ直す。セッションは別の cwd で開き直せる。
			workdir(ctx.cwd, settings.cwd);
			return serialized(threadId, () => launch(settings, params.prompt, signal, threadId));
		},
	});
}
