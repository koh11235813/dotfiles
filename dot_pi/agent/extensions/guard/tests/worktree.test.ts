import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import guard from "../index.ts";
import { SHARED_TMP_PATHS, sandbox, sandboxAvailable } from "../sandbox.ts";
import { addWorktrees } from "../worktree.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

const cannotRun = process.platform === "linux" ? !sandboxAvailable() : process.platform !== "darwin";

// 本物の HOME と一時ディレクトリを root にしない (permissions.test.ts と同じ理由)。
SHARED_TMP_PATHS.splice(0);
const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-worktree-")));
const dir = (...parts: string[]) => {
	const path = join(base, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
};
process.env.TMPDIR = dir("tmp");
process.env.HOME = dir("home");
delete process.env.PI_GUARD;
sandbox.available = true;
const home = process.cwd();
after(() => {
	process.chdir(home);
	rmSync(base, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

/** コミットを 1 つ持つリポジトリ。sub/ に追跡ファイルがある。 */
function repo(name: string): string {
	const root = dir(name);
	git(root, "init", "-q", "-b", "main");
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "sub", "tracked.txt"), "base\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "base");
	return root;
}

async function session(root: string, mode: string) {
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start");
	await app.command("permissions", mode);
	app.tools.push({ name: "subagent" });
	return app;
}

const call = (input: Record<string, unknown>, toolCallId = "call-1") => ({ toolName: "subagent", toolCallId, input });
const result = (toolCallId = "call-1") => ({ toolName: "subagent", toolCallId, content: [{ type: "text", text: "child output" }], details: { results: [] } });
const reason = (value: unknown) => (value as { block?: boolean; reason?: string } | undefined)?.reason ?? "";

for (const mode of ["full", "normal"]) {
	test(`${mode}: worktreeを頼んだsubagentはタスクごとのworktreeをcwdにもらい、差分が結果に付き、統合も削除もされない`, { skip: mode !== "full" && cannotRun }, async () => {
		const root = repo(`isolated-${mode}`);
		const app = await session(root, mode);
		const head = git(root, "rev-parse", "HEAD");

		const input: Record<string, any> = { tasks: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }], worktree: true };
		assert.equal(await app.emit("tool_call", call(input)), undefined);
		assert.equal("worktree" in input, false);
		const [first, second] = input.tasks.map((task: { cwd: string }) => task.cwd);
		assert.notEqual(first, second);
		for (const cwd of [first, second]) {
			assert.match(cwd, new RegExp(`^${root}/\\.pi-worktrees/[0-9a-f]{8}$`));
			assert.equal(git(cwd, "rev-parse", "HEAD"), head);
			assert.match(git(cwd, "rev-parse", "--abbrev-ref", "HEAD"), /^pi-subagent\/[0-9a-f]{8}$/);
		}
		// worktree の置き場は元の作業ツリーの status を汚さない。
		assert.equal(git(root, "status", "--porcelain"), "");

		// 子がしたこと: 1 つ目は commit と未追跡ファイル、2 つ目は何もしない。
		writeFileSync(join(first, "sub", "tracked.txt"), "changed\n");
		git(first, "commit", "-q", "-am", "child commit");
		writeFileSync(join(first, "new.txt"), "new\n");
		const reported = (await app.emit("tool_result", result())) as { content: Array<{ text: string }> };
		assert.equal(reported.content[0].text, "child output");
		const text = reported.content.slice(1).map((part) => part.text).join("\n");
		assert.ok(text.includes(`guard[worktree]: worker ran in ${first} `), text);
		assert.ok(text.includes(`guard[worktree]: worker ran in ${second} `), text);
		assert.match(text, /\?\? new\.txt/);
		assert.match(text, /child commit/);
		assert.match(text, /sub\/tracked\.txt \| 2 \+-/);
		assert.match(text, /No changes\./);
		assert.match(text, /Nothing was merged/);
		// 元の作業ツリーは変わらず、worktree は残る。
		assert.equal(git(root, "rev-parse", "HEAD"), head);
		assert.equal(git(root, "status", "--porcelain"), "");
		assert.ok(existsSync(join(first, "new.txt")) && existsSync(second));

		// 親の sandbox からも、worktree の向き先 (.git ファイル) は書き換えられない。
		if (mode === "normal") {
			const pointer = readFileSync(join(first, ".git"), "utf8");
			await app.registeredTools.get("bash")!.execute("call-3", { command: `echo 'gitdir: /tmp/elsewhere' > ${first}/.git` }, undefined, undefined, app.ctx).catch(() => {});
			assert.equal(readFileSync(join(first, ".git"), "utf8"), pointer);
			app.approve(false);
			assert.match(reason(await app.emit("tool_call", { toolName: "write", toolCallId: "call-4", input: { path: join(first, ".git"), content: "x" } })), /guard\[git-locked\]/);
		}

		// worktree を頼んでいない呼び出しには何もしない。
		const plain = { agent: "worker", task: "c" };
		assert.equal(await app.emit("tool_call", call(plain, "call-2")), undefined);
		assert.deepEqual(plain, { agent: "worker", task: "c" });
		assert.equal(await app.emit("tool_result", result("call-2")), undefined);
		assert.equal(readdirSync(join(root, ".pi-worktrees")).filter((name) => name !== ".gitignore").length, 2);
	});
}

test("worktreeのためのgitはsandboxの中で走り、リポジトリのhookは書ける場所の外に書けない", { skip: cannotRun }, async () => {
	// `git worktree add` は post-checkout を走らせる。full (sandbox なし) では同じ hook が外に書けることも見て、hook が走っていることを確かめる。
	for (const mode of ["full", "normal"]) {
		const root = repo(`hook-${mode}`);
		const escaped = join(process.env.HOME!, `escaped-${mode}`);
		writeFileSync(join(root, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch hook-ran\ntouch ${escaped} 2>/dev/null\nexit 0\n`, { mode: 0o755 });
		const app = await session(root, mode);
		const input: Record<string, any> = { agent: "worker", task: "a", worktree: true };
		assert.equal(await app.emit("tool_call", call(input)), undefined);
		assert.ok(existsSync(join(input.cwd, "hook-ran")), mode);
		assert.equal(existsSync(escaped), mode === "full", mode);
	}
});

test("結果が来ないまま終わった呼び出しのworktreeは、同じidの後の結果に付けない", async () => {
	const root = repo("ended");
	const app = await session(root, "full");
	assert.equal(await app.emit("tool_call", call({ agent: "worker", task: "a", worktree: true })), undefined);
	// 実行されなかった呼び出し (後ろの拡張が遮断した、実行の前に中断された) には tool_result が来ない。
	await app.emit("tool_execution_end", { toolName: "subagent", toolCallId: "call-1" });
	assert.equal(await app.emit("tool_result", result()), undefined);
});

test("単発は1つ、chainは全段で1つのworktreeを使い、cwdはリポジトリの中の同じ位置になる", async () => {
	const root = repo("shapes");
	const app = await session(join(root, "sub"), "full");
	const single: Record<string, any> = { agent: "worker", task: "a", worktree: true };
	assert.equal(await app.emit("tool_call", call(single)), undefined);
	assert.match(single.cwd, new RegExp(`^${root}/sub/\\.pi-worktrees/[0-9a-f]{8}/sub$`));
	assert.ok(existsSync(join(single.cwd, "tracked.txt")));

	const chain: Record<string, any> = { chain: [{ agent: "scout", task: "a" }, { agent: "worker", task: "{previous}" }], worktree: true };
	assert.equal(await app.emit("tool_call", call(chain, "call-2")), undefined);
	assert.equal(chain.chain[0].cwd, chain.chain[1].cwd);
	assert.notEqual(chain.chain[0].cwd, single.cwd);
});

test("worktreeを作れないときは子を起こさずに理由を返す", async () => {
	const plain = dir("not-a-repo");
	const app = await session(plain, "full");
	assert.match(reason(await app.emit("tool_call", call({ agent: "worker", task: "a", worktree: true }))), /guard\[worktree\]: .*not a git repository[\s\S]*No subagent was started/i);
	assert.equal(existsSync(join(plain, ".pi-worktrees")), false);

	const root = repo("refused");
	const other = await session(root, "full");
	assert.match(reason(await other.emit("tool_call", call({ agent: "worker", task: "a", cwd: "/tmp", worktree: true }))), /guard\[worktree\]: .*cwd/);
	assert.match(reason(await other.emit("tool_call", call({ tasks: [{ agent: "worker", task: "a", cwd: "sub" }], worktree: true }))), /guard\[worktree\]: .*cwd/);
	assert.equal(existsSync(join(root, ".pi-worktrees")), false);

	// 公式 sample が断る形 (単発・並列・chain のちょうど 1 つでない) には作らない。子は起きないので、worktree だけが残ることになる。
	const step = { agent: "worker", task: "a" };
	for (const input of [{}, { agent: "worker" }, { task: "a" }, { tasks: [], chain: [] }, { chain: [step], tasks: [step] }, { ...step, tasks: [step] }]) {
		assert.match(reason(await other.emit("tool_call", call({ ...input, worktree: true }))), /guard\[worktree\]: .*exactly one[\s\S]*No subagent was started/, JSON.stringify(input));
	}
	assert.equal(existsSync(join(root, ".pi-worktrees")), false);

	// 確認で断られた呼び出しも、sandbox が無いときも作らない。
	await other.command("permissions", "ask");
	other.approve(false);
	assert.match(reason(await other.emit("tool_call", call({ agent: "worker", task: "a", worktree: true }))), /guard\[ask\]/);
	other.approve(true);
	sandbox.available = false;
	try {
		assert.match(reason(await other.emit("tool_call", call({ agent: "worker", task: "a", worktree: true }))), /guard\[sandbox\]/);
	} finally {
		sandbox.available = true;
	}
	assert.equal(existsSync(join(root, ".pi-worktrees")), false);
});

test("並列の途中でworktreeを作れなくなったら、先に作って残した分を理由に書く", async () => {
	const added: string[] = [];
	const run = async (script: string, args: string[]) => {
		if (script.includes("rev-parse")) return "abc123\n\n";
		if (added.length === 1) throw new Error("fatal: could not create it");
		added.push(args[3]);
		return "";
	};
	const step = { agent: "worker", task: "a" };
	await assert.rejects(addWorktrees(run, "/repo", { tasks: [{ ...step }, { ...step }, { ...step }], worktree: true }), (error: Error) => {
		assert.equal(added.length, 1);
		assert.match(added[0], /^\/repo\/\.pi-worktrees\/[0-9a-f]{8}$/);
		assert.equal(error.message, `fatal: could not create it Already created by this call and kept: ${added[0]}.`);
		return true;
	});
	// 1 つ目で失敗したら、残したものは無い。
	await assert.rejects(addWorktrees(run, "/repo", { ...step, worktree: true }), (error: Error) => error.message === "fatal: could not create it");
});

test("worktreeに絞られた子は、自分のworktreeの外をcwdにしたsubagentを起こせない", async () => {
	const root = repo("delegating");
	mkdirSync(join(root, ".pi-worktrees"));
	const [worktree, sibling] = ["abcd1234", "ef567890"].map((id) => {
		git(root, "worktree", "add", "-q", "-b", `pi-subagent/${id}`, join(root, ".pi-worktrees", id), "HEAD");
		return join(root, ".pi-worktrees", id);
	});
	process.env.PI_GUARD = JSON.stringify({ mode: "normal", root, git: join(root, ".git"), pid: process.pid + 1 });
	try {
		const child = (cwd: string) => {
			process.chdir(cwd);
			const app = extensionHost();
			app.ctx.hasUI = false;
			guard(app.pi);
			app.ctx.cwd = cwd;
			return app;
		};
		const narrowed = child(join(worktree, "sub"));
		const step = { agent: "worker", task: "a" };
		// 孫は PI_GUARD の root (親の root) を継ぐので、worktree の外で起こされると親の root に書ける。
		for (const input of [
			{ ...step, cwd: root },
			{ ...step, cwd: sibling },
			{ ...step, cwd: "../.." },
			{ ...step, cwd: join(root, ".pi-worktrees") },
			{ tasks: [step, { ...step, cwd: join(root, "sub") }] },
			{ chain: [{ ...step, cwd: "/" }] },
		]) {
			assert.match(reason(await narrowed.emit("tool_call", call(input))), /guard\[worktree\]: .*outside this session's worktree[\s\S]*No subagent was started/, JSON.stringify(input));
		}
		// 自分の worktree の中と、cwd を省いた呼び出し (子の cwd で起きる) は通る。
		for (const input of [step, { ...step, cwd: worktree }, { ...step, cwd: "." }, { tasks: [{ ...step, cwd: join(worktree, "sub") }] }]) {
			assert.equal(await narrowed.emit("tool_call", call(input)), undefined, JSON.stringify(input));
		}
		// 絞られていない子は、今までどおりどの cwd でも起こせる (孫も親の root を継ぐだけ)。
		assert.equal(await child(join(root, "sub")).emit("tool_call", call({ ...step, cwd: sibling })), undefined);
	} finally {
		process.chdir(home);
		delete process.env.PI_GUARD;
	}
});

test("worktreeの中で起こされた子は、書ける場所を親のrootではなく自分のworktreeに絞る", async () => {
	const root = repo("narrowed");
	const worktree = join(root, ".pi-worktrees", "abcd1234");
	mkdirSync(join(root, ".pi-worktrees"));
	git(root, "worktree", "add", "-q", "-b", "pi-subagent/abcd1234", worktree, "HEAD");
	process.env.PI_GUARD = JSON.stringify({ mode: "normal", root, git: join(root, ".git"), pid: process.pid + 1 });
	try {
		const child = async (cwd: string) => {
			process.chdir(cwd);
			const app = extensionHost();
			app.ctx.hasUI = false;
			guard(app.pi);
			app.ctx.cwd = cwd;
			await app.emit("session_start");
			await app.command("permissions");
			return app;
		};
		const inside = await child(join(worktree, "sub"));
		assert.match(inside.notices.at(-1)!, new RegExp(`Write root: ${worktree}\\n`));
		assert.equal(await inside.emit("tool_call", { toolName: "write", toolCallId: "w1", input: { path: join(worktree, "sub", "x.txt"), content: "x" } }), undefined);
		for (const path of [join(root, "sub", "tracked.txt"), join(root, ".pi-worktrees", "other", "x.txt"), join(worktree, ".git")]) {
			assert.match(reason(await inside.emit("tool_call", { toolName: "write", toolCallId: "w2", input: { path, content: "x" } })), /guard\[(outside-write-roots|git-locked)\]/, path);
		}
		// worktree の外で起こされた子は今までどおり親の root を継ぐ。置き場そのものは worktree ではない。
		for (const cwd of [join(root, "sub"), join(root, ".pi-worktrees")]) {
			const outside = await child(cwd);
			assert.match(outside.notices.at(-1)!, new RegExp(`Write root: ${root}\\n`), cwd);
		}
	} finally {
		process.chdir(home);
		delete process.env.PI_GUARD;
	}
});

test("worktreeに絞られた子も、親のrootの中に置かれた道具をsandboxの外で起こさない", async () => {
	const root = repo("planted");
	const worktree = join(root, ".pi-worktrees", "abcd1234");
	mkdirSync(join(root, ".pi-worktrees"));
	git(root, "worktree", "add", "-q", "-b", "pi-subagent/abcd1234", worktree, "HEAD");
	// 親のモデルは親の root に書ける。子の書ける場所 (自分の worktree) の外でも、sandbox の中から置ける場所。
	const planted = join(root, ".venv", "bin");
	const ran = join(base, "planted-ran");
	mkdirSync(planted, { recursive: true });
	writeFileSync(join(planted, "chezmoi"), `#!/bin/sh\ntouch ${ran}\n`, { mode: 0o755 });
	const path = process.env.PATH;
	process.env.PI_GUARD = JSON.stringify({ mode: "normal", root, git: join(root, ".git"), pid: process.pid + 1 });
	process.env.PATH = planted;
	process.chdir(worktree);
	try {
		const app = extensionHost();
		app.ctx.hasUI = false;
		guard(app.pi);
		app.ctx.cwd = worktree;
		await app.emit("session_start");
		let answer: string | undefined | null = null;
		app.pi.events.emit("guard:binary", { name: "chezmoi", reply: (given?: string) => (answer = given) });
		assert.equal(answer, undefined);
		assert.equal(await app.emit("tool_call", { toolName: "write", toolCallId: "w1", input: { path: join(worktree, "sub", "x.txt"), content: "x" } }), undefined);
		assert.equal(existsSync(ran), false);
	} finally {
		process.env.PATH = path;
		process.chdir(home);
		delete process.env.PI_GUARD;
	}
});

test("worktreeの中の子がさらにworktreeで起こした孫は、いちばん内側のworktreeに絞られ、孫どうしは分かれる", async () => {
	const root = repo("grandchildren");
	const outer = join(root, ".pi-worktrees", "aaaa1111");
	mkdirSync(join(root, ".pi-worktrees"));
	git(root, "worktree", "add", "-q", "-b", "pi-subagent/aaaa1111", outer, "HEAD");
	mkdirSync(join(outer, ".pi-worktrees"));
	const [inner, sibling] = ["bbbb2222", "cccc3333"].map((id) => {
		git(outer, "worktree", "add", "-q", "-b", `pi-subagent/${id}`, join(outer, ".pi-worktrees", id), "HEAD");
		return join(outer, ".pi-worktrees", id);
	});
	// 孫も PI_GUARD の root (いちばん上の親の root) を継ぐ。
	process.env.PI_GUARD = JSON.stringify({ mode: "normal", root, git: join(root, ".git"), pid: process.pid + 1 });
	try {
		const child = async (cwd: string) => {
			process.chdir(cwd);
			const app = extensionHost();
			app.ctx.hasUI = false;
			guard(app.pi);
			app.ctx.cwd = cwd;
			await app.emit("session_start");
			await app.command("permissions");
			return app;
		};
		const write = (app: Awaited<ReturnType<typeof child>>, path: string) => app.emit("tool_call", { toolName: "write", toolCallId: "w", input: { path, content: "x" } });
		const grandchild = await child(join(inner, "sub"));
		assert.match(grandchild.notices.at(-1)!, new RegExp(`Write root: ${inner}\\n`));
		assert.equal(await write(grandchild, join(inner, "sub", "x.txt")), undefined);
		for (const path of [join(sibling, "x.txt"), join(outer, "sub", "x.txt"), join(root, "sub", "x.txt")]) {
			assert.match(reason(await write(grandchild, path)), /guard\[outside-write-roots\]/, path);
		}
		// 外側の worktree に絞られた子は、自分の中の worktree を cwd にした孫を起こせる (孫はそこに絞られる)。外は今までどおり起こせない。
		const narrowed = await child(join(outer, "sub"));
		assert.match(narrowed.notices.at(-1)!, new RegExp(`Write root: ${outer}\\n`));
		const step = { agent: "worker", task: "a" };
		assert.equal(await narrowed.emit("tool_call", call({ ...step, cwd: inner })), undefined);
		assert.match(reason(await narrowed.emit("tool_call", call({ ...step, cwd: root }))), /outside this session's worktree/);
		// 孫は、隣の孫と外側の worktree を cwd にしたひ孫を起こせない。
		for (const cwd of [sibling, outer]) assert.match(reason(await grandchild.emit("tool_call", call({ ...step, cwd }))), /outside this session's worktree/, cwd);
	} finally {
		process.chdir(home);
		delete process.env.PI_GUARD;
	}
});

test("worktreeに絞られた子のbashは、worktreeの中でcommitでき、親の作業ツリーとworktreeの向き先は書けない", { skip: cannotRun }, async () => {
	const root = repo("narrowed-bash");
	const worktree = join(root, ".pi-worktrees", "abcd1234");
	mkdirSync(join(root, ".pi-worktrees"));
	git(root, "worktree", "add", "-q", "-b", "pi-subagent/abcd1234", worktree, "HEAD");
	process.env.PI_GUARD = JSON.stringify({ mode: "normal", root, git: join(root, ".git"), pid: process.pid + 1 });
	process.chdir(worktree);
	try {
		const app = extensionHost();
		app.ctx.hasUI = false;
		guard(app.pi);
		app.ctx.cwd = worktree;
		await app.emit("session_start");
		const bash = app.registeredTools.get("bash")!;
		const run = async (command: string): Promise<string> => (await bash.execute("call-1", { command }, undefined, undefined, app.ctx).catch((error: Error) => ({ content: [{ text: error.message }] }))).content[0].text;
		await run("echo child > made.txt && git add -A && git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -q -m 'from the child'");
		assert.equal(git(worktree, "log", "--format=%s", "-1"), "from the child");
		await run(`echo x > ${root}/escaped.txt; echo 'gitdir: /tmp/elsewhere' > ${worktree}/.git`);
		assert.equal(existsSync(join(root, "escaped.txt")), false);
		assert.equal(git(worktree, "log", "--format=%s", "-1"), "from the child");
	} finally {
		process.chdir(home);
		delete process.env.PI_GUARD;
	}
});

// 子は自分の worktree の中に、その上で走る git が実行する設定を用意できる。親が結果に付ける差分のための git が
// 親の書ける場所つきで走ると、子の用意したスクリプトが親の作業ツリーと隣の worktree に書く。
for (const [name, plant] of [
	// common dir の写しに fsmonitor を仕込み、自分の worktree の commondir をそこへ向ける。
	[
		"commondirの向け直し",
		(root: string, worktree: string) => [
			`cp -r ${root}/.git/. evil/`,
			`git config -f evil/config core.fsmonitor ${worktree}/fsm.sh`,
			`echo ${worktree}/evil > ${join(root, ".git", "worktrees", basename(worktree))}/commondir`,
		],
	],
	// 入れ子のリポジトリの config に fsmonitor を仕込み、index に載せる。git status は載っているリポジトリの中でも git を起こす。
	[
		"入れ子のリポジトリ",
		(_root: string, worktree: string) => [
			"git init -q nested",
			"git -C nested -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -q --allow-empty -m nested",
			`git -C nested config core.fsmonitor ${worktree}/fsm.sh`,
			"git add nested",
		],
	],
] as const) {
	test(`親が差分を取るgitは、子がworktreeに仕込んだ設定 (${name}) を実行しても、親の作業ツリーにも隣のworktreeにも書けない`, { skip: cannotRun }, async () => {
		const root = repo(`planted-${name}`);
		const app = await session(root, "normal");
		const input: Record<string, any> = { tasks: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }], worktree: true };
		assert.equal(await app.emit("tool_call", call(input)), undefined);
		const [worktree, sibling] = input.tasks.map((task: { cwd: string }) => task.cwd);

		process.env.PI_GUARD = JSON.stringify({ mode: "normal", root, git: join(root, ".git"), pid: process.pid + 1 });
		process.chdir(worktree);
		try {
			const child = extensionHost();
			child.ctx.hasUI = false;
			guard(child.pi);
			child.ctx.cwd = worktree;
			await child.emit("session_start");
			const script = `printf '#!/bin/sh\\ntouch ${worktree}/ran.txt ${root}/via-report.txt ${sibling}/via-report.txt\\n' > fsm.sh && chmod +x fsm.sh`;
			await child.registeredTools.get("bash")!.execute("call-1", { command: [script, ...plant(root, worktree)].join("\n") }, undefined, undefined, child.ctx);
		} finally {
			process.chdir(home);
			delete process.env.PI_GUARD;
		}
		// 仕込みが効いていることを、書ける場所つきの git で先に確かめる (効いていなければ、下の検証は何も見ていない)。
		rmSync(join(worktree, "ran.txt"), { force: true });
		git(worktree, "status", "--porcelain");
		assert.equal(existsSync(join(worktree, "ran.txt")), true, "仕込んだスクリプトは git status で走る");
		for (const made of [join(worktree, "ran.txt"), join(root, "via-report.txt"), join(sibling, "via-report.txt")]) rmSync(made, { force: true });

		const patched = (await app.emit("tool_result", result())) as { content: Array<{ text: string }> };
		assert.match(patched.content.at(-1)!.text, /guard\[worktree\]: worker ran in/);
		// 書けない sandbox でも要約は取れている (git が起動に失敗して、何も走らなかっただけではない)。
		assert.doesNotMatch(patched.content.at(-1)!.text, /Could not inspect it/);
		assert.match(patched.content.at(-1)!.text, /fsm\.sh/);
		assert.equal(existsSync(join(root, "via-report.txt")), false, "親の作業ツリーに書かれていない");
		assert.equal(existsSync(join(sibling, "via-report.txt")), false, "隣の worktree に書かれていない");
		assert.equal(existsSync(join(worktree, "ran.txt")), false, "見ている worktree にも書かせない");
	});
}
