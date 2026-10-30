import { existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function targetDir(args: string, cwd: string): string {
	const path = args.trim();
	if (!path || path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return resolve(cwd, path);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cd", {
		description: "Move this session to another directory (default: $HOME)",
		handler: async (args, ctx) => {
			const target = targetDir(args, ctx.cwd);
			if (!existsSync(target) || !statSync(target).isDirectory()) {
				ctx.ui.notify(`Not a directory: ${target}`, "error");
				return;
			}
			if (target === ctx.cwd) {
				ctx.ui.notify(`Already in ${target}`, "info");
				return;
			}
			const source = ctx.sessionManager.getSessionFile();
			if (!source) {
				ctx.ui.notify("/cd needs a persisted session; this one runs with --no-session.", "error");
				return;
			}
			await ctx.waitForIdle();

			// switchSession は cwd を受け取らず、ファイルのヘッダの cwd で作り直す。
			// SessionManager.forkFrom はファイルが要るので、最初の応答前のまだ書かれていないセッションで投げる。
			const leaf = ctx.sessionManager.getLeafId();
			const entries = ctx.sessionManager.getEntries();
			const next = SessionManager.create(target);
			const file = next.getSessionFile()!;
			const header = { ...next.getHeader()!, ...(existsSync(source) ? { parentSession: source } : {}) };
			writeFileSync(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);

			await ctx.switchSession(file, {
				withSession: async (moved) => {
					// 開き直すと leaf は最後の entry になるので、/tree で戻っていた位置を復元する。
					if (leaf && leaf !== entries.at(-1)?.id) await moved.navigateTree(leaf);
				},
			});
		},
	});
}
