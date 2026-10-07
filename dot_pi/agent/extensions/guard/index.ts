/**
 * guard — Pi のツール呼び出しを規則表 (rules.ts) で止める。
 *
 * Pi は承認もサンドボックスも持たないので、AGENTS.md の禁止事項は文章でしかない。
 * `tool_call` を拾い、bash の command と edit / write の path を規則に照らす。
 *
 * 見ていないもの: MCP ツールと他の拡張が登録したツール、ユーザーが自分で打つ `!` コマンド
 * (`user_bash`)。bash 経由のファイル書き込み (`>`, `tee`, `sed -i`) は PATH_RULES ではなく
 * BASH_RULES の担当になる。
 *
 * confirm は UI が要る。subagent は子の Pi を `--mode json -p` で起動するので、その中では
 * confirm の規則がすべて遮断になる。
 *
 * このハンドラが例外を投げると Pi はそのツール呼び出しを遮断する (fail-closed)。
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { BASH_RULES, chezmoiTarget, evaluate, PATH_RULES, type Rule } from "./rules.ts";

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

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		let rule: Rule | undefined;
		let subject = "";
		if (isToolCallEventType("bash", event)) {
			subject = event.input.command;
			rule = evaluate(BASH_RULES, subject);
		} else if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			// Pi の edit / write は `~` を展開する。resolve だけだと cwd 配下の `~` という名前になる。
			subject = resolve(ctx.cwd, event.input.path.replace(/^~(?=\/|$)/, homedir()));
			rule = evaluate([...PATH_RULES, chezmoiTarget(chezmoiManaged())], subject);
		}
		if (!rule) return undefined;

		if (rule.decision === "confirm" && ctx.hasUI) {
			if (await ctx.ui.confirm(`guard: ${rule.id}`, `${head(subject)}\n\n${rule.reason}\n\nAllow?`)) return undefined;
			return { block: true, reason: `guard[${rule.id}]: denied by the user. ${rule.reason}` };
		}
		if (ctx.hasUI) ctx.ui.notify(`guard[${rule.id}] blocked: ${head(subject)}`, "warning");
		return { block: true, reason: `guard[${rule.id}]: ${rule.reason}` };
	});
}
