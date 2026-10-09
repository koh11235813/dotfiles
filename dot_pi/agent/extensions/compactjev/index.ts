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
 *
 * Providers are tried in order until one has usable credentials:
 *   typesafe/jev-latest, openrouter/~typesafe/jev-latest,
 *   cloudflare-workers-ai/typesafe/jev, vercel-ai-gateway/typesafe-ai/jev,
 *   opencode/jev-1.13.
 */

import type { ClassifierApi, ClassifierModel, ClassifierQuestion } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

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

/** One text block of a tool output, split into lines. */
interface LogBlock {
	lines: string[];
	/** Keep-probability per line, once Jev has scored it. */
	probabilities: number[];
	kept: boolean[];
}

/** A long tool result selected for filtering. */
interface LogTarget {
	command: string;
	/** Text blocks by content index. */
	blocks: Map<number, LogBlock>;
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
	return { lines, probabilities: lines.map(() => 1), kept: lines.map(() => false) };
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
			targets.set(m, { command: commands.get(m.toolCallId) ?? m.toolName, blocks, batches: 0, failed: 0 });
		}
	}
	return targets;
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
		const lines = nonBlankLines(target);
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
	const ranked = nonBlankLines(target).sort((a, b) => b.block.probabilities[b.index] - a.block.probabilities[a.index]);
	let budget = KEEP_CHARS;
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
	pi.on("session_before_compact", async (event, ctx) => {
		const jev = findJev(ctx);
		if (!jev) return undefined;
		const { preparation, signal } = event;

		try {
			const all = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
			const stated = [readGoal(event.branchEntries), event.customInstructions?.trim()].filter(Boolean).join("\n");
			const goal = (stated || lastUserText(all)).slice(0, GOAL_MAX_CHARS);
			const targets = selectTargets(all);
			const batches = planBatches(targets.values());
			if (batches.length === 0) return undefined;

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

			if (failed === batches.length) {
				ctx.ui.notify(`compactjev: all ${batches.length} Jev requests failed (${firstError}) — compacting without log filter`, "warning");
				return undefined;
			}
			const scoredTargets = new Set(batches.map((b) => b.target).filter((t) => t.failed === 0));
			for (const target of scoredTargets) selectLines(target);

			const stats: TargetStats[] = [];
			const filter = (messages: AgentMessage[]): AgentMessage[] =>
				messages.map((m) => {
					const target = targets.get(m);
					if (!target || !scoredTargets.has(target)) return m;
					const rebuilt = rebuild(m, target);
					stats.push({
						command: target.command,
						lines: nonBlankLines(target).length,
						dropped: rebuilt.dropped,
						before: textLength(m),
						after: textLength(rebuilt.message),
					});
					return rebuilt.message;
				});
			const summarize = filter(preparation.messagesToSummarize);
			const prefix = filter(preparation.turnPrefixMessages);

			// Swap only now, so a throw or abort above leaves the preparation untouched.
			preparation.messagesToSummarize.splice(0, preparation.messagesToSummarize.length, ...summarize);
			preparation.turnPrefixMessages.splice(0, preparation.turnPrefixMessages.length, ...prefix);

			const failures = failed ? `, ${failed}/${batches.length} Jev requests failed: ${firstError}` : "";
			const unscored = targets.size - scoredTargets.size;
			const skipped = unscored ? `, ${unscored} tool outputs left unfiltered` : "";
			ctx.ui.notify(formatStats(stats, `${failures}${skipped}`), "info");
		} catch (error) {
			if (!signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`compactjev: ${message} — compacting without log filter`, "warning");
			}
		}
		return undefined;
	});
}
