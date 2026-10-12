/**
 * compactjev の calls モード。
 *
 * ツール呼び出し (引数と結果) を 1 つの単位として Jev に「この先も原文のまま要るか」を訊き、
 * LLM の要約を作らずに、会話の原文を並べたものを圧縮の結果として返す。ユーザーとアシスタントの
 * 発言はそのまま残し、要らないと採点された呼び出しだけを頭と印に畳む。
 *
 * 返せないとき (Jev の失敗、予算に収まらない、採点の上限超え) は理由を返すだけで、呼んだ側が
 * lines モードに落として Pi の要約に任せる。原文の並びには上限が無いので、この逃げ道を消すと
 * 圧縮しても文脈が減らなくなる。
 */

import { type ClassifierApi, type ClassifierModel, type ClassifierQuestion, contentText } from "@earendil-works/pi-ai";
import { type CompactionResult, convertToLlm, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

/** 畳んだ呼び出しに残す引数の字数。Jev に見せる字数も同じ。 */
const CALL_HEAD_CHARS = 500;
/** 畳んだ結果に残す頭の字数。Jev に見せる頭と末尾の字数も同じ。 */
const RESULT_HEAD_CHARS = 300;
/** 失敗したツール結果の末尾から、採点に関わらず残す字数。lines モードも同じ値を使う。 */
export const ERROR_TAIL_CHARS = 600;
/** 引数と結果を合わせてこれ以下の呼び出しは訊かずに残す。畳んでも減らない。 */
const SMALL_CALL_CHARS = CALL_HEAD_CHARS + RESULT_HEAD_CHARS;
/** これ以上の採点なら原文のまま残す。 */
const KEEP_PROBABILITY = 0.5;
/** 1 回の Jev 要求に入れる呼び出しの数。 */
const BATCH_CALLS = 20;
/** 費用の上限: 1 回の圧縮で採点する呼び出しの数。 */
const MAX_SCORED_CALLS = 300;
/** 同時に出す Jev 要求の数。 */
const CONCURRENCY = 4;

/** ユーザーかアシスタントの発言、または Pi が作った前回の要約。原文のまま持つ。 */
interface TextItem {
	kind: "user" | "assistant" | "summary";
	text: string;
}

/** 1 つのツール呼び出し。`kept` が false なら `call` と `result` は畳んだ後の本文。 */
interface CallItem {
	kind: "call";
	/** toolCallId。畳んだ結果の原文はセッションのこの id の結果にある。 */
	id: string;
	call: string;
	result: string;
	error: boolean;
	/** 畳む前の、引数と結果を合わせた字数。 */
	chars: number;
	kept: boolean;
	/** Jev の採点。訊かなかった呼び出しには無い。 */
	probability?: number;
}

export type Item = TextItem | CallItem;

/** 圧縮の entry の `details`。ファイル一覧は Pi の要約と同じ欄に置く。 */
interface Details {
	readFiles: string[];
	modifiedFiles: string[];
	/** 今回の並び。次の圧縮はここから組み直し、残した呼び出しを採点し直す。 */
	compactjev: { version: 1; items: Item[] };
}

export type CallsOutcome =
	| { compaction: CompactionResult<Details>; calls: number; dropped: number }
	| { declined: string; failed: boolean };

/** 圧縮される範囲のメッセージを、発言と呼び出しの並びにする。thinking と画像は持たない。 */
function toItems(messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"]): Item[] {
	const items: Item[] = [];
	const calls = new Map<string, CallItem>();
	for (const m of convertToLlm(messages)) {
		if (m.role === "user") {
			const text = contentText(m.content, "");
			if (text.trim()) items.push({ kind: "user", text });
		} else if (m.role === "assistant") {
			const text = m.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			if (text.trim()) items.push({ kind: "assistant", text });
			for (const block of m.content) {
				if (block.type !== "toolCall") continue;
				// Pi の要約器が直列化するのと同じ形。
				const args = Object.entries(block.arguments ?? {})
					.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
					.join(", ");
				const item: CallItem = { kind: "call", id: block.id, call: `${block.name}(${args})`, result: "", error: false, chars: 0, kept: true };
				calls.set(block.id, item);
				items.push(item);
			}
		} else if (m.role === "toolResult") {
			let item = calls.get(m.toolCallId);
			if (!item) {
				// 呼び出しが範囲の外にある結果。
				item = { kind: "call", id: m.toolCallId, call: m.toolName, result: "", error: false, chars: 0, kept: true };
				items.push(item);
			}
			item.result = contentText(m.content, "");
			item.error = m.isError === true;
		}
	}
	for (const item of items) if (item.kind === "call") item.chars = item.call.length + item.result.length;
	return items;
}

/** `details` が自分の書いた形なら、その並びの写しを返す。Pi の要約の details や壊れた記録では undefined。 */
function storedItems(details: unknown): Item[] | undefined {
	const stored = (details as { compactjev?: { version?: unknown; items?: unknown } } | undefined)?.compactjev;
	if (stored?.version !== 1 || !Array.isArray(stored.items)) return undefined;
	const valid = stored.items.every((item: Record<string, unknown> | null) => {
		if (!item || typeof item !== "object") return false;
		if (item.kind === "user" || item.kind === "assistant" || item.kind === "summary") return typeof item.text === "string";
		return item.kind === "call" && typeof item.id === "string" && typeof item.call === "string" && typeof item.result === "string" && typeof item.chars === "number" && typeof item.kept === "boolean";
	});
	return valid ? structuredClone(stored.items) : undefined;
}

/** 前回の圧縮が残したもの。自分の結果なら並びとファイル一覧、そうでなければ要約の本文。 */
function previous(event: SessionBeforeCompactEvent): { items: Item[]; readFiles: string[]; modifiedFiles: string[] } {
	const summary = event.preparation.previousSummary;
	if (summary === undefined) return { items: [], readFiles: [], modifiedFiles: [] };
	const entry = event.branchEntries.findLast((e) => e.type === "compaction" && e.summary === summary);
	const details = entry?.type === "compaction" ? (entry.details as Partial<Details> | undefined) : undefined;
	const items = storedItems(details);
	// Pi の要約には採点する呼び出しが無い。ファイル一覧は Pi が fileOps に足し込んでいる。
	if (!items) return { items: [{ kind: "summary", text: summary }], readFiles: [], modifiedFiles: [] };
	const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : []);
	return { items, readFiles: list(details?.readFiles), modifiedFiles: list(details?.modifiedFiles) };
}

/** 呼び出しを畳んだときの引数と結果。 */
function collapse(item: CallItem): { call: string; result: string } {
	// 印を足すと元より長くなる長さのものは、そのまま残す。
	const shorter = (cut: string, whole: string): string => (cut.length < whole.length ? cut : whole);
	// write や edit では書いた中身が引数にあるので、引数の側にも引き方を書く。
	const call = shorter(`${item.call.slice(0, CALL_HEAD_CHARS)} [… ${item.call.length - CALL_HEAD_CHARS} chars dropped by compactjev; session_recall(id="${item.id}") returns the whole call]`, item.call);
	const keep = item.error ? ERROR_TAIL_CHARS : RESULT_HEAD_CHARS;
	const note = `[… ${item.result.length - keep} chars dropped by compactjev; session_recall(id="${item.id}") returns the whole result]`;
	// 失敗の中身 (エラー文、終了状態) は出力の終わりにある。
	return { call, result: shorter(item.error ? `${note}\n${item.result.slice(-keep)}` : `${item.result.slice(0, keep)}\n${note}`, item.result) };
}

const HEADER = `This is not a summary. It is the earlier conversation itself: user and assistant text is verbatim and in order. Tool calls judged no longer needed were cut to a short excerpt (their start, or their end if they failed) with a note in place. The session_recall tool returns any of them whole, arguments and result, by the id in the note.`;

function render(items: Item[]): string {
	const parts = items.map((item) => {
		if (item.kind === "summary") return `[Earlier summary]: ${item.text}`;
		if (item.kind === "user") return `[User]: ${item.text}`;
		if (item.kind === "assistant") return `[Assistant]: ${item.text}`;
		const call = `[Tool call]: ${item.call}`;
		return item.result ? `${call}\n[Tool result${item.error ? " (error)" : ""}]: ${item.result}` : call;
	});
	return [HEADER, ...parts].join("\n\n");
}

/** Jev に見せる 1 つの呼び出し。結果は頭と末尾だけ。 */
function excerpt(item: CallItem): { call: string; output: string; chars: number; failed: boolean } {
	const output = item.result.length > RESULT_HEAD_CHARS * 2 ? `${item.result.slice(0, RESULT_HEAD_CHARS)}\n[…]\n${item.result.slice(-RESULT_HEAD_CHARS)}` : item.result;
	return { call: item.call.slice(0, CALL_HEAD_CHARS), output, chars: item.result.length, failed: item.error };
}

/** 1 回の要求で `batch` を採点する。失敗したら理由を返す。 */
async function scoreBatch(ctx: ExtensionContext, jev: ClassifierModel<ClassifierApi>, goal: string, batch: CallItem[], signal: AbortSignal): Promise<string | undefined> {
	const questions: Record<string, ClassifierQuestion> = {};
	batch.forEach((_, i) => {
		questions[`c${i}`] = {
			type: "bool",
			instructions: `Does continuing toward \`goal\` still need the full input and output of \`calls[${i}]\` verbatim?`,
			criteria: {
				true: "Yes. Later work depends on its exact content and running the tool again would not cheaply give it back: an error, a result value, the text being edited.",
				false: "No. It is routine, superseded by a later call, already acted on, or cheap to get again.",
			},
		};
	});
	const result = await ctx.modelRegistry.classify(jev, { state: { goal, calls: batch.map(excerpt) }, questions }, { signal });
	if (result.stopReason !== "stop") return result.errorMessage ?? result.stopReason;
	let unanswered = 0;
	batch.forEach((item, i) => {
		const answer = result.answers[`c${i}`];
		if (answer?.type === "bool") item.probability = answer.probability;
		else unanswered++;
	});
	return unanswered ? `no answer for ${unanswered}/${batch.length} calls` : undefined;
}

export async function compactCalls(event: SessionBeforeCompactEvent, ctx: ExtensionContext, jev: ClassifierModel<ClassifierApi>, goal: string): Promise<CallsOutcome> {
	const { preparation, signal } = event;
	const before = previous(event);
	const items = [...before.items, ...toItems([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages])];
	const candidates = items.filter((item): item is CallItem => {
		if (item.kind !== "call" || !item.kept || item.chars <= SMALL_CALL_CHARS) return false;
		// 畳んでも原文のままになる呼び出しを採点に回すと、何も減らないのに畳んだものとして数え、記録にもそう残る。
		const cut = collapse(item);
		return cut.call !== item.call || cut.result !== item.result;
	});
	if (candidates.length > MAX_SCORED_CALLS) return { declined: `${candidates.length} tool calls to score, over the cap of ${MAX_SCORED_CALLS}`, failed: false };

	const batches: CallItem[][] = [];
	for (let i = 0; i < candidates.length; i += BATCH_CALLS) batches.push(candidates.slice(i, i + BATCH_CALLS));
	let next = 0;
	let error: string | undefined;
	const worker = async (): Promise<void> => {
		while (!error && next < batches.length && !signal.aborted) {
			// 例外をそのまま投げると、ほかの worker は止まらずに残りの要求を出し続け、呼んだ側は行を絞るほうにも落ちない。
			const failure = await scoreBatch(ctx, jev, goal, batches[next++], signal).catch((thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)) || "threw");
			// そのまま error に代入すると、並行していた別の要求の成功が、先に起きた失敗を消す。
			error ||= failure;
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	if (error) return { declined: `Jev request failed: ${error}`, failed: true };

	// Pi の要約は reserveTokens の中に収まる。原文の並びにも同じ枠を掛け、1 トークン 4 字と見積もる。
	const budget = preparation.settings.reserveTokens * 4;
	const full = new Map(candidates.map((item) => [item, { call: item.call, result: item.result }]));
	for (const item of candidates) Object.assign(item, collapse(item), { kept: false });
	let room = budget - render(items).length;
	if (room < 0) return { declined: `the conversation text alone is ${budget - room} chars, over the budget of ${budget} chars`, failed: false };
	// 採点の高い順に、予算が続くかぎり原文へ戻す。収まらない呼び出しは飛ばし、後ろの小さいものを試す。
	for (const item of [...candidates].sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))) {
		if ((item.probability ?? 0) < KEEP_PROBABILITY) break;
		const cost = item.chars - item.call.length - item.result.length;
		if (cost > room) continue;
		room -= cost;
		Object.assign(item, full.get(item), { kept: true });
	}
	// Pi は拡張が作った圧縮の details からファイル一覧を引き継がない (compaction.js の extractFileOperations) ので、自分で足し込む。
	const modified = new Set([...before.modifiedFiles, ...preparation.fileOps.written, ...preparation.fileOps.edited]);
	const details: Details = {
		readFiles: [...new Set([...before.readFiles, ...preparation.fileOps.read])].filter((path) => !modified.has(path)).sort(),
		modifiedFiles: [...modified].sort(),
		compactjev: { version: 1, items },
	};
	return {
		compaction: { summary: render(items), firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, details },
		calls: candidates.length,
		dropped: candidates.filter((item) => !item.kept).length,
	};
}
