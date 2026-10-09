import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

type Totals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

function emptyTotals(): Totals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAmount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function addTotals(totals: Totals, usage: Totals) {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
		const sum = totals[key] + usage[key];
		if (Number.isFinite(sum)) totals[key] = sum;
	}
}

function childUsage(value: unknown): Totals | undefined {
	if (!isRecord(value)) return undefined;
	const { input, output, cacheRead, cacheWrite, cost } = value;
	if (!isAmount(input) || !Number.isInteger(input) ||
		!isAmount(output) || !Number.isInteger(output) ||
		!isAmount(cacheRead) || !Number.isInteger(cacheRead) ||
		!isAmount(cacheWrite) || !Number.isInteger(cacheWrite) || !isAmount(cost)) return undefined;
	return { input, output, cacheRead, cacheWrite, cost };
}

function sumUsage(entries: readonly SessionEntry[]) {
	const totals = emptyTotals();
	const subagents = emptyTotals();
	let reported = 0;
	let unreported = 0;
	for (const entry of entries) {
		const usage = entry.type === "message"
			? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
			: (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined);
		if (usage) {
			addTotals(totals, {
				input: isAmount(usage.input) ? usage.input : 0,
				output: isAmount(usage.output) ? usage.output : 0,
				cacheRead: isAmount(usage.cacheRead) ? usage.cacheRead : 0,
				cacheWrite: isAmount(usage.cacheWrite) ? usage.cacheWrite : 0,
				cost: isAmount(usage.cost?.total) ? usage.cost.total : 0,
			});
		}
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "subagent") continue;
		const { details } = entry.message;
		if (!isRecord(details) || !Array.isArray(details.results) || details.results.length === 0) {
			unreported++;
			continue;
		}
		for (const result of details.results) {
			const child = isRecord(result) ? childUsage(result.usage) : undefined;
			if (!child) {
				unreported++;
				continue;
			}
			reported++;
			addTotals(subagents, child);
			// Native tool usage already accounts for children and is authoritative.
			if (usage === undefined) addTotals(totals, child);
		}
	}
	return { totals, subagents, reported, unreported };
}

function formatTotals(label: string, totals: Totals): string {
	return [
		label,
		`Input: ${totals.input}`,
		`Output: ${totals.output}`,
		`Cache read: ${totals.cacheRead}`,
		`Cache write: ${totals.cacheWrite}`,
		`Estimated cost: $${totals.cost.toFixed(4)} USD`,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show latest turn and session usage, estimated cost, and context usage",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			let turnStart = 0;
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message" && entry.message.role === "user") {
					turnStart = i + 1;
					break;
				}
			}

			const context = ctx.getContextUsage();
			const contextText = context
				? `${context.percent === null ? "unknown" : `${context.percent.toFixed(1)}%`} (${context.tokens ?? "unknown"} / ${context.contextWindow} tokens)`
				: "unknown";
			const session = sumUsage(ctx.sessionManager.getEntries());
			ctx.ui.notify([
				formatTotals("Latest turn", sumUsage(branch.slice(turnStart)).totals),
				formatTotals("Session total", session.totals),
				[
					formatTotals("Subagents reported totals (included in session totals; native usage is authoritative, not added again)", session.subagents),
					`Reported results: ${session.reported}`,
					`Unreported calls/results: ${session.unreported}${session.unreported > 0 ? " (usage unknown)" : ""}`,
				].join("\n"),
				`Context: ${contextText}`,
				"Subscription quota: unknown",
			].join("\n\n"), "info");
		},
	});
}
