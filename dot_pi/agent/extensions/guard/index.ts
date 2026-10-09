/**
 * guard — Pi のツール呼び出しを規則表 (rules.ts) で止め、bash ツールを OS の sandbox (sandbox.ts) に入れる。
 *
 * Pi は承認もサンドボックスも持たないので、AGENTS.md の禁止事項は文章でしかない。
 * 規則表と sandbox は別の軸で、規則表は full を含むどのモードでも効く。
 *
 * - 規則表: `tool_call` を拾い、bash の command と edit / write の path を照らす。
 * - sandbox: 組み込みの bash を同名で差し替え、full 以外では書ける場所を root・一時ディレクトリ・
 *   EXTRA_WRITE_PATHS に絞る (readonly は専用の一時ディレクトリだけ)。`tool_call` で command を
 *   書き換えないのは、transcript と規則表にモデルが書いたままの command を残すため。
 * - edit / write は Pi のプロセス内 (Node の fs) で動き sandbox の外なので、同じ場所の外への書き込みを
 *   ここで confirm にする。そうしないと write が sandbox の抜け道になる。
 *
 * ユーザーが自分で打つ `!` コマンド (`user_bash`) は意図して sandbox に入れていない。人の操作まで絞る理由がない。
 * ほかに覆っていないもの: MCP や他の拡張のツール、Pi の外のプロセス、ネットワーク、読み取り。/permissions の ask / readonly がツールを読み取り専用と
 * みなす根拠は組み込み reader の出自と readOnlyHint で、実際の副作用は検証しない。
 *
 * confirm は UI が要る。subagent は子の Pi を `--mode json -p` で起動するので、その中では
 * confirm の規則がすべて遮断になる。子はモードと root を環境変数 PI_GUARD で親から受け継ぎ、変えられない。
 * root まで渡すのは、subagent の cwd がモデルの指定だから (`cwd: "/"` で書ける場所を広げさせない)。
 *
 * このハンドラが例外を投げると Pi はそのツール呼び出しを遮断する (fail-closed)。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { GUARD_ENV, inheritedState, isPermissionMode, isPermissionState, judgePermission, PERMISSIONS_ENTRY, type PermissionMode, type PermissionState } from "./permissions.ts";
import { BASH_RULES, chezmoiTarget, evaluate, PATH_RULES, type Rule } from "./rules.ts";
import { containsHome, gitCommonDir, inside, sandboxArgv, sandboxAvailable, wrap, writeRoots } from "./sandbox.ts";

/** ダイアログと通知に出す対象の上限。数十行のヒアドキュメントが画面を埋めないようにする。 */
const SHOWN_LINES = 5;
const SHOWN_CHARS = 400;

/** 対象の先頭だけ。何に当たったかは規則の reason が説明する。 */
function head(subject: string): string {
	const shown = subject.split("\n").slice(0, SHOWN_LINES).join("\n").slice(0, SHOWN_CHARS);
	return shown.length < subject.length ? `${shown}\n[… ${subject.length - shown.length} more chars not shown]` : shown;
}

/**
 * chezmoi が管理するファイルの絶対パス。chezmoi が無い、または失敗するホストでは空。
 * ここで例外を通すと fail-closed で edit / write が全部止まるので、規則が効かない側に倒す。
 * 数十 ms で返るのでキャッシュしない。セッション中に `chezmoi add` された分も拾える。
 */
function chezmoiManaged(): Set<string> {
	try {
		const out = execFileSync("chezmoi", ["managed", "--include=files", "--path-style=absolute"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		return new Set(out.split("\n").filter(Boolean));
	} catch {
		return new Set();
	}
}

/**
 * edit / write が実際に開くパス。Pi の resolveToCwd (dist/core/tools/path-utils.js、実体は utils/paths.js の
 * resolvePath) と同じ手順をなぞる。SDK が export していないので写している。
 * 手順がずれると `@/abs/path` や `file:///abs/path` が cwd 配下の名前に見えて、判定と書き込み先が食い違う。
 */
export function targetPath(input: string, cwd: string): string {
	let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	else if (/^file:\/\//.test(path)) path = fileURLToPath(path);
	return resolve(cwd, path);
}

/** edit / write の先が書ける場所の外。規則表と同じ形にして、confirm と UI なしの遮断を既存の枠に任せる。 */
function outsideRoots(roots: string[]): Rule {
	return {
		id: "outside-write-roots",
		decision: "confirm",
		reason:
			"This path is outside the session's write roots (project directory, temp dir, tool caches) and needs the user's approval. Do not retry or route around this; bash is sandboxed to the same roots. Report what you wanted to write.",
		matches: (path) => !inside(roots, path),
	};
}

export default function (pi: ExtensionAPI) {
	const inherited = inheritedState(process.env[GUARD_ENV], process.pid);
	let mode: PermissionMode = inherited?.mode ?? "normal";
	let root = inherited?.root ?? process.cwd();
	// 子孫は自分で git に訊かない。親のモデルが `.git` を書き換えた後かもしれない。
	let git = inherited?.git;
	let scratch: string | undefined;

	/** 子孫は書き出さない。自分の pid で上書きすると、`/reload` の後に継承を見失って鍵が外れる。 */
	function publish() {
		if (!inherited) process.env[GUARD_ENV] = JSON.stringify({ mode, root, git, pid: process.pid });
	}

	function restore(ctx: ExtensionContext) {
		if (inherited) return;
		mode = "normal";
		root = ctx.cwd;
		git = gitCommonDir(root);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PERMISSIONS_ENTRY && isPermissionState(entry.data)) {
				mode = entry.data.mode;
			}
		}
		publish();
	}

	/** full では呼ばない。readonly の一時ディレクトリは sort など一時ファイルを作る道具が要るので、使うときに作る。 */
	function roots(): string[] {
		if (mode === "full") throw new Error("guard: full mode has no write roots.");
		if (mode === "readonly" && !(scratch && existsSync(scratch))) scratch = mkdtempSync(join(tmpdir(), "pi-guard-"));
		return writeRoots(mode, root, scratch ?? "", git);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
		scratch = undefined;
	});

	// モードは呼び出しのたびに読む (/permissions で途中から変わる)。`tool_call` を通らない経路で呼ばれても
	// sandbox なしでは走らないよう、ここでも例外で止める。
	pi.registerTool(
		createBashToolDefinition(process.cwd(), {
			spawnHook: (context) => {
				if (mode === "full") return context;
				const argv = sandboxArgv(roots());
				if (!argv) throw new Error(`guard[sandbox]: no OS sandbox on ${process.platform}.`);
				const wrapped = wrap(context, argv);
				if (mode === "readonly") wrapped.env.TMPDIR = scratch;
				return wrapped;
			},
		}),
	);

	pi.registerCommand("permissions", {
		description: "Show or set tool permissions: full, normal (sandboxed bash), ask, readonly",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (requested) {
				if (!isPermissionMode(requested)) {
					ctx.ui.notify("Usage: /permissions [full|normal|ask|readonly]", "warning");
					return;
				}
				if (inherited) {
					ctx.ui.notify(`Permissions: ${mode}, inherited from the parent Pi session and cannot be changed here.`, "warning");
					return;
				}
				pi.appendEntry(PERMISSIONS_ENTRY, { version: 1, mode: requested } satisfies PermissionState);
				mode = requested;
				publish();
			}
			ctx.ui.notify(
				[
					`Permissions: ${mode}${inherited ? " (inherited from the parent Pi session)" : ""}. Write root: ${containsHome(root) ? `none (${root} contains your home directory, so it is not writable; start Pi in a project directory)` : root}`,
					"full: no sandbox. normal (default): the bash tool runs in an OS sandbox that can write only to the write root, the temp dir and a few caches; edit/write outside those need confirmation. ask: normal, plus confirmation for every tool that is not read-only. readonly: bash runs with a read-only filesystem (private TMPDIR only); edit/write and tools without a trusted readOnlyHint are blocked.",
					`Sandbox: ${mode === "full" ? "off" : sandboxAvailable() ? "available" : "UNAVAILABLE, bash is blocked"}. Fixed guard rules apply in every mode.`,
					"Not covered: your own ! commands, MCP and other extension tools (readOnlyHint is not verified), processes outside Pi. Network and reads are not restricted. Mode is persisted per session and branch; subagents inherit it.",
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		let rule: Rule | undefined;
		let subject = "";
		if (isToolCallEventType("bash", event)) {
			subject = event.input.command;
			rule = evaluate(BASH_RULES, subject);
		} else if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			subject = targetPath(event.input.path, ctx.cwd);
			const rules = [...PATH_RULES, chezmoiTarget(chezmoiManaged())];
			if (mode === "normal" || mode === "ask") rules.push(outsideRoots(roots()));
			rule = evaluate(rules, subject);
		}
		// 固定の forbid はモードやメタデータ、確認ダイアログより先に適用する。
		if (rule?.decision === "forbid") {
			if (ctx.hasUI) ctx.ui.notify(`guard[${rule.id}] blocked: ${head(subject)}`, "warning");
			return { block: true, reason: `guard[${rule.id}]: ${rule.reason}` };
		}

		// sandbox が無いのに通すと、normal も readonly も名前だけになる。黙って素の bash に落とさない。
		if (event.toolName === "bash" && mode !== "full" && !sandboxAvailable()) {
			const reason = `guard[sandbox]: The OS sandbox is unavailable, so bash is disabled in ${mode} mode. Stop and tell the user: install bubblewrap (Linux, with unprivileged user namespaces enabled), or switch with /permissions full. Do not retry or route around this.`;
			if (ctx.hasUI) ctx.ui.notify(reason, "warning");
			return { block: true, reason };
		}

		const permission = judgePermission(
			mode,
			event.toolName,
			mode === "full" || mode === "normal" ? undefined : pi.getAllTools().find((tool) => tool.name === event.toolName),
		);
		if (permission === "forbid") {
			const reason = `guard[readonly]: ${event.toolName} is not an allowed read-only tool.`;
			if (ctx.hasUI) ctx.ui.notify(reason, "warning");
			return { block: true, reason };
		}

		if (!rule) {
			if (permission !== "confirm") return undefined;
			if (!ctx.hasUI) return { block: true, reason: `guard[ask]: ${event.toolName} needs the user's approval and no user can be asked in this session. Do not retry or route around this; report what you wanted to do.` };
			if (await ctx.ui.confirm("guard: ask", `${event.toolName}\n\n${head(JSON.stringify(event.input))}\n\nAllow?`)) return undefined;
			return { block: true, reason: `guard[ask]: ${event.toolName} was not approved.` };
		}

		if (rule.decision === "confirm" && ctx.hasUI) {
			if (await ctx.ui.confirm(`guard: ${rule.id}`, `${head(subject)}\n\n${rule.reason}\n\nAllow?`)) return undefined;
			return { block: true, reason: `guard[${rule.id}]: denied by the user. ${rule.reason}` };
		}
		if (ctx.hasUI) ctx.ui.notify(`guard[${rule.id}] blocked: ${head(subject)}`, "warning");
		return { block: true, reason: `guard[${rule.id}]: ${rule.reason}` };
	});
}
