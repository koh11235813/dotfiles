import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import guard from "../../guard/index.ts";
import type { JobSummary } from "../../guard/monitor/jobs.ts";
import { SHARED_TMP_PATHS, sandbox } from "../../guard/sandbox.ts";
import checkpoint, { HOOKS_UNSTOPPABLE } from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

// guard (monitor) と checkpoint を 1 つの Pi に載せたときの繋がり。job は full で走らせるので、実物の sandbox は要らない。
// 本物の HOME と一時ディレクトリを巻き込まない (guard のテストと同じ理由)。job のログもこの下に出る。
SHARED_TMP_PATHS.splice(0);
// このホストの git が設定に書いた hook を止められない版 (2.54 / 2.55) でも基準を取れるよう、版の門を外す。ここのテストは hook を仕込まない。
HOOKS_UNSTOPPABLE.splice(0);
const base = realpathSync(mkdtempSync(join(tmpdir(), "checkpoint-monitor-")));
const dir = (...parts: string[]) => {
	const path = join(base, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
};
process.env.TMPDIR = dir("tmp");
process.env.HOME = dir("home");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.PI_GUARD;
sandbox.available = true;
after(() => rmSync(base, { recursive: true, force: true }));

test("monitorのjobが走っている間は戻さず、止めるか終わるのを待つよう伝える。jobが居なくなれば戻せる", async () => {
	const root = dir("project");
	writeFileSync(join(root, "a.txt"), "a\n");
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "pipe" });
	git("init", "-q");
	git("add", "-A");
	git("commit", "-q", "-m", "init");

	const app = extensionHost();
	guard(app.pi);
	checkpoint(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start", { reason: "startup" });
	try {
		await app.command("permissions", "full");
		await app.emit("before_agent_start", { prompt: "do it" });
		await app.emit("tool_call", { toolName: "write", toolCallId: "c", input: { path: "a.txt" } });
		writeFileSync(join(root, "a.txt"), "pi\n");
		await app.emit("tool_result", { toolName: "write", toolCallId: "c", input: { path: "a.txt" }, isError: false });

		const job = (await app.registeredTools.get("monitor")!.execute("call-1", { command: "sleep 30" }, undefined, undefined, app.ctx)).details as JobSummary;
		await app.command("checkpoint", "restore a.txt");
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "pi\n", "job が書いている最中かもしれない間は戻さない");
		assert.match(app.notices.at(-1)!, new RegExp(`job.*${job.id}`));
		assert.match(app.notices.at(-1)!, /\/jobs stop/);
		// /jobs stop が効かない job (シグナルの届かないもの) は running のまま残る。そのときの出口も伝える。
		assert.match(app.notices.at(-1)!, /stays running after being stopped.*restart Pi/);
		// 一覧と差分は読むだけなので、job が走っていても見せる。
		await app.command("checkpoint");
		assert.match(app.notices.at(-1)!, /M\s+a\.txt/);

		await app.command("jobs", `stop ${job.id}`);
		await app.command("checkpoint", "restore a.txt");
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n", "終わった job は妨げない");
	} finally {
		await app.emit("session_shutdown", { reason: "quit" });
	}
});

test("確認を待つ間にPiが動き出したりjobが起きたりしたら、承認されていても戻さない", async () => {
	const root = dir("project-confirm");
	writeFileSync(join(root, "a.txt"), "a\n");
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "pipe" });
	git("init", "-q");
	git("add", "-A");
	git("commit", "-q", "-m", "init");

	const app = extensionHost();
	guard(app.pi);
	checkpoint(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start", { reason: "startup" });
	try {
		await app.command("permissions", "full");
		await app.emit("before_agent_start", { prompt: "do it" });
		// Pi の write / edit の記録が無い変更は、戻す前に確認が出る。
		writeFileSync(join(root, "a.txt"), "shell\n");
		/** 確認ダイアログが開いている間に起きること。monitor は idle のときに知らせでターンを起こすので、人が答える前に Pi は動き出せる。 */
		let meanwhile = async () => {};
		Object.assign(app.ctx.ui, { confirm: async () => (await meanwhile(), true) });

		let job: JobSummary | undefined;
		meanwhile = async () => {
			job = (await app.registeredTools.get("monitor")!.execute("call-1", { command: "sleep 30" }, undefined, undefined, app.ctx)).details as JobSummary;
		};
		await app.command("checkpoint", "restore a.txt");
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "shell\n", "まだ書いていない job が、戻した後で書き換えうる");
		assert.match(app.notices.at(-1)!, new RegExp(`job.*${job!.id}`));
		await app.command("jobs", `stop ${job!.id}`);

		meanwhile = async () => app.idle(false);
		await app.command("checkpoint", "restore a.txt");
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "shell\n");
		assert.match(app.notices.at(-1)!, /not restoring while Pi is running/);

		meanwhile = async () => {};
		app.idle(true);
		await app.command("checkpoint", "restore a.txt");
		assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n", "何も起きなければ、承認で戻る");
	} finally {
		await app.emit("session_shutdown", { reason: "quit" });
	}
});

test("PATHの要素がsandboxの中から書ける場所にあっても、そこに置かれたgitをsandboxの外で起こさない", async () => {
	const root = dir("project-path");
	const outside = dir("outside-path");
	// root の中の venv を有効にしたシェルから Pi を起動した、という状況。
	const venv = dir("project-path", ".venv", "bin");
	writeFileSync(join(root, "a.txt"), "a\n");
	writeFileSync(join(root, ".gitignore"), ".venv\n");
	const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	execFileSync(realGit, ["init", "-q"], { cwd: root });
	const path = process.env.PATH;
	process.env.PATH = `${venv}:${path}`;
	const app = extensionHost();
	guard(app.pi);
	checkpoint(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start", { reason: "startup" });
	try {
		// モデルの bash が sandbox の中から置いたものに見立てる。
		writeFileSync(join(venv, "git"), `#!/bin/sh\necho escaped > ${outside}/mark\nexec ${realGit} "$@"\n`, { mode: 0o755 });
		// 次の依頼で基準を取る。人は git を打っていない。
		await app.emit("before_agent_start", { prompt: "do it" });
		// 同じターンの中の write でも、基準の中身を git に訊く。
		writeFileSync(join(root, "a.txt"), "someone\n");
		await app.emit("tool_call", { toolName: "write", toolCallId: "c", input: { path: "a.txt" } });
		await app.command("checkpoint");
		assert.equal(existsSync(join(outside, "mark")), false, "置かれた git が sandbox の外で走った");
		assert.match(app.notices.at(-1)!, /M\s+a\.txt/, "書ける場所の外にある本物の git で基準を取っている");

		// 書ける場所の外に git が無ければ起こさない。名前で起こし直すと、飛ばした候補を拾う。
		process.env.PATH = venv;
		await app.command("checkpoint", "new");
		assert.equal(existsSync(join(outside, "mark")), false);
		assert.match(app.notices.at(-1)!, /could not take a baseline.*Keeping the previous baseline/);
	} finally {
		process.env.PATH = path;
		await app.emit("session_shutdown", { reason: "quit" });
	}
});
