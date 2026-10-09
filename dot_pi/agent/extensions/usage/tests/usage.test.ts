import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import usageExtension from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, totalCost: number): Usage {
	return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost } };
}
function assistant(stats: Usage): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text: "Done" }], api: "openai-responses", provider: "openai",
		model: "test", usage: stats, stopReason: "stop", timestamp: 1 };
}

test("/usage は最後のユーザー入力以降の全モデル呼び出しとセッション累計を区別する", async () => {
	const app = extensionHost();
	usageExtension(app.pi);
	app.manager.appendMessage({ role: "user", content: "Earlier task", timestamp: 1 });
	app.manager.appendMessage(assistant(usage(1000, 100, 400, 20, 0.4)));
	app.manager.appendMessage({ role: "user", content: "Current task", timestamp: 2 });
	app.manager.appendMessage(assistant(usage(100, 10, 20, 5, 0.01)));
	app.manager.appendMessage(assistant(usage(150, 15, 30, 10, 0.02)));
	await app.command("usage");
	const report = app.notices.at(-1)!;
	const latest = report.split("Session total")[0];
	const total = report.split("Session total")[1];
	assert.match(latest, /Latest turn/);
	assert.match(latest, /Input:\s*250\b/);
	assert.match(latest, /Output:\s*25\b/);
	assert.match(latest, /Cache read:\s*50\b/);
	assert.match(latest, /Cache write:\s*15\b/);
	assert.match(latest, /\$0\.0300/);
	assert.match(total, /Input:\s*1,?250\b/);
	assert.match(total, /Output:\s*125\b/);
	assert.match(total, /Cache read:\s*450\b/);
	assert.match(total, /Cache write:\s*35\b/);
	assert.match(total, /\$0\.4300/);
	assert.match(report, /Context:.*20(?:\.0)?%.*200.*1,?000/);
	assert.match(report, /Subscription quota: unknown/i);
});

test("cache warming・compact・分岐要約・ツールと子エージェントの報告済みusageを二重計上しない", async () => {
	const app = extensionHost();
	usageExtension(app.pi);
	const root = app.manager.appendMessage({ role: "user", content: "Task", timestamp: 1 });
	app.manager.appendMessage(assistant(usage(10, 1, 2, 3, 0.01)));
	app.manager.appendUsage("cache_warm", "openai", "test", usage(20, 2, 4, 6, 0.02));
	app.manager.appendCompaction("Summary", root, 100, undefined, false, usage(30, 3, 6, 9, 0.03));
	app.manager.branchWithSummary(root, "Branch summary", undefined, false, usage(40, 4, 8, 12, 0.04));
	app.manager.appendMessage({ role: "toolResult", toolCallId: "native", toolName: "subagent", isError: false, timestamp: 2,
		content: [{ type: "text", text: "Child done" }], usage: usage(50, 5, 10, 15, 0.05),
		details: { mode: "single", results: [{ agent: "worker", usage: { input: 50, output: 5, cacheRead: 10, cacheWrite: 15, cost: 0.05 } }] } });
	app.manager.appendMessage({ role: "toolResult", toolCallId: "legacy", toolName: "subagent", isError: false, timestamp: 3,
		content: [{ type: "text", text: "Legacy child done" }],
		details: { mode: "single", results: [{ agent: "worker", usage: { input: 60, output: 6, cacheRead: 12, cacheWrite: 18, cost: 0.06 } }] } });
	app.manager.appendMessage({ role: "toolResult", toolCallId: "unreported", toolName: "subagent", isError: true, timestamp: 4,
		content: [{ type: "text", text: "Usage unavailable" }] });
	await app.command("usage");
	const report = app.notices.at(-1)!;
	const total = report.split("Session total")[1].split("Subagents")[0];
	assert.match(total, /Input:\s*210\b/);
	assert.match(total, /Output:\s*21\b/);
	assert.match(total, /Cache read:\s*42\b/);
	assert.match(total, /Cache write:\s*63\b/);
	assert.match(total, /\$0\.2100/);
	const children = report.split("Subagents")[1];
	assert.match(children, /Input:\s*110\b/);
	assert.match(children, /\$0\.1100/);
	assert.match(children, /unknown|unreported|incomplete/i);
	assert.match(children, /included/i);
});

test("空のセッションと不明なコンテキストは推測せず表示する", async () => {
	const app = extensionHost();
	usageExtension(app.pi);
	app.ctx.getContextUsage = () => undefined;
	await app.command("usage");
	assert.match(app.notices.at(-1)!, /Input:\s*0\b/);
	assert.match(app.notices.at(-1)!, /Context: unknown/);
	assert.match(app.notices.at(-1)!, /Subscription quota: unknown/i);
	app.ctx.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 1000 });
	await app.command("usage");
	assert.match(app.notices.at(-1)!, /Context:.*unknown.*unknown.*1,?000/);
});
