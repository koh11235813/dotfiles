import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import guard from "../index.ts";
import { bwrap, containsHome, EXTRA_WRITE_PATHS, gitCommonDir, inside, readDenied, sandboxArgv, sandboxAvailable, seatbelt, wrap, writeRoots } from "../sandbox.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

// 本物の HOME と一時ディレクトリを root にしない。os.tmpdir() の下に作った「外」が外でなくなる。
// 表の /tmp と /var/tmp も同じ理由で外す (Linux では os.tmpdir() が /tmp)。中身は専用のテストで戻して確かめる。
const sharedTmp = EXTRA_WRITE_PATHS.splice(0, 2);
const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-sandbox-")));
const dir = (...parts: string[]) => {
	const path = join(base, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
};
process.env.TMPDIR = dir("tmp");
process.env.HOME = dir("home");
delete process.env.PI_GUARD;

test("normalとaskで書けるのはroot・一時ディレクトリ・実在するキャッシュだけで、readonlyは専用の一時ディレクトリだけ", () => {
	const root = dir("roots", "project");
	const scratch = dir("roots", "scratch");
	dir("home", ".cache");
	const expected = [root, join(base, "tmp"), join(base, "home", ".cache")];
	assert.deepEqual(writeRoots("normal", root, scratch), expected);
	assert.deepEqual(writeRoots("ask", root, scratch), expected);
	assert.deepEqual(writeRoots("readonly", root, scratch), [scratch]);
	dir("home", ".npm");
	assert.deepEqual(writeRoots("normal", root, scratch), [...expected, join(base, "home", ".npm")]);
});

test("rootはsymlinkを解決して渡す", () => {
	symlinkSync(dir("links", "real"), join(base, "links", "alias"));
	assert.equal(writeRoots("normal", join(base, "links", "alias"), "")[0], join(base, "links", "real"));
});

test("linked worktreeではrootの外にあるgitのcommon dirも書ける。root内の.gitは重ねて足さない", () => {
	const repo = dir("git", "repo");
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdio: "ignore" });
	git("init");
	git("commit", "--allow-empty", "-m", "init");
	const linked = join(base, "git", "linked");
	git("worktree", "add", linked);
	const sub = dir("git", "repo", "sub");
	assert.equal(gitCommonDir(dir("git", "plain")), undefined);
	for (const root of [linked, sub]) {
		assert.equal(gitCommonDir(root), join(repo, ".git"));
		assert.ok(writeRoots("normal", root, "", gitCommonDir(root)).includes(join(repo, ".git")));
	}
	assert.ok(!writeRoots("normal", repo, "", gitCommonDir(repo)).includes(join(repo, ".git")));
	assert.deepEqual(writeRoots("readonly", linked, dir("git", "scratch"), gitCommonDir(linked)), [join(base, "git", "scratch")]);
});

test("gitのcommon dirはrootごとに一度しか訊かず、後から.gitを書き換えても書ける場所は広がらない", () => {
	const victim = dir("tamper", "victim");
	const root = dir("tamper", "project");
	for (const repo of [victim, root]) execFileSync("git", ["-C", repo, "init"], { stdio: "ignore" });
	assert.equal(gitCommonDir(join(root, ".")), join(root, ".git"));
	writeFileSync(join(root, ".git", "commondir"), `${join(victim, ".git")}\n`);
	assert.equal(gitCommonDir(join(root, ".")), join(root, ".git"));
});

test("ホームディレクトリを含むrootは書ける場所にしない", () => {
	const home = process.env.HOME!;
	dir("home", ".cache");
	for (const root of [home, "/", join(home, "..")]) {
		assert.equal(containsHome(root), true, root);
		assert.ok(!writeRoots("normal", root, "").some((path) => path === home || path === "/" || path === base), root);
	}
	assert.ok(writeRoots("normal", home, "").includes(join(home, ".cache")));
	assert.equal(containsHome(dir("home", "project")), false);
	assert.equal(writeRoots("normal", join(home, "project"), "")[0], join(home, "project"));
});

test("まだ無いパスは一番近い祖先で判定し、外を指すsymlinkと切れたsymlinkは外とみなす", () => {
	const root = dir("inside", "root");
	symlinkSync(dir("inside", "elsewhere"), join(root, "escape"));
	symlinkSync(join(base, "inside", "missing"), join(root, "dangling"));
	assert.equal(inside([root], join(root, "new", "deep", "file.txt")), true);
	assert.equal(inside([root], root), true);
	assert.equal(inside([root], `${root}-sibling/file.txt`), false);
	assert.equal(inside([root], join(root, "escape", "file.txt")), false);
	assert.equal(inside([root], join(root, "dangling")), false);
	assert.equal(inside([root], join(root, "nul\0byte.txt")), false);
});

test("seatbeltは書き込みだけを拒否してrootsを再許可し、パスの引用符を逃がす", () => {
	const profile = seatbelt(["/work/project", '/odd/"quoted"\\dir'], []);
	assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny file-write\*\)\n\(allow file-write\*\n/);
	assert.ok(profile.includes('(subpath "/work/project")'));
	assert.ok(profile.includes('(subpath "/odd/\\"quoted\\"\\\\dir")'));
	assert.ok(profile.includes('(literal "/dev/null")'));
	assert.doesNotMatch(profile, /network|file-read/);
});

test("bwrapは/を読み取り専用にしてrootsだけ書けるように重ね、ネットワークは切り離さない", () => {
	assert.deepEqual(bwrap(["/work/project", "/tmp"], []), [
		"--ro-bind", "/", "/",
		"--bind-try", "/work/project", "/work/project",
		"--bind-try", "/tmp", "/tmp",
		"--dev", "/dev",
		"--unshare-pid",
		"--proc", "/proc",
		"--die-with-parent",
		"--new-session",
		"--",
	]);
});

test("sandboxの実体は絶対パスで呼び、PATHからは探さない。対応していないOSには無い", () => {
	assert.equal(sandboxArgv([], [], "darwin")?.[0], "/usr/bin/sandbox-exec");
	// bubblewrap が無いホスト (macOS) では無し。
	assert.equal(sandboxArgv([], [], "linux")?.[0], ["/usr/bin/bwrap", "/bin/bwrap"].find((path) => existsSync(path)));
	assert.equal(sandboxArgv([], [], "win32"), undefined);
});

test("モデルのコマンドはシェル文字列に埋めず環境変数で渡す", () => {
	const command = `echo "it's" > 'out file'; $(touch pwned)`;
	const wrapped = wrap({ command, cwd: "/work", env: { KEEP: "1" } }, ["sandbox", "-p", "it's (a) profile"]);
	assert.equal(wrapped.command, `exec 'sandbox' '-p' 'it'\\''s (a) profile' /bin/bash -c "$PI_GUARD_COMMAND"`);
	assert.deepEqual(wrapped.env, { KEEP: "1", PI_GUARD_COMMAND: command });
	assert.equal(wrapped.cwd, "/work");
});

test("読ませない場所は無くても数え、symlinkならリンク先も数える", () => {
	const home = process.env.HOME!;
	// この時点では .ssh も .env も .zshenv も無い。
	assert.deepEqual(readDenied(), [".ssh", ".env", ".zshenv", ".aws", ".netrc"].map((name) => join(home, name)));
	symlinkSync(dir("denied", "aws"), join(home, ".aws"));
	try {
		assert.deepEqual(readDenied().slice(3), [join(home, ".aws"), join(base, "denied", "aws"), join(home, ".netrc")]);
	} finally {
		rmSync(join(home, ".aws"));
	}
});

test("読ませない場所と重なるrootは書ける場所にしない", () => {
	const home = process.env.HOME!;
	const inner = dir("home", ".ssh", "project");
	const outer = dir("denied", "outer");
	symlinkSync(dir("denied", "outer", "deep", "netrc"), join(home, ".netrc"));
	try {
		assert.ok(!writeRoots("normal", inner, "").includes(inner));
		assert.ok(!writeRoots("normal", outer, "").includes(outer));
		assert.deepEqual(writeRoots("readonly", "", inner), []);
	} finally {
		rmSync(join(home, ".netrc"));
		rmSync(join(home, ".ssh"), { recursive: true });
	}
});

test("seatbeltは読ませない場所の拒否を最後に置き、入口のstatだけ戻す", () => {
	const profile = seatbelt(["/work/project"], ["/home/me/.ssh", '/home/me/.e"nv']).split("\n");
	assert.deepEqual(profile.slice(-2), [
		'(deny file-read* (subpath "/home/me/.ssh") (subpath "/home/me/.e\\"nv"))',
		'(allow file-read-metadata (literal "/home/me/.ssh") (literal "/home/me/.e\\"nv"))',
	]);
	assert.ok(profile.indexOf('\t(subpath "/work/project")') < profile.length - 2);
});

test("bwrapは読ませない場所をrootsの後で隠し、実在しないものとsymlinkのままの名前は飛ばす", () => {
	const directory = dir("hide", "dir");
	const file = join(dir("hide"), "file");
	writeFileSync(file, "secret\n");
	const link = join(base, "hide", "link");
	symlinkSync(directory, link);
	assert.deepEqual(bwrap(["/work/project"], [directory, file, link, join(base, "hide", "missing")]).slice(0, 11), [
		"--ro-bind", "/", "/",
		"--bind-try", "/work/project", "/work/project",
		"--tmpfs", directory,
		"--ro-bind", "/dev/null", file,
	]);
});

// Linux は bubblewrap が動くホストでだけ走る。macOS で probe が失敗するなら、それは見逃さず落とす。
const cannotRun = process.platform === "linux" ? !sandboxAvailable() : process.platform !== "darwin";

test("bashツールは実際のsandboxの中で走り、モードごとに書ける場所が変わる", { skip: cannotRun }, async () => {
	const root = dir("real", "project");
	const outside = dir("real", "outside");
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start");
	const bash = app.registeredTools.get("bash")!;
	const run = async (command: string): Promise<{ ok: boolean; text: string }> => {
		const result = await bash.execute("call-1", { command }, undefined, undefined, app.ctx);
		return { ok: !result.isError, text: result.content[0].text };
	};

	assert.equal((await run("echo in > inside.txt")).ok, true);
	assert.equal(readFileSync(join(root, "inside.txt"), "utf8"), "in\n");
	assert.equal((await run(`echo out > ${outside}/normal.txt`)).ok, false);
	assert.equal(existsSync(join(outside, "normal.txt")), false);
	// 引用符や改行を含むコマンドがそのまま届く。
	assert.equal((await run(`printf '%s\\n' "it's" 'a "b"' > quoted.txt\ncat quoted.txt`)).text, `it's\na "b"\n`);
	assert.equal((await run('echo tmp > "$TMPDIR/tmp.txt" && cat <<EOF\nheredoc\nEOF')).text, "heredoc\n");
	// シェルが開く /dev の節点とパイプ。
	// Linux では /dev/stderr を開けない。sandbox と無関係で、Node が子の標準出力を socket でつなぐため (ENXIO)。
	const reopen = process.platform === "darwin" ? "echo c > /dev/stderr; echo d > /dev/stdout" : "echo c; echo d";
	const devices = `echo a > /dev/null; echo b >&2; ${reopen}; (echo e; echo f 1>&2) 2>&1 | tr a-z A-Z`;
	assert.equal((await run(devices)).text, "b\nc\nd\nE\nF\n");
	// エディタや git の原子的な保存 (一時ファイル → rename) と削除。seatbelt では rename も unlink も file-write-unlink。
	assert.equal((await run("echo a > a.txt && mv a.txt b.txt && rm b.txt && mkdir d && rmdir d && ls")).text, "inside.txt\nquoted.txt\n");
	const commit = await run("git init -q repo && cd repo && echo tracked > file.txt && git add file.txt && git -c user.name=t -c user.email=t@example.com commit -q -m init && git log --oneline | wc -l");
	assert.equal(commit.text.trim(), "1", commit.text);
	writeFileSync(join(outside, "victim.txt"), "keep\n");
	for (const command of [`rm ${outside}/victim.txt`, `mv ${outside}/victim.txt ${outside}/moved.txt`, `mv ${outside}/victim.txt stolen.txt`, `mv inside.txt ${outside}/`]) {
		assert.equal((await run(command)).ok, false, command);
	}
	assert.equal(readFileSync(join(outside, "victim.txt"), "utf8"), "keep\n");
	assert.equal(existsSync(join(root, "inside.txt")), true);
	// 時間切れで Pi はプロセスグループを殺す。sandbox の中の子まで残らず消える。
	const alive = () => {
		try {
			return execFileSync("pgrep", ["-fx", "sleep 61.5"], { encoding: "utf8" });
		} catch {
			return "";
		}
	};
	const pending = bash.execute("call-1", { command: "sleep 61.5 & sleep 61.5", timeout: 2 }, undefined, undefined, app.ctx).then((result: { content: Array<{ text: string }> }) => result.content[0].text, String);
	await new Promise((done) => setTimeout(done, 1000));
	assert.equal(alive().trim().split("\n").length, 2);
	assert.match(await pending, /timed out/i);
	for (let waited = 0; alive() && waited < 3000; waited += 100) await new Promise((done) => setTimeout(done, 100));
	assert.equal(alive(), "");
	if (process.platform === "darwin") {
		// sandbox の中の Pi は sandbox を張れない。素通しではなく失敗する。
		assert.match((await run("/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true")).text, /Operation not permitted/);
	}

	await app.command("permissions", "readonly");
	assert.equal((await run("echo ro > readonly.txt")).ok, false);
	assert.equal(existsSync(join(root, "readonly.txt")), false);
	const scratch = (await run('echo tmp > "$TMPDIR/scratch.txt" && cat <<EOF\n$TMPDIR\nEOF')).text.trim();
	assert.notEqual(scratch, process.env.TMPDIR);
	assert.equal(statSync(scratch).mode & 0o777, 0o700);
	assert.equal((await run(devices)).text, "b\nc\nd\nE\nF\n");
	assert.equal(readFileSync(join(scratch, "scratch.txt"), "utf8"), "tmp\n");
	await app.emit("session_shutdown");
	assert.equal(existsSync(scratch), false);

	await app.command("permissions", "full");
	assert.equal((await run(`echo out > ${outside}/full.txt`)).ok, true);
});

test("full以外のbashは読ませない場所を読めず、ほかの読み取りはそのまま通る", { skip: cannotRun }, async () => {
	const home = process.env.HOME!;
	const root = dir("home", "deny-project");
	const target = dir("deny", "target");
	const secrets = [join(dir("home", ".ssh"), "id_test"), join(home, ".env"), join(home, ".zshenv"), join(target, "credentials")];
	try {
		for (const path of secrets) writeFileSync(path, "SECRET\n");
		// リンク先が HOME の外にある。
		symlinkSync(target, join(home, ".aws"));
		writeFileSync(join(home, "notes.txt"), "plain\n");
		symlinkSync(join(home, ".ssh"), join(root, "keys"));
		const app = extensionHost();
		guard(app.pi);
		app.ctx.cwd = root;
		await app.emit("session_start");
		const bash = app.registeredTools.get("bash")!;
		const run = async (command: string): Promise<{ ok: boolean; text: string }> => {
			const result = await bash.execute("call-1", { command }, undefined, undefined, app.ctx);
			return { ok: !result.isError, text: result.content[0].text };
		};
		const routes = [
			"cat ~/.ssh/id_test", "cat ~/.env", "cat ~/.zshenv", "cat ~/.ssh/../.zshenv", "cat keys/id_test", "cat ~/.aws/credentials", `cat ${target}/credentials`,
			"cp ~/.env copy.txt; cat copy.txt", "ls ~/.ssh", "grep -r SECRET ~/.ssh ~/.env ~/.zshenv ~/.aws",
		];
		for (const mode of ["normal", "ask", "readonly"]) {
			await app.command("permissions", mode);
			for (const command of routes) {
				const result = await run(command);
				assert.doesNotMatch(result.text, /SECRET/, `${mode}: ${command}`);
				// bubblewrap ではファイルが /dev/null に見え、読むと空で成功する。
				if (process.platform === "darwin" || command.includes("id_test") || command.includes("credentials")) assert.equal(result.ok, false, `${mode}: ${command}`);
			}
			assert.deepEqual((await run("ls -la ~ > /dev/null && ls -A ~ && cat ~/notes.txt")).text.split("\n").filter((name) => /^(\.ssh|\.env|\.zshenv|\.aws|plain)$/.test(name)), [".aws", ".env", ".ssh", ".zshenv", "plain"], mode);
		}
		// 隠したのは sandbox の中の見え方だけで、実物は残っている。
		for (const path of secrets) assert.equal(readFileSync(path, "utf8"), "SECRET\n");
		await app.emit("session_shutdown");
		await app.command("permissions", "full");
		for (const command of routes.slice(0, 7)) assert.equal((await run(command)).text, "SECRET\n", command);
	} finally {
		for (const name of [".ssh", ".env", ".zshenv", ".aws"]) rmSync(join(home, name), { recursive: true, force: true });
	}
});

test("normalでは/tmpと/var/tmpに書け、readonlyでは書けない", { skip: cannotRun }, async () => {
	EXTRA_WRITE_PATHS.unshift(...sharedTmp);
	const shared = ["/tmp", "/var/tmp"].map((path) => mkdtempSync(join(path, "guard-shared-")));
	// Linux ではテスト用の HOME が /tmp の下にある。読ませない場所を含む /tmp が書ける場所から外れるので、よそへ向ける。
	const home = process.env.HOME;
	process.env.HOME = "/nonexistent";
	try {
		const root = dir("shared", "project");
		// Linux では root も一時ディレクトリも /tmp の中にあり、/tmp に畳まれて並びが変わる。
		for (const path of ["/tmp", "/var/tmp"]) assert.ok(writeRoots("normal", root, "").includes(realpathSync(path)), path);
		const app = extensionHost();
		guard(app.pi);
		app.ctx.cwd = root;
		await app.emit("session_start");
		const bash = app.registeredTools.get("bash")!;
		const write = async (): Promise<boolean[]> => {
			const results = [];
			for (const path of shared) results.push(!(await bash.execute("call-1", { command: `echo x >> ${path}/file.txt` }, undefined, undefined, app.ctx)).isError);
			return results;
		};
		assert.deepEqual(await write(), [true, true]);
		await app.command("permissions", "readonly");
		assert.deepEqual(await write(), [false, false]);
		await app.emit("session_shutdown");
	} finally {
		process.env.HOME = home;
		EXTRA_WRITE_PATHS.splice(0, 2);
		for (const path of shared) rmSync(path, { recursive: true, force: true });
	}
});
