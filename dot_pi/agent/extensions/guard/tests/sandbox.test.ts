import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import guard from "../index.ts";
import { bwrap, containsHome, fileOperations, gitCommonDir, gitLocks, inside, readDenied, sandboxArgv, SANDBOX_NOT_STARTED, sandboxAvailable, seatbelt, SHARED_TMP_PATHS, wrap, writeRoots } from "../sandbox.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

// 本物の HOME と一時ディレクトリを root にしない。os.tmpdir() の下に作った「外」が外でなくなる。
// 表の /tmp と /var/tmp も同じ理由で外す (Linux では os.tmpdir() が /tmp)。中身は専用のテストで戻して確かめる。
const sharedTmp = SHARED_TMP_PATHS.splice(0);
const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-sandbox-")));
const dir = (...parts: string[]) => {
	const path = join(base, ...parts);
	mkdirSync(path, { recursive: true });
	return path;
};
process.env.TMPDIR = dir("tmp");
process.env.HOME = dir("home");
delete process.env.PI_GUARD;
after(() => rmSync(base, { recursive: true, force: true }));

/** submodule を 2 つ (`sm` と、名前に / を含む `lib/deep`) 持つリポジトリ。 */
function withSubmodules(name: string): { repo: string; git: string } {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "protocol.file.allow=always", ...args], { stdio: "ignore" });
	const source = dir(name, "source");
	git(source, "init", "-q");
	git(source, "commit", "-q", "--allow-empty", "-m", "init");
	const repo = dir(name, "repo");
	git(repo, "init", "-q");
	git(repo, "submodule", "add", "-q", source, "sm");
	git(repo, "submodule", "add", "-q", source, "lib/deep");
	git(repo, "commit", "-q", "-m", "submodules");
	return { repo, git: join(repo, ".git") };
}

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

test("道具が黙って書く先は書けるが、sandboxの外で次に実行されるものまでは開けない", () => {
	const home = process.env.HOME!;
	const root = dir("roots", "tools");
	const writable = [
		dir("home", ".cargo", "registry"), dir("home", ".cargo", "git"),
		dir("home", ".local", "share", "uv"), dir("home", ".local", "share", "pipx"), dir("home", ".local", "share", "mise"),
		dir("home", "go", "pkg", "mod"), dir("home", ".bun", "install", "cache"), dir("home", ".config", "gh"),
		join(dir("home", ".config", "chezmoi"), "chezmoistate.boltdb"),
	];
	const closed = [
		dir("home", ".cargo", "bin"), join(home, ".cargo", "config.toml"), dir("home", ".local", "share", "other"), join(home, ".local", "bin", "tool"),
		dir("home", "go", "bin"), dir("home", ".bun", "bin"), join(home, ".config", "chezmoi", "chezmoi.toml"), join(home, ".config", "other"),
	];
	try {
		writeFileSync(writable.at(-1)!, "");
		const roots = writeRoots("normal", root, "");
		for (const path of writable) assert.ok(roots.includes(path), path);
		for (const path of writable) assert.equal(inside(roots, join(path, path.endsWith(".boltdb") ? "" : "file")), true, path);
		for (const path of closed) assert.equal(inside(roots, path), false, path);
		assert.deepEqual(writeRoots("readonly", root, dir("roots", "tools-scratch")), [join(base, "roots", "tools-scratch")]);
	} finally {
		for (const name of [".cargo", ".local", "go", ".bun", ".config"]) rmSync(join(home, name), { recursive: true, force: true });
	}
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

test("/reloadでモジュールが評価し直されても、gitのcommon dirは最初の答えを使い続ける", async () => {
	const victim = dir("reload", "victim");
	const root = dir("reload", "project");
	for (const repo of [victim, root]) execFileSync("git", ["-C", repo, "init"], { stdio: "ignore" });
	assert.equal(gitCommonDir(root), join(root, ".git"));
	writeFileSync(join(root, ".git", "commondir"), `${join(victim, ".git")}\n`);
	// Pi は拡張を moduleCache: false で読み直す。別のモジュール実体として読み込んで同じ状況を作る。
	const reloaded: typeof import("../sandbox.ts") = await import("../sandbox.ts?reload");
	assert.notEqual(reloaded.gitCommonDir, gitCommonDir);
	assert.equal(reloaded.gitCommonDir(root), join(root, ".git"));
	// まだ訊いていない root は、読み直した後でも訊ける。
	assert.equal(reloaded.gitCommonDir(victim), join(victim, ".git"));
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
	assert.equal(sandboxArgv([], [], [], "darwin")?.[0], "/usr/bin/sandbox-exec");
	// bubblewrap が無いホスト (macOS) では無し。
	assert.equal(sandboxArgv([], [], [], "linux")?.[0], ["/usr/bin/bwrap", "/bin/bwrap"].find((path) => existsSync(path)));
	assert.equal(sandboxArgv([], [], [], "win32"), undefined);
});

test("モデルのコマンドはシェル文字列に埋めず環境変数で渡す", () => {
	const command = `echo "it's" > 'out file'; $(touch pwned)`;
	const wrapped = wrap({ command, cwd: "/work", env: { KEEP: "1" } }, ["sandbox", "-p", "it's (a) profile"]);
	assert.ok(wrapped.command.includes(`'sandbox' '-p' 'it'\\''s (a) profile' /bin/bash -c `), wrapped.command);
	assert.ok(!wrapped.command.includes("pwned"));
	assert.deepEqual(wrapped.env, { KEEP: "1", PI_GUARD_COMMAND: command });
	assert.equal(wrapped.cwd, "/work");
});

test("sandboxが起動しなかったときは、コマンドの失敗と区別して何も実行されていないと伝える", () => {
	const marker = join(dir("start"), "ran");
	const run = (argv: string[], command: string) => {
		const wrapped = wrap({ command, cwd: base, env: { ...process.env } }, argv);
		return spawnSync("/bin/bash", ["-c", wrapped.command], { cwd: wrapped.cwd, env: wrapped.env, encoding: "utf8" });
	};
	// 起動できた sandbox の代わりに env を挟む。コマンドの終了コードと出力はそのまま返り、印は混ざらない。
	const failed = run(["/usr/bin/env"], `echo out; echo err >&2; touch ${marker}; exit 3`);
	assert.deepEqual([failed.status, failed.stdout, failed.stderr], [3, "out\n", "err\n"]);
	assert.equal(existsSync(marker), true);
	rmSync(marker);
	assert.equal(run(["/usr/bin/env"], "sleep 0.2; exit 0").status, 0);
	// 継いだ fd はコマンドに見せない。
	assert.equal(run(["/usr/bin/env"], "echo leak >&3 || echo leak >&4").stdout, "");

	// 最後のは、何も走らせずに 0 で終わる launcher。成功に見せない。
	for (const argv of [["/nonexistent/sandbox"], ["/bin/sh", "-c", "echo launcher: no namespaces >&2; exit 1", "--"], ["/bin/sh", "-c", ":", "--"]]) {
		const result = run(argv, `touch ${marker}`);
		assert.notEqual(result.status, 0);
		assert.ok(result.stderr.includes(SANDBOX_NOT_STARTED), result.stderr);
		assert.match(SANDBOX_NOT_STARTED, /did not start.*nothing was executed/i);
		assert.equal(existsSync(marker), false);
	}
});

test("edit/writeのファイルI/Oも、sandboxが起動しなかったときは何も読み書きされていないと伝える", async () => {
	const target = join(dir("io-start"), "file.txt");
	const failure = (run: Promise<unknown>): Promise<string> => run.then(() => "resolved", (error: Error) => error.message);
	// 3 つ目は、何も走らせずに 0 で終わる launcher。書けたことにしない。
	// 最後のは、印を書く fd を渡さない launcher。印が届かないまま読み書きだけ済ませると、伝える文が嘘になる。
	for (const argv of [["/nonexistent/sandbox"], ["/bin/sh", "-c", "echo launcher: no namespaces >&2; exit 1", "--"], ["/bin/sh", "-c", ":", "--"], ["/bin/sh", "-c", 'exec 3>&-; exec "$@"', "--"]]) {
		const io = fileOperations(argv);
		for (const run of [() => io.writeFile(target, "x"), () => io.mkdir(join(base, "io-start", "sub")), () => io.readFile(target), () => io.access(target)]) {
			assert.ok((await failure(run())).includes(SANDBOX_NOT_STARTED), argv.join(" "));
		}
	}
	assert.equal(await failure(fileOperations(["/bin/sh", "-c", "echo launcher: no namespaces >&2; exit 1", "--"]).writeFile(target, "x")), `launcher: no namespaces\n${SANDBOX_NOT_STARTED}`);
	assert.deepEqual(readdirSync(join(base, "io-start")), []);

	// 起動できた sandbox の代わりに env を挟む。中の道具の失敗は、起動の失敗と混ぜない。
	const io = fileOperations(["/usr/bin/env"]);
	const missing = await failure(io.readFile(target));
	assert.match(missing, /No such file/);
	assert.ok(!missing.includes(SANDBOX_NOT_STARTED), missing);
	assert.equal((await io.access(target).catch((error: NodeJS.ErrnoException) => error)).code, "ENOENT");
	await io.writeFile(target, "written\n");
	assert.equal(String(await io.readFile(target)), "written\n");
	await io.access(target);
});

test("edit/writeのファイルI/Oは道具を絶対パスで呼び、Piの環境変数を中に渡さない", async () => {
	const work = dir("io-tools");
	const target = join(work, "file.txt");
	// PATH の先頭に同名の偽物がある sandbox に見立てる (root 配下の node_modules/.bin など)。
	const fake = dir("io-tools", "bin");
	for (const name of ["cat", "mkdir"]) writeFileSync(join(fake, name), "#!/bin/sh\necho HIJACKED\n", { mode: 0o755 });
	const io = fileOperations(["/usr/bin/env", `PATH=${fake}`]);
	await io.mkdir(join(work, "made", "deep"));
	assert.equal(statSync(join(work, "made", "deep")).isDirectory(), true);
	await io.writeFile(target, "content\n");
	assert.equal(readFileSync(target, "utf8"), "content\n");
	assert.equal(String(await io.readFile(target)), "content\n");

	// launcher が受け取る環境変数を書き出させる。Pi が持っている秘密も、BASH_ENV のようにシェルの動きを変えるものも渡らない。
	const seen = join(work, "env.txt");
	process.env.GUARD_TEST_SECRET = "leaked";
	try {
		await fileOperations(["/bin/sh", "-c", `/usr/bin/env > '${seen}'; exec "$@"`, "--"]).readFile(target);
	} finally {
		delete process.env.GUARD_TEST_SECRET;
	}
	const names = readFileSync(seen, "utf8").split("\n").map((line) => line.split("=")[0]);
	for (const name of ["GUARD_TEST_SECRET", "HOME", "PATH", "TMPDIR"]) assert.ok(!names.includes(name), name);
});

test("読ませない場所は無くても数え、symlinkならリンク先も数える", () => {
	const home = process.env.HOME!;
	// この時点では .ssh も .env も .zshenv も無い。
	assert.deepEqual(readDenied(), [".ssh", ".env", ".zshenv", ".aws", ".netrc", ".git-credentials", ".pypirc"].map((name) => join(home, name)));
	symlinkSync(dir("denied", "aws"), join(home, ".aws"));
	try {
		assert.deepEqual(readDenied().slice(3, 6), [join(home, ".aws"), join(base, "denied", "aws"), join(home, ".netrc")]);
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

test("gitのhooks・config・commondirと、worktreeの.gitファイルは書かせない場所として数える", () => {
	const repo = dir("locks", "repo");
	execFileSync("git", ["-C", repo, "init"], { stdio: "ignore" });
	execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
	const git = join(repo, ".git");
	const common = [
		{ path: join(git, "hooks"), directory: true },
		{ path: join(git, "config"), directory: false },
		{ path: join(git, "commondir"), directory: false },
	];
	assert.deepEqual(gitLocks(repo, git), common);
	// サブディレクトリが root でも、common dir の分は変わらない。
	assert.deepEqual(gitLocks(dir("locks", "repo", "sub"), git), common);
	const linked = join(base, "locks", "linked");
	execFileSync("git", ["-C", repo, "worktree", "add", linked], { stdio: "ignore" });
	assert.deepEqual(gitLocks(linked, git), [...common, { path: join(linked, ".git"), directory: false }]);
	assert.deepEqual(gitLocks(dir("locks", "plain"), undefined), []);
});

test("rootの下にある別のリポジトリと、起動後にgit initされたrootも、書かせない場所として数える", () => {
	const own = (git: string) => [
		{ path: join(git, "hooks"), directory: true },
		{ path: join(git, "config"), directory: false },
		{ path: join(git, "commondir"), directory: false },
	];
	// リポジトリでないディレクトリに、リポジトリをいくつか収めている。root から訊いた common dir は無い。
	const workspace = dir("nested", "workspace");
	const app = dir("nested", "workspace", "app");
	const deep = dir("nested", "workspace", "org", "team", "lib");
	const deeper = dir("nested", "workspace", "a", "b", "c", "d");
	for (const repo of [app, deep, deeper]) execFileSync("git", ["-C", repo, "init"], { stdio: "ignore" });
	// symlink は辿らない。root の中から好きな場所を歩かせない。
	const elsewhere = dir("nested", "elsewhere");
	execFileSync("git", ["-C", elsewhere, "init"], { stdio: "ignore" });
	symlinkSync(elsewhere, join(workspace, "link"));
	// 探すのは root から 3 段下まで。それより深いリポジトリは数えない (README の「できないこと」)。
	assert.deepEqual(gitLocks(workspace, undefined), [...own(join(app, ".git")), ...own(join(deep, ".git"))]);

	// 起動したときはリポジトリでなかった root。common dir の答えは「無い」のまま変わらないが、塞ぐ側は呼ぶたびに見直す。
	const late = dir("nested", "late");
	assert.equal(gitCommonDir(late), undefined);
	assert.deepEqual(gitLocks(late, gitCommonDir(late)), []);
	execFileSync("git", ["-C", late, "init"], { stdio: "ignore" });
	assert.equal(gitCommonDir(late), undefined);
	assert.deepEqual(gitLocks(late, gitCommonDir(late)), own(join(late, ".git")));
});

test("submoduleのgit dirにあるconfigとhooksも書かせない場所として数え、一度数えたものは外さない", () => {
	const { repo, git } = withSubmodules("modlocks");
	const modules = join(repo, ".git", "modules");
	const own = (name: string) => [{ path: join(modules, name, "hooks"), directory: true }, { path: join(modules, name, "config"), directory: false }];
	// 名前に / を含む submodule は modules の下で入れ子のディレクトリになる。
	assert.deepEqual(gitLocks(repo, git).slice(3), [...own("lib/deep"), ...own("sm")]);
	// 目印の HEAD は sandbox の中から消せる。消した次の呼び出しで外れると、2 回に分ければ config を書ける。
	rmSync(join(modules, "sm", "HEAD"));
	assert.deepEqual(gitLocks(repo, git).slice(3), [...own("lib/deep"), ...own("sm")]);
});

test("bwrapは書かせない場所を読み取り専用で重ね直し、親をmount pointにしてrenameで外せなくする", () => {
	const git = dir("lockargs", "repo", ".git");
	const hooks = dir("lockargs", "repo", ".git", "hooks");
	const config = join(git, "config");
	writeFileSync(config, "");
	const root = join(base, "lockargs", "repo");
	const locks = [{ path: hooks, directory: true }, { path: config, directory: false }, { path: join(git, "commondir"), directory: false }];
	assert.deepEqual(bwrap([root], [], locks).slice(3, -8), [
		"--bind-try", root, root,
		"--bind", git, git,
		"--ro-bind", hooks, hooks,
		"--ro-bind", config, config,
	]);
	// 無い hooks は空の読み取り専用ディレクトリを重ねる (中に hook を作らせない)。無いファイルは重ねられないので飛ばす。
	rmSync(hooks, { recursive: true });
	assert.deepEqual(bwrap([root], [], locks).slice(6, -8), ["--bind", git, git, "--tmpfs", hooks, "--remount-ro", hooks, "--ro-bind", config, config]);
	// hooks が symlink なら、その名前には重ねられない。リンク先を読み取り専用にする。
	symlinkSync(dir("lockargs", "shared-hooks"), hooks);
	assert.deepEqual(bwrap([root], [], locks).slice(9, 12), ["--ro-bind", join(base, "lockargs", "shared-hooks"), join(base, "lockargs", "shared-hooks")]);
	rmSync(hooks);
	// 切れた symlink には何も重ねられない (重ねようとすると起動に失敗して、どのコマンドも走らなくなる)。飛ばす。
	symlinkSync(join(base, "lockargs", "gone"), hooks);
	assert.deepEqual(bwrap([root], [], locks).slice(6, -8), ["--bind", git, git, "--ro-bind", config, config]);
	rmSync(hooks);
	// 書ける場所の外にある親は mount point にしない (bind すると書けるようになる)。そこでは無い hooks の mount 先も作れない。
	assert.deepEqual(bwrap([join(base, "lockargs", "elsewhere")], [], locks).slice(6, -8), ["--ro-bind", config, config]);
});

test("seatbeltは書かせない場所への書き込みと、その親のrenameを拒否する", () => {
	const profile = seatbelt(["/work/project"], ["/home/me/.ssh"], [{ path: "/work/project/.git/hooks", directory: true }, { path: "/work/project/.git/config", directory: false }]).split("\n");
	const at = profile.indexOf('(deny file-write* (subpath "/work/project/.git/hooks") (subpath "/work/project/.git/config"))');
	assert.ok(at > profile.indexOf('\t(subpath "/work/project")'), profile.join("\n"));
	assert.equal(profile[at + 1], '(deny file-write-unlink (literal "/work/project/.git"))');
	assert.ok(at < profile.length - 2);
	assert.doesNotMatch(seatbelt(["/work/project"], [], []), /deny file-write-unlink/);
	// submodule の config までの祖先は全部動かせなくする。直接の親だけだと `.git/modules` を rename して作り直せる。
	const nested = seatbelt(["/work/project"], [], [{ path: "/work/project/.git/modules/lib/deep/config", directory: false }]);
	assert.match(nested, /^\(deny file-write-unlink \(literal "\/work\/project\/\.git"\) \(literal "\/work\/project\/\.git\/modules"\) \(literal "\/work\/project\/\.git\/modules\/lib"\) \(literal "\/work\/project\/\.git\/modules\/lib\/deep"\)\)$/m);
	// 親が書ける場所そのもの (linked worktree の .git ファイル) なら、動かせなくする祖先は無い。空の規則は書かない。
	assert.doesNotMatch(seatbelt(["/work/linked"], [], [{ path: "/work/linked/.git", directory: false }]), /deny file-write-unlink/);
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
	// pgrep はホスト全体を数える。秒数を固定すると、同じテストを並べて走らせている別のプロセスの sleep まで拾う。
	const nap = `sleep 61.${process.pid}`;
	const alive = () => {
		try {
			return execFileSync("pgrep", ["-fx", nap], { encoding: "utf8" });
		} catch {
			return "";
		}
	};
	const pending = bash.execute("call-1", { command: `${nap} & ${nap}`, timeout: 2 }, undefined, undefined, app.ctx).then((result: { content: Array<{ text: string }> }) => result.content[0].text, String);
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
	// 名前に持ち主の pid を入れる。クラッシュで残ったものを、次に起動した Pi が見分けて掃除する。
	assert.ok(scratch.startsWith(join(process.env.TMPDIR!, `pi-guard-${process.pid}-`)), scratch);
	assert.equal(statSync(scratch).mode & 0o777, 0o700);
	assert.equal((await run(devices)).text, "b\nc\nd\nE\nF\n");
	assert.equal(readFileSync(join(scratch, "scratch.txt"), "utf8"), "tmp\n");
	await app.emit("session_shutdown");
	assert.equal(existsSync(scratch), false);

	await app.command("permissions", "full");
	assert.equal((await run(`echo out > ${outside}/full.txt`)).ok, true);
});

test("ほかの拡張が自分で起こすコマンドも、guardに準備を頼めばbashツールと同じsandboxの中で走る", { skip: cannotRun }, async () => {
	const root = dir("channel", "project");
	const outside = dir("channel", "outside");
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start");
	// 頼む側 (verify など) がすること。返事は emit の中で来て、返ってきた形をそのまま起こす。
	const run = (command: string): { ok: boolean; text: string } => {
		let answer: { command: string; cwd: string; env: NodeJS.ProcessEnv } | { error: string } | undefined;
		app.pi.events.emit("guard:bash", { command, cwd: root, env: process.env, reply: (given: typeof answer) => (answer = given) });
		assert.ok(answer, "返事は emit から戻る前に来る");
		if ("error" in answer) return { ok: false, text: answer.error };
		const result = spawnSync("/bin/bash", ["-c", answer.command], { cwd: answer.cwd, env: answer.env, encoding: "utf8" });
		return { ok: result.status === 0, text: result.stdout + result.stderr };
	};
	assert.equal(run("echo in > inside.txt && cat inside.txt").text, "in\n");
	assert.equal(run(`echo out > ${outside}/normal.txt`).ok, false);
	assert.equal(existsSync(join(outside, "normal.txt")), false);

	await app.command("permissions", "readonly");
	assert.equal(run("echo ro > readonly.txt").ok, false);
	assert.equal(existsSync(join(root, "readonly.txt")), false);
	assert.equal(run('echo tmp > "$TMPDIR/scratch.txt"').ok, true);
	await app.emit("session_shutdown");

	await app.command("permissions", "full");
	assert.equal(run(`echo out > ${outside}/full.txt`).ok, true);
	// 固定の forbid はどのモードでも効く。頼んだ側には、準備の代わりに理由が返る。
	assert.match(run(`git push --force origin main; echo ran > ${outside}/forbidden.txt`).text, /^guard\[git-force-push\]/);
	assert.equal(existsSync(join(outside, "forbidden.txt")), false);
});

test("sandboxの中からは.git/hooksと.git/configを書けず、commitなどの普段の操作は通る", { skip: cannotRun }, async () => {
	const root = dir("gitlock", "project");
	const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "init");
	const linked = join(base, "gitlock", "linked");
	git("worktree", "add", "-q", linked);
	const config = readFileSync(join(root, ".git", "config"), "utf8");
	const session = async (cwd: string) => {
		const app = extensionHost();
		guard(app.pi);
		app.ctx.cwd = cwd;
		await app.emit("session_start");
		const bash = app.registeredTools.get("bash")!;
		const run = async (command: string): Promise<{ ok: boolean; text: string }> => {
			const result = await bash.execute("call-1", { command }, undefined, undefined, app.ctx);
			return { ok: !result.isError, text: result.content[0].text };
		};
		return { app, run };
	};
	const attacks = [
		"echo 'touch pwned' > .git/hooks/pre-commit", "mkdir -p .git/hooks && echo x > .git/hooks/post-checkout", "mv .git/hooks .git/hooks.old",
		"rm -rf .git/hooks/* && rmdir .git/hooks", "git config core.hooksPath /tmp", "echo '[core]' >> .git/config", "cp .git/config c && mv c .git/config",
		"mv .git .git.old", "git config alias.x '!touch pwned'",
	];

	const main = await session(root);
	for (const command of attacks) assert.equal((await main.run(command)).ok, false, command);
	assert.equal(readFileSync(join(root, ".git", "config"), "utf8"), config);
	// 失敗した書き込みが lock を残すと、ホスト側の次の設定変更が止まる。
	assert.equal(existsSync(join(root, ".git", "config.lock")), false);
	assert.deepEqual(readdirSync(join(root, ".git", "hooks")).filter((name) => !name.endsWith(".sample")), []);
	const work = "echo a > a.txt && git add a.txt && git -c user.name=t -c user.email=t@example.com commit -q -m a && git checkout -q -b topic && git stash list && git log --oneline | wc -l";
	const done = await main.run(work);
	assert.equal(done.text.trim(), "2", done.text);
	// upstream の設定は config に書けないのに、git は成功の文面と終了コード 0 を返す (README に書いてある挙動)。
	const tracked = await main.run("git branch -u @{-1} 2>&1; echo code=$?");
	assert.match(tracked.text, /could not write config file[\s\S]*set up to track[\s\S]*code=0/);
	assert.equal(readFileSync(join(root, ".git", "config"), "utf8"), config);
	// hooks が無いリポジトリでも、後から作って仕込めない。
	rmSync(join(root, ".git", "hooks"), { recursive: true });
	assert.equal((await main.run("mkdir -p .git/hooks && echo x > .git/hooks/pre-commit")).ok, false);
	assert.deepEqual(readdirSync(join(root, ".git", "hooks")), []);
	// hooks が切れた symlink (共有の hooks へ向けていて、その先が消えた) でも、sandbox は起動する。
	rmSync(join(root, ".git", "hooks"), { recursive: true });
	symlinkSync(join(base, "gitlock", "gone"), join(root, ".git", "hooks"));
	assert.deepEqual(await main.run("echo hello"), { ok: true, text: "hello\n" });
	rmSync(join(root, ".git", "hooks"));
	mkdirSync(join(root, ".git", "hooks"));
	// readonly では元から書けない。full は囲わない。
	await main.app.command("permissions", "readonly");
	assert.equal((await main.run(attacks[0])).ok, false);
	await main.app.command("permissions", "full");
	assert.equal((await main.run("echo x > .git/hooks/full-mode && rm .git/hooks/full-mode")).ok, true);
	await main.app.emit("session_shutdown");

	// linked worktree。common dir は root の外にあり、root の .git はファイル。
	const other = await session(linked);
	for (const command of [`echo x > ${root}/.git/hooks/pre-commit`, `git config core.hooksPath /tmp`, "echo 'gitdir: /tmp/elsewhere' > .git", "rm .git", "mv .git dotgit"]) {
		assert.equal((await other.run(command)).ok, false, command);
	}
	const commit = await other.run("echo b > b.txt && git add b.txt && git -c user.name=t -c user.email=t@example.com commit -q -m b && git log --oneline | wc -l");
	assert.equal(commit.text.trim(), "2", commit.text);
	assert.equal(readFileSync(join(root, ".git", "config"), "utf8"), config);
	assert.equal(existsSync(join(root, ".git", "config.lock")), false);
	await other.app.emit("session_shutdown");
});

test("sandboxの中からは、rootの下にある別のリポジトリと、起動後にgit initしたrootのhooksとconfigも書けない", { skip: cannotRun }, async () => {
	const session = async (cwd: string) => {
		const app = extensionHost();
		guard(app.pi);
		app.ctx.cwd = cwd;
		await app.emit("session_start");
		const bash = app.registeredTools.get("bash")!;
		const run = async (command: string): Promise<{ ok: boolean; text: string }> => {
			const result = await bash.execute("call-1", { command }, undefined, undefined, app.ctx);
			return { ok: !result.isError, text: result.content[0].text };
		};
		return { app, run };
	};
	const workspace = dir("nestlock", "workspace");
	const repo = dir("nestlock", "workspace", "app");
	execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
	const config = readFileSync(join(repo, ".git", "config"), "utf8");
	const parent = await session(workspace);
	for (const command of ["echo 'touch pwned' > app/.git/hooks/pre-commit", "git -C app config core.fsmonitor 'touch pwned'", "mv app/.git app/.git.old", "mv app app.old"]) {
		assert.equal((await parent.run(command)).ok, false, command);
	}
	assert.equal(readFileSync(join(repo, ".git", "config"), "utf8"), config);
	assert.equal(existsSync(join(repo, ".git", "hooks", "pre-commit")), false);
	const commit = await parent.run("cd app && echo a > a.txt && git add a.txt && git -c user.name=t -c user.email=t@example.com commit -q -m a && git log --oneline | wc -l");
	assert.equal(commit.text.trim(), "1", commit.text);
	await parent.app.emit("session_shutdown");

	// リポジトリでない root で起動して、sandbox の中で git init する。作った呼び出しの間は塞げないが、次の呼び出しからは塞ぐ。
	const late = await session(dir("nestlock", "late"));
	assert.equal((await late.run("git init -q")).ok, true);
	const attacks = ["echo 'touch pwned' > .git/hooks/pre-commit", "git config core.fsmonitor 'touch pwned'"];
	for (const command of attacks) assert.equal((await late.run(command)).ok, false, command);
	await late.app.emit("session_start", { reason: "reload" });
	for (const command of attacks) assert.equal((await late.run(command)).ok, false, command);
	assert.deepEqual(readdirSync(join(base, "nestlock", "late", ".git", "hooks")).filter((name) => !name.endsWith(".sample")), []);
	await late.app.emit("session_shutdown");
});

test("sandboxの中からはsubmoduleのgit dirのhooksとconfigも書けず、submoduleの中のcommitは通る", { skip: cannotRun }, async () => {
	const { repo } = withSubmodules("modlock");
	const outside = dir("modlock", "outside");
	const config = readFileSync(join(repo, ".git", "modules", "sm", "config"), "utf8");
	const head = readFileSync(join(repo, ".git", "modules", "sm", "HEAD"), "utf8");
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = repo;
	await app.emit("session_start");
	const bash = app.registeredTools.get("bash")!;
	const run = async (command: string): Promise<{ ok: boolean; text: string }> => {
		const result = await bash.execute("call-1", { command }, undefined, undefined, app.ctx);
		return { ok: !result.isError, text: result.content[0].text };
	};
	const evil = `printf '[core]\\n\\tfsmonitor = "touch ${outside}/PWNED; false"\\n'`;
	const attacks = [
		`${evil} >> .git/modules/sm/config`, "echo x > .git/modules/sm/hooks/post-checkout", `${evil} >> .git/modules/lib/deep/config`,
		"git -C sm config core.hooksPath /tmp", "mv .git/modules/sm/hooks .git/modules/sm/hooks.old", "mv .git/modules/sm .git/modules/sm.old",
		// 直接の親だけ動かせなくしても、その上を動かして同じ名前で作り直せる。
		`mv .git/modules .git/modules.old && mkdir -p .git/modules/sm && cp -r .git/modules.old/sm/. .git/modules/sm/ && ${evil} >> .git/modules/sm/config`,
		"mv .git/modules/lib .git/modules/lib.old",
		// 目印の HEAD を消しても、次の呼び出しで外れない。
		"rm .git/modules/sm/HEAD", `${evil} >> .git/modules/sm/config`,
	];
	for (const command of attacks.slice(0, -2)) assert.equal((await run(command)).ok, false, command);
	await run(attacks.at(-2)!);
	assert.equal((await run(attacks.at(-1)!)).ok, false);
	writeFileSync(join(repo, ".git", "modules", "sm", "HEAD"), head);
	assert.equal(readFileSync(join(repo, ".git", "modules", "sm", "config"), "utf8"), config);
	assert.equal(existsSync(join(repo, ".git", "modules", "sm", "config.lock")), false);
	// ホスト側の git が submodule の config を読んでも、外には何も出来ていない。
	execFileSync("git", ["-C", repo, "status", "--porcelain"], { stdio: "ignore" });
	assert.deepEqual(readdirSync(outside), []);
	const work = "cd sm && echo a > a.txt && git add a.txt && git -c user.name=t -c user.email=t@example.com commit -q -m a && git log --oneline | wc -l";
	const done = await run(work);
	assert.equal(done.text.trim(), "2", done.text);
	await app.emit("session_shutdown");
});

test("settings.jsonのshellPathとshellCommandPrefixは、sandboxの中で実行するシェルと先頭に足す行として効く", async () => {
	const root = dir("shell", "project");
	const shell = join(dir("home", "shell"), "wrapped-bash");
	writeFileSync(shell, '#!/bin/bash\nexport VIA_SHELL=yes\nexec /bin/bash "$@"\n', { mode: 0o755 });
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start");
	const bash = app.registeredTools.get("bash")!;
	const run = async (command: string): Promise<string> => (await bash.execute("call-1", { command }, undefined, undefined, app.ctx)).content[0].text;
	const command = `echo "shell=\${VIA_SHELL:-no} prefix=\${PREFIXED:-no}"; { echo x > ${base}/outside-shell.txt; } 2>/dev/null; true`;
	for (const mode of cannotRun ? ["full"] : ["full", "normal", "readonly"]) {
		await app.command("permissions", mode);
		for (const key of Object.keys(app.settings)) delete app.settings[key];
		assert.equal(await run(command), "shell=no prefix=no\n", mode);
		Object.assign(app.settings, { shellPath: "~/shell/wrapped-bash", shellCommandPrefix: "PREFIXED=yes\nexport PREFIXED" });
		assert.equal(await run(command), "shell=yes prefix=yes\n", mode);
		// 設定のシェルも sandbox の中で動く。書ける場所は変わらない。
		assert.equal(existsSync(join(base, "outside-shell.txt")), mode === "full", mode);
		rmSync(join(base, "outside-shell.txt"), { force: true });
	}
	await app.emit("session_shutdown");
});

test("full以外のbashは読ませない場所を読めず、ほかの読み取りはそのまま通る", { skip: cannotRun }, async () => {
	const home = process.env.HOME!;
	const root = dir("home", "deny-project");
	const target = dir("deny", "target");
	const secrets = [join(dir("home", ".ssh"), "id_test"), join(home, ".env"), join(home, ".zshenv"), join(target, "credentials"), join(home, ".git-credentials"), join(home, ".pypirc")];
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
			"cat ~/.git-credentials", "cat ~/.pypirc",
			"cp ~/.env copy.txt; cat copy.txt", "ls ~/.ssh", "grep -r SECRET ~/.ssh ~/.env ~/.zshenv ~/.aws ~/.git-credentials ~/.pypirc",
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
		for (const command of routes.slice(0, 9)) assert.equal((await run(command)).text, "SECRET\n", command);
	} finally {
		for (const name of [".ssh", ".env", ".zshenv", ".aws", ".git-credentials", ".pypirc"]) rmSync(join(home, name), { recursive: true, force: true });
	}
});

test("normalでは/tmpと/var/tmpに書け、readonlyでは書けない", { skip: cannotRun }, async () => {
	// 外してあるのは共有の一時ディレクトリの表だけで、キャッシュの表の並びには依らない。
	assert.deepEqual(sharedTmp, ["/tmp", "/var/tmp"]);
	for (const path of sharedTmp) assert.ok(!writeRoots("normal", dir("shared", "before"), "").includes(realpathSync(path)), path);
	SHARED_TMP_PATHS.push(...sharedTmp);
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
		SHARED_TMP_PATHS.splice(0);
		for (const path of shared) rmSync(path, { recursive: true, force: true });
	}
});

/** write / edit は失敗を例外で返す (bash と違い、結果の isError ではない)。 */
const attempt = (tool: { execute: Function }, input: Record<string, unknown>, ctx: unknown, id = "call-1"): Promise<{ ok: boolean; text: string }> =>
	tool.execute(id, input, undefined, undefined, ctx).then(
		(result: { content: Array<{ text: string }> }) => ({ ok: true, text: result.content[0].text }),
		(error: unknown) => ({ ok: false, text: String(error) }),
	);

test("writeは実際のsandboxの中で書き、判定を通らずに届いた呼び出しでもrootの外には書けない", { skip: cannotRun }, async () => {
	const root = dir("files", "project");
	const outside = dir("files", "outside");
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start");
	const write = app.registeredTools.get("write")!;
	const content = `it's "quoted" $HOME \\n 日本語\n末尾に改行なし`;

	assert.equal((await attempt(write, { path: "new/dir/file.txt", content }, app.ctx)).ok, true);
	assert.equal(readFileSync(join(root, "new", "dir", "file.txt"), "utf8"), content);
	// tool_call を通していない。判定がずれた・呼ばれなかったときに、書き込みを止めるのは OS の境界。
	const escaped = await attempt(write, { path: join(outside, "file.txt"), content }, app.ctx);
	assert.equal(escaped.ok, false);
	assert.equal(existsSync(join(outside, "file.txt")), false);
	// 判定の後で root の中に置かれた symlink 越しでも、書く先は解決後のパスで止まる。
	symlinkSync(outside, join(root, "escape"));
	assert.equal((await attempt(write, { path: "escape/file.txt", content }, app.ctx)).ok, false);
	assert.deepEqual(readdirSync(outside), []);
	// bash に書かせない git の場所は、write にも書かせない。
	execFileSync("git", ["-C", root, "init", "-q"]);
	assert.equal((await attempt(write, { path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" }, app.ctx)).ok, false);
	assert.equal(existsSync(join(root, ".git", "hooks", "pre-commit")), false);
	assert.equal((await attempt(write, { path: ".git/info/exclude", content: "x\n" }, app.ctx)).ok, true);

	await app.command("permissions", "readonly");
	assert.equal((await attempt(write, { path: "readonly.txt", content }, app.ctx)).ok, false);
	assert.equal(existsSync(join(root, "readonly.txt")), false);
	await app.emit("session_shutdown");

	await app.command("permissions", "full");
	assert.equal((await attempt(write, { path: join(outside, "full.txt"), content }, app.ctx)).ok, true);
	assert.equal(readFileSync(join(outside, "full.txt"), "utf8"), content);
});

test("確認で人が承認したedit/writeは、その呼び出しの、承認されたパスにだけsandboxの外で届く", { skip: cannotRun }, async () => {
	const root = dir("approved", "project");
	const outside = dir("approved", "outside");
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = root;
	await app.emit("session_start");
	const write = app.registeredTools.get("write")!;
	const edit = app.registeredTools.get("edit")!;
	const target = join(outside, "file.txt");
	const call = (toolName: string, toolCallId: string, input: Record<string, unknown>) => app.emit("tool_call", { toolName, toolCallId, input });

	app.approve(false);
	assert.equal(((await call("write", "denied", { path: target })) as { block: boolean }).block, true);
	assert.equal((await attempt(write, { path: target, content: "denied\n" }, app.ctx, "denied")).ok, false);

	app.approve(true);
	assert.equal(await call("write", "ok", { path: target }), undefined);
	// 承認の後で引数が変わっていたら (ほかの拡張の tool_call は input を書き換えられる)、承認されていないパスには届かない。
	assert.equal((await attempt(write, { path: join(outside, "other.txt"), content: "other\n" }, app.ctx, "ok")).ok, false);
	assert.equal(await call("write", "ok", { path: target }), undefined);
	assert.equal((await attempt(write, { path: target, content: "before\n" }, app.ctx, "ok")).ok, true);
	assert.equal(readFileSync(target, "utf8"), "before\n");
	// 承認は 1 回の呼び出しの分だけ。同じ id でもう一度は届かない。
	assert.equal((await attempt(write, { path: target, content: "again\n" }, app.ctx, "ok")).ok, false);
	assert.equal(await call("edit", "edit-ok", { path: target }), undefined);
	assert.equal((await attempt(edit, { path: target, edits: [{ oldText: "before", newText: "after" }] }, app.ctx, "edit-ok")).ok, true);
	assert.deepEqual(readdirSync(outside), ["file.txt"]);
	assert.equal(readFileSync(target, "utf8"), "after\n");
	// 承認の後で実行されずに終わった呼び出し (後ろの拡張が遮断した、実行の前に中断された) の承認は残さない。
	assert.equal(await call("write", "never-ran", { path: target }), undefined);
	await app.emit("tool_execution_end", { toolName: "write", toolCallId: "never-ran", result: {}, isError: true });
	assert.equal((await attempt(write, { path: target, content: "stale\n" }, app.ctx, "never-ran")).ok, false);
	assert.equal(readFileSync(target, "utf8"), "after\n");
});

test("子の確認の置き場には、sandboxの中のbashから答えを置けない", { skip: cannotRun }, async () => {
	const app = extensionHost();
	guard(app.pi);
	app.ctx.cwd = dir("asks", "project");
	await app.emit("session_start");
	const asks: string = JSON.parse(process.env.PI_GUARD!).ask;
	assert.ok(asks.startsWith(process.env.HOME!), asks);
	const bash = app.registeredTools.get("bash")!;
	for (const mode of ["normal", "ask", "readonly"]) {
		await app.command("permissions", mode);
		const result = await bash.execute("call-1", { command: `echo '{"approved":true}' > ${asks}/1-aa.answer` }, undefined, undefined, app.ctx);
		assert.equal(result.isError, true, mode);
	}
	assert.deepEqual(readdirSync(asks), []);
	await app.emit("session_shutdown");
});

test("editは実際のsandboxの中で読んで書き、rootの外と読ませない場所には届かない", { skip: cannotRun }, async () => {
	const home = process.env.HOME!;
	const root = dir("home", "edit-project");
	const outside = join(dir("edits", "outside"), "file.txt");
	const secret = join(dir("home", ".ssh"), "config");
	try {
		const app = extensionHost();
		guard(app.pi);
		app.ctx.cwd = root;
		await app.emit("session_start");
		const edit = app.registeredTools.get("edit")!;
		const edits = [{ oldText: "before", newText: "after" }];

		// BOM と CRLF を保つのは Pi の edit で、I/O を差し替えても変わらない。
		writeFileSync(join(root, "file.txt"), "﻿line 1\r\nbefore 日本語\r\n");
		assert.equal((await attempt(edit, { path: "file.txt", edits }, app.ctx)).ok, true);
		assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "﻿line 1\r\nafter 日本語\r\n");
		assert.match((await attempt(edit, { path: "missing.txt", edits }, app.ctx)).text, /Could not edit file: missing\.txt\. Error code: ENOENT/);

		writeFileSync(outside, "before\n");
		assert.match((await attempt(edit, { path: outside, edits }, app.ctx)).text, /Could not edit file: .*Error code: EACCES/);
		assert.equal(readFileSync(outside, "utf8"), "before\n");
		// 読ませない場所の中は、edit の I/O が動く sandbox からは無いように見える。隠していなければ、書けない場所として EACCES になる。
		writeFileSync(secret, "before SECRET\n");
		const denied = await attempt(edit, { path: secret, edits }, app.ctx);
		assert.match(denied.text, /Could not edit file: .*Error code: ENOENT/);
		assert.doesNotMatch(denied.text, /SECRET/);
		assert.equal(readFileSync(secret, "utf8"), "before SECRET\n");
		// 上の edit は読む前の確かめで止まっている (読ませない場所は書ける場所から必ず外れる)。読む段そのものも中身を返さないことは、
		// 同じ I/O を直に呼んで確かめる。隠さない sandbox なら読めるので、止めているのは読ませない場所の表。
		const read = (hidden: string[]) => fileOperations(sandboxArgv(writeRoots("normal", root, ""), hidden)!).readFile(secret).then(String, () => "");
		assert.doesNotMatch(await read(readDenied()), /SECRET/);
		assert.equal(await read([]), "before SECRET\n");

		await app.command("permissions", "full");
		assert.equal((await attempt(edit, { path: outside, edits }, app.ctx)).ok, true);
		assert.equal(readFileSync(outside, "utf8"), "after\n");
	} finally {
		rmSync(join(home, ".ssh"), { recursive: true, force: true });
	}
});
