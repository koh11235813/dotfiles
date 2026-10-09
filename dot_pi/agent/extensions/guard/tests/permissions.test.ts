import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import guard, { targetPath } from "../index.ts";
import { PERMISSIONS_ENTRY } from "../permissions.ts";
import { sandbox } from "../sandbox.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

// SDK の場所。loader は HOME から release を探すので、下で HOME を差し替える前に解決しておく。
const SDK = import.meta.resolve("@earendil-works/pi-coding-agent");

// 本物の HOME と一時ディレクトリを root にしない。os.tmpdir() の下に作った「外」が外でなくなる。
const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-permissions-")));
const dir = (...parts: string[]) => {
	const path = join(base, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
};
process.env.TMPDIR = dir("tmp");
process.env.HOME = dir("home");
// Pi の bash からこのテストを走らせると、親の PI_GUARD を継承してしまう。
delete process.env.PI_GUARD;
// 判定の検証をホストの bubblewrap の有無に左右させない。実物は sandbox.test.ts が走らせる。
sandbox.available = true;

const call = (toolName: string, input: Record<string, unknown> = {}) => ({ toolName, toolCallId: "call-1", input });
const blocked = (result: unknown) => (result as { block?: boolean } | undefined)?.block === true;

test("/permissions readonly は読み取りとsandbox内のbashを許可し、edit/writeを遮断して現在のモードを表示する", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	await app.command("permissions", "readonly");
	assert.equal(await app.emit("tool_call", call("read", { path: "README.md" })), undefined);
	assert.equal(await app.emit("tool_call", call("bash", { command: "echo changed > file.txt" })), undefined);
	assert.ok(blocked(await app.emit("tool_call", call("write", { path: "file.txt", content: "changed" }))));
	assert.ok(blocked(await app.emit("tool_call", call("edit", { path: "file.txt" }))));
	assert.equal(app.confirmations.length, 0);
	await app.command("permissions");
	assert.match(app.notices.at(-1)!, /Permissions: readonly/);
});

test("sandboxが使えなければfull以外のbashは遮断し、素のbashに落とさない", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	app.approve(true);
	sandbox.available = false;
	try {
		for (const mode of ["normal", "ask", "readonly"]) {
			await app.command("permissions", mode);
			const result = await app.emit("tool_call", call("bash", { command: "pwd" })) as { block: boolean; reason: string };
			assert.equal(result?.block, true, mode);
			assert.match(result.reason, /guard\[sandbox\].*bubblewrap.*\/permissions full/);
		}
		assert.equal(app.confirmations.length, 0);
		await app.command("permissions");
		assert.match(app.notices.at(-1)!, /UNAVAILABLE/);
		await app.command("permissions", "full");
		assert.equal(await app.emit("tool_call", call("bash", { command: "pwd" })), undefined);
	} finally {
		sandbox.available = true;
	}
});

test("権限モードは再開とtreeで復元され、新規セッションはnormalに戻る", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	await app.command("permissions", "readonly");
	const readonly = app.manager.getLeafId()!;
	await app.command("permissions", "full");
	app.manager.branch(readonly);
	await app.emit("session_tree");
	await app.command("permissions");
	assert.match(app.notices.at(-1)!, /Permissions: readonly/);
	await app.emit("session_start", { reason: "resume" });
	assert.ok(blocked(await app.emit("tool_call", call("write", { path: "file.txt" }))));
	app.replaceSession();
	await app.emit("session_start", { reason: "new" });
	await app.command("permissions");
	assert.match(app.notices.at(-1)!, /Permissions: normal/);
	assert.equal(await app.emit("tool_call", call("write", { path: "file.txt" })), undefined);
});

test("sandbox導入前に保存されたnormalはsandboxつきのnormalとして復元し、未知のモードは無視する", async () => {
	const app = extensionHost();
	guard(app.pi);
	app.manager.appendCustomEntry(PERMISSIONS_ENTRY, { version: 1, mode: "readonly" });
	app.manager.appendCustomEntry(PERMISSIONS_ENTRY, { version: 1, mode: "normal" });
	app.manager.appendCustomEntry(PERMISSIONS_ENTRY, { version: 1, mode: "workspace" });
	await app.emit("session_start", { reason: "resume" });
	await app.command("permissions");
	assert.match(app.notices.at(-1)!, /Permissions: normal/);
	sandbox.available = false;
	try {
		assert.ok(blocked(await app.emit("tool_call", call("bash", { command: "pwd" }))));
	} finally {
		sandbox.available = true;
	}
	app.manager.appendCustomEntry(PERMISSIONS_ENTRY, { version: 1, mode: "full" });
	await app.emit("session_start", { reason: "resume" });
	await app.command("permissions");
	assert.match(app.notices.at(-1)!, /Permissions: full/);
});

test("askは非readonly・未知ツールを確認し、拒否やUIなしでは実行させない", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	await app.command("permissions", "ask");
	assert.equal(await app.emit("tool_call", call("read", { path: "file" })), undefined);
	assert.equal(app.confirmations.length, 0);
	assert.ok(blocked(await app.emit("tool_call", call("bash", { command: "pwd" }))));
	app.approve(true);
	assert.equal(await app.emit("tool_call", call("bash", { command: "pwd" })), undefined);
	app.approve(false);
	assert.ok(blocked(await app.emit("tool_call", call("unknown_tool"))));
	assert.doesNotMatch(app.confirmations.at(-1)!, /no user/);
	app.ctx.hasUI = false;
	app.approve(true);
	// 誰にも訊いていないのに「ユーザーが拒否した」とは言わない。
	const unasked = await app.emit("tool_call", call("bash", { command: "pwd" })) as { block: boolean; reason: string };
	assert.equal(unasked.block, true);
	assert.match(unasked.reason, /no user can be asked/);
	assert.doesNotMatch(unasked.reason, /denied|not approved/);
});

test("どのモードでも固定禁止は承認や誤ったreadonlyヒントで解除できない", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	app.approve(true);
	app.tools.find((tool) => tool.name === "write")!.annotations!.readOnlyHint = true;
	for (const mode of ["full", "normal", "ask", "readonly"]) {
		await app.command("permissions", mode);
		const result = await app.emit("tool_call", call("bash", { command: "git push origin main --force-with-lease" })) as { block: boolean; reason: string };
		assert.equal(result.block, true);
		assert.match(result.reason, /git-force-push/);
	}
	assert.equal(app.confirmations.length, 0);
	assert.ok(blocked(await app.emit("tool_call", call("write", { path: "file.txt" }))));
	app.tools.push({ name: "mcp_read", annotations: { readOnlyHint: true } }, { name: "mcp_unknown" });
	assert.equal(await app.emit("tool_call", call("mcp_read")), undefined);
	assert.ok(blocked(await app.emit("tool_call", call("mcp_unknown"))));
	assert.ok(blocked(await app.emit("tool_call", call("subagent", { agent: "worker" }))));
});

test("fullとnormalは既存guardの確認を維持し、不正なモード指定は状態を変えない", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	for (const mode of ["full", "normal"]) {
		await app.command("permissions", mode);
		app.approve(false);
		assert.ok(blocked(await app.emit("tool_call", call("bash", { command: "git push" }))));
		app.approve(true);
		assert.equal(await app.emit("tool_call", call("bash", { command: "git push" })), undefined);
	}
	await app.command("permissions", "readonly");
	await app.command("permissions", "workspace /tmp");
	assert.match(app.notices.at(-1)!, /Usage/);
	await app.command("permissions");
	assert.match(app.notices.at(-1)!, /Permissions: readonly/);
});

test("normalとaskでは書ける場所の外へのedit/writeを確認し、UIなしでは遮断する。fullは確認しない", async () => {
	const app = extensionHost();
	guard(app.pi);
	const root = dir("write", "project");
	const outside = join(dir("write", "outside"), "file.txt");
	symlinkSync(join(base, "write", "outside"), join(root, "escape"));
	app.ctx.cwd = root;
	await app.emit("session_start");

	assert.equal(await app.emit("tool_call", call("write", { path: "new/dir/file.txt" })), undefined);
	assert.equal(await app.emit("tool_call", call("edit", { path: join(process.env.TMPDIR!, "note.txt") })), undefined);
	assert.equal(app.confirmations.length, 0);
	for (const path of [outside, "../outside/file.txt", "escape/file.txt", "~/.zshrc"]) {
		const result = await app.emit("tool_call", call("write", { path })) as { block: boolean; reason: string };
		assert.equal(result?.block, true, path);
		assert.match(result.reason, /outside-write-roots/);
	}
	assert.equal(app.confirmations.length, 4);
	app.approve(true);
	assert.equal(await app.emit("tool_call", call("edit", { path: outside })), undefined);

	await app.command("permissions", "ask");
	assert.equal(await app.emit("tool_call", call("write", { path: outside })), undefined);
	assert.equal(app.confirmations.length, 6);
	app.approve(false);
	assert.match((await app.emit("tool_call", call("write", { path: outside })) as { reason: string }).reason, /denied by the user/);
	app.approve(true);
	assert.equal(app.confirmations.length, 7);

	await app.command("permissions", "normal");
	app.ctx.hasUI = false;
	const unasked = await app.emit("tool_call", call("write", { path: outside })) as { block: boolean; reason: string };
	assert.equal(unasked.block, true);
	assert.doesNotMatch(unasked.reason, /denied by the user/);
	assert.equal(app.confirmations.length, 7);

	await app.command("permissions", "full");
	assert.equal(await app.emit("tool_call", call("write", { path: outside })), undefined);
});

test("edit/writeの判定はPiが実際に開くパスで行う (@・file://・~・Unicodeの空白・NUL)", async () => {
	const app = extensionHost();
	guard(app.pi);
	const root = dir("forms", "project");
	const outside = dir("forms", "outside");
	symlinkSync(outside, join(root, "es cape"));
	app.ctx.cwd = root;
	app.ctx.hasUI = false;
	await app.emit("session_start");
	for (const path of ["@file.txt", `@${root}/file.txt`, `file://${root}/file.txt`, "a\u00A0b.txt", "@~/project-in-home/../../forms/project/file.txt"]) {
		assert.equal(await app.emit("tool_call", call("write", { path })), undefined, path);
	}
	for (const path of [`@${outside}/file.txt`, `file://${outside}/file.txt`, "@~/file.txt", "~", "@../outside/file.txt", "es\u00A0cape/file.txt", "es\u3000cape/file.txt", "file.txt\0", `${outside}/file.txt\0.txt`]) {
		assert.ok(blocked(await app.emit("tool_call", call("write", { path }))), path);
		assert.ok(blocked(await app.emit("tool_call", call("edit", { path }))), path);
	}
});

test("ホームディレクトリで起動するとcwdは書ける場所にならず、/permissionsがそれを示す", async () => {
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = process.env.HOME!;
	await app.emit("session_start");
	const result = await app.emit("tool_call", call("write", { path: ".zshrc" })) as { block: boolean; reason: string };
	assert.equal(result?.block, true);
	assert.match(result.reason, /outside-write-roots/);
	await app.command("permissions");
	assert.match(app.notices.at(-1)!, /Write root: none \(.*contains your home directory/);
});

test("環境変数もセッションの記録も無いプロセスはnormalで始まり、壊れたPI_GUARDでfullにはならない", async () => {
	for (const value of [undefined, "", "not json", "null", "{}", JSON.stringify({ mode: "unrestricted", root: "/", pid: 1 }), JSON.stringify({ mode: "full", pid: 1 })]) {
		if (value === undefined) delete process.env.PI_GUARD;
		else process.env.PI_GUARD = value;
		const app = extensionHost();
		guard(app.pi);
		app.ctx.hasUI = false;
		await app.emit("session_start");
		await app.command("permissions");
		assert.match(app.notices.at(-1)!, /Permissions: normal\./, String(value));
		sandbox.available = false;
		try {
			assert.ok(blocked(await app.emit("tool_call", call("bash", { command: "pwd" }))), String(value));
		} finally {
			sandbox.available = true;
		}
	}
	delete process.env.PI_GUARD;
});

test("モードとrootを環境変数で子孫のPiに渡す", async () => {
	const app = extensionHost();
	guard(app.pi);
	const root = dir("export", "project");
	app.ctx.cwd = root;
	await app.emit("session_start");
	assert.deepEqual(JSON.parse(process.env.PI_GUARD!), { mode: "normal", root, pid: process.pid });
	await app.command("permissions", "readonly");
	assert.deepEqual(JSON.parse(process.env.PI_GUARD!), { mode: "readonly", root, pid: process.pid });
	// git の common dir も渡す。子孫が自分で訊くと、親のモデルが .git を書き換えた後の答えになる。
	const linked = dir("export", "repo", "sub");
	execFileSync("git", ["-C", join(base, "export", "repo"), "init"], { stdio: "ignore" });
	app.ctx.cwd = linked;
	await app.emit("session_start");
	assert.equal(JSON.parse(process.env.PI_GUARD!).git, join(base, "export", "repo", ".git"));
	// 同じプロセスでの再評価 (/reload) は継承ではない。自分の値に縛られない。
	const reloaded = extensionHost();
	guard(reloaded.pi);
	await reloaded.emit("session_start");
	await reloaded.command("permissions", "full");
	assert.match(reloaded.notices.at(-1)!, /Permissions: full/);
});

test("子孫のPiは親のモードとrootを引き継ぎ、自分のcwdや/permissionsでは変えられない", async () => {
	const root = dir("inherit", "parent");
	const elsewhere = dir("inherit", "elsewhere");
	const exported = JSON.stringify({ mode: "normal", root, pid: process.pid + 1 });
	process.env.PI_GUARD = exported;
	try {
		const app = extensionHost();
		guard(app.pi);
		// subagent の cwd はモデルが決める。root にはしない。
		app.ctx.cwd = elsewhere;
		app.ctx.hasUI = false;
		app.manager.appendCustomEntry(PERMISSIONS_ENTRY, { version: 1, mode: "full" });
		await app.emit("session_start");
		await app.command("permissions", "full");
		assert.match(app.notices.at(-1)!, /Permissions: normal, inherited/);
		assert.equal(process.env.PI_GUARD, exported);
		assert.equal(await app.emit("tool_call", call("write", { path: join(root, "file.txt") })), undefined);
		assert.ok(blocked(await app.emit("tool_call", call("write", { path: "file.txt" }))));

		process.env.PI_GUARD = JSON.stringify({ mode: "readonly", root, pid: process.pid + 1 });
		const readonly = extensionHost();
		guard(readonly.pi);
		await readonly.emit("session_start");
		assert.ok(blocked(await readonly.emit("tool_call", call("write", { path: join(root, "file.txt") }))));
	} finally {
		delete process.env.PI_GUARD;
	}
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
	assert.ok(blocked(await app.emit("tool_call", call("read", { path: "README.md" }))));
	app.tools.push({ name: "powershell", annotations: { readOnlyHint: true } });
	assert.ok(blocked(await app.emit("tool_call", call("powershell", { command: "Set-Content file changed" }))));
});

test("targetPath は動いている release の resolveToCwd と同じパスを返す", async () => {
	// 写しなので、Pi の更新で手順が変わると判定と書き込み先が黙ってずれる。release の実物と突き合わせて気づけるようにする。
	const { resolveToCwd } = await import(new URL("./core/tools/path-utils.js", SDK).href);
	const inputs = [
		"a.txt", "./a/../b.txt", "../out.txt", "/abs/a.txt", "~", "~/a.txt", "~user/a.txt",
		"@a.txt", "@/abs/a.txt", "@~/a.txt", "@@a.txt", "@file:///abs/a.txt",
		"file:///abs/a%20b.txt", "file://localhost/abs/a.txt", "FILE:///abs/a.txt",
		"a\u00A0b.txt", "a\u2009b.txt", "a\u202Fb.txt", "a\u3000b.txt", "a\u200Bb.txt", "\u00A0@a.txt",
		" a.txt ", "", ".",
	];
	for (const input of inputs) {
		assert.equal(targetPath(input, "/work/dir"), resolveToCwd(input, "/work/dir"), JSON.stringify(input));
	}
});
