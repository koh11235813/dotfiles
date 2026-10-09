/**
 * bash ツールを OS の境界に入れる部品。macOS は sandbox-exec (seatbelt)、Linux は bubblewrap を直接呼ぶ。
 *
 * 絞るのはファイルへの書き込みと、認証情報の置き場 (READ_DENIED_PATHS) の読み取り。それ以外の読み取りと
 * ネットワークは絞らない (ネットワークは全部か無しかしか選べず、無しでは開発にならない)。
 * 書ける場所は「何を書けるか」の表 (EXTRA_WRITE_PATHS) とセッションの root で決まり、判定の枠は index.ts が持つ。
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { PermissionMode } from "./permissions.ts";

const real = (path: string): string | undefined => {
	try {
		return realpathSync.native(path);
	} catch {
		return undefined;
	}
};

const gitCommonDirs = new Map<string, string | undefined>();

/**
 * root から見た git の common dir。git が無い、リポジトリでないときは無し。
 * root ごとに一度しか訊かない。答えは root の中の `.git` が決め、それは sandbox の中から書き換えられる。
 * 毎回訊き直すと、モデルが `.git` を他のリポジトリへ向け直して書ける場所を広げられる。
 * PATH に root 配下のディレクトリがあると `git` 自体も差し替えられるので、モデルが動く前 (セッション開始時) に呼ぶ。
 */
export function gitCommonDir(root: string): string | undefined {
	if (gitCommonDirs.has(root)) return gitCommonDirs.get(root);
	let dir: string | undefined;
	try {
		const out = execFileSync("git", ["-C", root, "rev-parse", "--git-common-dir"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		dir = resolve(root, out.trim());
	} catch {}
	gitCommonDirs.set(root, dir);
	return dir;
}

/**
 * root の外で書き込みを許す場所。root の中で作業していても道具が黙って書く先だけを並べる。
 * 無いパスは飛ばす。`~` そのものや、シェルの rc・`~/.ssh`・`~/.pi` を含む場所は足さない
 * (次に sandbox の外で動くものを書き換えられると境界の意味が無くなる)。
 */
export const EXTRA_WRITE_PATHS: Array<() => string | undefined> = [
	// モデルが一時ファイルの置き場として知っているのはこの 2 つで、$TMPDIR (macOS では /var/folders 配下) は使ってくれない。
	// 全ユーザー共有の場所だが、開けないと `/tmp/x` と決め打ちしたコマンドが軒並み失敗する。
	() => "/tmp",
	() => "/var/tmp",
	// XDG のキャッシュ。pip, uv, pnpm, go build (Linux), mise などが実行のたびに書く。
	() => join(homedir(), ".cache"),
	// npm install / npx のキャッシュとログ。
	() => join(homedir(), ".npm"),
	// macOS で ~/.cache の代わりに使われる場所。pip, go build, clang の module cache など。
	() => (process.platform === "darwin" ? join(homedir(), "Library", "Caches") : undefined),
];

/**
 * full 以外で読ませない場所。ファイルでもディレクトリでもよく、無くてもよい。
 * 普通の開発コマンドが読まない認証情報の置き場だけを並べる。`~/.gnupg` (commit の署名)、`~/.config/gh`、
 * `~/.git-credentials`、`~/.npmrc`、`~/.pi/agent/auth.json`、`.zshenv` 以外の rc は入れていない。
 * sandbox の中の git / gh / npm / シェルの起動がそれを読むので、塞ぐと正当な作業が止まる。
 * 止めるのはファイルを読むことだけ。Pi のプロセスが既に持っている環境変数 (`.zshenv` の中身が行き着く先) は
 * sandbox の中の `env` でそのまま見える。環境変数を削ると、それを当てにしている道具まで動かなくなる。
 */
export const READ_DENIED_PATHS: Array<() => string> = [
	// 秘密鍵。読めなくなるので、sandbox の中の ssh は鍵も config も known_hosts も使えない。
	() => join(homedir(), ".ssh"),
	() => join(homedir(), ".env"),
	() => join(homedir(), ".zshenv"),
	() => join(homedir(), ".aws"),
	() => join(homedir(), ".netrc"),
];

/**
 * 読ませない場所の、解決後のパス。無いものも落とさない (seatbelt の規則はパスが無くても書け、後から作られても読めない)。
 * symlink ならリンク先も足す。OS の境界が照合するのは解決後のパスで、リンク自体の名前だけ塞いでも中身は読める。
 */
export function readDenied(): string[] {
	return [
		...new Set(
			READ_DENIED_PATHS.flatMap((entry) => {
				const path = entry();
				const unresolved = join(real(dirname(path)) ?? dirname(path), basename(path));
				return [unresolved, real(path) ?? unresolved];
			}),
		),
	];
}

/**
 * root がホームディレクトリを含む (`/` や `~` で Pi を起動した)。
 * そのまま書けるようにすると `~/.ssh` もシェルの rc も書けて、sandbox が名前だけになる。
 */
export function containsHome(root: string): boolean {
	const home = real(homedir());
	const found = real(root);
	return !!home && !!found && within(found, home);
}

/**
 * そのモードで書ける場所。realpath 済みで、無いパスは落とす。
 * seatbelt は解決後のパスで照合するので、`/var/folders` のままでは `/private/var/folders` に当たらない。
 * git は gitCommonDir の結果。commit / fetch / worktree 操作が書く .git は、root が linked worktree や
 * リポジトリのサブディレクトリだと root の外にある。
 */
export function writeRoots(mode: Exclude<PermissionMode, "full">, root: string, scratch: string, git?: string): string[] {
	const paths =
		mode === "readonly" ? [scratch] : [containsHome(root) ? undefined : root, tmpdir(), git, ...EXTRA_WRITE_PATHS.map((entry) => entry())];
	// 読ませない場所と重なるものは書ける場所にしない (`~/.ssh` の中で Pi を起動した、リンク先が root の中にある)。
	// 中にあれば中身を書き換えられ、外側にあれば親ディレクトリごと rename して差し替えられる。
	const denied = readDenied();
	const found = [...new Set(paths.flatMap((path) => (path && real(path)) || []))].filter(
		(path) => !denied.some((entry) => within(entry, path) || within(path, entry)),
	);
	// 他の root の中にあるもの (普通のリポジトリの .git など) は重ねて書かない。
	return found.filter((path) => !found.some((other) => other !== path && within(other, path)));
}

const within = (root: string, target: string): boolean => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * path が roots のどれかの中か。path はまだ無くてもよい。
 * 存在する一番近い祖先を realpath するので、root の中の symlink が外を指していれば外と判定する。
 */
export function inside(roots: string[], path: string): boolean {
	// NUL を含むパスは realpath が失敗して祖先の判定に落ちる。書き込み側の解釈に賭けず、外として扱う。
	if (path.includes("\0")) return false;
	let rest = "";
	for (let current = path; ; current = dirname(current)) {
		const found = real(current);
		if (found) {
			return roots.some((root) => within(root, join(found, rest)));
		}
		// realpath は失敗するのに lstat は通る = 切れた symlink。書くとリンク先に作られるので、祖先に登らず外として扱う。
		try {
			lstatSync(current);
			return false;
		} catch {}
		if (dirname(current) === current) return false;
		rest = join(basename(current), rest);
	}
}

/**
 * seatbelt のプロファイル。後に書いた規則が勝つので、全部許可 → 書き込み拒否 → roots だけ再許可 →
 * denied の読み取り拒否の順。読み取り拒否を最後に置くのは、どの許可にも上書きさせないため。
 * /dev の節点はシェルのリダイレクト (`> /dev/null`, `>&2` 相当の `/dev/stderr`) と pty に要る。
 */
export function seatbelt(roots: string[], denied: string[]): string {
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		"(allow file-write*",
		// JSON の文字列は seatbelt の文字列リテラルとして読める (`"` と `\` を逆スラッシュで逃がす)。
		...roots.map((root) => `\t(subpath ${JSON.stringify(root)})`),
		'\t(literal "/dev/null")',
		'\t(literal "/dev/zero")',
		'\t(literal "/dev/tty")',
		'\t(literal "/dev/ptmx")',
		'\t(literal "/dev/dtracehelper")',
		'\t(regex #"^/dev/fd/")',
		'\t(regex #"^/dev/ttys[0-9]+$")',
		// macOS の /bin/bash (3.2) はヒアドキュメントの一時ファイルを TMPDIR を見ずに /var/tmp へ作る。
		// readonly では /var/tmp を開けていないので、その名前だけ通す。
		'\t(literal "/private/var/tmp")',
		'\t(regex #"^/private/var/tmp/sh-thd-[0-9]+$"))',
		// subpath はそのパス自身にも当たるので、ファイルとディレクトリを分けない (無いパスは種類が分からない)。
		// 入口そのものの stat だけ戻す。塞ぐと `ls -la ~` が失敗で終わる。中の一覧も、中のファイルの stat も通らないまま。
		...(denied.length > 0
			? [
					`(deny file-read* ${denied.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ")})`,
					`(allow file-read-metadata ${denied.map((path) => `(literal ${JSON.stringify(path)})`).join(" ")})`,
				]
			: []),
	].join("\n");
}

/**
 * bwrap の引数。`/` を読み取り専用で重ね、roots だけ書けるように重ね直す。--unshare-net は付けない。
 * denied は roots の後で隠す (後の mount が勝つ)。ディレクトリは空の tmpfs、ファイルは /dev/null を重ねるので、
 * seatbelt と違い読むと失敗せず空に見える。mount 先が要るので実在するものだけ。symlink のままの名前は
 * 重ねられないので飛ばし、リンク先 (readDenied が別に返す) を隠す。
 * --unshare-pid は --proc の前提 (user namespace の中で /proc を張り直すには pid namespace が要る) で、
 * 同時に sandbox の外のプロセスを ptrace して抜ける道を塞ぐ。
 * --new-session (端末への TIOCSTI 注入を塞ぐ) は --unshare-pid と --die-with-parent が前提。単独で付けると
 * 子が別のプロセスグループになり、Pi の時間切れ・中断の kill が届かずに残る (Arch で実測)。
 */
export function bwrap(roots: string[], denied: string[]): string[] {
	return [
		"--ro-bind", "/", "/",
		...roots.flatMap((root) => ["--bind-try", root, root]),
		...denied.flatMap((path) => {
			if (real(path) !== path) return [];
			return statSync(path).isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path];
		}),
		"--dev", "/dev",
		"--unshare-pid",
		"--proc", "/proc",
		"--die-with-parent",
		"--new-session",
		"--",
	];
}

/** sandbox を起動する argv。後ろに実行するコマンドを続ける。対応していない OS では無し。 */
export function sandboxArgv(roots: string[], denied: string[], platform: string = process.platform): string[] | undefined {
	if (platform === "darwin") return ["/usr/bin/sandbox-exec", "-p", seatbelt(roots, denied)];
	if (platform === "linux") {
		// PATH からは探さない。root 配下の PATH (node_modules/.bin など) に `bwrap` を置かれると sandbox ごと差し替わる。
		const binary = ["/usr/bin/bwrap", "/bin/bwrap"].find((path) => existsSync(path));
		return binary && [binary, ...bwrap(roots, denied)];
	}
	return undefined;
}

const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

/**
 * Pi が `bash -c` に渡すコマンドを sandbox 越しの実行に差し替える。
 * モデルのコマンドは環境変数で運ぶ。文字列に埋めると引用符の扱いを 1 つ誤っただけで sandbox の外で走る。
 * argv のほうは自分で作った文字列なので単引用符で包めば足りる。
 */
export function wrap<T extends { command: string; env: NodeJS.ProcessEnv }>(context: T, argv: string[]): T {
	return {
		...context,
		command: `exec ${argv.map(quote).join(" ")} /bin/bash -c "$PI_GUARD_COMMAND"`,
		env: { ...context.env, PI_GUARD_COMMAND: context.command },
	};
}

/** 覚えるのは成功だけ。失敗は次の呼び出しで試し直すので、bubblewrap を入れた後に Pi を起動し直さなくてよい。 */
export const sandbox = { available: undefined as boolean | undefined };

/**
 * 実際に sandbox の中で何か走らせて確かめる。バイナリがあっても、user namespace を作れない kernel や
 * 既に sandbox の中 (入れ子の sandbox-exec) では起動に失敗する。
 */
export function sandboxAvailable(): boolean {
	if (sandbox.available !== undefined) return sandbox.available;
	const argv = sandboxArgv([], []);
	if (!argv) return false;
	try {
		execFileSync(argv[0], [...argv.slice(1), "/bin/bash", "-c", ":"], { stdio: "ignore", timeout: 5000 });
		sandbox.available = true;
		return true;
	} catch {
		return false;
	}
}
