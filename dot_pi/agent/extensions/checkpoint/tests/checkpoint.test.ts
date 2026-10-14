import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import checkpoint, { hookGate, HOOKS_UNSTOPPABLE } from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "checkpoint-test-")));
after(() => rmSync(base, { recursive: true, force: true }));

// 設定に書いた hook を止められない版の git (2.54 / 2.55) では、checkpoint は基準を取らない。このホストの git がその版でも
// ほかの挙動を確かめられるよう、版の門を外しておく。外したまま走らせてよいのは、設定に書いた hook を仕込まないテストだけ。
// 設定に書いた hook を仕込むテストは gated() で門を戻し、実物の git の版のままで確かめる。
const gate = HOOKS_UNSTOPPABLE.splice(0);
async function gated(body: () => void | Promise<void>) {
	HOOKS_UNSTOPPABLE.push(...gate);
	try {
		await body();
	} finally {
		HOOKS_UNSTOPPABLE.splice(0);
	}
}
/** このホストの git の版 ("<major>.<minor>")。 */
const hostGit = execFileSync("git", ["--version"], { encoding: "utf8" }).match(/\d+\.\d+/)![0];
/** このホストの git が、設定に書いた hook を止められない版か。 */
const unstoppable = hostGit === "2.54" || hostGit === "2.55";

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
	assert.match(app.lastNotice(), /M\s+a\.txt\s+unchanged since Pi wrote it/);
	assert.match(app.lastNotice(), /M\s+b\.txt\s+Pi's changes mixed with other changes/);
	assert.match(app.lastNotice(), /M\s+c\.txt\s+changed by something other than Pi's write \/ edit/);
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
	assert.match(app.confirmations[0], /Pi's changes mixed with other changes/);
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
	assert.match(app.lastNotice(), /changed while waiting for confirmation/);
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
	assert.match(app.confirmations[0], /changed by something other than Pi's write \/ edit/);
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
		assert.match(app.lastNotice(), /is not a restore candidate/, path);
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
	assert.match(app.lastNotice(), /M\s+a\.txt\s+changed by something other than Pi's write \/ edit/);
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
	assert.match(reloaded.confirmations[0], /changed by something other than Pi's write \/ edit/);
});

test("/checkpoint new は今の状態を新しい基準にする", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.piWrites("a.txt", "first task\n");
	await app.command("checkpoint", "new");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /no files changed/);
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
	assert.match(app.notices.at(-1)!, /M\s+sub\/b\.txt\s+unchanged since Pi wrote it/);
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
	assert.match(app.lastNotice(), /no baseline/);
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\n");
});

/** 走ると mark を作る実行ファイル。 */
function trap(dir: string, name: string, mark: string) {
	mkdirSync(join(dir, name, ".."), { recursive: true });
	writeFileSync(join(dir, name), `#!/bin/sh\ntouch '${mark}'\n`);
	chmodSync(join(dir, name), 0o755);
	return join(dir, name);
}

/**
 * 基準を取り、Pi が a.txt を書き、一覧を見て戻すところまで進める。
 * refused は、版の門が断るはずのとき (門を戻して呼び、このホストの git が設定に書いた hook を止められない版)。
 * そのときは、基準を取らず、一覧も復元も断ることを確かめる。
 */
async function listAndRestore(dir: string, refused = false) {
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	if (refused) {
		for (const args of ["", "restore a.txt"]) {
			await app.command("checkpoint", args);
			assert.match(app.lastNotice(), /not taking a baseline.*need git 2\.56 or later/, args);
		}
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\n");
		return;
	}
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt/);
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
}

test("リポジトリの設定に仕込まれた hook と fsmonitor は走らせない", async () => {
	const dir = repo();
	const marks = mkdtempSync(join(base, "marks-"));
	trap(dir, ".git/hooks/post-index-change", join(marks, "hook"));
	git(dir, "config", "core.fsmonitor", trap(dir, ".git/fsmonitor", join(marks, "fsmonitor")));
	// 門は戻さない。この 2 つは版に依らない鍵 (core.hooksPath、core.fsmonitor) で止める。門を戻すと、2.54 / 2.55 のホストでは
	// git add も git restore も起きず、何も走らないのが鍵のおかげかどうかを見ないことになる。
	await listAndRestore(dir);
	assert.deepEqual(readdirSync(marks), []);
});

// 設定に書いた hook (hook.<名前>.event / command) は hooks ディレクトリを見ないので、core.hooksPath では止まらない。
for (const [name, config] of [
	[".git/config", (dir: string) => join(dir, ".git", "config")],
	// Linux の sandbox は、無い `.git/commondir` を新しく作ることを止められない (guard の README の「できないこと」)。
	[
		"commondir を向け直した先の config",
		(dir: string) => {
			execFileSync("cp", ["-r", join(dir, ".git"), join(dir, ".evil")]);
			writeFileSync(join(dir, ".git", "commondir"), `${join(dir, ".evil")}\n`);
			return join(dir, ".evil", "config");
		},
	],
] as const) {
	test(`リポジトリの設定 (${name}) に書かれた hook は、基準を取るときも戻すときも走らせない`, async () => {
		const dir = repo();
		const marks = mkdtempSync(join(base, "marks-"));
		const file = config(dir);
		for (const [hook, event] of [["x", "post-index-change"], ["y", "post-checkout"]]) {
			git(dir, "config", "-f", file, `hook.${hook}.event`, event);
			git(dir, "config", "-f", file, `hook.${hook}.command`, `touch '${join(marks, event)}'`);
			// 設定の側で有効と書かれていても、止めるほうが勝つ。
			git(dir, "config", "-f", file, `hook.${event}.enabled`, "true");
		}
		await gated(() => listAndRestore(dir, unstoppable));
		assert.deepEqual(readdirSync(marks), []);
	});
}

test("版の門が断るのは、設定に書いた hook を止める鍵を知らない git 2.54 / 2.55 と、版を読めないときだけ", () =>
	gated(() => {
		// 2.47 には設定に書いた hook という仕組みが無い。2.56 からは event ごとに止められる。
		for (const output of ["git version 2.47.3\n", "git version 2.56.0\n"]) assert.equal(hookGate(output), undefined, output);
		for (const [output, shown] of [
			["git version 2.54.0 (Apple Git-157)\n", /git 2\.54\.0 /],
			["git version 2.55.1\n", /git 2\.55\.1 /],
			["not a version\n", /cannot read the git version/],
		] as const) {
			assert.match(hookGate(output) ?? "", shown, output);
			assert.match(hookGate(output) ?? "", /need git 2\.56 or later/, output);
		}
	}));

test("設定に書いた hook を止められない版の git では基準を取らず、理由を status に出す。依頼のたびに warning は出さない", async () => {
	const dir = repo();
	writeFileSync(join(dir, "untracked.txt"), "would be added to .git/objects\n");
	const blob = git(dir, "hash-object", "untracked.txt").trim();
	const app = extensionHost();
	app.ctx.cwd = dir;
	checkpoint(app.pi);
	// このホストの git を、止められない版に数えさせる。
	HOOKS_UNSTOPPABLE.push(hostGit);
	try {
		await app.emit("session_start", { reason: "startup" });
		for (const prompt of ["do it", "again"]) await app.emit("before_agent_start", { prompt });
		assert.deepEqual(app.notices, []);
		assert.match(app.statuses.get("checkpoint") ?? "", /not taking a baseline.*need git 2\.56 or later/);
		// 人が打ったコマンドには、毎回理由を答える。
		for (const args of ["", "new", "diff", "restore untracked.txt"]) {
			await app.command("checkpoint", args);
			assert.match(app.notices.at(-1)!, /not taking a baseline.*need git 2\.56 or later/, args);
		}
		assert.throws(() => git(dir, "cat-file", "-e", blob), "基準を取る git add を起こしていない");
	} finally {
		HOOKS_UNSTOPPABLE.splice(0);
	}
	// 止められる版になれば、次の依頼で基準を取り、status を消す。
	await app.emit("before_agent_start", { prompt: "after an upgrade" });
	assert.equal(app.statuses.get("checkpoint"), undefined);
	await app.command("checkpoint");
	assert.match(app.notices.at(-1)!, /no files changed/);
});

test("基準があっても、git が設定に書いた hook を止められない版なら、一覧も復元もしない。セッションに残った基準も使わない", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.piWrites("a.txt", "pi\n");
	HOOKS_UNSTOPPABLE.push(hostGit);
	try {
		// セッションの途中で git が変わった。
		for (const args of ["", "diff", "restore a.txt"]) {
			await app.command("checkpoint", args);
			assert.match(app.lastNotice(), /not taking a baseline.*need git 2\.56 or later/, args);
		}
		// 門が入る前の checkpoint が残した基準を、再開で拾った。
		const resumed = extensionHost();
		resumed.ctx.cwd = dir;
		resumed.replaceSession(app.manager);
		checkpoint(resumed.pi);
		await resumed.emit("session_start", { reason: "resume" });
		assert.match(resumed.statuses.get("checkpoint") ?? "", /need git 2\.56 or later/);
		await resumed.emit("tool_call", { toolName: "write", toolCallId: "c", input: { path: "a.txt" } });
		await resumed.command("checkpoint", "restore a.txt");
		assert.match(resumed.notices.at(-1)!, /not taking a baseline/);
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\n");
	} finally {
		HOOKS_UNSTOPPABLE.splice(0);
	}
	// 止められる版に戻れば、同じ基準で続けられる。
	await app.command("checkpoint", "restore a.txt");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
});

// promisor remote を仕込んで object を 1 つ消すと、git は欠けた object を取りに行き、そのとき remote の設定がコマンドを起こす。
for (const [name, plant] of [
	["ext:: の transport", (dir: string, mark: string) => [["protocol.ext.allow", "always"], ["remote.origin.url", `ext::sh -c touch% ${mark}`]]],
	["core.sshCommand", (dir: string, mark: string) => [["core.sshCommand", `touch ${mark}; false`], ["remote.origin.url", "ssh://nowhere.invalid/repo"]]],
] as const) {
	test(`リポジトリの設定に仕込まれた promisor remote (${name}) があっても、欠けた object を取りに行かない`, async () => {
		const dir = repo();
		const mark = join(mkdtempSync(join(base, "marks-")), "fetched");
		const app = await start(dir);
		await app.piWrites("a.txt", "pi\n");
		const blob = git(dir, "rev-parse", "HEAD:a.txt").trim();
		for (const [key, value] of [...plant(dir, mark), ["remote.origin.promisor", "true"], ["extensions.partialClone", "origin"]]) git(dir, "config", key, value);
		rmSync(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
		// 基準の中身が欠けているので、差分は失敗してよい。
		for (const args of ["", "diff a.txt", "restore a.txt"]) await app.command("checkpoint", args).catch(() => {});
		assert.equal(existsSync(mark), false, "remote の設定からコマンドが起きていない");
		// 欠けたまま git restore を打つと、git は a.txt を消してから失敗する。
		assert.match(app.lastNotice(), /not restoring a\.txt because its baseline content cannot be read from git/);
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\n");
	});
}

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
	assert.match(app.lastNotice(), /filter "x=y"/);
	await app.command("checkpoint", "restore b.md");
	assert.equal(readFileSync(join(dir, "b.md"), "utf8"), "b\n");
	// 基準に無かったファイルは消すだけで、基準の中身を書き出さないので戻せる。
	await app.piWrites("new.txt", "pi\n");
	await app.command("checkpoint", "restore new.txt");
	assert.equal(existsSync(join(dir, "new.txt")), false);
	assert.deepEqual(readdirSync(marks), []);
});

/**
 * 利用者の設定 (scope の環境変数が指すファイル) に、絶対パスでない filter「x」(`git lfs install` が書く `git-lfs clean -- %f` の形) があり、
 * PATH の先頭に同じ名前の実行ファイルが置かれている、という状況で body を走らせる。置かれたものが走ると marks に印が付く。
 */
async function withPlantedFilter(scope: "GIT_CONFIG_GLOBAL" | "GIT_CONFIG_SYSTEM", body: (marks: string) => Promise<void>) {
	const marks = mkdtempSync(join(base, "marks-"));
	const bin = mkdtempSync(join(base, "bin-"));
	const config = join(mkdtempSync(join(base, "config-")), "gitconfig");
	writeFileSync(config, '[filter "x"]\n\tclean = planted-clean\n\tsmudge = planted-smudge\n\trequired = true\n');
	for (const key of ["clean", "smudge"]) trap(bin, `planted-${key}`, join(marks, key));
	const saved = { PATH: process.env.PATH, [scope]: process.env[scope] };
	process.env.PATH = `${bin}:${saved.PATH}`;
	process.env[scope] = config;
	try {
		await body(marks);
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

for (const scope of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] as const) {
	test(`利用者の設定 (${scope}) にある filter も走らせず、その filter が掛かるファイルは戻さない`, () =>
		withPlantedFilter(scope, async (marks) => {
			const dir = repo({ "a.txt": "a\n", "b.md": "b\n" });
			// どのファイルに掛けるかは、モデルの書ける .gitattributes が決める。
			writeFileSync(join(dir, ".gitattributes"), "*.txt filter=x\n");
			const app = await start(dir);
			assert.deepEqual(readdirSync(marks), [], "基準を取る git add で走っていない");
			await app.piWrites("a.txt", "pi\n");
			await app.piWrites("b.md", "pi\n");
			// filter を通さない、作業ツリーのままの中身で比べる。
			await app.command("checkpoint", "diff a.txt");
			assert.match(app.lastNotice(), /^-a$/m);
			assert.match(app.lastNotice(), /^\+pi$/m);
			app.approve(true);
			await app.command("checkpoint", "restore a.txt");
			assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "pi\n");
			assert.match(app.lastNotice(), /filter "x"/);
			await app.command("checkpoint", "restore b.md");
			assert.equal(readFileSync(join(dir, "b.md"), "utf8"), "b\n");
			assert.deepEqual(readdirSync(marks), []);
		}));
}

test("確認を待つ間に .gitattributes で利用者の設定の filter を掛けられても、戻す git は smudge を走らせない", () =>
	withPlantedFilter("GIT_CONFIG_GLOBAL", async (marks) => {
		const dir = repo();
		const app = await start(dir);
		writeFileSync(join(dir, "a.txt"), "someone\n");
		app.ctx.ui.confirm = async () => {
			writeFileSync(join(dir, ".gitattributes"), "*.txt filter=x\n");
			return true;
		};
		await app.command("checkpoint", "restore a.txt");
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
		assert.deepEqual(readdirSync(marks), []);
	}));

test("git が index に入れられないものが 1 つあっても、残りのファイルで基準を取る", async () => {
	const dir = repo();
	mkdirSync(join(dir, "nested"));
	git(join(dir, "nested"), "init", "-q");
	const app = await start(dir);
	assert.deepEqual(app.notices, []);
	await app.piWrites("a.txt", "pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt\s+unchanged since Pi wrote it/);
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
	assert.match(app.lastNotice(), /"d"/);

	await app.command("checkpoint", "restore e");
	assert.equal(readFileSync(join(dir, "e/ignored.log"), "utf8"), "not in the list\n");
	assert.match(app.lastNotice(), /"e"/);

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
	assert.match(app.lastNotice(), /M\s+b\.txt\s+unchanged since Pi wrote it/);
	assert.match(app.lastNotice(), /M\s+c\.txt\s+unchanged since Pi wrote it/);
	await app.command("checkpoint", "restore b.txt");
	assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "b\n");
	assert.equal(git(dir, "ls-files", "-v"), "H a.txt\nS b.txt\nh c.txt\n");
});

test("名前が .. で始まるファイルもリポジトリの中のファイルとして Pi の記録が付く", async () => {
	const dir = repo();
	const app = await start(dir);
	await app.piWrites("..foo", "pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /A\s+\.\.foo\s+unchanged since Pi wrote it/);
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
	assert.match(moved.notices.at(-1)!, /no files changed/);

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
	assert.match(app.lastNotice(), /M\s+a\.txt\s+changed by something other than Pi's write \/ edit/);
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
	assert.match(app.lastNotice(), /M\s+b\.txt\s+unchanged since Pi wrote it/);
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
	assert.match(lines[200], /\d+ more lines/);
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
	assert.match(app.lastNotice(), /M\s+after\.sh\s+Pi's changes mixed with other changes/);
	assert.match(app.lastNotice(), /M\s+before\.sh\s+Pi's changes mixed with other changes/);
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
	assert.match(app.lastNotice(), /no files changed/);
	await app.piWrites("dist/out.js", "pi\n");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+dist\/out\.js\s+unchanged since Pi wrote it/);
	await app.command("checkpoint", "restore dist/out.js");
	assert.equal(readFileSync(join(dir, "dist/out.js"), "utf8"), "built\n");
	assert.equal(git(dir, "ls-files", "-v"), "H .gitignore\nh a.txt\nS b.txt\nH dist/out.js\n");
	// 基準を取った後で印を付けても、そこにあるファイルを「消えた」とは言わない。
	git(dir, "update-index", "--skip-worktree", "dist/out.js");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /no files changed/);
});

test("基準に無いファイルを戻す確認は、ファイルが消えることと、タスク前からあったかもしれないことを伝える", async () => {
	const dir = repo({ "a.txt": "a\n", ".gitignore": "secret.env\n" });
	writeFileSync(join(dir, "secret.env"), "here before the task, ignored\n");
	const app = await start(dir);
	await app.piWrites(".gitignore", "");
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /A\s+secret\.env\s+changed by something other than Pi's write \/ edit/);
	app.approve(false);
	await app.command("checkpoint", "restore secret.env");
	assert.equal(app.confirmations.length, 1);
	assert.match(app.confirmations[0], /Delete secret\.env\?/);
	assert.match(app.confirmations[0], /existed before the task/);
	assert.equal(readFileSync(join(dir, "secret.env"), "utf8"), "here before the task, ignored\n");
	// 基準にあるファイルの確認は、消すとは言わない。
	writeFileSync(join(dir, "a.txt"), "a person\n");
	await app.command("checkpoint", "restore a.txt");
	assert.match(app.confirmations[1], /Restore a\.txt to the baseline\?/);
	assert.doesNotMatch(app.confirmations[1], /Delete|existed before the task/);
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
	assert.match(app.lastNotice(), /could not take a baseline.*previous baseline/s);
	await app.command("checkpoint");
	assert.match(app.lastNotice(), /M\s+a\.txt\s+unchanged since Pi wrote it/);
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
	assert.match(app.lastNotice(), /changed while waiting for confirmation/);
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
	assert.match(app.lastNotice(), /M\s+a\.txt\s+Pi's changes mixed with other changes/);
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
	assert.match(app.notices.at(-1) ?? "", /could not take a baseline/);
});

test("sandbox の中から書けない場所に git が無いことは、再開でも依頼のたびでも、1 セッションに 1 度だけ知らせる", async () => {
	const dir = repo();
	const earlier = await start(dir);
	/** guard が「書ける場所の外に git は無い」と答える Pi で、manager のセッションを始める。 */
	const withoutGit = async (manager?: typeof earlier.manager) => {
		const app = extensionHost();
		app.ctx.cwd = dir;
		if (manager) app.replaceSession(manager);
		app.pi.events.on("guard:binary", (data) => (data as { reply: (found?: string) => void }).reply(undefined));
		checkpoint(app.pi);
		await app.emit("session_start", { reason: manager ? "resume" : "startup" });
		return app;
	};
	const told = (app: { notices: string[] }) => app.notices.filter((notice) => /no git on the PATH entries the sandbox cannot write to/.test(notice)).length;

	// 基準の残ったセッションの再開では、残った基準を確かめるところで分かる。
	const resumed = await withoutGit(earlier.manager);
	assert.equal(told(resumed), 1);
	for (const prompt of ["do it", "again"]) await resumed.emit("before_agent_start", { prompt });
	assert.equal(resumed.notices.length, 1);
	// 人が打った /checkpoint new には、毎回答える。
	await resumed.command("checkpoint", "new");
	assert.equal(told(resumed), 2);

	// 新しいセッションでは、最初の依頼で分かる。
	const fresh = await withoutGit();
	assert.deepEqual(fresh.notices, []);
	for (const prompt of ["do it", "again"]) await fresh.emit("before_agent_start", { prompt });
	assert.equal(fresh.notices.length, 1);
	assert.equal(told(fresh), 1);
});
