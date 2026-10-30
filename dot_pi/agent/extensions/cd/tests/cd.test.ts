import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import cd from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-cd-")));
const agentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
after(() => {
	if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = agentDir;
	rmSync(sandbox, { recursive: true, force: true });
});

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 0 };
}

function assistant(text: string) {
	return { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "stop", timestamp: 0 } as never;
}

function host(manager = SessionManager.create(join(sandbox, "from"), join(sandbox, "sessions"))) {
	mkdirSync(manager.getCwd(), { recursive: true });
	const app = extensionHost();
	const switched: Array<{ manager: SessionManager; navigated?: string }> = [];
	app.replaceSession(manager);
	Object.assign(app.ctx, {
		cwd: manager.getCwd(),
		waitForIdle: async () => {},
		switchSession: async (path: string, options: { withSession: (ctx: unknown) => Promise<void> }) => {
			const record: (typeof switched)[number] = { manager: SessionManager.open(path) };
			switched.push(record);
			await options.withSession({
				navigateTree: async (id: string) => { record.navigated = id; },
			});
			return { cancelled: false };
		},
	});
	cd(app.pi);
	return { app, manager, switched };
}

test("引数なしの /cd はホームへ移り、履歴を引き継ぎ、元のセッションを親として残す", async () => {
	const { app, manager, switched } = host();
	manager.appendMessage(user("hello"));
	manager.appendMessage(assistant("hi"));
	await app.command("cd");
	const moved = switched[0]!.manager;
	assert.equal(moved.getCwd(), homedir());
	assert.deepEqual(moved.getEntries().map((entry) => entry.id), manager.getEntries().map((entry) => entry.id));
	assert.equal(moved.getHeader()!.parentSession, manager.getSessionFile());
});

test("~ と相対パスは解決され、最初の応答前のセッションでも移れて拡張の状態を失わない", async () => {
	const { app, manager, switched } = host();
	manager.appendCustomEntry("goal", { version: 1, text: "keep" });
	mkdirSync(join(sandbox, "from", "sub"), { recursive: true });
	await app.command("cd", "sub");
	await app.command("cd", "~");
	assert.equal(switched[0]!.manager.getCwd(), join(sandbox, "from", "sub"));
	assert.equal(switched[1]!.manager.getCwd(), homedir());
	assert.equal(switched[0]!.manager.getEntries().at(-1)!.type, "custom");
	assert.equal(switched[0]!.manager.getHeader()!.parentSession, undefined);
});

test("/tree で戻っていた位置は移動後も保たれ、末尾にいれば木を動かさない", async () => {
	const { app, manager, switched } = host();
	const first = manager.appendMessage(user("first"));
	manager.appendMessage(assistant("second"));
	await app.command("cd", sandbox);
	assert.equal(switched[0]!.navigated, undefined);
	manager.branch(first);
	await app.command("cd", sandbox);
	assert.equal(switched[1]!.navigated, first);
});

test("存在しない場所・ファイル・今いる場所・保存しないセッションでは切り替えない", async () => {
	const { app, switched } = host();
	const file = join(sandbox, "file");
	writeFileSync(file, "");
	await app.command("cd", join(sandbox, "missing"));
	await app.command("cd", file);
	await app.command("cd", ".");
	assert.equal(switched.length, 0);
	assert.match(app.notices.join("\n"), /Not a directory.*missing[\s\S]*Not a directory.*file[\s\S]*Already in/);

	const memory = host(SessionManager.inMemory(join(sandbox, "from")));
	await memory.app.command("cd", sandbox);
	assert.equal(memory.switched.length, 0);
	assert.match(memory.app.notices.join("\n"), /--no-session/);
	assert.equal(existsSync(join(sandbox, "missing")), false);
});
