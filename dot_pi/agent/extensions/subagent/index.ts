/**
 * subagent — Pi 同梱の公式サンプル (examples/extensions/subagent) を、いま動いている release から読み込む。
 *
 * サンプルへの symlink は release のバージョンをパスに含むので、Pi を更新するたびに古い release を
 * 指したまま残る。その release が消えると Pi は index.ts の無いディレクトリを読み飛ばすだけで、
 * エラーも警告も出ないまま subagent ツールが使えなくなる。
 * コピーを置かないのは、サンプル側の修正を取り込み損ねるため。
 *
 * サンプルに付属する prompt テンプレート (/implement など) も同じ理由でここから渡す。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
	const install = join(getAgentDir(), "install");
	const version = readFileSync(join(install, "current-version"), "utf8").trim();
	const example = join(
		install,
		"releases",
		version,
		"node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts",
	);
	const { default: subagent } = await import(example);
	await subagent(pi);
	pi.on("resources_discover", () => ({ promptPaths: [join(dirname(example), "prompts")] }));
}
