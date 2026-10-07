/**
 * tps — 直前の応答の生成速度をフッターに `54 tps` の形で出す。
 *
 * 分子は provider が報告する出力トークン数 (reasoning を含む)、分母は最初の delta から
 * message_end までの時間。リクエスト送信から測ると最初のトークンが届くまでの待ち時間が混ざり、
 * プロンプトが長いほど遅く見えてしまう。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** これより短い生成は数トークンが一度に届いただけで、割ると桁違いの値になるので前の表示を残す。 */
const MIN_SECONDS = 0.5;

export default function (pi: ExtensionAPI) {
	let firstDelta: number | undefined;

	pi.on("message_update", (event) => {
		if (firstDelta === undefined && event.assistantMessageEvent.type.endsWith("_delta")) firstDelta = performance.now();
	});

	pi.on("message_end", (event, ctx) => {
		const started = firstDelta;
		firstDelta = undefined;
		if (event.message.role !== "assistant" || started === undefined) return;
		const seconds = (performance.now() - started) / 1000;
		const tokens = event.message.usage.output;
		if (!tokens || seconds < MIN_SECONDS) return;
		ctx.ui.setStatus("tps", ctx.ui.theme.fg("dim", `${Math.round(tokens / seconds)} tps`));
	});
}
