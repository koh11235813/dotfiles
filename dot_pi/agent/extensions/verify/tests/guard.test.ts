import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import guard from "../../guard/index.ts";
import { SHARED_TMP_PATHS, sandboxAvailable } from "../../guard/sandbox.ts";
import verify from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

// guard と verify を 1 つの Pi に載せたときの繋がり。実物の sandbox が要る。
const cannotRun = process.platform === "linux" ? !sandboxAvailable() : process.platform !== "darwin";

// 本物の HOME・一時ディレクトリ・~/.pi/agent・利用者の git 設定を巻き込まない (guard と verify のテストと同じ理由)。
SHARED_TMP_PATHS.splice(0);
const base = realpathSync(mkdtempSync(join(tmpdir(), "verify-guard-")));
const dir = (...parts: string[]) => {
	const path = join(base, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
};
process.env.TMPDIR = dir("tmp");
process.env.HOME = dir("home");
process.env.PI_CODING_AGENT_DIR = join(base, "agent");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.PI_GUARD;
after(() => rmSync(base, { recursive: true, force: true }));

const boundary = { outcome: "completed", entries: [] as unknown[], continue: false };

test("PATHの要素がsandboxの中から書ける場所にあっても、そこに置かれたgitをsandboxの外で起こさない", async () => {
	const root = dir("path", "project");
	const outside = dir("path", "outside");
	// root の中の `.venv/bin` を有効にしたシェルから Pi を起動したホスト。root の中なので、sandbox の中から書ける。
	const bin = dir("path", "project", ".venv", "bin");
	writeFileSync(join(root, "a.txt"), "one\n");
	const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	execFileSync(realGit, ["init", "-q"], { cwd: root });
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	const app = extensionHost();
	guard(app.pi);
	verify(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start");
	try {
		await app.command("verify", "add true");
		// モデルの bash が sandbox の中から置いたものに見立てる。
		writeFileSync(join(bin, "git"), `#!/bin/sh\necho escaped > ${outside}/mark\nexec ${realGit} "$@"\n`, { mode: 0o755 });
		// 次のターンの始まり。人は何も打っていない。
		await app.emit("agent_start");
		assert.equal(existsSync(join(outside, "mark")), false, "置かれた git が sandbox の外で走った");
		assert.match(app.statuses.get("verify") ?? "", /^検証: 未実行/, "書ける場所の外にある本物の git でリポジトリを見つけている");
		await app.emit("agent_settled", { aborted: false });

		// 書ける場所の外に git が無ければ起こさない。名前で起こし直すと、飛ばした候補を拾う。
		process.env.PATH = bin;
		await app.command("verify");
		assert.equal(existsSync(join(outside, "mark")), false);
		assert.match(app.notices.at(-1)!, /git が見つからない/);
		assert.doesNotMatch(app.notices.at(-1)!, /リポジトリの外/);
	} finally {
		process.env.PATH = path;
		rmSync(join(bin, "git"), { force: true });
		await app.emit("session_shutdown", { reason: "quit" });
	}
});

test("readonlyでは、検証コマンドが落ちてもモデルへ差し戻さない。モデルは何も書けない", { skip: cannotRun }, async () => {
	const root = dir("readonly", "project");
	writeFileSync(join(root, "a.txt"), "one\n");
	execFileSync("git", ["init", "-q"], { cwd: root });
	const app = extensionHost();
	guard(app.pi);
	verify(app.pi);
	Object.assign(app.ctx.ui, { onTerminalInput: () => () => {} });
	Object.assign(app.ctx, { hasPendingMessages: () => false });
	app.ctx.cwd = root;
	await app.emit("session_start");
	try {
		// 書き込みを伴う検証コマンド (テストが成果物や一時ファイルを置く、など)。
		await app.command("verify", "add echo built > artifact.txt");
		await app.command("permissions", "readonly");
		await app.emit("agent_start");
		// readonly のモデルは書けない。変えたのは人か別のプロセス。
		writeFileSync(join(root, "a.txt"), "two\n");
		assert.equal(await app.emit("agent_before_settle", boundary), undefined, "直せる相手がいないので続行させない");
		assert.equal(existsSync(join(root, "artifact.txt")), false);
		assert.match(app.statuses.get("verify") ?? "", /^検証: 失敗 \(echo built > artifact\.txt: 終了コード 1。readonly .*モデルへは戻していない\)$/);
		await app.emit("agent_settled", { aborted: false });
		assert.match(app.notices.at(-1)!, /^検証: 失敗 .*readonly/);
	} finally {
		await app.emit("session_shutdown", { reason: "quit" });
	}
});

test("guardと一緒に読み込むと、検証コマンドはguardのsandboxの中でモードに従って走り、成功はmonitorの入口からverifiedとして届く", { skip: cannotRun }, async () => {
	const root = dir("project");
	const outside = dir("outside");
	writeFileSync(join(root, "a.txt"), "one\n");
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "pipe" });
	git("init", "-q");
	git("add", "-A");
	git("commit", "-q", "-m", "init");

	const app = extensionHost();
	guard(app.pi);
	verify(app.pi);
	Object.assign(app.ctx.ui, { onTerminalInput: () => () => {} });
	Object.assign(app.ctx, { hasPendingMessages: () => false });
	app.ctx.cwd = root;
	await app.emit("session_start");
	try {
		// モデルが書き換えられるのは、登録したコマンドが実行する中身。root の外へ書こうとするものに見立てる。
		await app.command("verify", `add echo ran > ${outside}/mark`);

		await app.emit("agent_start");
		writeFileSync(join(root, "a.txt"), "two\n");
		const failed = (await app.emit("agent_before_settle", boundary)) as { continue: boolean; entries: Array<{ content: string }> };
		assert.equal(existsSync(join(outside, "mark")), false, "normal では root の外に書けない");
		assert.equal(failed.continue, true);
		assert.match(failed.entries[0]!.content, /Read-only file system|Operation not permitted/);
		await app.emit("agent_settled", { aborted: false });
		assert.deepEqual(app.messages, [], "失敗は verified として流さない");

		await app.command("permissions", "full");
		await app.emit("agent_start");
		writeFileSync(join(root, "a.txt"), "three\n");
		assert.equal(await app.emit("agent_before_settle", boundary), undefined);
		assert.equal(existsSync(join(outside, "mark")), true, "full は sandbox なし");
		assert.equal(app.statuses.get("verify"), "検証: 成功");
		assert.deepEqual(app.messages, [], "知らせるのは最終結果が決まる agent_settled");
		await app.emit("agent_settled", { aborted: false });

		assert.equal(app.messages.length, 1);
		const { message, options } = app.messages[0]!;
		assert.equal(message.customType, "monitor-event");
		assert.match(message.content as string, new RegExp(`^\\[verified\\] verify: .*echo ran > ${outside}/mark\\n`));
		assert.equal((message.details as { kind: string }).kind, "verified");
		assert.deepEqual(options, { deliverAs: "nextTurn" }, "成功の知らせでターンは起こさない");

		// 変更の無いタスクは確かめ直さないので、同じ成功を 2 度は流さない。
		await app.emit("agent_start");
		await app.emit("agent_before_settle", boundary);
		await app.emit("agent_settled", { aborted: false });
		assert.equal(app.messages.length, 1);
	} finally {
		await app.emit("session_shutdown", { reason: "quit" });
	}
});
