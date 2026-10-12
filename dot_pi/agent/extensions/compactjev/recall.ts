/**
 * session_recall: 圧縮で文脈から消えた履歴を、モデルがセッションから引き直す道具。
 *
 * 圧縮は entry を消さない。要約の entry を足すだけなので、今の枝の entry を読めば圧縮前の発言も
 * ツール結果も原文で残っている。ここでは読むだけで、何も書かない。
 */

import { contentText, Type } from "@earendil-works/pi-ai";
import { type ContextEditEntry, convertToLlm, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** 1 回の呼び出しで返す本文の字数。超える分は offset で続きを取る。 */
const RECALL_MAX_CHARS = 10000;
/** 検索で返す件数。 */
const RECALL_MAX_MATCHES = 10;
/** 一致箇所の前後に付ける字数。 */
const EXCERPT_CHARS = 150;

interface Recalled {
	id: string;
	/** ツール結果なら、その toolCallId。compactjev が畳んだ印に書く id はこちら。 */
	callId?: string;
	/** アシスタントの発言なら、その中の呼び出しを toolCallId から引く表。 */
	calls?: Map<string, string>;
	label: string;
	text: string;
}

const TOOL_NAME = "session_recall";

/**
 * 今の枝のメッセージを、モデルに見える形の本文にする。
 * `forSearch` ではこの道具自身の呼び出しと結果を外す。実行中の呼び出しはもう枝に入っていて、探している語を
 * 引数に持つので、外さないと何を探しても自分に一致する。過去の検索とその結果も同じ語を持ち、件数の枠を食う。
 */
function records(entries: SessionEntry[], forSearch: boolean): Recalled[] {
	const out: Recalled[] = [];
	// Pi が文脈から外した・置き換えた entry を原文で返すと、外した意味が無くなる。後の編集が勝つ (session-manager.js の buildSessionProjection)。
	const edits = new Map<string, ContextEditEntry["replacement"]>();
	for (const entry of entries) if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const edit = edits.get(entry.id);
		if (edit === null) continue;
		// 文字列の置き換えを配列に直すのは、Pi の projectContextEntry と同じ。
		const content = edit && typeof edit.content === "string" && entry.message.role !== "user" ? [{ type: "text", text: edit.content }] : edit?.content;
		const message = edit ? ({ ...entry.message, content } as typeof entry.message) : entry.message;
		for (const m of convertToLlm([message])) {
			if (m.role === "user") out.push({ id: entry.id, label: "user", text: contentText(m.content, "") });
			else if (m.role === "toolResult") {
				if (forSearch && m.toolName === TOOL_NAME) continue;
				out.push({ id: entry.id, callId: m.toolCallId, label: `tool result${m.isError ? " (error)" : ""}`, text: contentText(m.content, "") });
			} else if (m.role === "assistant") {
				const calls = new Map<string, string>();
				const parts = m.content.flatMap((block) => {
					if (block.type === "text") return [block.text];
					if (block.type !== "toolCall" || (forSearch && block.name === TOOL_NAME)) return [];
					const args = Object.entries(block.arguments ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
					const call = `${block.name}(${args.join(", ")})`;
					calls.set(block.id, call);
					return [call];
				});
				out.push({ id: entry.id, calls, label: "assistant", text: parts.join("\n") });
			}
		}
	}
	return out.filter((record) => record.text.trim());
}

function whole(all: Recalled[], id: string, offset: number): string {
	let text = all.find((r) => r.id === id)?.text;
	if (text === undefined) {
		// toolCallId は呼び出しと結果の 2 つの entry にまたがる。結果だけ返すと、write や edit の書いた中身 (引数) が戻らない。
		const call = all.find((r) => r.calls?.has(id))?.calls?.get(id);
		const result = all.find((r) => r.callId === id);
		const parts = [...(call === undefined ? [] : [`[Tool call]: ${call}`]), ...(result ? [`[T${result.label.slice(1)}]: ${result.text}`] : [])];
		if (parts.length === 0) throw new Error(`session_recall: no entry with id ${id}`);
		text = parts.join("\n");
	}
	const rest = text.length - offset - RECALL_MAX_CHARS;
	return `${text.slice(offset, offset + RECALL_MAX_CHARS)}${rest > 0 ? `\n[${rest} more chars; call again with offset=${offset + RECALL_MAX_CHARS}]` : ""}`;
}

function search(all: Recalled[], query: string): string {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const matches = all.filter((record) => {
		const text = record.text.toLowerCase();
		return words.every((word) => text.includes(word));
	});
	if (words.length === 0 || matches.length === 0) return `No entry in this session matches ${JSON.stringify(query)}.`;
	const shown = matches.reverse().slice(0, RECALL_MAX_MATCHES).map((record) => {
		const at = record.text.toLowerCase().indexOf(words[0]);
		const start = Math.max(0, at - EXCERPT_CHARS);
		const end = Math.min(record.text.length, at + words[0].length + EXCERPT_CHARS);
		const excerpt = `${start > 0 ? "…" : ""}${record.text.slice(start, end)}${end < record.text.length ? "…" : ""}`;
		return `id ${record.id}${record.callId ? ` (tool call ${record.callId})` : ""}, ${record.label}, ${record.text.length} chars\n${excerpt}`;
	});
	const count = matches.length === 1 ? "1 matching entry" : `${matches.length} matching entries, newest first${matches.length > shown.length ? `, first ${shown.length} shown` : ""}`;
	return [`${count}. Pass an id to get an entry whole.`, ...shown].join("\n\n");
}

export function registerRecall(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_NAME,
		description:
			"Read this session's own history, including everything from before a compaction. With query: list the entries containing all of its words (case-insensitive), newest first, each with its id and the text around the match. With id: return that entry's full text; id is an entry id from a search, or the tool call id named in a 'dropped by compactjev' note, which returns that call's arguments and its result together. Entries the session has removed from context are not returned, and replaced ones come back as replaced. Long entries come in pieces: pass the offset the result names to continue. Use it when the compacted history lacks an exact command, output or wording you need, instead of running the tool again.",
		promptSnippet: "Search this session's history from before compaction, or get one earlier message or tool result whole",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Words that must all appear in an entry" })),
			id: Type.Optional(Type.String({ description: "Entry id to return whole, or tool call id to return the call and its result whole" })),
			offset: Type.Optional(Type.Number({ description: "Character offset to continue a long entry from (with id)" })),
		}),
		// guard は ask と readonly で、この申告のある道具だけを確認なしに通す (guard/permissions.ts の judgePermission)。
		annotations: { readOnlyHint: true },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const entries = ctx.sessionManager.getBranch();
			if (params.id) return { content: [{ type: "text", text: whole(records(entries, false), params.id, Math.max(0, Math.floor(params.offset ?? 0))) }], details: undefined };
			if (params.query) return { content: [{ type: "text", text: search(records(entries, true), params.query) }], details: undefined };
			throw new Error("session_recall: pass query or id");
		},
	});
}
