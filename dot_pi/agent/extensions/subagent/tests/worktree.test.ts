import assert from "node:assert/strict";
import { test } from "node:test";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import { withWorktree } from "../worktree.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

type Tool = { description: string; parameters: { properties: Record<string, unknown>; required?: string[] }; execute: Function; renderCall?: unknown };

const renderCall = () => "call";

/**
 * 公式 sample (examples/extensions/subagent/index.ts) が登録するのと同じ形のツール。実物は読み込めない
 * (node は node_modules の下の .ts を実行しない)。写しているのは引数の表だけで、execute は呼ばれた引数を返す。
 */
function sample(pi: { registerTool: Function }) {
	const item = Type.Object({ agent: Type.String(), task: Type.String(), cwd: Type.Optional(Type.String()) });
	pi.registerTool({
		name: "subagent",
		description: "Delegate tasks to specialized subagents with isolated context.",
		parameters: Type.Object({
			agent: Type.Optional(Type.String()),
			task: Type.Optional(Type.String()),
			tasks: Type.Optional(Type.Array(item)),
			chain: Type.Optional(Type.Array(item)),
			cwd: Type.Optional(Type.String()),
		}),
		execute: async (_id: string, params: unknown) => ({ content: [], details: params }),
		renderCall,
	});
}

function registered() {
	const app = extensionHost();
	const original = extensionHost();
	sample(original.pi);
	sample(withWorktree(app.pi));
	return { tool: app.registeredTools.get("subagent") as unknown as Tool, original: original.registeredTools.get("subagent") as unknown as Tool };
}

test("subagentツールにworktreeの引数が足され、ほかの引数と描画は公式sampleのまま", async () => {
	const { tool, original } = registered();
	assert.deepEqual(Object.keys(tool.parameters.properties), [...Object.keys(original.parameters.properties), "worktree"]);
	assert.deepEqual(tool.parameters.required ?? [], original.parameters.required ?? []);
	assert.ok(tool.description.startsWith(original.description));
	assert.match(tool.description, /worktree: true/);
	assert.equal(tool.renderCall, original.renderCall);

	const check = (args: Record<string, unknown>) => validateToolArguments(tool as never, { type: "toolCall", id: "1", name: "subagent", arguments: args });
	assert.deepEqual(check({ agent: "worker", task: "a", worktree: true }), { agent: "worker", task: "a", worktree: true });
	assert.deepEqual(check({ agent: "worker", task: "a" }), { agent: "worker", task: "a" });
	assert.throws(() => check({ agent: "worker", task: "a", worktree: { path: "/" } }), /Validation failed/);
});

test("worktreeを誰も用意しなかった呼び出しは、子を起こさずに失敗する", async () => {
	const { tool } = registered();
	assert.deepEqual((await tool.execute("call-0", { agent: "worker", task: "a" }, undefined, undefined, {})).details, { agent: "worker", task: "a" });
	// guard が用意したら worktree は引数から消えている。残っているのは guard が読み込まれていないとき。
	await assert.rejects(tool.execute("call-1", { agent: "worker", task: "a", worktree: true }, undefined, undefined, {}), /guard extension[\s\S]*Nothing was run/);
});

test("subagent以外の登録はそのまま通す", () => {
	const app = extensionHost();
	const other = { name: "other", execute: async () => ({}) };
	withWorktree(app.pi).registerTool(other as never);
	assert.equal(app.registeredTools.get("other"), other);
	assert.equal(typeof withWorktree(app.pi).on, "function");
});
