import assert from "node:assert/strict";
import { test } from "node:test";
import guard from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

const call = (toolName: string, input: Record<string, unknown> = {}) => ({ toolName, toolCallId: "call-1", input });

test("/permissions readonly は読み取りを許可し、書き込み可能なbashを遮断して現在のモードを表示する", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	await app.command("permissions", "readonly");
	assert.equal(await app.emit("tool_call", call("read", { path: "README.md" })), undefined);
	const denied = await app.emit("tool_call", call("bash", { command: "echo changed > file.txt" })) as { block: boolean };
	assert.equal(denied?.block, true);
	assert.equal(app.confirmations.length, 0);
	await app.command("permissions");
	assert.match(app.notices.at(-1)!, /readonly/);
});

test("権限モードは再開とtreeで復元され、新規セッションはnormalに戻る", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	await app.command("permissions", "readonly");
	const readonly = app.manager.getLeafId()!;
	await app.command("permissions", "normal");
	app.manager.branch(readonly);
	await app.emit("session_tree");
	await app.command("permissions");
	assert.match(app.notices.at(-1)!, /Permissions: readonly/);
	await app.emit("session_start", { reason: "resume" });
	assert.equal((await app.emit("tool_call", call("bash", { command: "pwd" })) as { block: boolean })?.block, true);
	app.replaceSession();
	await app.emit("session_start", { reason: "new" });
	assert.equal(await app.emit("tool_call", call("bash", { command: "pwd" })), undefined);
});

test("askは非readonly・未知ツールを確認し、拒否やUIなしでは実行させない", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	await app.command("permissions", "ask");
	assert.equal(await app.emit("tool_call", call("read", { path: "file" })), undefined);
	assert.equal(app.confirmations.length, 0);
	assert.equal((await app.emit("tool_call", call("bash", { command: "pwd" })) as { block: boolean })?.block, true);
	app.approve(true);
	assert.equal(await app.emit("tool_call", call("bash", { command: "pwd" })), undefined);
	app.approve(false);
	assert.equal((await app.emit("tool_call", call("unknown_tool")) as { block: boolean })?.block, true);
	app.ctx.hasUI = false;
	app.approve(true);
	assert.equal((await app.emit("tool_call", call("bash", { command: "pwd" })) as { block: boolean })?.block, true);
});

test("どのモードでも固定禁止は承認や誤ったreadonlyヒントで解除できない", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	app.approve(true);
	app.tools.find((tool) => tool.name === "bash")!.annotations!.readOnlyHint = true;
	for (const mode of ["normal", "ask", "readonly"]) {
		await app.command("permissions", mode);
		const result = await app.emit("tool_call", call("bash", { command: "git push origin main --force-with-lease" })) as { block: boolean; reason: string };
		assert.equal(result.block, true);
		assert.match(result.reason, /git-force-push/);
	}
	assert.equal(app.confirmations.length, 0);
	assert.equal((await app.emit("tool_call", call("bash", { command: "pwd" })) as { block: boolean })?.block, true);
	app.tools.push({ name: "mcp_read", annotations: { readOnlyHint: true } }, { name: "mcp_unknown" });
	assert.equal(await app.emit("tool_call", call("mcp_read")), undefined);
	assert.equal((await app.emit("tool_call", call("mcp_unknown")) as { block: boolean })?.block, true);
	assert.equal((await app.emit("tool_call", call("subagent", { agent: "worker" })) as { block: boolean })?.block, true);
});

test("normalは既存guardの確認を維持し、不正なモード指定は状態を変えない", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	assert.equal((await app.emit("tool_call", call("bash", { command: "git push" })) as { block: boolean })?.block, true);
	app.approve(true);
	assert.equal(await app.emit("tool_call", call("bash", { command: "git push" })), undefined);
	await app.command("permissions", "readonly");
	await app.command("permissions", "workspace /tmp");
	assert.match(app.notices.at(-1)!, /Usage/);
	await app.command("permissions");
	assert.match(app.notices.at(-1)!, /Permissions: readonly/);
});

test("Pi組み込みreaderはヒントなしでも許可するが、同名の拡張ツールは出自で区別する", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	const reader = app.tools.find((tool) => tool.name === "read")!;
	reader.annotations = undefined;
	reader.sourceInfo = { source: "builtin", path: "builtin:read" };
	for (const name of ["grep", "find", "ls"]) app.tools.push({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } });
	await app.command("permissions", "readonly");
	for (const toolName of ["read", "grep", "find", "ls"]) {
		assert.equal(await app.emit("tool_call", call(toolName, { path: "README.md" })), undefined);
	}
	reader.sourceInfo = { source: "extension", path: "/some/extension.ts" };
	assert.equal((await app.emit("tool_call", call("read", { path: "README.md" })) as { block: boolean })?.block, true);
	app.tools.push({ name: "powershell", annotations: { readOnlyHint: true } });
	assert.equal((await app.emit("tool_call", call("powershell", { command: "Set-Content file changed" })) as { block: boolean })?.block, true);
});
