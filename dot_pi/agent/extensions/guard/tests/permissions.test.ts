import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import guard, { targetPath } from "../index.ts";
import { GUARD_LOADED, PERMISSIONS_ENTRY } from "../permissions.ts";
import { SHARED_TMP_PATHS, sandbox } from "../sandbox.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

// SDK の場所。loader は HOME から release を探すので、下で HOME を差し替える前に解決しておく。
const SDK = import.meta.resolve("@earendil-works/pi-coding-agent");

// 本物の HOME と一時ディレクトリを root にしない。os.tmpdir() の下に作った「外」が外でなくなる。
// 表の /tmp と /var/tmp も同じ理由で外す (Linux では os.tmpdir() が /tmp)。
SHARED_TMP_PATHS.splice(0);
const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-permissions-")));
const dir = (...parts: string[]) => {
	const path = join(base, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
};
process.env.TMPDIR = dir("tmp");
process.env.HOME = dir("home");
after(() => rmSync(base, { recursive: true, force: true }));
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

test("sandboxが使えなければfull以外のbash・edit・writeは遮断し、sandboxなしの実行に落とさない", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	app.approve(true);
	sandbox.available = false;
	try {
		for (const mode of ["normal", "ask", "readonly"]) {
			await app.command("permissions", mode);
			for (const attempt of [call("bash", { command: "pwd" }), call("write", { path: "file.txt" }), call("edit", { path: "file.txt" })]) {
				const result = await app.emit("tool_call", attempt) as { block: boolean; reason: string };
				assert.equal(result?.block, true, `${mode}: ${attempt.toolName}`);
				assert.match(result.reason, new RegExp(`guard\\[sandbox\\].*${attempt.toolName} is disabled.*bubblewrap.*/permissions full`));
			}
		}
		assert.equal(app.confirmations.length, 0);
		await app.command("permissions");
		assert.match(app.notices.at(-1)!, /UNAVAILABLE/);
		await app.command("permissions", "full");
		assert.equal(await app.emit("tool_call", call("bash", { command: "pwd" })), undefined);
		assert.equal(await app.emit("tool_call", call("write", { path: "file.txt" })), undefined);
	} finally {
		sandbox.available = true;
	}
});

test("ほかの拡張から頼まれたコマンドの準備も、sandboxが使えなければfull以外では断る", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	const prepare = (command: string) => {
		let answer: { command?: string; error?: string } | undefined;
		app.pi.events.emit("guard:bash", { command, cwd: app.ctx.cwd, env: process.env, reply: (given: typeof answer) => (answer = given) });
		return answer;
	};
	sandbox.available = false;
	try {
		for (const mode of ["normal", "ask", "readonly"]) {
			await app.command("permissions", mode);
			assert.match(prepare("pwd")?.error ?? "", /^guard\[sandbox\].*unavailable/, mode);
		}
		await app.command("permissions", "full");
		assert.equal(prepare("pwd")?.command, "pwd");
	} finally {
		sandbox.available = true;
	}
	// 形の合わない頼みには返事をしない (頼んだ側は guard が居ないときと同じ扱いになる)。
	assert.doesNotThrow(() => app.pi.events.emit("guard:bash", { command: 1 }));
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

test("読ませない場所と重なって外されたrootを、/permissionsは書ける場所として出さない", async () => {
	const home = process.env.HOME!;
	const root = dir("home", ".ssh", "project");
	try {
		const app = extensionHost();
		guard(app.pi);
		app.ctx.cwd = root;
		await app.emit("session_start");
		assert.ok(blocked(await app.emit("tool_call", call("write", { path: "file.txt" }))));
		await app.command("permissions");
		assert.match(app.notices.at(-1)!, /Write root: none \(.*overlaps a path the sandbox must not read/);
		assert.doesNotMatch(app.notices.at(-1)!, /contains your home directory/);
	} finally {
		rmSync(join(home, ".ssh"), { recursive: true });
	}
});

test("chezmoiは書ける場所の外にあるPATHの要素からだけ探し、root配下に置かれた同名のものは実行しない", async () => {
	const root = dir("chezmoi", "project");
	const ran = join(base, "chezmoi", "ran");
	const fake = (bin: string, script: string) => {
		writeFileSync(join(bin, "chezmoi"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
		return bin;
	};
	const planted = [dir("chezmoi", "project", "node_modules", ".bin"), dir("tmp", "bin")].map((bin) => fake(bin, `touch ${ran}`));
	const trusted = fake(dir("chezmoi", "bin"), `echo ${root}/managed.txt`);
	const path = process.env.PATH;
	const cwd = process.cwd();
	process.chdir(planted[0]);
	process.env.PATH = [".", "", ...planted, trusted, path].join(":");
	try {
		const app = extensionHost();
		guard(app.pi);
		app.ctx.cwd = root;
		await app.emit("session_start");
		for (const mode of ["normal", "full"]) {
			await app.command("permissions", mode);
			const result = await app.emit("tool_call", call("write", { path: "managed.txt" })) as { block: boolean; reason: string };
			assert.match(result.reason, /chezmoi-target/, mode);
			assert.equal(await app.emit("tool_call", call("write", { path: "other.txt" })), undefined, mode);
		}
		assert.equal(existsSync(ran), false);

		// Pi の cwd が書ける場所の外にあっても、PATH の相対の要素 (`.` と空) からは拾わない。
		// 名前だけの候補は書ける場所の外に見えるうえ、実行するときに PATH を探し直される。
		const elsewhere = fake(dir("chezmoi", "elsewhere"), `touch ${ran}`);
		process.chdir(elsewhere);
		process.env.PATH = [".", "", "/usr/bin", "/bin"].join(":");
		assert.equal(await app.emit("tool_call", call("write", { path: "managed.txt" })), undefined);
		assert.equal(existsSync(ran), false);
	} finally {
		process.env.PATH = path;
		process.chdir(cwd);
	}
});

test("ほかの拡張がsandboxの外で起こす道具の実体は、書ける場所の外にあるものだけを、symlinkを解いた先で答える", async () => {
	const root = dir("binary", "project");
	const tool = (bin: string) => {
		writeFileSync(join(bin, "tool"), "#!/bin/sh\n", { mode: 0o755 });
		return bin;
	};
	const planted = tool(dir("binary", "project", ".venv", "bin"));
	const trusted = tool(dir("binary", "bin"));
	// 書ける場所に置いた symlink は、確かめた後で掛け替えられる。答えるのはその先。
	const linked = dir("binary", "project", "links");
	symlinkSync(join(trusted, "tool"), join(linked, "tool"));
	// 呼ばれた名前で振る舞いを変えるもの (mise の shim)。先を直に起こすと別のコマンドになる。
	const shims = dir("binary", "shims");
	writeFileSync(join(trusted, "multi"), "#!/bin/sh\n", { mode: 0o755 });
	symlinkSync(join(trusted, "multi"), join(shims, "tool"));
	const path = process.env.PATH;
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start");
	const ask = (name: unknown) => {
		let answer: string | undefined | null = null;
		app.pi.events.emit("guard:binary", { name, reply: (given?: string) => (answer = given) });
		return answer;
	};
	try {
		for (const mode of ["normal", "full"]) {
			await app.command("permissions", mode);
			process.env.PATH = [".", "", planted, shims, linked, path].join(":");
			assert.equal(ask("tool"), join(trusted, "tool"), mode);
			// 見つからないときは「無い」と答える。返事が無い (guard が居ない) のとは別。
			process.env.PATH = [".", "", planted, shims].join(":");
			assert.equal(ask("tool"), undefined, mode);
		}
		assert.equal(ask(1), null, "形の合わない頼みには返事をしない");
	} finally {
		process.env.PATH = path;
	}
});

test("起動時に、持ち主のPiがもう居ないreadonly用の一時ディレクトリだけを掃除する", async () => {
	const tmp = process.env.TMPDIR!;
	const dead = spawnSync("/bin/sh", ["-c", ":"]).pid;
	const victim = dir("sweep", "victim");
	writeFileSync(join(victim, "keep.txt"), "keep\n");
	const make = (name: string) => {
		mkdirSync(join(tmp, name));
		writeFileSync(join(tmp, name, "sort-tmp"), "x\n");
		return join(tmp, name);
	};
	const stale = [make(`pi-guard-${dead}-AbC123`), make(`pi-guard-${dead}-second`)];
	// 生きている Pi のもの、pid の無い古い名前、別の道具のもの、ディレクトリでないものには触らない。
	const kept = [make(`pi-guard-${process.pid}-live01`), make("pi-guard-oldStyle"), make(`pi-jobs-${dead}-x`), make(`pi-guard-${dead}x-odd`)];
	const link = join(tmp, `pi-guard-${dead}-link`);
	symlinkSync(victim, link);
	const file = join(tmp, `pi-guard-${dead}-file`);
	writeFileSync(file, "x\n");
	try {
		const app = extensionHost();
		guard(app.pi);
		await app.emit("session_start", { reason: "reload" });
		for (const path of stale) assert.equal(existsSync(path), true, path);
		await app.emit("session_start", { reason: "startup" });
		for (const path of stale) assert.equal(existsSync(path), false, path);
		for (const path of kept) assert.equal(existsSync(join(path, "sort-tmp")), true, path);
		assert.equal(existsSync(join(victim, "keep.txt")), true);
		// リンク先が残るだけでは足りない。rmSync は symlink ならリンクだけを消すので、名前そのものが残ることを見る。
		assert.equal(lstatSync(link).isSymbolicLink(), true);
		assert.equal(existsSync(file), true);

		// 親から継いだ Pi は掃除しない。sandbox の pid namespace の中では、外の Pi がみな居ないように見える。
		const again = make(`pi-guard-${dead}-AbC123`);
		process.env.PI_GUARD = JSON.stringify({ mode: "normal", root: victim, pid: process.pid + 1 });
		const child = extensionHost();
		guard(child.pi);
		await child.emit("session_start", { reason: "startup" });
		assert.equal(existsSync(again), true);
	} finally {
		delete process.env.PI_GUARD;
		for (const name of readdirSync(tmp)) if (name.startsWith("pi-")) rmSync(join(tmp, name), { recursive: true, force: true });
	}
});

test("現在のモードをstatusに常に出し、/permissions・再開・treeで追従する。fullはsandboxが無いと分かる文面にする", async () => {
	const app = extensionHost();
	guard(app.pi);
	assert.equal(app.statuses.has("guard"), false);
	await app.emit("session_start");
	assert.equal(app.statuses.get("guard"), "guard: normal");
	await app.command("permissions", "readonly");
	assert.equal(app.statuses.get("guard"), "guard: readonly");
	const readonly = app.manager.getLeafId()!;
	await app.command("permissions", "full");
	assert.equal(app.statuses.get("guard"), "guard: FULL (no sandbox)");
	// 不正な指定と表示だけの呼び出しでは変わらない。
	await app.command("permissions", "workspace");
	await app.command("permissions");
	assert.equal(app.statuses.get("guard"), "guard: FULL (no sandbox)");
	app.manager.branch(readonly);
	await app.emit("session_tree");
	assert.equal(app.statuses.get("guard"), "guard: readonly");
	await app.command("permissions", "ask");
	app.replaceSession();
	await app.emit("session_start", { reason: "new" });
	assert.equal(app.statuses.get("guard"), "guard: normal");

	// UI の無いセッション (print / json) では出さない。
	const headless = extensionHost();
	guard(headless.pi);
	headless.ctx.hasUI = false;
	await headless.emit("session_start");
	await headless.command("permissions", "full");
	assert.equal(headless.statuses.has("guard"), false);
});

test("normalとaskでは.git/hooksと.git/configへのedit/writeを確認する。sandboxの中のbashと同じ場所", async () => {
	const root = dir("gitlock", "project");
	execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
	// submodule の git dir。ホスト側の git は submodule の中でも config と hooks を読む。
	const source = dir("gitlock", "source");
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "protocol.file.allow=always", ...args], { stdio: "ignore" });
	git(source, "init");
	git(source, "commit", "--allow-empty", "-m", "init");
	git(root, "submodule", "add", source, "sm");
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start");
	for (const path of [".git/modules/sm/config", ".git/modules/sm/hooks/post-checkout"]) {
		app.approve(false);
		for (const toolName of ["write", "edit"]) {
			const result = await app.emit("tool_call", call(toolName, { path })) as { block: boolean; reason: string };
			assert.equal(result?.block, true, `${toolName} ${path}`);
			assert.match(result.reason, /guard\[git-locked\]/);
		}
	}
	// git dir のほかの場所 (index や objects) は、submodule の中の commit が書くので確認しない。
	assert.equal(await app.emit("tool_call", call("write", { path: ".git/modules/sm/info/exclude" })), undefined);
	for (const mode of ["normal", "ask"]) {
		await app.command("permissions", mode);
		app.approve(false);
		for (const path of [".git/hooks/pre-commit", ".git/hooks/new/dir/hook", ".git/config", ".git/commondir", join(root, ".git", "config")]) {
			for (const toolName of ["write", "edit"]) {
				const result = await app.emit("tool_call", call(toolName, { path })) as { block: boolean; reason: string };
				assert.equal(result?.block, true, `${mode} ${toolName} ${path}`);
				assert.match(result.reason, /guard\[git-locked\]/);
			}
		}
	}
	await app.command("permissions", "normal");
	const asked = app.confirmations.length;
	for (const path of ["file.txt", ".gitignore", ".git/info/exclude", ".git/hooks.txt", ".github/workflows/ci.yml"]) {
		assert.equal(await app.emit("tool_call", call("write", { path })), undefined, path);
	}
	assert.equal(app.confirmations.length, asked);
	app.approve(true);
	assert.equal(await app.emit("tool_call", call("write", { path: ".git/hooks/pre-commit" })), undefined);
	app.ctx.hasUI = false;
	assert.match((await app.emit("tool_call", call("write", { path: ".git/config" })) as { reason: string }).reason, /git-locked.*No user can be asked/);
	await app.command("permissions", "full");
	assert.equal(await app.emit("tool_call", call("write", { path: ".git/config" })), undefined);

	// 起動したときはリポジトリでなかった root と、root の下にある別のリポジトリも同じ扱い。
	const workspace = dir("gitlock", "workspace");
	execFileSync("git", ["-C", dir("gitlock", "workspace", "app"), "init"], { stdio: "ignore" });
	const late = extensionHost();
	guard(late.pi);
	late.ctx.cwd = workspace;
	late.ctx.hasUI = false;
	await late.emit("session_start");
	assert.equal(await late.emit("tool_call", call("write", { path: ".git/hooks/post-checkout" })), undefined);
	execFileSync("git", ["-C", workspace, "init"], { stdio: "ignore" });
	for (const path of [".git/hooks/post-checkout", ".git/config", "app/.git/hooks/pre-commit", "app/.git/config"]) {
		assert.match((await late.emit("tool_call", call("write", { path })) as { reason: string })?.reason ?? "", /guard\[git-locked\]/, path);
	}
	assert.equal(await late.emit("tool_call", call("write", { path: "app/file.txt" })), undefined);
});

test(".git/hooksがsymlinkでも、リンク越しとリンク先のどちらへのedit/writeも確認する", async () => {
	// 共有の hooks ディレクトリへ向けたリポジトリ。sandbox はリンク先を読み取り専用に重ねるので、bash からは書けない。
	const root = dir("gitlock-symlink", "project");
	execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
	rmSync(join(root, ".git", "hooks"), { recursive: true, force: true });
	symlinkSync(dir("gitlock-symlink", "project", "shared-hooks"), join(root, ".git", "hooks"));
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start");
	app.approve(false);
	for (const path of [".git/hooks/pre-commit", "shared-hooks/pre-commit"]) {
		for (const toolName of ["write", "edit"]) {
			const result = (await app.emit("tool_call", call(toolName, { path }))) as { block: boolean; reason: string } | undefined;
			assert.equal(result?.block, true, `${toolName} ${path}`);
			assert.match(result!.reason, /guard\[git-locked\]/);
		}
	}
	assert.equal(await app.emit("tool_call", call("write", { path: "shared-hooks.txt" })), undefined);
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
	// ask は子の確認を受け付ける置き場。UI を持つ親だけが渡す。
	const ask = join(process.env.HOME!, ".local", "state", "pi-guard", `ask-${process.pid}`);
	assert.deepEqual(JSON.parse(process.env.PI_GUARD!), { mode: "normal", root, pid: process.pid, ask });
	await app.command("permissions", "readonly");
	assert.deepEqual(JSON.parse(process.env.PI_GUARD!), { mode: "readonly", root, pid: process.pid, ask });
	await app.emit("session_shutdown");
	const headless = extensionHost();
	guard(headless.pi);
	headless.ctx.cwd = root;
	headless.ctx.hasUI = false;
	await headless.emit("session_start");
	assert.deepEqual(JSON.parse(process.env.PI_GUARD!), { mode: "normal", root, pid: process.pid });
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

/** その間に Pi のプロセスの stderr へ書かれたもの。 */
async function stderrDuring(run: () => Promise<unknown>): Promise<string> {
	const original = process.stderr.write;
	let written = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		written += chunk.toString();
		return true;
	}) as typeof process.stderr.write;
	try {
		await run();
	} finally {
		process.stderr.write = original;
	}
	return written;
}

test("親のモードを継いだUIなしの子は、guardが効いていることをstderrで親に知らせる", async () => {
	const start = async (hasUI: boolean) => {
		const app = extensionHost();
		guard(app.pi);
		app.ctx.hasUI = hasUI;
		return stderrDuring(() => app.emit("session_start"));
	};
	// 親 (継いでいない Pi) は書かない。
	assert.equal(await start(false), "");
	process.env.PI_GUARD = JSON.stringify({ mode: "normal", root: dir("loaded", "parent"), pid: process.pid + 1 });
	try {
		assert.equal(await start(false), `${GUARD_LOADED}\n`);
		// 端末を持つ子の stderr は誰も集めていない。画面を汚すだけなので書かない。
		assert.equal(await start(true), "");
	} finally {
		delete process.env.PI_GUARD;
	}
});

/** 条件が満たされるまで待つ。確認の受け渡しはファイルを見に行く間隔の分だけ遅れる。 */
async function eventually<T>(read: () => T | undefined, what: string): Promise<T> {
	for (let waited = 0; waited < 5000; waited += 20) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((done) => setTimeout(done, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

test("UIを持たない子は確認を親に頼み、答えが来るまで待つ。親が居なければ誰にも訊けなかったとして遮断する", async () => {
	const asks = dir("ask", "child");
	// 生きている別のプロセスを親に見立てる。
	const state = { mode: "normal", root: dir("ask", "project"), pid: process.ppid, ask: asks };
	process.env.PI_GUARD = JSON.stringify(state);
	try {
		const app = extensionHost();
		guard(app.pi);
		app.ctx.hasUI = false;
		await app.emit("session_start");
		const answer = async (approved: boolean) => {
			const name = await eventually(() => readdirSync(asks).find((entry) => entry.endsWith(".request")), "a request");
			const request = JSON.parse(readFileSync(join(asks, name), "utf8"));
			writeFileSync(join(asks, name.replace(/request$/, "answer")), JSON.stringify({ approved }));
			rmSync(join(asks, name));
			return request as { title: string; message: string };
		};

		const pushed = app.emit("tool_call", call("bash", { command: "git push origin main" }));
		const request = await answer(true);
		assert.equal(request.title, "guard: git-push");
		assert.match(request.message, /^git push origin main\n\n.*needs the user's approval/);
		assert.equal(await pushed, undefined);
		// 答えは読んだら消す。置きっぱなしにしない。
		assert.deepEqual(readdirSync(asks), []);

		const refused = app.emit("tool_call", call("bash", { command: "git push origin main" }));
		await answer(false);
		assert.match((await refused as { reason: string }).reason, /guard\[git-push\]: denied by the user/);

		// 固定の禁止は訊かない。
		assert.match((await app.emit("tool_call", call("bash", { command: "git push --force" })) as { reason: string }).reason, /git-force-push/);
		assert.deepEqual(readdirSync(asks), []);
		assert.equal(app.confirmations.length, 0);

		// 依頼が答えの無いまま消えた (親が /reload で置き場を作り直した)。置き場も親も残っているが、待ち続けない。
		const dropped = app.emit("tool_call", call("bash", { command: "git push origin main" }));
		rmSync(join(asks, await eventually(() => readdirSync(asks).find((entry) => entry.endsWith(".request")), "a request")));
		const outcome = await Promise.race([dropped, new Promise((done) => setTimeout(() => done("still waiting"), 3000))]);
		assert.match((outcome as { reason: string }).reason ?? String(outcome), /No user can be asked/);

		// 親が受け付けをやめた (置き場を消した)。訊けなかったのであって、断られたのではない。
		rmSync(asks, { recursive: true });
		const closed = await app.emit("tool_call", call("bash", { command: "git push" })) as { block: boolean; reason: string };
		assert.equal(closed.block, true);
		assert.match(closed.reason, /No user can be asked/);
		assert.doesNotMatch(closed.reason, /denied/);
	} finally {
		delete process.env.PI_GUARD;
	}

	// 親のプロセスがもう居ない。待ち続けない。
	const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
	process.env.PI_GUARD = JSON.stringify({ ...state, pid: gone, ask: dir("ask", "orphan") });
	try {
		const app = extensionHost();
		guard(app.pi);
		app.ctx.hasUI = false;
		await app.emit("session_start");
		assert.match((await app.emit("tool_call", call("bash", { command: "git push" })) as { reason: string }).reason, /No user can be asked/);
	} finally {
		delete process.env.PI_GUARD;
	}
});

test("UIを持つ親は、子の確認を自分のUIに出して答えを返す。置き場はsandboxの中から書けない場所で、セッションの終わりに消す", async () => {
	const root = dir("ask", "parent");
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start");
	const asks = join(process.env.HOME!, ".local", "state", "pi-guard", `ask-${process.pid}`);
	assert.equal(JSON.parse(process.env.PI_GUARD!).ask, asks);
	assert.equal(lstatSync(asks).mode & 0o777, 0o700);
	// 書けると、モデルが bash で答えを置いて自分で承認できる。
	for (const mode of ["normal", "ask", "readonly"]) {
		await app.command("permissions", mode);
		assert.ok(blocked(await app.emit("tool_call", call("write", { path: join(asks, "1-00.answer") }))), mode);
	}
	await app.command("permissions", "normal");
	const before = app.confirmations.length;

	// 子に見立てたプロセスが生きている間だけ訊く。名前の先頭が子の pid。
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	try {
		const ask = async (id: string, approved: boolean) => {
			app.approve(approved);
			writeFileSync(join(asks, `${id}.request`), JSON.stringify({ title: "guard: git-push", message: "git push\n\nAllow?" }));
			const answer = await eventually(() => (existsSync(join(asks, `${id}.answer`)) ? readFileSync(join(asks, `${id}.answer`), "utf8") : undefined), "an answer");
			assert.equal(existsSync(join(asks, `${id}.request`)), false);
			return JSON.parse(answer);
		};
		assert.deepEqual(await ask(`${child.pid}-aa`, true), { approved: true });
		assert.equal(app.confirmations.at(-1), "[subagent] guard: git-push\ngit push\n\nAllow?");
		assert.deepEqual(await ask(`${child.pid}-bb`, false), { approved: false });
		assert.equal(app.confirmations.length, before + 2);
		// 読めない依頼は承認しない。
		app.approve(true);
		writeFileSync(join(asks, `${child.pid}-cc.request`), "not json");
		assert.deepEqual(JSON.parse(await eventually(() => (existsSync(join(asks, `${child.pid}-cc.answer`)) ? readFileSync(join(asks, `${child.pid}-cc.answer`), "utf8") : undefined), "an answer")), { approved: false });
		assert.equal(app.confirmations.length, before + 2);
		// 置き場に書けるプロセスなら何でも依頼を置ける。題と本文は上限で切り、画面を埋めさせない。
		writeFileSync(join(asks, `${child.pid}-ee.request`), JSON.stringify({ title: "T".repeat(500), message: "M".repeat(5000) }));
		await eventually(() => (existsSync(join(asks, `${child.pid}-ee.answer`)) ? true : undefined), "an answer");
		assert.equal(app.confirmations.at(-1), `[subagent] ${"T".repeat(200)}\n${"M".repeat(2000)}`);
	} finally {
		child.kill();
	}
	// 訊いた子がもう居なければ、誰も待っていないダイアログは出さない。
	await new Promise((done) => child.once("exit", done));
	writeFileSync(join(asks, `${child.pid}-dd.request`), JSON.stringify({ title: "t", message: "m" }));
	await eventually(() => (existsSync(join(asks, `${child.pid}-dd.request`)) ? undefined : true), "the stale request to be dropped");
	assert.equal(app.confirmations.length, before + 3);

	await app.emit("session_shutdown");
	assert.equal(existsSync(asks), false);

	// root が置き場を含むと、sandbox の中の bash が答えを置ける。受け付けない。
	const wide = extensionHost();
	guard(wide.pi);
	wide.ctx.cwd = join(process.env.HOME!, ".local");
	await wide.emit("session_start");
	assert.equal(JSON.parse(process.env.PI_GUARD!).ask, undefined);
	assert.equal(existsSync(asks), false);
});

test("子が確認を待っている間に居なくなったら、親はダイアログを閉じて答えを置かない", async () => {
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = dir("ask", "gone");
	// 人が答えるまで開いたままのダイアログ。ほかに閉じられるのは、渡された signal だけ。
	const dialogs: Array<{ open: boolean; answer: (approved: boolean) => void }> = [];
	app.ctx.ui.confirm = (_title, _message, opts) =>
		new Promise((resolve) => {
			const dialog = { open: true, answer: resolve };
			dialogs.push(dialog);
			opts?.signal?.addEventListener("abort", () => {
				dialog.open = false;
				resolve(false);
			});
		});
	await app.emit("session_start");
	const asks: string = JSON.parse(process.env.PI_GUARD!).ask;
	const sleeper = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	const ask = async (child: { pid?: number }, id: string) => {
		writeFileSync(join(asks, `${child.pid}-${id}.request`), JSON.stringify({ title: "guard: git-push", message: "git push" }));
		const shown = dialogs.length;
		await eventually(() => (dialogs.length > shown ? true : undefined), "the dialog");
		return dialogs.at(-1)!;
	};
	const children = [sleeper(), sleeper(), sleeper()];
	try {
		// 親で subagent を止めると、子は依頼を消さずに終わる (SIGTERM で process.exit する)。
		const abandoned = await ask(children[0], "aa");
		assert.equal(abandoned.open, true);
		children[0].kill();
		await eventually(() => (abandoned.open ? undefined : true), "the abandoned dialog to be dismissed");
		await eventually(() => (readdirSync(asks).length === 0 ? true : undefined), "the request to be dropped");

		// 見に行く間隔の間に子が居なくなり、その後で人が承認した。読む者の居ない答えは置かない。
		const late = await ask(children[1], "bb");
		children[1].kill();
		await new Promise((done) => children[1].once("exit", done));
		late.answer(true);
		await eventually(() => (existsSync(join(asks, `${children[1].pid}-bb.request`)) ? undefined : true), "the request to be dropped");
		assert.deepEqual(readdirSync(asks), []);

		// 閉じた後も、次の子の確認は出て答えが返る。
		(await ask(children[2], "cc")).answer(true);
		assert.deepEqual(JSON.parse(await eventually(() => (existsSync(join(asks, `${children[2].pid}-cc.answer`)) ? readFileSync(join(asks, `${children[2].pid}-cc.answer`), "utf8") : undefined), "an answer")), { approved: true });
	} finally {
		for (const child of children) child.kill();
		await app.emit("session_shutdown");
	}
});

test("起動時に、持ち主のPiがもう居ない子の確認の置き場だけを掃除する", async () => {
	const home = dir("home", ".local", "state", "pi-guard");
	const dead = spawnSync("/bin/sh", ["-c", ":"]).pid;
	const make = (name: string) => {
		mkdirSync(join(home, name), { recursive: true });
		writeFileSync(join(home, name, "1-aa.answer"), "{}");
		return join(home, name);
	};
	const stale = make(`ask-${dead}`);
	// 生きている Pi のものと、置き場でない名前には触らない。
	const kept = [make(`ask-${process.ppid}`), make(`ask-${dead}x`), make("other")];
	try {
		const app = extensionHost();
		guard(app.pi);
		await app.emit("session_start", { reason: "reload" });
		assert.equal(existsSync(stale), true);
		await app.emit("session_start", { reason: "startup" });
		assert.equal(existsSync(stale), false);
		for (const path of kept) assert.equal(existsSync(join(path, "1-aa.answer")), true, path);
		await app.emit("session_shutdown");

		// 親から継いだ Pi は掃除しない (readonly の一時ディレクトリと同じ理由)。
		make(`ask-${dead}`);
		process.env.PI_GUARD = JSON.stringify({ mode: "normal", root: dir("sweep-asks", "project"), pid: process.pid + 1 });
		const child = extensionHost();
		guard(child.pi);
		await child.emit("session_start", { reason: "startup" });
		assert.equal(existsSync(stale), true);
	} finally {
		delete process.env.PI_GUARD;
		rmSync(home, { recursive: true, force: true });
	}
});

test("子の確認は親のUIに出て、承認された書き込みは子のsandboxを通さずに届く", async () => {
	const root = dir("relay", "project");
	const target = join(dir("relay", "outside"), "file.txt");
	const parent = extensionHost();
	guard(parent.pi);
	parent.ctx.cwd = root;
	await parent.emit("session_start");
	// 同じプロセスの中で子に見立てる。pid が同じだと継承とみなされないので、生きている別のプロセスの pid にする。
	const published = process.env.PI_GUARD!;
	process.env.PI_GUARD = JSON.stringify({ ...JSON.parse(published), pid: process.ppid });
	try {
		const child = extensionHost();
		guard(child.pi);
		child.ctx.cwd = root;
		child.ctx.hasUI = false;
		await child.emit("session_start");
		const write = (toolCallId: string) => child.emit("tool_call", { toolName: "write", toolCallId, input: { path: target } });

		assert.match((await write("refused") as { reason: string }).reason, /guard\[outside-write-roots\]: denied by the user/);
		assert.match(parent.confirmations.at(-1)!, new RegExp(`^\\[subagent\\] guard: outside-write-roots\n${target}\n`));
		parent.approve(true);
		assert.equal(await write("allowed"), undefined);
		assert.equal(child.confirmations.length, 0);
		await child.registeredTools.get("write")!.execute("allowed", { path: target, content: "from the child\n" }, undefined, undefined, child.ctx);
		assert.equal(readFileSync(target, "utf8"), "from the child\n");
	} finally {
		process.env.PI_GUARD = published;
		await parent.emit("session_shutdown");
		delete process.env.PI_GUARD;
	}
});

test("subagentの子がguardの知らせを出さずに動いていたら、結果に警告を足して人にも知らせる", async () => {
	const app = extensionHost();
	guard(app.pi);
	await app.emit("session_start");
	const content = [{ type: "text", text: "done" }];
	const ran = [{ role: "user" }, { role: "assistant" }];
	const result = (results: unknown) => app.emit("tool_result", { toolName: "subagent", toolCallId: "call-1", input: {}, content, isError: false, details: { mode: "parallel", results } });

	assert.equal(await result([{ agent: "scout", messages: ran, stderr: `${GUARD_LOADED}\n` }, { agent: "worker", messages: ran, stderr: `warning\n${GUARD_LOADED}\nmore\n` }]), undefined);
	// 起動しなかった子 (未知の agent、spawn の失敗) は何も実行していない。
	assert.equal(await result([{ agent: "ghost", messages: [], stderr: 'Unknown agent: "ghost".' }]), undefined);
	assert.equal(app.notices.length, 0);

	const warned = await result([{ agent: "scout", messages: ran, stderr: `${GUARD_LOADED}\n` }, { agent: "worker", messages: ran, stderr: "" }, { agent: "planner", messages: ran, stderr: "boom" }]) as { content: Array<{ text: string }> };
	assert.deepEqual(warned.content[0], content[0]);
	assert.match(warned.content[1].text, /guard\[subagent\].*worker, planner.*without guard/);
	assert.doesNotMatch(warned.content[1].text, /scout/);
	assert.match(app.notices.at(-1)!, /guard\[subagent\].*worker, planner/);

	// 中断された subagent は例外で終わり、結果に details が載らない。途中経過で届いていた子の様子で判定する。
	const partial = (toolCallId: string, results: unknown) => app.emit("tool_execution_update", { toolName: "subagent", toolCallId, args: {}, partialResult: { content, details: { mode: "single", results } } });
	const aborted = (toolCallId: string) => app.emit("tool_result", { toolName: "subagent", toolCallId, input: {}, content: [{ type: "text", text: "Subagent was aborted" }], isError: true, details: {} });
	// 公式 sample は同じ result を書き足しながら渡してくる。最初の途中経過の後で届いた stderr も見える。
	const unguarded = { agent: "worker", messages: [ran[0]], stderr: "" };
	await partial("stopped", [unguarded]);
	unguarded.messages.push(ran[1]);
	unguarded.stderr = "boom";
	const stopped = await aborted("stopped") as { content: Array<{ text: string }> };
	assert.equal(stopped.content[0].text, "Subagent was aborted");
	assert.match(stopped.content[1].text, /guard\[subagent\].*worker.*without guard/);
	await partial("stopped-guarded", [{ agent: "scout", messages: ran, stderr: `${GUARD_LOADED}\n` }]);
	assert.equal(await aborted("stopped-guarded"), undefined);
	// 途中経過は、その呼び出しの結果にだけ使う。
	assert.equal(await aborted("stopped"), undefined);
	assert.equal(await aborted("never-reported"), undefined);

	// 公式 sample は、失敗した子の説明に errorMessage、無ければ stderr、それも無ければ子の最後の出力を使う。
	// 知らせの 1 行が、親のモデルに届く説明を置き換えないようにする。
	const said = [{ role: "user" }, { role: "assistant", content: [{ type: "text", text: "first" }] }, { role: "assistant", content: [{ type: "toolCall" }, { type: "text", text: "half done" }, { type: "text", text: "more" }] }, { role: "toolResult" }];
	const failed = async (text: string, messages: unknown, stderr: string) =>
		(await app.emit("tool_result", { toolName: "subagent", toolCallId: "call-1", input: {}, content: [{ type: "text", text }], isError: true, details: { mode: "single", results: [{ agent: "scout", exitCode: 1, messages, stderr }] } }) as { content: unknown } | undefined)?.content;
	assert.deepEqual(await failed(`Agent failed: ${GUARD_LOADED}\n`, said, `${GUARD_LOADED}\n`), [{ type: "text", text: "Agent failed: half done" }]);
	assert.deepEqual(await failed(`Chain stopped at step 1 (scout): ${GUARD_LOADED}\n`, [{ role: "user" }], `${GUARD_LOADED}\n`), [{ type: "text", text: "Chain stopped at step 1 (scout): (no output)" }]);
	// stderr にほかの行もあれば、知らせの行だけを除く。
	assert.deepEqual(await failed(`### [scout] failed\n\nwarn\n${GUARD_LOADED}\nboom\n`, said, `warn\n${GUARD_LOADED}\nboom\n`), [{ type: "text", text: "### [scout] failed\n\nwarn\nboom\n" }]);
	// 並列では、成功した子も同じ 1 行だけの stderr を持つ。失敗した子の説明に、ほかの子の出力を入れない。
	const worker = [{ role: "user" }, { role: "assistant", content: [{ type: "text", text: "worker partial" }] }];
	const mixed = await app.emit("tool_result", {
		toolName: "subagent", toolCallId: "call-1", input: {}, isError: false,
		content: [{ type: "text", text: `Parallel: 1/3 succeeded\n\n### [scout] completed\n\nhalf done\n\n---\n\n### [worker] failed\n\n${GUARD_LOADED}\n\n\n---\n\n### [planner] failed (error)\n\n429 rate limited` }],
		details: { mode: "parallel", results: [
			{ agent: "scout", exitCode: 0, messages: said, stderr: `${GUARD_LOADED}\n` },
			{ agent: "worker", exitCode: 1, messages: worker, stderr: `${GUARD_LOADED}\n` },
			{ agent: "planner", exitCode: 0, stopReason: "error", errorMessage: "429 rate limited", messages: said, stderr: `${GUARD_LOADED}\n` },
		] },
	}) as { content: Array<{ text: string }> };
	assert.equal(mixed.content[0].text, "Parallel: 1/3 succeeded\n\n### [scout] completed\n\nhalf done\n\n---\n\n### [worker] failed\n\nworker partial\n\n---\n\n### [planner] failed (error)\n\n429 rate limited");
	// 説明に stderr が使われていない (errorMessage がある、成功した) 結果には触らない。
	assert.equal(await failed("Agent error: 429 rate limited", said, `${GUARD_LOADED}\n`), undefined);
	assert.equal(app.notices.length, 2);

	// ほかのツールの結果と、形の違う details には触らない。
	assert.equal(await app.emit("tool_result", { toolName: "bash", toolCallId: "call-1", input: {}, content, isError: false, details: { results: [{ agent: "x", messages: ran, stderr: "" }] } }), undefined);
	for (const details of [undefined, null, {}, { results: "none" }, { results: [null, "text", {}] }]) {
		assert.equal(await app.emit("tool_result", { toolName: "subagent", toolCallId: "call-1", input: {}, content, isError: true, details }), undefined);
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

test("full以外では読ませない場所へのread/grep/find/ls/editを確認し、UIなしでは遮断する", async () => {
	const home = process.env.HOME!;
	const root = dir("home", "read-project");
	try {
		writeFileSync(join(dir("home", ".ssh"), "id_test"), "SECRET\n");
		writeFileSync(join(home, ".env"), "SECRET\n");
		writeFileSync(join(root, "plain.txt"), "plain\n");
		symlinkSync(join(home, ".ssh"), join(root, "keys"));
		// read は無い名前を別表記で探し直す。まっすぐな引用符で訊くと、曲がった引用符の symlink が開く。
		symlinkSync(join(home, ".ssh", "id_test"), join(root, "it\u2019s"));
		const app = extensionHost();
		guard(app.pi);
		app.ctx.cwd = root;
		await app.emit("session_start");
		for (const name of ["grep", "find", "ls"]) app.tools.push({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } });
		// ~/.aws は無い。無くても数える。
		const denied = ["~/.env", "~/.ssh", "~/.ssh/id_test", "../.ssh/id_test", "keys/id_test", "keys", "@~/.zshenv", `file://${home}/.netrc`, "~/.aws/credentials", "~/.pypirc", "../.pypirc"];
		const tools = ["read", "grep", "find", "ls", "edit"];
		for (const mode of ["normal", "ask", "readonly"]) {
			await app.command("permissions", mode);
			for (const toolName of mode === "readonly" ? tools.slice(0, 4) : tools) {
				for (const path of denied) {
					const asked = app.confirmations.length;
					app.approve(false);
					const result = await app.emit("tool_call", call(toolName, { path })) as { block: boolean; reason: string };
					assert.equal(result?.block, true, `${mode} ${toolName} ${path}`);
					assert.match(result.reason, /guard\[read-denied\]: denied by the user/);
					app.approve(true);
					assert.equal(await app.emit("tool_call", call(toolName, { path })), undefined);
					assert.equal(app.confirmations.length, asked + 2);
				}
			}
			app.approve(false);
			assert.ok(blocked(await app.emit("tool_call", call("read", { path: "it's" }))));
			const asked = app.confirmations.length;
			// 隣の名前や普通のファイル、path を省いた検索には訊かない。
			for (const path of ["plain.txt", "~/.sshrc", "~/.env.example", "~/.config/aws", "~/.pypirc.bak", undefined]) {
				for (const toolName of tools.slice(1, 4)) assert.equal(await app.emit("tool_call", call(toolName, { path })), undefined, `${mode} ${toolName} ${path}`);
			}
			assert.equal(await app.emit("tool_call", call("read", { path: "plain.txt" })), undefined);
			if (mode === "normal") assert.equal(await app.emit("tool_call", call("edit", { path: "plain.txt" })), undefined);
			assert.equal(app.confirmations.length, asked);
		}

		await app.command("permissions", "normal");
		app.ctx.hasUI = false;
		const asked = app.confirmations.length;
		for (const toolName of tools) {
			const unasked = await app.emit("tool_call", call(toolName, { path: "keys/id_test" })) as { block: boolean; reason: string };
			assert.equal(unasked?.block, true, toolName);
			assert.match(unasked.reason, /guard\[read-denied\].*No user can be asked/);
			assert.doesNotMatch(unasked.reason, /denied by the user/);
		}
		await app.command("permissions", "full");
		for (const toolName of tools) assert.equal(await app.emit("tool_call", call(toolName, { path: "~/.ssh/id_test" })), undefined, toolName);
		assert.equal(app.confirmations.length, asked);
	} finally {
		for (const name of [".ssh", ".env"]) rmSync(join(home, name), { recursive: true, force: true });
	}
});

test("grep/findに読ませない場所の親ディレクトリを渡したら確認する。中まで降りて読むため", async () => {
	const home = process.env.HOME!;
	const root = dir("home", "parent-project");
	try {
		writeFileSync(join(dir("home", ".ssh"), "id_test"), "SECRET\n");
		symlinkSync(home, join(root, "homelink"));
		const app = extensionHost();
		guard(app.pi);
		app.ctx.cwd = root;
		await app.emit("session_start");
		for (const name of ["grep", "find", "ls"]) app.tools.push({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } });
		for (const mode of ["normal", "ask", "readonly"]) {
			await app.command("permissions", mode);
			for (const toolName of ["grep", "find"]) {
				for (const path of ["~", "..", "/", "homelink", "@~/"]) {
					app.approve(false);
					const result = await app.emit("tool_call", call(toolName, { path, pattern: "SECRET" })) as { block: boolean; reason: string };
					assert.equal(result?.block, true, `${mode} ${toolName} ${path}`);
					assert.match(result.reason, /guard\[read-denied-inside\]: denied by the user/);
					app.approve(true);
					assert.equal(await app.emit("tool_call", call(toolName, { path, pattern: "SECRET" })), undefined);
				}
			}
			// 中に読ませない場所が無い検索、降りない ls、1 つのファイルを読む read には訊かない。
			const asked = app.confirmations.length;
			for (const toolName of ["grep", "find"]) {
				for (const path of [undefined, ".", "~/parent-project", "/usr"]) assert.equal(await app.emit("tool_call", call(toolName, { path })), undefined, `${mode} ${toolName} ${path}`);
			}
			assert.equal(await app.emit("tool_call", call("ls", { path: "~" })), undefined);
			assert.equal(await app.emit("tool_call", call("read", { path: "~/parent-project/file.txt" })), undefined);
			assert.equal(app.confirmations.length, asked);
		}
		// まだ無い場所は中に数えない。読むものが無い。
		rmSync(join(home, ".ssh"), { recursive: true });
		const asked = app.confirmations.length;
		assert.equal(await app.emit("tool_call", call("grep", { path: "~" })), undefined);
		assert.equal(app.confirmations.length, asked);

		writeFileSync(join(dir("home", ".ssh"), "id_test"), "SECRET\n");
		app.ctx.hasUI = false;
		assert.match((await app.emit("tool_call", call("find", { path: "~" })) as { reason: string }).reason, /guard\[read-denied-inside\].*No user can be asked/);
		await app.command("permissions", "full");
		assert.equal(await app.emit("tool_call", call("grep", { path: "~" })), undefined);
	} finally {
		rmSync(join(home, ".ssh"), { recursive: true, force: true });
	}
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
