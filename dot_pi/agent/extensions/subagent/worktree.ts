/**
 * 公式 sample の subagent ツールに、`worktree` の引数を足す。
 *
 * ここでするのは、引数をモデルに見せることだけ。worktree を作るのも、子の cwd を書き換えるのも、終わった後の差分を
 * 結果に付けるのも guard (`guard/worktree.ts`)。git を sandbox の中で打てるのが guard だけだから。
 * sample をコピーして直さないのは index.ts と同じ理由 (サンプル側の修正を取り込み損ねる)。登録を横取りして引数を足す。
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

const DESCRIPTION =
	"Set worktree: true to run each task (a chain shares one) in its own new git worktree under .pi-worktrees/, branched from HEAD, instead of the shared working directory. Use it when agents write files in parallel. Uncommitted changes of the current working tree are not in it, and node_modules, ports and environment variables are not separated. The result lists what each worktree changed; nothing is merged or removed automatically, and integration needs the user's approval. Cannot be combined with cwd.";

function extend(tool: ToolDefinition): ToolDefinition {
	return {
		...tool,
		description: `${tool.description} ${DESCRIPTION}`,
		parameters: Type.Object({
			...(tool.parameters as unknown as { properties: Record<string, never> }).properties,
			worktree: Type.Optional(Type.Boolean({ description: "Give each task its own git worktree (see the tool description)" })),
		}),
		// guard は用意した後で worktree を引数から消す。残っていたら誰も用意していない。黙って共有の cwd で走らせると、
		// 分かれているつもりの並列の書き込みが同じ作業ツリーでぶつかる。
		async execute(id, params, ...rest) {
			if ((params as { worktree?: unknown }).worktree) {
				throw new Error("subagent: worktree isolation is provided by the guard extension, which did not handle this call. Nothing was run. Delegate without worktree, or tell the user that guard is not loaded.");
			}
			return tool.execute(id, params, ...rest);
		},
	} as ToolDefinition;
}

/** `pi` と同じに振る舞い、subagent ツールの登録だけ書き換える。 */
export function withWorktree(pi: ExtensionAPI): ExtensionAPI {
	const wrapped: ExtensionAPI = Object.create(pi);
	wrapped.registerTool = (tool) => pi.registerTool(tool.name === "subagent" ? (extend(tool as unknown as ToolDefinition) as never) : tool);
	return wrapped;
}
