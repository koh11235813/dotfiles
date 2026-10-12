/**
 * bash ツールと、edit / write ツールのファイル I/O を OS の境界に入れる部品。macOS は sandbox-exec (seatbelt)、Linux は bubblewrap を直接呼ぶ。
 *
 * 絞るのはファイルへの書き込みと、認証情報の置き場 (READ_DENIED_PATHS) の読み取り。それ以外の読み取りと
 * ネットワークは絞らない (ネットワークは全部か無しかしか選べず、無しでは開発にならない)。
 * 書ける場所は「何を書けるか」の表 (SHARED_TMP_PATHS、EXTRA_WRITE_PATHS) とセッションの root で決まり、
 * その中でも git の hooks と config は書かせない (gitLocks)。判定の枠は index.ts が持つ。
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { EditOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "./permissions.ts";
import { WORKTREES_DIR } from "./worktree.ts";

const real = (path: string): string | undefined => {
	try {
		return realpathSync.native(path);
	} catch {
		return undefined;
	}
};

/**
 * readonly のときの一時ディレクトリ。名前に持ち主の pid を入れる。
 * Pi がクラッシュすると `session_shutdown` が呼ばれず残るので、次に起動した Pi が持ち主の居ないものを消す (sweepScratch)。
 */
export function makeScratch(): string {
	return mkdtempSync(join(tmpdir(), `pi-guard-${process.pid}-`));
}

/**
 * 持ち主の Pi がもう居ない一時ディレクトリを消す。古さでは選ばない。開いたままの readonly セッションは
 * 何日でも同じディレクトリを使い、mtime が古いだけで消すと走っている sort の一時ファイルが消える。
 * pid が別のプロセスに使い回されていたら残る (消し損ねる側に倒れる)。pid の無い名前 (この版より前のもの) には触らない。
 * 共有の /tmp では他人が同じ名前を置けるので、自分の持ち物で、symlink でないディレクトリだけを消す。
 * 失敗は捨てる。掃除できなくても Pi は使える。
 */
export function sweepScratch(): void {
	let names: string[] = [];
	try {
		names = readdirSync(tmpdir());
	} catch {}
	for (const name of names) {
		const pid = Number(/^pi-guard-(\d+)-/.exec(name)?.[1]);
		if (!pid) continue;
		try {
			process.kill(pid, 0);
			continue;
		} catch (error) {
			// EPERM は、居るが自分のものではないプロセス。
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
		}
		try {
			const path = join(tmpdir(), name);
			const stat = lstatSync(path);
			if (stat.isDirectory() && stat.uid === process.getuid?.()) rmSync(path, { recursive: true, force: true });
		} catch {}
	}
}

/**
 * モジュールの変数ではなく globalThis に置く。Pi は `/reload` で拡張を moduleCache: false で評価し直すので、
 * モジュールの変数だと reload のたびに空になり、下の「一度しか訊かない」が reload をまたいで守られない。
 * プロセスの中の値なので、sandbox の中のプロセスからは書き換えられない。
 */
const gitCommonDirs = ((globalThis as { piGuardGitCommonDirs?: Map<string, string | undefined> }).piGuardGitCommonDirs ??= new Map());

/**
 * root から見た git の common dir。git が無い、リポジトリでないときは無し。
 * root ごとに、Pi のプロセスが生きている間は一度しか訊かない。答えは root の中の `.git` が決め、それは sandbox の中から書き換えられる。
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
 * モデルが一時ファイルの置き場として知っている場所。$TMPDIR (macOS では /var/folders 配下) は使ってくれない。
 * 全ユーザー共有の場所だが、開けないと `/tmp/x` と決め打ちしたコマンドが軒並み失敗する。
 * EXTRA_WRITE_PATHS と表を分けているのは、テストがここだけを外すため (Linux では os.tmpdir() が /tmp で、
 * 開けたままだとテストの作る「外」が外でなくなる)。同じ表の先頭 2 件として外すと、表の並びを変えただけで壊れる。
 */
export const SHARED_TMP_PATHS: string[] = ["/tmp", "/var/tmp"];

/**
 * root の外で書き込みを許す場所。root の中で作業していても道具が黙って書く先だけを並べる。
 * 無いパスは飛ばす。`~` そのものや、シェルの rc・`~/.ssh`・`~/.pi` を含む場所は足さない
 * (次に sandbox の外で動くものを書き換えられると境界の意味が無くなる)。
 */
export const EXTRA_WRITE_PATHS: Array<() => string | undefined> = [
	// XDG のキャッシュ。pip, uv, pnpm, go build (Linux), mise などが実行のたびに書く。
	() => join(homedir(), ".cache"),
	// npm install / npx のキャッシュとログ。
	() => join(homedir(), ".npm"),
	// macOS で ~/.cache の代わりに使われる場所。pip, go build, clang の module cache など。
	() => (process.platform === "darwin" ? join(homedir(), "Library", "Caches") : undefined),
	// ここから下は「止まると分かっている」と issue #40 に挙がった道具の分。
	// cargo が依存を取ってくる先。`~/.cargo` ごとは開けない。`bin` と `config.toml` (rustc-wrapper や alias を書ける) は
	// 次に sandbox の外で打つ cargo が実行する。`cargo install` はそのため止まったまま。
	() => join(homedir(), ".cargo", "registry"),
	() => join(homedir(), ".cargo", "git"),
	// `uv python install` / `uv tool install`、pipx の venv、mise の installs。`~/.local/share` ごとは開けない。
	// 入るのは実行ファイルそのものなので、ここに書けるものは sandbox の外で次に動く道具を差し替えられる。
	// 入れる作業を通すことと両立しないので、開ける側に倒している (README の「できないこと」)。
	() => join(homedir(), ".local", "share", "uv"),
	() => join(homedir(), ".local", "share", "pipx"),
	() => join(homedir(), ".local", "share", "mise"),
	// Go の module cache。GOMODCACHE / GOPATH を変えているホストは見ていない。
	() => join(homedir(), "go", "pkg", "mod"),
	// bun install のキャッシュ。`~/.bun` ごとは開けない (`~/.bun/bin` に bun 自身がある)。
	() => join(homedir(), ".bun", "install", "cache"),
	// gh がトークンを更新して書き戻す hosts.yml の置き場。
	() => join(homedir(), ".config", "gh"),
	// chezmoi の状態ファイルだけ。`~/.config/chezmoi` ごとは開けない。chezmoi.toml には hook を書け、
	// guard 自身が edit / write のたびに sandbox の外で `chezmoi managed` を呼ぶ (index.ts の chezmoiManaged)。
	() => join(homedir(), ".config", "chezmoi", "chezmoistate.boltdb"),
];

/**
 * full 以外で読ませない場所。ファイルでもディレクトリでもよく、無くてもよい。
 * 普通の開発コマンドが読まない認証情報の置き場だけを並べる。`~/.gnupg` (commit の署名)、`~/.config/gh`、
 * `~/.npmrc`、`~/.pi/agent/auth.json`、`.zshenv` 以外の rc は入れていない。
 * sandbox の中の git / gh / npm / シェルの起動がそれを読むので、塞ぐと正当な作業が止まる。
 * `~/.git-credentials` は以前は同じ理由で外していたが、issue #40 で塞ぐと決めた。代わりに、sandbox の中から
 * https で push / fetch するには gh の credential helper など別の手段が要る (README)。
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
	// credential.helper=store の置き場。塞ぐと、sandbox の中の git は store に入れた https の認証を使えない。
	() => join(homedir(), ".git-credentials"),
	// PyPI の upload 用トークン。
	() => join(homedir(), ".pypirc"),
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
 * 読ませない場所と重なるものは書ける場所にしない (`~/.ssh` の中で Pi を起動した、リンク先が root の中にある)。
 * 中にあれば中身を書き換えられ、外側にあれば親ディレクトリごと rename して差し替えられる。path は realpath 済み。
 */
function overlapsDenied(path: string): boolean {
	return readDenied().some((entry) => within(entry, path) || within(path, entry));
}

/** root が書ける場所から外される理由。外されないなら無し。/permissions の表示が writeRoots と食い違わないように使う。 */
export function rootExcluded(root: string): "home" | "denied" | undefined {
	if (containsHome(root)) return "home";
	const found = real(root);
	return found && overlapsDenied(found) ? "denied" : undefined;
}

/**
 * そのモードで書ける場所。realpath 済みで、無いパスは落とす。
 * seatbelt は解決後のパスで照合するので、`/var/folders` のままでは `/private/var/folders` に当たらない。
 * git は gitCommonDir の結果。commit / fetch / worktree 操作が書く .git は、root が linked worktree や
 * リポジトリのサブディレクトリだと root の外にある。
 */
export function writeRoots(mode: Exclude<PermissionMode, "full">, root: string, scratch: string, git?: string): string[] {
	const paths =
		mode === "readonly" ? [scratch] : [containsHome(root) ? undefined : root, tmpdir(), git, ...SHARED_TMP_PATHS, ...EXTRA_WRITE_PATHS.map((entry) => entry())];
	const found = [...new Set(paths.flatMap((path) => (path && real(path)) || []))].filter((path) => !overlapsDenied(path));
	// 他の root の中にあるもの (普通のリポジトリの .git など) は重ねて書かない。
	return found.filter((path) => !found.some((other) => other !== path && within(other, path)));
}

/** 書ける場所の中にあっても書かせない場所。directory は、無いときに何として塞ぐかを決める。 */
export interface Lock {
	path: string;
	directory: boolean;
}

/**
 * sandbox の中から書かせない git の場所。
 * hook と config (core.hooksPath、core.fsmonitor、alias など) は、次にホスト側で git を打ったとき sandbox の外で実行される。
 * commondir は common dir の向き先で、書き換えるとよそに用意した config が読まれる。root の `.git` がファイル
 * (linked worktree) なら、それも同じ理由で向き先。
 *
 * 起点は git (gitCommonDir の結果) だけにしない。その答えは root ごとに一度きりで、リポジトリでない root で起動した後の
 * `git init` も、root の下に収めた別のリポジトリも入らない。一度しか訊かないのは書ける場所を広げないためで、
 * 塞ぐ側は広がっても困らないので、呼ぶたびに root の下の `.git` を探し直す (nestedGitDirs)。
 *
 * submodule の git dir (`<common>/modules/<名前>`) の hooks と config も同じ。ホスト側の `git status` は submodule の中でも
 * git を起こす。modules ごとは塞がない (中の index や objects に書けないと submodule の commit も fetch も止まる)。
 *
 * 塞ぐのはこの直接の道だけ。git は、書き換えられる作業ツリーの上で安全に動くようには作られていない。
 * 作業ツリーの中に入れ子のリポジトリを作って index に載せれば、その中の config がホストの `git status` で読まれる
 * (README の「できないこと」)。
 */
export function gitLocks(root: string, git: string | undefined): Lock[] {
	const found = real(root) ?? root;
	const common = git && real(git);
	const locks: Lock[] = [];
	const own = (dir: string) => locks.push({ path: join(dir, "hooks"), directory: true }, { path: join(dir, "config"), directory: false }, { path: join(dir, "commondir"), directory: false });
	if (common) own(common);
	const pointer = join(found, ".git");
	try {
		if (lstatSync(pointer).isFile()) locks.push({ path: pointer, directory: false });
	} catch {}
	for (const module of common ? submoduleGitDirs(common) : []) locks.push({ path: join(module, "hooks"), directory: true }, { path: join(module, "config"), directory: false });
	// 探して見つけた分は hooks・config・commondir だけ。その中の submodule までは追わない。
	for (const dir of nestedGitDirs(found)) if (dir !== common) own(dir);
	// subagent のために作った worktree (worktree.ts) の `.git` ファイルも向き先。子は自分の worktree を root にするので上の
	// pointer で塞がるが、親の root には worktree が丸ごと入っている。`.git` がファイルのものを root の下から全部探すことは
	// しない (submodule の作業ツリーまで動かせなくなる)。塞ぐのは guard が自分で作る置き場の分だけ。
	let worktrees: string[] = [];
	try {
		worktrees = readdirSync(join(found, WORKTREES_DIR));
	} catch {}
	for (const name of worktrees) {
		const file = join(found, WORKTREES_DIR, name, ".git");
		try {
			if (lstatSync(file).isFile()) locks.push({ path: file, directory: false });
		} catch {}
	}
	// symlink のもの (共有の hooks へ向けた `.git/hooks` など) は、リンク先も数える。名前だけだと、解決後のパスで照合する側
	// (edit / write の判定の inside、seatbelt) でリンク先の中が一致せず、確認なしで書ける。
	return locks.flatMap((lock) => {
		const target = real(lock.path);
		return target && target !== lock.path ? [lock, { ...lock, path: target }] : [lock];
	});
}

/** root から何段下のディレクトリまで `.git` を探すか。0 は root 直下の `.git` だけ。 */
const NESTED_DEPTH = 3;

/**
 * root の下にある `.git` ディレクトリ。root 自身のものと、NESTED_DEPTH 段下までのディレクトリのもの。
 * 全部は歩かない。bash と edit / write のたびに呼ばれ、2 万ディレクトリの木を全部歩くと 1 回に 140 ms かかる (Arch で実測。
 * 3 段までなら同じ木で 4 ms)。それより深いリポジトリは塞がれない。
 * symlink は辿らない (root の中から好きな場所を歩かせない)。`.git` がファイルのもの (submodule や worktree の作業ツリー) は数えない。
 * 見つけたものを覚えておく必要は無い。塞いだ `.git` とその祖先は sandbox の中から動かせず (pins)、消して外すことができない。
 */
function nestedGitDirs(root: string): string[] {
	const found: string[] = [];
	const walk = (parent: string, depth: number): void => {
		let names: string[] = [];
		try {
			names = readdirSync(parent, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? [entry.name] : []));
		} catch {}
		for (const name of names.sort()) {
			if (name === ".git") found.push(join(parent, name));
			else if (depth > 0) walk(join(parent, name), depth - 1);
		}
	};
	walk(root, NESTED_DEPTH);
	return found;
}

const seenSubmodules = ((globalThis as { piGuardSubmodules?: Map<string, Set<string>> }).piGuardSubmodules ??= new Map());

/**
 * common の下にある submodule の git dir。入れ子の submodule (`modules/<名前>/modules/...`) も数える。
 * 呼ぶたびに探し直すが、一度見つけたものは外さない (gitCommonDirs と同じく globalThis に覚える)。git dir の目印にしている
 * HEAD は sandbox の中から消せるので、今あるものだけを返すと「消す → 次の呼び出しで config を書く」の 2 手で抜けられる。
 * 探し直すのは、セッションの途中でホスト側が足した submodule を拾うため。
 */
function submoduleGitDirs(common: string): string[] {
	const seen: Set<string> = seenSubmodules.get(common) ?? new Set();
	seenSubmodules.set(common, seen);
	const walk = (parent: string): void => {
		let names: string[] = [];
		try {
			// symlink は辿らない。modules の下は sandbox の中から書けるので、辿ると好きな場所を歩かされる。
			names = readdirSync(parent, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? [entry.name] : []));
		} catch {}
		for (const name of names) {
			const path = join(parent, name);
			// HEAD が無いディレクトリは、名前に / を含む submodule の途中 (`modules/lib/deep` の `lib`)。
			// 覚えている git dir は HEAD を消されていても中を歩かない。`logs/HEAD` を持つ `logs` まで git dir に見える。
			if (!seen.has(path) && !existsSync(join(path, "HEAD"))) walk(path);
			else {
				seen.add(path);
				walk(join(path, "modules"));
			}
		}
	};
	walk(join(common, "modules"));
	return [...seen].sort();
}

/**
 * locks の祖先のうち、書ける場所の中にあるディレクトリ。浅い順。書ける場所そのものと、その外は数えない。
 * sandbox はこれを動かせないようにする。直接の親だけだと、その上 (`.git/modules`) を rename して同じ名前で作り直せる。
 */
function pins(roots: string[], locks: Lock[]): string[] {
	const found = new Set<string>();
	for (const lock of locks) {
		for (let parent = dirname(lock.path); roots.some((root) => parent !== root && within(root, parent)); parent = dirname(parent)) found.add(parent);
	}
	return [...found].sort((a, b) => a.length - b.length);
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
 * path の中に、targets のうち実在するものがあるか。path が symlink ならその先で見る (rg / fd は渡された symlink を辿る)。
 * 無い target は数えない。path の中の symlink の先までは追わない (rg / fd も既定では辿らない)。
 */
export function contains(path: string, targets: string[]): boolean {
	const found = real(path);
	return !!found && targets.some((target) => {
		const entry = real(target);
		return !!entry && within(found, entry);
	});
}

/**
 * seatbelt のプロファイル。後に書いた規則が勝つので、全部許可 → 書き込み拒否 → roots だけ再許可 →
 * denied の読み取り拒否の順。読み取り拒否を最後に置くのは、どの許可にも上書きさせないため。
 * /dev の節点はシェルのリダイレクト (`> /dev/null`, `>&2` 相当の `/dev/stderr`) と pty に要る。
 */
export function seatbelt(roots: string[], denied: string[], locks: Lock[] = []): string {
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
		// roots の再許可より後に置いて勝たせる。照合はパスなので、無い場所も後から作らせない。
		// 親の unlink (rename を含む) も拒否する。親ごと動かして、同じ名前で作り直す道を塞ぐ。
		// macOS の実機では確かめていない (README)。
		...(locks.length > 0
			? [
					`(deny file-write* ${locks.map((lock) => `(subpath ${JSON.stringify(lock.path)})`).join(" ")})`,
					// 動かせなくする祖先が無い (どの親も書ける場所そのものか、その外) こともある。空の規則は書けない。
					...[pins(roots, locks).map((path) => `(literal ${JSON.stringify(path)})`).join(" ")].flatMap((paths) => (paths ? [`(deny file-write-unlink ${paths})`] : [])),
				]
			: []),
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
 *
 * locks は roots の後で読み取り専用に重ね直す。その前に祖先 (pins) を bind し直して mount point にする。mount point は
 * rename も削除もできないので、`.git` ごと動かして作り直す道が塞がる (Arch で実測)。mount point を中に持つだけの
 * ディレクトリは rename できるので、直接の親だけでなく書ける場所までの祖先を全部そうする。書ける場所の外にある祖先は
 * bind しない (bind すると書けるようになる)。無いディレクトリには空の tmpfs を読み取り専用で重ねる。mount 先として
 * 実物の空ディレクトリが出来るが、git は空の hooks を hook 無しとして扱う。無いファイルは塞げない: 重ねるには
 * 実物の空ファイルを作ることになり、空の commondir はホスト側の git を止める。
 */
export function bwrap(roots: string[], denied: string[], locks: Lock[] = []): string[] {
	const writable = (path: string) => roots.some((root) => within(root, path));
	const pinned = pins(roots, locks).filter((parent) => existsSync(parent));
	return [
		"--ro-bind", "/", "/",
		...roots.flatMap((root) => ["--bind-try", root, root]),
		...pinned.flatMap((parent) => ["--bind", parent, parent]),
		...locks.flatMap(({ path, directory }) => {
			// symlink のままの名前には重ねられない (起動に失敗する)。リンク先を塞ぐ。リンク自体の掛け替えは残る。
			const found = real(path);
			if (found) return ["--ro-bind", found, found];
			// realpath は失敗するのに lstat は通る = 切れた symlink。その上には何も重ねられず、重ねようとすると起動に失敗して
			// どのコマンドも走らなくなる。飛ばす (リンクの掛け替えが残るのは、切れていない symlink と同じ)。
			try {
				lstatSync(path);
				return [];
			} catch {}
			// 書けない親の下には mount 先を作れず、起動に失敗する。そこは元から書けないので塞ぐ必要も無い。
			return directory && existsSync(dirname(path)) && writable(dirname(path)) ? ["--tmpfs", path, "--remount-ro", path] : [];
		}),
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
export function sandboxArgv(roots: string[], denied: string[], locks: Lock[] = [], platform: string = process.platform): string[] | undefined {
	if (platform === "darwin") return ["/usr/bin/sandbox-exec", "-p", seatbelt(roots, denied, locks)];
	if (platform === "linux") {
		// PATH からは探さない。root 配下の PATH (node_modules/.bin など) に `bwrap` を置かれると sandbox ごと差し替わる。
		const binary = ["/usr/bin/bwrap", "/bin/bwrap"].find((path) => existsSync(path));
		return binary && [binary, ...bwrap(roots, denied, locks)];
	}
	return undefined;
}

const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

/** sandbox が起動しなかったときにモデルへ返す文。コマンドの出力の後ろ (stderr) と、edit / write の失敗の文面の後ろに付く。 */
export const SANDBOX_NOT_STARTED =
	"guard[sandbox]: The OS sandbox did not start, so nothing was executed: the error above comes from the sandbox launcher, not from your command. Do not retry or route around this. Stop and tell the user; they can check the sandbox (bubblewrap / user namespaces on Linux) or switch with /permissions full.";

/**
 * Pi が `bash -c` に渡すコマンドを sandbox 越しの実行に差し替える。
 * モデルのコマンドは環境変数で運ぶ。文字列に埋めると引用符の扱いを 1 つ誤っただけで sandbox の外で走る。
 * argv のほうは自分で作った文字列なので単引用符で包めば足りる。
 *
 * probe が通った後でも起動は失敗しうる (user namespace を後から止められた、bind する先が消えた)。そのときの
 * 出力は launcher の 1 行と終了コード 1 で、コマンドの失敗と見分けがつかない。だから sandbox の中の最初の
 * シェルに、継いだ fd へ印を書かせる。印が無ければ中まで届いていない。終了コードや stderr の文面で見分けないのは、
 * コマンド自身が同じ終了コードも同じ文面も出せるから。印を書いたら fd を閉じてからコマンドに替わるので、
 * コマンドからは見えず、残した子が握り続けることもない。
 * `exec` で launcher に替わらなくなった分、外側に bash が 1 つ残る。Pi の kill はプロセスグループ宛てなので届く。
 */
export function wrap<T extends { command: string; env: NodeJS.ProcessEnv }>(context: T, argv: string[], shell = "/bin/bash"): T {
	// 印を書くシェルは /bin/bash に固定し、コマンドを実行するシェルだけ差し替える。sandbox の外で動くのは Pi が選ぶ
	// /bin/bash とこの launcher だけで、設定の shellPath (project の settings.json にも書ける) は中でしか動かない。
	const inner = `echo 1 >&4; exec 4>&-; exec "$0" -c "$PI_GUARD_COMMAND"`;
	return {
		...context,
		command: [
			"exec 3>&1",
			`started=$(${argv.map(quote).join(" ")} /bin/bash -c ${quote(inner)} ${quote(shell)} 4>&1 >&3 3>&-)`,
			"code=$?",
			'[ -n "$started" ] && exit "$code"',
			`echo ${quote(SANDBOX_NOT_STARTED)} >&2`,
			'[ "$code" -ne 0 ] || code=126',
			'exit "$code"',
		].join("\n"),
		env: { ...context.env, PI_GUARD_COMMAND: context.command },
	};
}

/**
 * sandbox の中で行うファイルの読み書き。edit / write ツールの I/O をこれに差し替える。Pi の既定は Pi のプロセス内 (Node の fs) で、
 * sandbox の外にある。argv は sandboxArgv の結果。
 *
 * パスはシェルの文字列に埋めず引数で、内容は stdin で渡す (wrap がコマンドを環境変数で運ぶのと同じ理由)。
 * 道具は絶対パスで呼び、環境変数は渡さない。PATH から探すと、root 配下に置かれた同名のものが使われる
 * (sandbox の中なので外へは出られないが、書く内容を差し替えられる)。
 *
 * 起動しなかった sandbox を道具の失敗と混ぜないのも wrap と同じで、中の最初のシェルに継いだ fd へ印を書かせる。
 * 印が無ければ、終了コードが 0 でも失敗にする (何も走らせずに 0 で終わる launcher を、書けたことにしない)。
 * 印を書けなかったシェルは道具を呼ばずに終わる。続けさせると、読み書きした後で「何も実行されていない」と伝えることになる。
 */
export function fileOperations(argv: string[]): EditOperations & WriteOperations {
	const run = (script: string, path: string, input?: string): Promise<Buffer> =>
		new Promise((done, fail) => {
			const child = spawn(argv[0], [...argv.slice(1), "/bin/bash", "-c", `echo 1 >&3 || exit 1; exec 3>&-; ${script}`, "bash", path], { env: {}, stdio: ["pipe", "pipe", "pipe", "pipe"] });
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			let started = false;
			child.stdout!.on("data", (chunk) => out.push(chunk));
			child.stderr!.on("data", (chunk) => err.push(chunk));
			child.stdio[3]!.on("data", () => {
				started = true;
			});
			// 起動に失敗した sandbox は stdin を読まずに終わる。EPIPE を拾わないと未捕捉例外になる。失敗は印と終了コードで分かる。
			child.stdin!.on("error", () => {});
			// launcher そのものを起こせなかった。
			child.on("error", (error) => fail(new Error(`${error.message}\n${SANDBOX_NOT_STARTED}`)));
			child.on("close", (code) => {
				const message = Buffer.concat(err).toString().trim();
				if (!started) fail(new Error(`${message || `exit code ${code}`}\n${SANDBOX_NOT_STARTED}`));
				else if (code === 0) done(Buffer.concat(out));
				else fail(new Error(message || `exit code ${code}`));
			});
			child.stdin!.end(input ?? "");
		});
	return {
		readFile: (path) => run('exec /bin/cat -- "$1"', path),
		writeFile: (path, content) => run('exec /bin/cat > "$1"', path, content).then(() => {}),
		mkdir: (dir) => run('exec /bin/mkdir -p -- "$1"', dir).then(() => {}),
		// Pi の edit は失敗の code を文面に出す (`Could not edit file: ... Error code: ENOENT`)。無いのか書けないのかだけ分ける。
		access: (path) =>
			run('[ -e "$1" ] || { echo ENOENT >&2; exit 1; }; [ -r "$1" ] && [ -w "$1" ] || { echo EACCES >&2; exit 1; }', path).then(
				() => {},
				(error: Error) => {
					throw /^E[A-Z]+$/.test(error.message) ? Object.assign(error, { code: error.message }) : error;
				},
			),
	};
}

/** sandbox なし (full) で、設定されたシェルに実行させる。運び方は wrap と同じ。 */
export function viaShell<T extends { command: string; env: NodeJS.ProcessEnv }>(context: T, shell: string): T {
	return { ...context, command: `exec ${quote(shell)} -c "$PI_GUARD_COMMAND"`, env: { ...context.env, PI_GUARD_COMMAND: context.command } };
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
