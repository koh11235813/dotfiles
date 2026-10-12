/**
 * compactjev — Jev-based log filter for Pi's compaction.
 *
 * Hooks `session_before_compact`. For every long tool result in the messages about to be
 * summarized, it asks TypeSafe's Jev classifier whether each line is needed to understand what
 * the command produced, given the user's goal. Each result then keeps its highest-rated lines
 * that fit a character budget, in original order; a line too long for what is left of the budget
 * is cut to fit, each run of dropped lines is collapsed into a single marker and blank lines are
 * dropped. The handler returns nothing, so Pi's default LLM summarization runs on the filtered
 * messages.
 *
 * Lines are picked by rank, not by a probability threshold: Jev ranks outcome lines above
 * progress noise, but its absolute probabilities for the two overlap.
 *
 * The goal is the `/goal` text (the goal extension's last "goal" entry on the branch) followed by
 * the `/compact` instructions. The last user message is only a fallback when both are empty: it
 * is the last one in the span being discarded, not the current request, and is often "continue".
 *
 * Tool results: Pi's summarizer only sees the first 2000 characters of each, so progress noise at
 * the head of a log pushes the errors at its tail out of the summary; the budget makes the whole
 * filtered result fit inside that cut.
 *
 * Whatever Pi's own cut would serve better is left to it:
 * - `!` bash executions: Pi passes these to the summarizer whole, so any filter only loses text.
 * - Results of `read`, `grep`, `find` and `ls`: see READER_TOOLS.
 * - A result with a failed or incomplete Jev request: see scoreBatch.
 * - 空行を除いて 1 行しかない結果: selectTargets を参照。
 *
 * 失敗したツール結果 (isError) だけは上の 2 つの例外にしない。末尾を Jev に訊かずに残し (pinTail)、
 * 採点が欠けても頭と末尾に絞る。Pi に任せると頭の 2000 字だけが残り、失敗の中身が落ちる。
 *
 * 絞るたびに、何を落としたかを custom entry "compactjev" としてセッションに残す (README.md)。
 *
 * ここまでが既定の lines モード。`/compactjev calls` を選んだセッションでは、先に calls.ts の
 * 方式 (呼び出し単位で採点し、要約を作らずに原文を返す) を試し、返せなかったときだけ上へ落ちる。
 * session_recall (recall.ts) はどちらのモードでも登録する。
 *
 * Providers are tried in order until one has usable credentials:
 *   typesafe/jev-latest, openrouter/~typesafe/jev-latest,
 *   cloudflare-workers-ai/typesafe/jev, vercel-ai-gateway/typesafe-ai/jev,
 *   opencode/jev-1.13.
 */

import type { ClassifierApi, ClassifierModel, ClassifierQuestion } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { compactCalls, ERROR_TAIL_CHARS } from "./calls.ts";
import { registerRecall } from "./recall.ts";

type AgentMessage = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];

/** (provider, id) candidates for a Jev classifier, in preference order. */
const JEV_CANDIDATES: Array<[string, string]> = [
	["typesafe", "jev-latest"],
	["openrouter", "~typesafe/jev-latest"],
	["cloudflare-workers-ai", "typesafe/jev"],
	["vercel-ai-gateway", "typesafe-ai/jev"],
	["opencode", "jev-1.13"],
];

/** Tool outputs at or below this many characters already fit the summarizer's per-result cut. */
const MIN_LOG_CHARS = 2000;
/** Characters of kept lines per tool output; the rest of MIN_LOG_CHARS is left for the markers. */
const KEEP_CHARS = 1800;
/** A cut line shorter than this says too little to be worth its marker. */
const MIN_CUT_CHARS = 200;
/** Builtin tools whose result is file content or a path list, not a command's log: the Jev question
 * has no outcome lines to find there, and scattered lines read worse than Pi's contiguous head. */
const READER_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Characters of the user's goal sent to Jev. */
const GOAL_MAX_CHARS = 1000;
/** Characters of the rendered command sent to Jev. */
const COMMAND_MAX_CHARS = 500;
/** Characters of each line sent to Jev; the full line is what gets kept or dropped. */
const LINE_MAX_CHARS = 300;
/** Lines per classify request, to stay inside System One input-token limits. */
const BATCH_LINES = 40;
/** Classify requests in flight at once, across all tool outputs. */
const CONCURRENCY = 4;
/** Cost cap: non-blank lines scored per compaction. */
const MAX_SCORED_LINES = 3000;

/** Jev の要求が失敗した圧縮がこの回数続いたら警告する。1 回きりの失敗は通知の末尾で足りる。 */
const FAIL_STREAK_WARN = 2;

/** One text block of a tool output, split into lines. */
interface LogBlock {
	lines: string[];
	/** Keep-probability per line, once Jev has scored it. */
	probabilities: number[];
	kept: boolean[];
	/** 失敗した出力の末尾の行。Jev に訊かず、採点に関わらず残す。 */
	pinned: boolean[];
}

/** A long tool result selected for filtering. */
interface LogTarget {
	command: string;
	/** Text blocks by content index. */
	blocks: Map<number, LogBlock>;
	/** Pi が失敗と記録したツール結果。 */
	error: boolean;
	batches: number;
	failed: number;
}

/** Up to BATCH_LINES non-blank lines of one target, scored in one classify request. */
interface LogBatch {
	target: LogTarget;
	lines: Array<{ block: LogBlock; index: number }>;
}

/** Pick the first Jev classifier the session has credentials for. */
function findJev(ctx: ExtensionContext): ClassifierModel<ClassifierApi> | undefined {
	for (const [provider, id] of JEV_CANDIDATES) {
		const model = ctx.modelRegistry.findOfType("classifier", provider, id);
		// findOfType is a catalog lookup and returns models whose provider has no credential.
		if (model && ctx.modelRegistry.getProviderAuthStatus(provider).configured) return model;
	}
	return undefined;
}

function textOf(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n");
}

/** The text of the last `/goal` entry on the branch; "" when none was set or it was cleared. */
export function readGoal(entries: SessionBeforeCompactEvent["branchEntries"]): string {
	let goal = "";
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "goal") continue;
		const data = entry.data as { version?: unknown; text?: unknown } | undefined;
		if (data?.version === 1 && typeof data.text === "string") goal = data.text.trim();
	}
	return goal;
}

type Mode = "lines" | "calls";

/** `/compactjev` で最後に選んだ方式。選んでいなければ lines。 */
export function readMode(entries: SessionBeforeCompactEvent["branchEntries"]): Mode {
	let mode: Mode = "lines";
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "compactjev-mode") continue;
		const data = entry.data as { version?: unknown; mode?: unknown } | undefined;
		if (data?.version === 1 && (data.mode === "lines" || data.mode === "calls")) mode = data.mode;
	}
	return mode;
}

function lastUserText(messages: AgentMessage[]): string {
	const user = messages.filter((m) => m.role === "user").at(-1);
	return user?.role === "user" ? textOf(user.content) : "";
}

/** Render a tool call the way Pi's summarizer serializes it: `name(k=JSON, ...)`. */
function renderToolCalls(messages: AgentMessage[]): Map<string, string> {
	const calls = new Map<string, string>();
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall") continue;
			const args = Object.entries(block.arguments ?? {})
				.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
				.join(", ");
			calls.set(block.id, `${block.name}(${args})`.slice(0, COMMAND_MAX_CHARS));
		}
	}
	return calls;
}

function toBlock(text: string): LogBlock {
	const lines = text.split("\n");
	return { lines, probabilities: lines.map(() => 1), kept: lines.map(() => false), pinned: lines.map(() => false) };
}

/** Pick the long tool outputs to filter, keyed by their (live, never mutated) message object. */
function selectTargets(messages: AgentMessage[]): Map<AgentMessage, LogTarget> {
	const commands = renderToolCalls(messages);
	const targets = new Map<AgentMessage, LogTarget>();
	for (const m of messages) {
		if (m.role === "toolResult" && !READER_TOOLS.has(m.toolName)) {
			const total = m.content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0);
			if (total <= MIN_LOG_CHARS) continue;
			const blocks = new Map<number, LogBlock>();
			m.content.forEach((c, i) => {
				if (c.type === "text") blocks.set(i, toBlock(c.text));
			});
			const target: LogTarget = { command: commands.get(m.toolCallId) ?? m.toolName, blocks, error: m.isError === true, batches: 0, failed: 0 };
			if (target.error) pinTail(target);
			// 1 行だけなら順位を付ける相手が無い。こちらで切ると印の分だけ Pi の頭 2000 字より短くなるので対象にしない。
			// 失敗した出力は 1 行でも外さない。Pi に任せると頭の 2000 字だけが残り、末尾の終了状態が落ちる。
			if (target.error || nonBlankLines(target).length > 1) targets.set(m, target);
		}
	}
	return targets;
}

/** 失敗した出力の末尾から、ERROR_TAIL_CHARS に収まる行を採点の対象から外して残す。 */
function pinTail(target: LogTarget): void {
	const lines = nonBlankLines(target);
	let room = ERROR_TAIL_CHARS;
	for (let i = lines.length - 1; i >= 0; i--) {
		const { block, index } = lines[i];
		const line = block.lines[index];
		if (line.length + 1 > room) {
			// 最後の行だけで枠を超える出力は、その行の終わりを残す。頭を残すと失敗の中身が落ちる。
			if (i !== lines.length - 1) break;
			const keep = room - 1 - `[… ${line.length} chars dropped by compactjev] `.length;
			// ほかに行が無ければ、採点で選ぶ分の予算が丸ごと余る。頭を捨てると Pi 単体の頭 2000 字より 1400 字多く失う。
			const head = lines.length === 1 ? line.slice(0, KEEP_CHARS - ERROR_TAIL_CHARS) : "";
			block.lines[index] = `${head && `${head} `}[… ${line.length - head.length - keep} chars dropped by compactjev] ${line.slice(-keep)}`;
			block.pinned[index] = true;
			break;
		}
		room -= line.length + 1;
		block.pinned[index] = true;
	}
}

/** 空行と、採点せずに残す行を除いた行。 */
function rankedLines(target: LogTarget): LogBatch["lines"] {
	return nonBlankLines(target).filter(({ block, index }) => !block.pinned[index]);
}

function nonBlankLines(target: LogTarget): LogBatch["lines"] {
	const lines: LogBatch["lines"] = [];
	for (const block of target.blocks.values()) {
		block.lines.forEach((line, index) => {
			if (line.trim()) lines.push({ block, index });
		});
	}
	return lines;
}

/** Split targets into batches, leaving whole targets unscored once the cost cap would be exceeded. */
function planBatches(targets: Iterable<LogTarget>): LogBatch[] {
	const batches: LogBatch[] = [];
	let scored = 0;
	for (const target of targets) {
		const lines = rankedLines(target);
		// 失敗した出力で、残す末尾のほかに 1 行しか無いもの。順位を付ける相手が無い。
		if (lines.length < 2) continue;
		if (scored + lines.length > MAX_SCORED_LINES) continue;
		scored += lines.length;
		for (let i = 0; i < lines.length; i += BATCH_LINES) {
			batches.push({ target, lines: lines.slice(i, i + BATCH_LINES) });
			target.batches++;
		}
	}
	return batches;
}

async function scoreBatch(
	ctx: ExtensionContext,
	jev: ClassifierModel<ClassifierApi>,
	goal: string,
	batch: LogBatch,
	signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const questions: Record<string, ClassifierQuestion> = {};
	batch.lines.forEach((_, i) => {
		questions[`l${i}`] = {
			type: "bool",
			instructions: `Is \`lines[${i}]\` needed to understand what \`command\` produced, given \`goal\`?`,
			criteria: {
				true: "Yes. It states an outcome: an error, warning, failure, result value, file path, test name, or summary line.",
				false: "No. It is progress noise, repeated boilerplate, decoration, or information other lines already carry.",
			},
		};
	});
	const lines = batch.lines.map(({ block, index }) => block.lines[index].slice(0, LINE_MAX_CHARS));
	const result = await ctx.modelRegistry.classify(
		jev,
		{ state: { goal, command: batch.target.command, lines }, questions },
		{ signal },
	);
	// Not ok means the target is left unfiltered: its unscored lines would sit at probability 1,
	// outrank every scored line and take the budget.
	if (result.stopReason !== "stop") return { ok: false, error: result.errorMessage ?? result.stopReason };
	let unanswered = 0;
	batch.lines.forEach(({ block, index }, i) => {
		const answer = result.answers[`l${i}`];
		if (answer?.type === "bool") block.probabilities[index] = answer.probability;
		else unanswered++;
	});
	return unanswered ? { ok: false, error: `no answer for ${unanswered}/${batch.lines.length} lines` } : { ok: true };
}

/** Keep the highest-ranked lines within KEEP_CHARS, then trim until the collapsed text fits MIN_LOG_CHARS. */
function selectLines(target: LogTarget): void {
	const ranked = rankedLines(target).sort((a, b) => b.block.probabilities[b.index] - a.block.probabilities[a.index]);
	let budget = KEEP_CHARS;
	for (const { block, index } of nonBlankLines(target)) {
		if (!block.pinned[index]) continue;
		block.kept[index] = true;
		budget -= block.lines[index].length + 1;
	}
	for (const { block, index } of ranked) {
		const line = block.lines[index];
		block.kept[index] = true;
		if (line.length + 1 <= budget) {
			budget -= line.length + 1;
			continue;
		}
		// Skipping it instead would wipe a result that is one long line, where Pi keeps its head.
		const marker = ` [… ${line.length} chars dropped by compactjev]`;
		const room = budget - 1 - marker.length;
		if (room < MIN_CUT_CHARS) {
			// Shorter lines further down the ranking may still fit.
			block.kept[index] = false;
			continue;
		}
		block.lines[index] = `${line.slice(0, room)} [… ${line.length - room} chars dropped by compactjev]`;
		break;
	}
	// Markers are only known after collapsing, so the budget alone cannot guarantee the fit.
	const kept = ranked.filter(({ block, index }) => block.kept[index]);
	const length = (): number => [...target.blocks.values()].reduce((n, block) => n + collapse(block).text.length, 0);
	while (kept.length && length() > MIN_LOG_CHARS) {
		const { block, index } = kept.pop()!;
		block.kept[index] = false;
	}
}

/** The block's kept lines with dropped runs collapsed into markers and blank lines removed. */
function collapse(block: LogBlock): { text: string; dropped: number } {
	const out: string[] = [];
	let run = 0;
	let dropped = 0;
	const flush = (): void => {
		if (run) out.push(`[… ${run} lines dropped by compactjev]`);
		run = 0;
	};
	block.lines.forEach((line, i) => {
		if (!line.trim()) return;
		if (!block.kept[i]) {
			run++;
			dropped++;
			return;
		}
		flush();
		out.push(line);
	});
	flush();
	return { text: out.join("\n"), dropped };
}

/** A filtered copy of the message, or the original object when its text is unchanged. */
function rebuild(m: AgentMessage, target: LogTarget): { message: AgentMessage; dropped: number } {
	let dropped = 0;
	if (m.role !== "toolResult") return { message: m, dropped };
	let changed = false;
	const content = m.content.map((c, i) => {
		const block = target.blocks.get(i);
		if (!block || c.type !== "text") return c;
		const filtered = collapse(block);
		if (filtered.text === c.text) return c;
		changed = true;
		dropped += filtered.dropped;
		return { ...c, text: filtered.text };
	});
	return changed ? { message: { ...m, content }, dropped } : { message: m, dropped };
}

/** Size of one filtered tool output before and after compactjev. */
interface TargetStats {
	command: string;
	lines: number;
	dropped: number;
	before: number;
	after: number;
}

/** Characters of the text the summarizer serializes for a tool output. */
function textLength(m: AgentMessage): number {
	if (m.role !== "toolResult") return 0;
	return m.content.reduce((n, c) => n + (c.type === "text" ? c.text.length : 0), 0);
}

function percent(before: number, after: number): string {
	return before ? `-${Math.round(((before - after) / before) * 100)}%` : "-0%";
}

/** 絞った 1 つのツール出力について、何を落としたかの記録。原文はセッションの toolCallId の結果にある。 */
interface OutputRecord {
	toolCallId: string;
	command: string;
	before: number;
	after: string;
	blankLines: number;
	batches: number;
	/** 失敗した Jev 要求の数。0 でなければ失敗した出力で、採点を使わず元の順に頭と末尾を残している。 */
	failed: number;
	/** 空行を除いた各行。落とした行だけ、Jev に見せた範囲の本文を持つ。`pinned` は Jev に訊かずに残した行。 */
	lines: Array<{ chars: number; probability: number; kept: boolean; pinned?: true; text?: string }>;
}

function recordOutput(m: AgentMessage, filtered: AgentMessage, target: LogTarget): OutputRecord | undefined {
	if (m.role !== "toolResult" || filtered.role !== "toolResult") return undefined;
	const lines: OutputRecord["lines"] = [];
	let blankLines = 0;
	for (const [i, block] of target.blocks) {
		const content = m.content[i];
		// selectLines は切り詰めた行で block.lines を書き換えるので、長さと本文は原文から取る。
		const original = content.type === "text" ? content.text.split("\n") : [];
		original.forEach((line, index) => {
			if (!line.trim()) {
				blankLines++;
				return;
			}
			const kept = block.kept[index];
			lines.push({ chars: line.length, probability: block.probabilities[index], kept, ...(block.pinned[index] ? { pinned: true as const } : {}), ...(kept ? {} : { text: line.slice(0, LINE_MAX_CHARS) }) });
		});
	}
	return { toolCallId: m.toolCallId, command: target.command, before: textLength(m), after: textOf(filtered.content), blankLines, batches: target.batches, failed: target.failed, lines };
}

/** A total line (ending in `suffix`) followed by one line per tool output, largest reduction first. */
function formatStats(stats: TargetStats[], suffix: string): string {
	const sum = (key: "lines" | "dropped" | "before" | "after"): number => stats.reduce((n, s) => n + s[key], 0);
	const before = sum("before");
	const after = sum("after");
	const head = `compactjev: ${before} → ${after} chars (${percent(before, after)}), dropped ${sum("dropped")}/${sum("lines")} lines in ${stats.length} tool outputs${suffix}`;
	const rows = [...stats]
		.sort((a, b) => b.before - b.after - (a.before - a.after))
		.map((s) => `  ${s.before} → ${s.after} chars (${percent(s.before, s.after)}), ${s.dropped}/${s.lines} lines: ${s.command.slice(0, 80)}`);
	return [head, ...rows].join("\n");
}

export default function (pi: ExtensionAPI) {
	// 失敗が続いた圧縮の回数。セッションをまたいで持ち越さない (拡張は new / resume / reload で作り直される)。
	let failStreak = 0;
	let streakWarned = false;

	registerRecall(pi);

	pi.registerCommand("compactjev", {
		description: "Show or set how compactjev compacts: lines (filter log lines, Pi summarizes) or calls (keep or drop whole tool calls, no LLM summary)",
		handler: async (args, ctx) => {
			const mode = args.trim();
			if (mode === "lines" || mode === "calls") pi.appendEntry("compactjev-mode", { version: 1, mode });
			else if (mode) {
				ctx.ui.notify("Usage: /compactjev [lines|calls]", "warning");
				return;
			}
			ctx.ui.notify(`compactjev mode: ${readMode(ctx.sessionManager.getBranch())}`, "info");
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const jev = findJev(ctx);
		if (!jev) return undefined;
		const { preparation, signal } = event;

		try {
			const all = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
			const stated = [readGoal(event.branchEntries), event.customInstructions?.trim()].filter(Boolean).join("\n");
			const goal = (stated || lastUserText(all)).slice(0, GOAL_MAX_CHARS);

			if (readMode(event.branchEntries) === "calls") {
				const outcome = await compactCalls(event, ctx, jev, goal);
				if (signal.aborted) return undefined;
				if ("compaction" in outcome) {
					ctx.ui.notify(`compactjev: kept the conversation verbatim without an LLM summary, ${outcome.compaction.summary.length} chars, cut ${outcome.dropped}/${outcome.calls} scored tool calls`, "info");
					return { compaction: outcome.compaction };
				}
				// 落ちるたびに知らせる。lines に落ちた後は Jev が通れば連続失敗の警告が出ないので、ここで黙ると calls が効いていないことに気づけない。
				ctx.ui.notify(`compactjev: calls mode not used (${outcome.declined}); filtering log lines for Pi's summary instead`, outcome.failed ? "warning" : "info");
			}
			const targets = selectTargets(all);
			const batches = planBatches(targets.values());
			const errorTargets = [...targets.values()].filter((target) => target.error);
			if (batches.length === 0 && errorTargets.length === 0) return undefined;

			let next = 0;
			// Promise.all rejects on the first throw but cannot cancel the other workers.
			let stopped = false;
			let failed = 0;
			let firstError = "";
			const worker = async (): Promise<void> => {
				while (!stopped && next < batches.length && !signal.aborted) {
					const batch = batches[next++];
					try {
						const scored = await scoreBatch(ctx, jev, goal, batch, signal);
						if (scored.ok) continue;
						firstError ||= scored.error;
						batch.target.failed++;
						failed++;
					} catch (error) {
						stopped = true;
						throw error;
					}
				}
			};
			await Promise.all(Array.from({ length: CONCURRENCY }, worker));
			if (signal.aborted) return undefined;

			if (failed) failStreak++;
			// Jev に訊かなかった圧縮 (失敗した 1 行の出力だけ) は、失敗の無い圧縮に数えない。
			else if (batches.length) {
				failStreak = 0;
				streakWarned = false;
			}
			const allFailed = batches.length > 0 && failed === batches.length;
			if (allFailed) {
				const rest = errorTargets.length ? "keeping only the head and tail of failed tool outputs" : "compacting without log filter";
				ctx.ui.notify(`compactjev: all ${batches.length} Jev requests failed (${firstError}) — ${rest}`, "warning");
				if (errorTargets.length === 0) return undefined;
			}
			// 失敗した出力は採点が欠けても絞る。欠けた採点は捨てて全行を同じ順位に戻すと、元の順のまま頭と末尾が残る。
			for (const target of errorTargets) {
				if (target.failed === 0 && target.batches > 0) continue;
				for (const block of target.blocks.values()) block.probabilities.fill(1);
			}
			const scoredTargets = new Set([...targets.values()].filter((t) => t.error || (t.failed === 0 && t.batches > 0)));
			for (const target of scoredTargets) selectLines(target);

			const stats: TargetStats[] = [];
			const outputs: OutputRecord[] = [];
			const unfiltered: Array<{ toolCallId: string; command: string; chars: number; batches: number; failed: number }> = [];
			const filter = (messages: AgentMessage[]): AgentMessage[] =>
				messages.map((m) => {
					const target = targets.get(m);
					if (!target) return m;
					if (!scoredTargets.has(target)) {
						if (m.role === "toolResult") unfiltered.push({ toolCallId: m.toolCallId, command: target.command, chars: textLength(m), batches: target.batches, failed: target.failed });
						return m;
					}
					const rebuilt = rebuild(m, target);
					stats.push({
						command: target.command,
						lines: nonBlankLines(target).length,
						dropped: rebuilt.dropped,
						before: textLength(m),
						after: textLength(rebuilt.message),
					});
					const output = recordOutput(m, rebuilt.message, target);
					if (output) outputs.push(output);
					return rebuilt.message;
				});
			const summarize = filter(preparation.messagesToSummarize);
			const prefix = filter(preparation.turnPrefixMessages);

			// Swap only now, so a throw or abort above leaves the preparation untouched.
			preparation.messagesToSummarize.splice(0, preparation.messagesToSummarize.length, ...summarize);
			preparation.turnPrefixMessages.splice(0, preparation.turnPrefixMessages.length, ...prefix);

			try {
				pi.appendEntry("compactjev", { version: 1, lineChars: LINE_MAX_CHARS, batchLines: BATCH_LINES, outputs, unfiltered });
			} catch (error) {
				// 外側の catch に任せると、もう絞った後なのに「絞らずに圧縮する」と知らせてしまう。
				ctx.ui.notify(`compactjev: loss record not saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}

			const failures = failed ? `, ${failed}/${batches.length} Jev requests failed: ${firstError}` : "";
			const unscored = targets.size - scoredTargets.size;
			const skipped = unscored ? `, ${unscored} tool outputs left unfiltered` : "";
			ctx.ui.notify(formatStats(stats, `${failures}${skipped}`), "info");
			// 全滅のときは上で毎回警告している。ここは info の末尾に埋もれる一部失敗のためのもの。
			if (failed && !allFailed && failStreak >= FAIL_STREAK_WARN && !streakWarned) {
				streakWarned = true;
				ctx.ui.notify(`compactjev: Jev requests failed in ${failStreak} compactions in a row (${firstError}); the tool outputs they covered are not being filtered`, "warning");
			}
		} catch (error) {
			if (!signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`compactjev: ${message} — compacting without log filter`, "warning");
			}
		}
		return undefined;
	});
}
