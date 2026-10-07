/**
 * questionnaire — Pi 同梱の公式サンプル (examples/extensions/questionnaire.ts) を、いま動いている
 * release から読み込む。モデルが選択肢つきの質問を 1 問以上まとめて出せる `questionnaire` ツールになる。
 *
 * symlink でもコピーでもない理由は subagent/index.ts と同じ。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
	const install = join(getAgentDir(), "install");
	const version = readFileSync(join(install, "current-version"), "utf8").trim();
	const { default: questionnaire } = await import(
		join(install, "releases", version, "node_modules/@earendil-works/pi-coding-agent/examples/extensions/questionnaire.ts")
	);
	await questionnaire(pi);
}
