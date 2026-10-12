import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import checkpoint from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "checkpoint-test-")));
after(() => rmSync(base, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]) {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
}

/** `files` を commit 済みにしたリポジトリ。 */
function repo(files: Record<string, string> = { "a.txt": "a\n" }) {
	const dir = mkdtempSync(join(base, "repo-"));
	git(dir, "init", "-q");
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

/** dir を cwd にして拡張を読み込み、タスクを始めたところまで進める。 */
async function start(dir: string) {
	const app = extensionHost();
	app.ctx.cwd = dir;
	checkpoint(app.pi);
	await app.emit("session_start", { reason: "startup" });
	await app.emit("before_agent_start", { prompt: "do it" });
	return {
		...app,
		/** Pi の write / edit が path に text を書いた。 */
		piWrites: async (path: string, text: string, toolName = "write") => {
			await app.emit("tool_call", { toolName, toolCallId: "c", input: { path } });
			mkdirSync(join(dir, path, ".."), { recursive: true });
			writeFileSync(join(dir, path), text);
			await app.emit("tool_result", { toolName, toolCallId: "c", input: { path }, isError: false });
		},
		lastNotice: () => app.notices.at(-1) ?? "",
	};
}

test("/checkpoint はタスク開始時からの変更だけを並べ、開始前からあった未 commit の差分は出さない", async () => {
	const dir = repo({ "a.txt": "a\n", "dirty.txt": "clean\n" });
	writeFileSync(join(dir, "dirty.txt"), "edited before the task\n");
	const app = await start(dir);
	await app.piWrites("a.txt", "a changed by pi\n");
	await app.piWrites("src/new.txt", "new\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt/);
	assert.match(app.lastNotice(), /A\s+src\/new\.txt/);
	assert.doesNotMatch(app.lastNotice(), /dirty\.txt/);
	assert.match(app.lastNotice(), /\/checkpoint restore/);
});

test("一覧は Pi の write / edit が書いたままのファイルと、それ以外の変更を分けて示す", async () => {
	const dir = repo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	await app.piWrites("b.txt", "pi\n", "edit");
	writeFileSync(join(dir, "b.txt"), "pi, then someone else\n");
	writeFileSync(join(dir, "c.txt"), "changed by a shell command or a person\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt\s+Pi が書いたまま/);
	assert.match(app.lastNotice(), /M\s+b\.txt\s+Pi と別の変更が混じっている/);
	assert.match(app.lastNotice(), /M\s+c\.txt\s+Pi の write \/ edit 以外の変更/);
});

test("/checkpoint diff は基準と今の差分を見せる", async () => {
	const dir = repo({ "a.txt": "a\n", "b.txt": "b\n" });
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	await app.piWrites("b.txt", "other\n");
	await app.command("checkpoint", "diff a.txt");
	assert.match(app.lastNotice(), /^-a$/m);
	assert.match(app.lastNotice(), /^\+pi$/m);
	assert.doesNotMatch(app.lastNotice(), /other/);
	await app.command("checkpoint", "diff");
	assert.match(app.lastNotice(), /^\+other$/m);
});

test("Pi が書いたままのファイルは確認なしで基準に戻り、index と他のファイルは動かない", async () => {
	const dir = repo({ "a.txt": "a\n", "b.txt": "b\n" });
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	await app.piWrites("b.txt", "pi\n");
	await app.piWrites("new.txt", "pi\n");
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
	assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "pi\n");
	await app.command("checkpoint", "restore new.txt");
	assert.equal(existsSync(join(dir, "new.txt")), false);
	assert.deepEqual(app.confirmations, []);
	assert.equal(git(dir, "diff", "--cached", "--name-only"), "");
	await app.command("checkpoint");
	assert.doesNotMatch(app.lastNotice(), /a\.txt|new\.txt/);
	assert.match(app.lastNotice(), /b\.txt/);
});

test("Pi が書いた後に誰かが変えたファイルは確認で止まり、断れば上書きしない", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	writeFileSync(join(dir, "a.txt"), "pi\nand a person\n");
	app.approve(false);
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\nand a person\n");
	assert.equal(app.confirmations.length, 1);
	assert.match(app.confirmations[0], /a\.txt/);
	assert.match(app.confirmations[0], /Pi と別の変更が混じっている/);
	app.approve(true);
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
});

test("確認を待つ間に中身が変わったら、承認されていても上書きしない", async () => {
	const dir = repo();
	const app = await start(dir);
	writeFileSync(join(dir, "a.txt"), "what the person saw\n");
	app.ctx.ui.confirm = async () => {
		writeFileSync(join(dir, "a.txt"), "written while the dialog was open\n");
		return true;
	};
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "written while the dialog was open\n");
	assert.match(app.lastNotice(), /確認の間に中身が変わった/);
});

test("Pi が書く前に誰かが変えていたファイルも、Pi が上書きした後で確認に回る", async () => {
	const dir = repo();
	const app = await start(dir);
	writeFileSync(join(dir, "a.txt"), "a person edited this after the task started\n");
	await app.piWrites("a.txt", "pi overwrote it\n");
	app.approve(false);
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi overwrote it\n");
	assert.equal(app.confirmations.length, 1);
});

test("shell や人が変えたファイルは誰の変更か分からないので、戻す前に必ず確認する", async () => {
	const dir = repo();
	const app = await start(dir);
	writeFileSync(join(dir, "a.txt"), "sed -i, a formatter, or a person\n");
	app.approve(false);
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "sed -i, a formatter, or a person\n");
	assert.match(app.confirmations[0], /Pi の write \/ edit 以外の変更/);
});

test("確認できないとき (UI なし)、Pi が動いている間、一覧に無いパスは戻さない", async () => {
	const dir = repo({ "a.txt": "a\n", "b.txt": "b\n" });
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	writeFileSync(join(dir, "b.txt"), "someone\n");
	app.approve(true);

	app.idle(false);
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\n");
	app.idle(true);

	(app.ctx as { hasUI: boolean }).hasUI = false;
	await app.command("checkpoint", "restore b.txt");
	assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "someone\n");
	assert.deepEqual(app.confirmations, []);
	(app.ctx as { hasUI: boolean }).hasUI = true;

	for (const path of ["", "nope.txt", "../outside.txt", "/etc/hostname"]) {
		await app.command("checkpoint", `restore ${path}`);
		assert.match(app.lastNotice(), /復元候補に無い/, path);
	}
});

test("未追跡ファイルは基準に入り、commit が 1 つも無くても戻せる。ignore されたファイルは見ない", async () => {
	const dir = mkdtempSync(join(base, "repo-"));
	git(dir, "init", "-q");
	writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
	writeFileSync(join(dir, "notes.txt"), "untracked, written before the task\n");
	writeFileSync(join(dir, "ignored.log"), "before\n");
	const app = await start(dir);
	await app.piWrites("notes.txt", "pi\n");
	await app.piWrites("ignored.log", "pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+notes\.txt/);
	assert.doesNotMatch(app.lastNotice(), /ignored\.log/);
	await app.command("checkpoint", "restore notes.txt");
	assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "untracked, written before the task\n");
	assert.equal(git(dir, "status", "--short", "--", "notes.txt"), "?? notes.txt\n");
});

test("symlink は辿らずにリンクそのものを 1 つのファイルとして扱う", async () => {
	const dir = repo({ "a.txt": "a\n" });
	symlinkSync("a.txt", join(dir, "link"));
	const app = await start(dir);
	// リンク越しの write は、指す先のファイルを変える。記録が付くのはリンクの側なので、先のファイルは確認に回る。
	await app.emit("tool_call", { toolName: "write", toolCallId: "c", input: { path: "link" } });
	writeFileSync(join(dir, "link"), "written through the link\n");
	await app.emit("tool_result", { toolName: "write", toolCallId: "c", input: { path: "link" }, isError: false });
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt\s+Pi の write \/ edit 以外の変更/);
	assert.doesNotMatch(app.lastNotice(), /\slink\s/);

	// リンクが普通のファイルに置き換わったら、リンクに戻す。指す先は触らない。
	rmSync(join(dir, "link"));
	writeFileSync(join(dir, "link"), "now a regular file\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /T\s+link/);
	app.approve(true);
	await app.command("checkpoint", "restore link");
	assert.equal(readlinkSync(join(dir, "link")), "a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "written through the link\n");
});

test("基準はセッションに残り、reload しても取り直さない。Pi が書いた記録は消えるので確認に回る", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");

	const reloaded = extensionHost();
	reloaded.ctx.cwd = dir;
	reloaded.replaceSession(app.manager);
	checkpoint(reloaded.pi);
	await reloaded.emit("session_start", { reason: "reload" });
	await reloaded.emit("before_agent_start", { prompt: "next" });
	reloaded.approve(false);
	await reloaded.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\n");
	assert.match(reloaded.confirmations[0], /Pi の write \/ edit 以外の変更/);
});

test("/checkpoint new は今の状態を新しい基準にする", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.piWrites("a.txt", "first task\n");
	await app.command("checkpoint", "new");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /変わったファイルは無い/);
	await app.piWrites("a.txt", "second task\n");
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "first task\n");
});

test("基準を取っても戻しても、commit・stash・ref・index は増えない", async () => {
	const dir = repo({ "a.txt": "a\n", "sub/b.txt": "b\n" });
	const state = () => [git(dir, "rev-parse", "HEAD"), git(dir, "for-each-ref"), git(dir, "stash", "list"), git(dir, "diff", "--cached", "--name-only")];
	const before = state();
	const app = extensionHost();
	app.ctx.cwd = join(dir, "sub");
	checkpoint(app.pi);
	await app.emit("session_start", { reason: "startup" });
	await app.emit("before_agent_start", { prompt: "do it" });
	// cwd がリポジトリの下の階でも、パスはリポジトリの頭から数える。
	await app.emit("tool_call", { toolName: "edit", toolCallId: "c", input: { path: "b.txt" } });
	writeFileSync(join(dir, "sub/b.txt"), "pi\n");
	await app.emit("tool_result", { toolName: "edit", toolCallId: "c", input: { path: "b.txt" }, isError: false });
	await app.command("checkpoint");
	assert.match(app.notices.at(-1)!, /M\s+sub\/b\.txt\s+Pi が書いたまま/);
	await app.command("checkpoint", "new");
	writeFileSync(join(dir, "a.txt"), "changed\n");
	app.approve(true);
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
	assert.deepEqual(state(), before);
});

test("git の作業ツリーの外では何もせず、そう伝える", async () => {
	const dir = mkdtempSync(join(base, "plain-"));
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /基準が無い/);
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\n");
});

/** 走ると mark を作る実行ファイル。 */
function trap(dir: string, name: string, mark: string) {
	mkdirSync(join(dir, name, ".."), { recursive: true });
	writeFileSync(join(dir, name), `#!/bin/sh\ntouch '${mark}'\n`);
	chmodSync(join(dir, name), 0o755);
	return join(dir, name);
}

test("リポジトリの設定に仕込まれた hook と fsmonitor は走らせない", async () => {
	const dir = repo();
	const marks = mkdtempSync(join(base, "marks-"));
	trap(dir, ".git/hooks/post-index-change", join(marks, "hook"));
	git(dir, "config", "core.fsmonitor", trap(dir, ".git/fsmonitor", join(marks, "fsmonitor")));
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt/);
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
	assert.deepEqual(readdirSync(marks), []);
});

test("リポジトリの設定に仕込まれた filter は走らせず、その filter が掛かるファイルは戻さない", async () => {
	const dir = repo({ "a.txt": "a\n", "b.md": "b\n" });
	const marks = mkdtempSync(join(base, "marks-"));
	for (const key of ["clean", "smudge", "process"]) git(dir, "config", `filter.x=y.${key}`, `sh -c 'touch ${join(marks, key)}; cat'`);
	git(dir, "config", "filter.x=y.required", "true");
	writeFileSync(join(dir, ".gitattributes"), "*.txt filter=x=y\n");
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	await app.piWrites("b.md", "pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt/);
	app.approve(true);
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\n");
	assert.match(app.lastNotice(), /filter「x=y」/);
	await app.command("checkpoint", "restore b.md");
	assert.equal(readFileSync(join(dir, "b.md"), "utf8"), "b\n");
	// 基準に無かったファイルは消すだけで、基準の中身を書き出さないので戻せる。
	await app.piWrites("new.txt", "pi\n");
	await app.command("checkpoint", "restore new.txt");
	assert.equal(existsSync(join(dir, "new.txt")), false);
	assert.deepEqual(readdirSync(marks), []);
});

test("利用者の設定 (リポジトリの外) にある filter は止めず、そのファイルも戻せる", async () => {
	const dir = repo();
	const config = join(mkdtempSync(join(base, "global-")), "gitconfig");
	writeFileSync(config, "");
	const saved = process.env.GIT_CONFIG_GLOBAL;
	process.env.GIT_CONFIG_GLOBAL = config;
	try {
		git(dir, "config", "--global", "filter.upper.clean", "tr a-z A-Z");
		git(dir, "config", "--global", "filter.upper.smudge", "tr A-Z a-z");
		writeFileSync(join(dir, ".gitattributes"), "*.txt filter=upper\n");
		const app = await start(dir);
		await app.piWrites("a.txt", "pi\n");
		await app.command("checkpoint", "diff a.txt");
		assert.match(app.lastNotice(), /^\+PI$/m);
		app.approve(true);
		await app.command("checkpoint", "restore a.txt");
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
	} finally {
		if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = saved;
	}
});

test("git が index に入れられないものが 1 つあっても、残りのファイルで基準を取る", async () => {
	const dir = repo();
	mkdirSync(join(dir, "nested"));
	git(join(dir, "nested"), "init", "-q");
	const app = await start(dir);
	assert.deepEqual(app.notices, []);
	await app.piWrites("a.txt", "pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt\s+Pi が書いたまま/);
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
});

test("戻すと名前の出ていない別のパスが消えるときは、戻さずにそのパスを伝える", async () => {
	const dir = repo({ "d/x.txt": "x\n", "e": "e\n" });
	const app = await start(dir);
	rmSync(join(dir, "d"), { recursive: true });
	writeFileSync(join(dir, "d"), "someone's new file\n");
	rmSync(join(dir, "e"));
	mkdirSync(join(dir, "e"));
	writeFileSync(join(dir, "e/ignored.log"), "not in the list\n");
	writeFileSync(join(dir, ".git/info/exclude"), "*.log\n");
	app.approve(true);

	await app.command("checkpoint", "restore d/x.txt");
	assert.equal(readFileSync(join(dir, "d"), "utf8"), "someone's new file\n");
	assert.match(app.lastNotice(), /「d」/);

	await app.command("checkpoint", "restore e");
	assert.equal(readFileSync(join(dir, "e/ignored.log"), "utf8"), "not in the list\n");
	assert.match(app.lastNotice(), /「e」/);

	// 邪魔なものを先に片付ければ戻せる。
	await app.command("checkpoint", "restore d");
	await app.command("checkpoint", "restore d/x.txt");
	assert.equal(readFileSync(join(dir, "d/x.txt"), "utf8"), "x\n");
	rmSync(join(dir, "e/ignored.log"));
	// 確認を待つ間に置かれたものも消さない。
	app.ctx.ui.confirm = async () => {
		writeFileSync(join(dir, "e/ignored.log"), "written while the dialog was open\n");
		return true;
	};
	await app.command("checkpoint", "restore e");
	assert.equal(readFileSync(join(dir, "e/ignored.log"), "utf8"), "written while the dialog was open\n");
	rmSync(join(dir, "e/ignored.log"));
	app.ctx.ui.confirm = async () => true;
	await app.command("checkpoint", "restore e");
	assert.equal(readFileSync(join(dir, "e"), "utf8"), "e\n");
});

test("skip-worktree / assume-unchanged の付いたファイルの変更も一覧に出て、利用者の index の印は動かない", async () => {
	const dir = repo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
	git(dir, "update-index", "--skip-worktree", "b.txt");
	git(dir, "update-index", "--assume-unchanged", "c.txt");
	const app = await start(dir);
	await app.piWrites("b.txt", "pi\n");
	await app.piWrites("c.txt", "pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+b\.txt\s+Pi が書いたまま/);
	assert.match(app.lastNotice(), /M\s+c\.txt\s+Pi が書いたまま/);
	await app.command("checkpoint", "restore b.txt");
	assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "b\n");
	assert.equal(git(dir, "ls-files", "-v"), "H a.txt\nS b.txt\nh c.txt\n");
});

test("名前が .. で始まるファイルもリポジトリの中のファイルとして Pi の記録が付く", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.piWrites("..foo", "pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /A\s+\.\.foo\s+Pi が書いたまま/);
});

test("restore のパスは glob として解釈せず、その名前のファイルだけを戻す", async () => {
	const dir = repo({ "a.txt": "a\n", "*.txt": "star\n" });
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	await app.piWrites("*.txt", "pi\n");
	await app.command("checkpoint", "restore *.txt");
	assert.equal(readFileSync(join(dir, "*.txt"), "utf8"), "star\n");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\n");
});

test("セッションに残った基準は、別のリポジトリ・消えた tree・object id でない値なら使わず取り直す", async () => {
	const dir = repo();
	const other = repo();
	const elsewhere = await start(other);
	await elsewhere.piWrites("a.txt", "changed in the other repository\n");

	/** session を引き継いで dir で再開し、次の依頼を送ったところ。 */
	const resume = async (manager: typeof elsewhere.manager) => {
		const app = extensionHost();
		app.ctx.cwd = dir;
		app.replaceSession(manager);
		checkpoint(app.pi);
		await app.emit("session_start", { reason: "resume" });
		await app.emit("before_agent_start", { prompt: "next" });
		return app;
	};
	const moved = await resume(elsewhere.manager);
	await moved.command("checkpoint");
	assert.match(moved.notices.at(-1)!, /変わったファイルは無い/);

	for (const tree of ["1".repeat(40), "HEAD"]) {
		const fresh = extensionHost();
		fresh.manager.appendCustomEntry("checkpoint", { version: 1, top: dir, tree });
		const app = await resume(fresh.manager);
		writeFileSync(join(dir, "a.txt"), `after ${tree}\n`);
		git(dir, "commit", "-q", "-a", "-m", "moves HEAD");
		await app.command("checkpoint");
		assert.match(app.notices.at(-1)!, /M\s+a\.txt/, tree);
	}
});

test("/tree で会話を戻しても基準はセッションから見つかり、取り直さない", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	app.manager.resetLeaf();

	const reloaded = extensionHost();
	reloaded.ctx.cwd = dir;
	reloaded.replaceSession(app.manager);
	checkpoint(reloaded.pi);
	await reloaded.emit("session_start", { reason: "reload" });
	await reloaded.emit("before_agent_start", { prompt: "next" });
	await reloaded.command("checkpoint");
	assert.match(reloaded.notices.at(-1)!, /M\s+a\.txt/);
});

test("失敗した write / edit は Pi が書いた記録にしない", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.emit("tool_call", { toolName: "edit", toolCallId: "c", input: { path: "a.txt" } });
	await app.emit("tool_result", { toolName: "edit", toolCallId: "c", input: { path: "a.txt" }, isError: true });
	writeFileSync(join(dir, "a.txt"), "a person\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt\s+Pi の write \/ edit 以外の変更/);
});

test("戻した後は Pi の記録を消す。同じ中身を誰かが書けば確認に回り、Pi が書き直せば Pi が書いたままになる", async () => {
	const dir = repo({ "a.txt": "a\n", "b.txt": "b\n" });
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	await app.command("checkpoint", "restore a.txt");
	writeFileSync(join(dir, "a.txt"), "pi\n");
	app.approve(false);
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\n");
	assert.equal(app.confirmations.length, 1);

	writeFileSync(join(dir, "b.txt"), "a person\n");
	await app.piWrites("b.txt", "pi over a person\n");
	app.approve(true);
	await app.command("checkpoint", "restore b.txt");
	await app.piWrites("b.txt", "pi again\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+b\.txt\s+Pi が書いたまま/);
});

test("戻す前の作業ツリーを tree に取り、知らせた id から戻す前の中身を読める", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.piWrites("a.txt", "about to be thrown away\n");
	await app.command("checkpoint", "restore a.txt");
	const [, tree] = app.lastNotice().match(/tree ([0-9a-f]{40,64})/)!;
	assert.equal(git(dir, "show", `${tree}:a.txt`), "about to be thrown away\n");
});

test("/checkpoint diff は 200 行で切り、残りの行数を添える", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.piWrites("a.txt", Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join(""));
	await app.command("checkpoint", "diff");
	const lines = app.lastNotice().split("\n");
	assert.equal(lines.length, 201);
	assert.match(lines[200], /残り \d+ 行/);
});

test("一時ディレクトリに何も残さない", async () => {
	const dir = repo();
	const saved = process.env.TMPDIR;
	process.env.TMPDIR = mkdtempSync(join(base, "tmp-"));
	try {
		const app = await start(dir);
		await app.piWrites("a.txt", "pi\n");
		await app.command("checkpoint");
		await app.command("checkpoint", "restore a.txt");
		assert.deepEqual(readdirSync(process.env.TMPDIR), []);
	} finally {
		if (saved === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = saved;
	}
});

test("Pi が書いた前後に誰かが実行ビットを変えたファイルは、中身が同じでも確認に回る", async () => {
	const dir = repo({ "after.sh": "echo a\n", "before.sh": "echo a\n" });
	const app = await start(dir);
	await app.piWrites("after.sh", "echo pi\n");
	chmodSync(join(dir, "after.sh"), 0o755);
	chmodSync(join(dir, "before.sh"), 0o755);
	await app.piWrites("before.sh", "echo pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+after\.sh\s+Pi と別の変更が混じっている/);
	assert.match(app.lastNotice(), /M\s+before\.sh\s+Pi と別の変更が混じっている/);
	app.approve(false);
	await app.command("checkpoint", "restore after.sh");
	await app.command("checkpoint", "restore before.sh");
	assert.equal(app.confirmations.length, 2);
	assert.equal(statSync(join(dir, "after.sh")).mode & 0o777, 0o755);
	assert.equal(readFileSync(join(dir, "after.sh"), "utf8"), "echo pi\n");
});

test("追跡済みで .gitignore に当たるファイルの変更は、index に skip-worktree の印があっても一覧に出る", async () => {
	const dir = repo({ "a.txt": "a\n", "b.txt": "b\n" });
	writeFileSync(join(dir, ".gitignore"), "dist/\n");
	mkdirSync(join(dir, "dist"));
	writeFileSync(join(dir, "dist/out.js"), "built\n");
	git(dir, "add", "-f", ".gitignore", "dist/out.js");
	git(dir, "commit", "-q", "-m", "tracked but ignored");
	git(dir, "update-index", "--skip-worktree", "b.txt");
	git(dir, "update-index", "--assume-unchanged", "a.txt");
	const app = await start(dir);
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /変わったファイルは無い/);
	await app.piWrites("dist/out.js", "pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+dist\/out\.js\s+Pi が書いたまま/);
	await app.command("checkpoint", "restore dist/out.js");
	assert.equal(readFileSync(join(dir, "dist/out.js"), "utf8"), "built\n");
	assert.equal(git(dir, "ls-files", "-v"), "H .gitignore\nh a.txt\nS b.txt\nH dist/out.js\n");
	// 基準を取った後で印を付けても、そこにあるファイルを「消えた」とは言わない。
	git(dir, "update-index", "--skip-worktree", "dist/out.js");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /変わったファイルは無い/);
});

test("基準に無いファイルを戻す確認は、ファイルが消えることと、タスク前からあったかもしれないことを伝える", async () => {
	const dir = repo({ "a.txt": "a\n", ".gitignore": "secret.env\n" });
	writeFileSync(join(dir, "secret.env"), "here before the task, ignored\n");
	const app = await start(dir);
	await app.piWrites(".gitignore", "");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /A\s+secret\.env\s+Pi の write \/ edit 以外の変更/);
	app.approve(false);
	await app.command("checkpoint", "restore secret.env");
	assert.equal(app.confirmations.length, 1);
	assert.match(app.confirmations[0], /secret\.env を消す\?/);
	assert.match(app.confirmations[0], /タスクの前からあった/);
	assert.equal(readFileSync(join(dir, "secret.env"), "utf8"), "here before the task, ignored\n");
	// 基準にあるファイルの確認は、消すとは言わない。
	writeFileSync(join(dir, "a.txt"), "a person\n");
	await app.command("checkpoint", "restore a.txt");
	assert.match(app.confirmations[1], /a\.txt を基準に戻す\?/);
	assert.doesNotMatch(app.confirmations[1], /消す\?|タスクの前からあった/);
});

test("/checkpoint new が基準を取れなかったら、前の基準と Pi の記録を残して知らせる", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	const saved = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try {
		await app.command("checkpoint", "new");
	} finally {
		process.env.PATH = saved;
	}
	assert.match(app.lastNotice(), /基準を取れなかった.*前の基準/s);
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt\s+Pi が書いたまま/);
});

test("名前の頭や末尾に空白があるファイルも、一覧に出た名前のまま diff と restore に渡せる", async () => {
	const dir = repo({ "a.txt": "a\n", " lead.txt": "lead\n", "trail.txt ": "trail\n" });
	const app = await start(dir);
	for (const name of ["a.txt", " lead.txt", "trail.txt "]) await app.piWrites(name, "pi\n");
	await app.command("checkpoint", "diff  lead.txt");
	assert.match(app.lastNotice(), /^-lead$/m);
	await app.command("checkpoint", "restore  lead.txt");
	assert.equal(readFileSync(join(dir, " lead.txt"), "utf8"), "lead\n");
	await app.command("checkpoint", "restore trail.txt ");
	assert.equal(readFileSync(join(dir, "trail.txt "), "utf8"), "trail\n");
	// 余分な空白を挟んだだけの入力は、今まで通り空白の無い名前として扱う。
	await app.command("checkpoint", "  restore   a.txt  ");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
});

test("リポジトリの設定に仕込まれた diff.external と textconv は走らせない", async () => {
	const dir = repo();
	const marks = mkdtempSync(join(base, "marks-"));
	git(dir, "config", "diff.external", trap(dir, ".git/external", join(marks, "external")));
	git(dir, "config", "diff.x.textconv", trap(dir, ".git/textconv", join(marks, "textconv")));
	writeFileSync(join(dir, ".gitattributes"), "*.txt diff=x\n");
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	await app.command("checkpoint", "diff");
	assert.match(app.lastNotice(), /^\+pi$/m);
	assert.deepEqual(readdirSync(marks), []);
});

test("確認を待つ間に symlink の指す先が変わったら、承認されていても戻さない", async () => {
	const dir = repo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
	symlinkSync("a.txt", join(dir, "link"));
	const app = await start(dir);
	rmSync(join(dir, "link"));
	symlinkSync("b.txt", join(dir, "link"));
	app.ctx.ui.confirm = async () => {
		rmSync(join(dir, "link"));
		symlinkSync("c.txt", join(dir, "link"));
		return true;
	};
	await app.command("checkpoint", "restore link");
	assert.equal(readlinkSync(join(dir, "link")), "c.txt");
	assert.match(app.lastNotice(), /確認の間に中身が変わった/);
});

test("Pi が書く直前の中身を基準と比べられなかったファイルは、確認に回す", async () => {
	const dir = repo();
	const app = await start(dir);
	const saved = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try {
		await app.emit("tool_call", { toolName: "write", toolCallId: "c", input: { path: "a.txt" } });
	} finally {
		process.env.PATH = saved;
	}
	writeFileSync(join(dir, "a.txt"), "pi\n");
	await app.emit("tool_result", { toolName: "write", toolCallId: "c", input: { path: "a.txt" }, isError: false });
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt\s+Pi と別の変更が混じっている/);
});

test("git を起動できないときは「作業ツリーの外」として黙らず、基準を取れなかったと知らせる", async () => {
	const dir = repo();
	const app = extensionHost();
	app.ctx.cwd = dir;
	checkpoint(app.pi);
	const saved = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try {
		await app.emit("session_start", { reason: "startup" });
		await app.emit("before_agent_start", { prompt: "do it" });
	} finally {
		process.env.PATH = saved;
	}
	assert.match(app.notices.at(-1) ?? "", /基準を取れなかった/);
});
