/**
 * guard は、Pi のツール呼び出しを規則表 (rules.ts) で止め、bash・edit・write ツールを OS の sandbox (sandbox.ts) に入れる。
 *
 * Pi は承認もサンドボックスも持たないので、AGENTS.md の禁止事項は文章でしかない。
 * 規則表と sandbox は別の軸で、規則表は full を含むどのモードでも効く。
 *
 * - 規則表: `tool_call` を拾い、bash の command と edit / write の path を照らす。
 * - sandbox: 組み込みの bash を同名で差し替え、full 以外では書ける場所を root・一時ディレクトリ・
 *   EXTRA_WRITE_PATHS に絞り (readonly は専用の一時ディレクトリだけ。macOS では os.tmpdir() も)、READ_DENIED_PATHS を読めなくする。
 *   `tool_call` で command を書き換えないのは、transcript と規則表にモデルが書いたままの command を残すため。
 * - monitor (monitor/index.ts) は待たずに走らせる bash で、規則表も sandbox もモードの判定も bash と同じものを通る。
 *   sandbox は起動したときのモードで決まり、走っている間は変わらない。だからモードを厳しい側へ変えたら job を止める。
 * - edit / write も同名で差し替え、full 以外ではファイルの読み書きを同じ sandbox の中で行う (sandbox.ts の fileOperations)。
 *   書ける場所の外と、sandbox が書かせない git の場所 (gitLocks) への書き込みは、ここで confirm にする。人に訊けるのは
 *   `tool_call` だけで、承認された呼び出しは sandbox を通さずに Pi のプロセス内で行う (下の fileIO)。
 * - read / grep / find / ls は Pi のプロセス内 (Node の fs と rg / fd) で動き sandbox の外なので、READ_DENIED_PATHS を指す
 *   呼び出しをここで confirm にする。edit も書く前に読むので同じ。
 *   grep / find は rg / fd を `--hidden` で起動し、親ディレクトリ (`~` など) を渡されると中まで降りて読むので、
 *   読ませない場所を中に含む検索も confirm にする。
 *
 * ユーザーが自分で打つ `!` コマンド (`user_bash`) は意図して sandbox に入れていない。人の操作まで絞る理由がない。
 * ほかに覆っていないもの: MCP や他の拡張のツール、Pi の外のプロセス、ネットワーク、READ_DENIED_PATHS 以外の読み取り、
 * Pi が既に持っている環境変数 (sandbox の中の `env` で見える)。/permissions の ask / readonly がツールを読み取り専用と
 * みなす根拠は組み込み reader の出自と readOnlyHint で、実際の副作用は検証しない。
 *
 * confirm は UI が要る。subagent は子の Pi を `--mode json -p` で起動するので、子は確認を親の UI に回す (ask.ts)。
 * 親にも UI が無ければ、confirm の規則はすべて遮断になる。子はモードと root を環境変数 PI_GUARD で親から受け継ぎ、変えられない。
 * root まで渡すのは、subagent の cwd がモデルの指定だから (`cwd: "/"` で書ける場所を広げさせない)。
 * subagent に `worktree: true` が付いていたら、タスクごとの git worktree を作って子の cwd にし、終わった後の差分を結果に足す
 * (worktree.ts)。worktree の中で起こされた子は、書ける場所をその worktree に絞る。
 * 子の Pi のプロセスそのものは sandbox に入れていない。入るのは子の guard が包む道具だけなので、子が guard を
 * 読み込まなかったことを `tool_result` で確かめる (下の GUARD_LOADED)。
 *
 * このハンドラが例外を投げると Pi はそのツール呼び出しを遮断する (fail-closed)。
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type BashSpawnHook, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition, type ExtensionAPI, type ExtensionContext, getAgentDir, isToolCallEventType, type ToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { askDirName, askParent, serveAsks, sweepAsks } from "./ask.ts";
import { registerMonitor } from "./monitor/index.ts";
import { GUARD_ENV, GUARD_LOADED, inheritedState, isPermissionMode, isPermissionState, judgePermission, PERMISSIONS_ENTRY, type PermissionMode, type PermissionState } from "./permissions.ts";
import { BASH_RULES, chezmoiTarget, evaluate, PATH_RULES, type Rule } from "./rules.ts";
import { addWorktrees, report, type Run, type SubagentInput, taskRoot, type Worktree } from "./worktree.ts";
import { allowWrite, cacheLocks, contains, fileOperations, gitCommonDir, gitLocks, inside, type Lock, makeScratch, READ_DENIED_PATHS, readDenied, rootExcluded, sandboxArgv, sandboxAvailable, sweepScratch, viaShell, wrap, writeRoots } from "./sandbox.ts";

/** ダイアログと通知に出す対象の上限。数十行のヒアドキュメントが画面を埋めないようにする。 */
const SHOWN_LINES = 5;
const SHOWN_CHARS = 400;

/** 対象の先頭だけ。何に当たったかは規則の reason が説明する。 */
function head(subject: string): string {
	const shown = subject.split("\n").slice(0, SHOWN_LINES).join("\n").slice(0, SHOWN_CHARS);
	return shown.length < subject.length ? `${shown}\n[… ${subject.length - shown.length} more chars not shown]` : shown;
}

/**
 * guard が起こす chezmoi と、ほかの拡張が sandbox の外で起こす道具 (git) の実体。PATH から探すが、相対の要素と、書ける場所の中にあるものは飛ばす。
 * sandbox の中から置ける場所のものを拾うと、次に sandbox の外で実行される (chezmoi も full では外で起こす)。
 * 返すのは symlink を解いた先。PATH にあった候補のまま返すと、書ける場所に置いた symlink を、確かめた後で掛け替えられる。
 * 先の名前が違うもの (mise の shim のように、呼ばれた名前で振る舞いを変えるもの) も飛ばす。先を直に起こすと別のコマンドになる。
 * bwrap のように決まった絶対パスだけを見ないのは、置き場がホストごとに違う (Homebrew、pacman、`~/.local/bin`) からで、
 * 見つからなければ chezmoi の規則が効かなくなる。
 */
function binary(name: string, writable: string[]): string | undefined {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter(isAbsolute)
		.flatMap((entry) => {
			try {
				return [realpathSync.native(join(entry, name))];
			} catch {
				return [];
			}
		})
		.find((found) => basename(found) === name && !inside(writable, found));
}

/**
 * chezmoi が管理するファイルの絶対パス。実体を拾えなければ "missing"、起こして失敗したら (非ゼロ終了、時間切れ) "failed"。
 * ここで例外を通すと fail-closed で edit / write が全部止まるので、規則が効かない側に倒す。倒したことは呼んだ側が人に知らせる。
 * 数十 ms で返るのでキャッシュしない。セッション中に `chezmoi add` された分も拾える。
 *
 * launcher は sandbox を起動する argv (full では空)。`managed` は source の template を評価する (`.chezmoiignore`、
 * `.chezmoiremove`、`.chezmoiexternal.*` など)。root が chezmoi の source だとモデルがそれを書けるので、sandbox の外で起こすと
 * `{{ output "..." }}` で任意のコマンドが外で走る。入口のファイルを名指しで守る道は取らない (サブディレクトリの
 * `.chezmoiignore` のように、入口はどこにでも新しく作れる)。template の関数を切る chezmoi の設定も見つからなかった。
 */
function chezmoiManaged(writable: string[], launcher: string[]): Set<string> | "missing" | "failed" {
	try {
		const chezmoi = binary("chezmoi", writable);
		if (!chezmoi) return "missing";
		const [command, ...args] = [...launcher, chezmoi, "managed", "--include=files", "--path-style=absolute"];
		const out = execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		return new Set(out.split("\n").filter(Boolean));
	} catch {
		return "failed";
	}
}

/** chezmoi を使っているホストか。使っていないホストで「chezmoi が見つからない」と知らせないために見る。 */
const usesChezmoi = (): boolean => existsSync(join(homedir(), ".config", "chezmoi")) || existsSync(join(homedir(), ".local", "share", "chezmoi"));

/**
 * edit / write が実際に開くパス。Pi の resolveToCwd (dist/core/tools/path-utils.js、実体は utils/paths.js の
 * resolvePath) と同じ手順をなぞる。SDK が export していないので写している。
 * 手順がずれると `@/abs/path` や `file:///abs/path` が cwd 配下の名前に見えて、判定と書き込み先が食い違う。
 */
export function targetPath(input: string, cwd: string): string {
	let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	else if (/^file:\/\//.test(path)) path = fileURLToPath(path);
	return resolve(cwd, path);
}

/** edit / write の先が書ける場所の外。規則表と同じ形にして、confirm と UI なしの遮断を既存の枠に任せる。 */
function outsideRoots(roots: string[]): Rule {
	return {
		id: "outside-write-roots",
		decision: "confirm",
		reason:
			"This path is outside the session's write roots (project directory, temp dir, tool caches) and needs the user's approval. Do not retry or route around this; bash is sandboxed to the same roots. Report what you wanted to write.",
		matches: (path) => !inside(roots, path),
	};
}

/** edit / write の先が、sandbox の中の bash にも書かせない git の場所。 */
function gitLocked(locks: Lock[]): Rule {
	return {
		id: "git-locked",
		decision: "confirm",
		reason:
			"This path is git's hooks, config or worktree pointer: what is written there runs outside the sandbox the next time git is used on the host, so it needs the user's approval. Do not retry or route around this; sandboxed bash cannot write it either. Report what you wanted to change (the user can run `git config` themselves).",
		matches: (path) => inside(locks.map((lock) => lock.path), path),
	};
}

/**
 * read は無いパスを macOS の別表記 (スクリーンショット名の AM/PM 前の空白、NFD、曲がった引用符) で探し直す
 * (path-utils.js の resolveReadPath)。元の名前だけで判定すると、cwd に別表記の名前で置いた symlink 越しに読める。
 */
function readVariants(path: string): string[] {
	const nfd = path.normalize("NFD");
	return [path, path.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, path.replace(/'/g, "\u2019"), nfd.replace(/'/g, "\u2019")];
}

/** 組み込み reader と edit の先が読ませない場所。sandbox の中の bash と同じ表で、こちらは人に訊ける。 */
function readDeniedPath(denied: string[]): Rule {
	return {
		id: "read-denied",
		decision: "confirm",
		reason:
			"This path holds credentials (SSH keys, tokens, shell secrets) and reading it needs the user's approval. Do not retry or route around this; sandboxed bash cannot read it either. Report what you needed from it.",
		matches: (path) => readVariants(path).some((variant) => inside(denied, variant)),
	};
}

/**
 * grep / find の探す先が、読ませない場所を中に含む。rg / fd は `--hidden` で起動されるので、`~` を渡せば
 * `~/.ssh` まで降りて読む。引数の path だけを見る readDeniedPath はそれを通してしまう。
 * 数えるのは実在するものだけ (無ければ読むものが無い)。
 */
function containsReadDenied(denied: string[]): Rule {
	return {
		id: "read-denied-inside",
		decision: "confirm",
		reason:
			"This search starts above a path that holds credentials (SSH keys, tokens) and would descend into it, so it needs the user's approval. Do not retry or route around this; search a narrower directory instead (the project, not your home directory).",
		matches: (path) => contains(path, denied),
	};
}

/**
 * bash の結果に足す説明。モデルが読む。出力から写したもの (パスや errno の文面) は入れない。拾う行は、モデルのコマンドも
 * リポジトリの中身 (`cat` したファイル) も自分で出せるので、写すと guard の名前でその文面をモデルに読ませることになる。
 * 行を偽って足させても、得るのはこの固定の文だけ (README)。
 */
const GIT_CONFIG_NOT_SAVED =
	"guard[git-locked]: git could not write .git/config, so the setting above was NOT saved, even if git printed a success message and exited with code 0. The sandbox keeps git's config read-only. Do not retry or route around this; if the setting is needed (upstream tracking, a remote, a submodule), ask the user to run the git command themselves, outside the sandbox.";
const GIT_LOCK_KEPT =
	"guard[git-locked]: The sandbox keeps .git/config and .git/hooks read-only, so they, and the repository directory that contains them, cannot be written, removed or moved from here; what the command above left behind stays. Do not retry or route around this; report what you wanted to remove or move, and the user can do it outside the sandbox.";

/** git が config を書けなかった行の、config のパス。git は相対で出す (`.git/config`。`git -C sub` でも同じ)。 */
const configNotWritten = (line: string): string | undefined => /could not write config file (.+): [^:]+$/.exec(line)?.[1];

/** リポジトリの中の config の名前。相対のパスは、コマンドが cd した後の場所からなので、どのリポジトリのものかは決められない。 */
const GIT_CONFIG_PATH = /(^|\/)\.git\/(modules\/.+\/)?config$/;

/**
 * `.git/config` か `.git/hooks` を指して断られた行 (`rm`、`mv`、`git clean`、リダイレクト)。errno の文面は macOS の seatbelt が
 * Operation not permitted、bubblewrap が Device or resource busy (mount point) と Read-only file system (その中)。
 * `mv sub sub2` のように `.git` のパスが出ない行は拾えない (README)。
 */
const GIT_LOCK_REFUSED = /\.git\/(config|hooks)(?![\w.-]).*(Operation not permitted|Device or resource busy|Read-only file system)/;

/** subagent の子の最後の出力。公式 sample の getFinalOutput と同じ選び方 (text を持つ最後の assistant の、最初の text)。 */
function lastOutput(messages: unknown): string {
	for (const message of Array.isArray(messages) ? [...messages].reverse() : []) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) if (part?.type === "text") return String(part.text);
	}
	return "";
}

/**
 * 子の確認の置き場 (ask.ts) を並べる場所。一時ディレクトリは sandbox の中から書けるので使えない。書けると、モデルが bash で
 * 答えを置いて自分で承認できる。
 */
const asksHome = (): string => join(homedir(), ".local", "state", "pi-guard");

/** 緩い順。 */
const STRICTNESS: PermissionMode[] = ["full", "normal", "ask", "readonly"];

/** ほかの拡張がコマンドの準備を頼む口 (`pi.events`)。中身は `{ command, cwd, env, reply }`。 */
export const BASH_CHANNEL = "guard:bash";
/** ほかの拡張が、sandbox の外で起こす道具の実体を訊く口 (`pi.events`)。中身は `{ name, reply }`。 */
export const BINARY_CHANNEL = "guard:binary";

export default function (pi: ExtensionAPI) {
	const inherited = inheritedState(process.env[GUARD_ENV], process.pid);
	let mode: PermissionMode = inherited?.mode ?? "normal";
	// worktree の中で起こされた子 (worktree.ts) は、親の root ではなくその worktree だけを書ける場所にする。
	let root = inherited ? (taskRoot(inherited.root, process.cwd()) ?? inherited.root) : process.cwd();
	// 子孫は自分で git に訊かない。親のモデルが `.git` を書き換えた後かもしれない。
	let gitDir = inherited?.git;
	let scratch: string | undefined;

	// chezmoi-target の規則が効いていないと人に知らせたか (下の chezmoiRule)。失敗は続いている間、実体が無いのはセッションの間。
	let chezmoiFailing = false;
	let chezmoiMissingTold = false;

	// 子の確認を受け付けている間だけ持つ。asks は置き場、live はダイアログを出す先。
	let asks: { dir: string; stop: () => void } | undefined;
	let live: ExtensionContext | undefined;

	/** 子孫は書き出さない。自分の pid で上書きすると、`/reload` の後に継承を見失って鍵が外れる。 */
	function publish() {
		if (!inherited) process.env[GUARD_ENV] = JSON.stringify({ mode, root, git: gitDir, pid: process.pid, ask: asks?.dir });
	}

	/**
	 * UI を持たない子孫の確認を、この Pi の UI で受け付け始める (ask.ts)。UI が無ければ受け付けない (子は今までどおり遮断)。
	 * 置き場は asksHome の下。root が置き場を含む (`~/.local` で Pi を起動した) と sandbox の中から書けるので、受け付けない。
	 * full には sandbox が無いので、この確かめは効かない (README の「できないこと」)。
	 * 作れなくても Pi は使える。失敗は捨てる。
	 */
	function listen(ctx: ExtensionContext) {
		live = ctx;
		if (asks || !ctx.hasUI) return;
		const dir = join(asksHome(), askDirName(process.pid));
		if (inside(writeRoots("normal", root, "", gitDir), dir)) return;
		try {
			asks = { dir, stop: serveAsks(dir, (title, message, signal) => live!.ui.confirm(`[subagent] ${title}`, message, { signal })) };
		} catch {}
	}

	/**
	 * 現在のモードを footer に出し続ける。full のまま気づかずに使い続けるのを防ぐためで、full だけ文面を変える。
	 * 色は付けない (theme の色名に頼ると、テーマ次第で読めなくなる)。
	 */
	function show(ctx: ExtensionContext) {
		if (ctx.hasUI) ctx.ui.setStatus("guard", mode === "full" ? "guard: FULL (no sandbox)" : `guard: ${mode}`);
	}

	function restore(ctx: ExtensionContext) {
		if (!inherited) {
			mode = "normal";
			root = ctx.cwd;
			gitDir = gitCommonDir(root);
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === PERMISSIONS_ENTRY && isPermissionState(entry.data)) {
					mode = entry.data.mode;
				}
			}
			listen(ctx);
			publish();
		}
		show(ctx);
	}

	/**
	 * 人に訊く。UI があれば自分で訊き、無ければ親の Pi に頼む (ask.ts)。誰にも訊けなければ undefined。
	 * subagent の子は UI を持たない (`--mode json -p`) ので、頼む先が無いと confirm の規則がすべて遮断になる。
	 */
	async function confirm(ctx: ExtensionContext, title: string, message: string): Promise<boolean | undefined> {
		if (ctx.hasUI) return ctx.ui.confirm(title, message);
		return inherited?.ask ? askParent(inherited.ask.dir, inherited.ask.parent, title, message) : undefined;
	}

	/**
	 * sandbox の外で起こす道具を探すときに避ける場所 (binary)。この Pi の系統のどれかが sandbox の中から書ける場所。
	 * full でも normal の書ける場所で見る。full に切り替える前に sandbox の中から置かれたものかもしれない。
	 * worktree に絞られた子でも親の root で見る。親のモデルが親の root に置いたものかもしれない。
	 */
	const plantable = (): string[] => writeRoots("normal", inherited?.root ?? root, "", gitDir, extras().paths);

	/**
	 * 人が設定で足した書ける場所 (sandbox.ts の allowWrite)。呼ぶたびに読む。
	 * 設定ファイルが sandbox の中から書ける (root の中のファイルへの symlink にしている) ときは読まない。読むと、モデルが bash で
	 * 書き足した場所が次の呼び出しから開く。書けるかは足す前の場所で見る。足した後の場所で見ると、設定の中身が
	 * 「設定を読むかどうか」を決めることになる。見るのは plantable と同じく親の root (worktree に絞られた子でも)。
	 * project の中の設定は探さない。root の中は sandbox の中から書けるので、置けたとしても上の決まりで読まないことになる。
	 */
	function extras() {
		const file = join(getAgentDir(), "guard.json");
		const ignored = inside(writeRoots("normal", inherited?.root ?? root, "", gitDir), file);
		return { file, ignored, ...(ignored ? { paths: [], rejected: [] } : allowWrite(file, [getAgentDir(), asksHome()])) };
	}

	/** full では呼ばない。readonly の一時ディレクトリは sort など一時ファイルを作る道具が要るので、使うときに作る。 */
	function roots(): string[] {
		if (mode === "full") throw new Error("guard: full mode has no write roots.");
		if (mode === "readonly" && !(scratch && existsSync(scratch))) scratch = makeScratch();
		return writeRoots(mode, root, scratch ?? "", gitDir, extras().paths);
	}

	/**
	 * chezmoi-target の規則 (rules.ts)。一覧は `chezmoi managed` に訊く。full 以外では、どこにも書けない sandbox の中で訊く
	 * (下の inspect と同じ形。理由は chezmoiManaged)。full は元から境界が無いので、そのまま起こす。
	 * sandbox が使えないホストの full 以外では訊かない。その edit / write は judge が遮断するので規則が要らず、
	 * 外で訊けば template が外で走る。
	 *
	 * 一覧が取れなければ規則は何にも当たらない。黙ってそうなると、守られていると思ったまま生成物を書き換えられるので、人に知らせる。
	 * 失敗は、続いている間に 1 度 (直ってまた壊れたら知らせ直す)。実体が無いのは、セッションに 1 度、chezmoi を使っているホストでだけ。
	 * 終了コード 0 で空の一覧 (`.chezmoiignore` に `*`) は、管理ファイルの無いホストと見分けられないので知らせない。
	 */
	function chezmoiRule(ctx: ExtensionContext): Rule {
		const launcher = mode === "full" ? [] : sandboxAvailable() ? sandboxArgv([], readDenied()) : undefined;
		const managed = launcher ? chezmoiManaged(plantable(), launcher) : new Set<string>();
		const warn = (problem: string) => {
			if (ctx.hasUI) ctx.ui.notify(`guard[chezmoi-target]: ${problem}, so the chezmoi-target rule is not in effect: edit/write on files that chezmoi generates is not confirmed.`, "warning");
		};
		if (managed === "failed" && !chezmoiFailing) warn("`chezmoi managed` failed or timed out (outside full mode it runs in a sandbox that cannot write anywhere; check the templates in the chezmoi source)");
		chezmoiFailing = managed === "failed";
		if (managed === "missing" && !chezmoiMissingTold && usesChezmoi()) {
			chezmoiMissingTold = true;
			warn("this host has a chezmoi config or source, but no usable chezmoi was found on PATH (relative entries, shims that resolve to another name such as mise's, and binaries in sandbox-writable places are skipped)");
		}
		return chezmoiTarget(typeof managed === "string" ? new Set() : managed);
	}

	pi.on("session_start", (event, ctx) => {
		// 継いだ Pi は掃除しない。sandbox の pid namespace の中で起こされていると、外の Pi がみな居ないように見える。
		if (event.reason === "startup" && !inherited) {
			sweepScratch();
			sweepAsks(asksHome());
		}
		restore(ctx);
		chezmoiFailing = false;
		chezmoiMissingTold = false;
		if (inherited && !ctx.hasUI) process.stderr.write(`${GUARD_LOADED}\n`);
	});
	// 枝を移ると、移る前の枝で起こした job の結果が別の枝に届く。モードも枝ごとなので、job は持ち越さない。
	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
		await monitor.reset();
	});
	// readonly の job は scratch を TMPDIR にしている。止まるのを待ってから消す。
	pi.on("session_shutdown", async () => {
		await monitor.reset();
		if (scratch) rmSync(scratch, { recursive: true, force: true });
		scratch = undefined;
		asks?.stop();
		asks = undefined;
	});

	// モードは呼び出しのたびに読む (/permissions で途中から変わる)。`tool_call` を通らない経路で呼ばれても
	// sandbox なしでは走らないよう、ここでも例外で止める。
	//
	// settings.json の shellPath と shellCommandPrefix もここで足す。bash を同名で差し替えたので、Pi が組み込みの bash に
	// 渡している分 (agent-session.js の _buildRuntime) は届かない。createBashToolDefinition の shellPath に渡さないのは、
	// それが sandbox の外で launcher を起こすシェルになるから。読むのは呼び出しのたび (factory の中では getSettings が使えない)。
	const sandboxed: BashSpawnHook = (given) => {
		const { shellPath, shellCommandPrefix } = pi.getSettings();
		const context = shellCommandPrefix ? { ...given, command: `${shellCommandPrefix}\n${given.command}` } : given;
		const shell = shellPath?.replace(/^~(?=$|\/)/, homedir());
		if (mode === "full") return shell ? viaShell(context, shell) : context;
		const argv = sandboxArgv(roots(), readDenied(), [...gitLocks(root, gitDir), ...cacheLocks()]);
		if (!argv) throw new Error(`guard[sandbox]: no OS sandbox on ${process.platform}.`);
		const wrapped = wrap(context, argv, shell);
		if (mode === "readonly") wrapped.env.TMPDIR = scratch;
		return wrapped;
	};
	pi.registerTool(createBashToolDefinition(process.cwd(), { spawnHook: sandboxed }));
	const monitor = registerMonitor(pi, sandboxed);

	// ほかの拡張が自分で起こすコマンド (verify の検証コマンド) を、bash ツールと同じ準備に通す口。返すのは準備済みの
	// command / cwd / env だけで、起こすのは頼んだ側。sandbox の部品 (書ける場所、launcher の引数) は外へ渡さない。
	// 渡すと、境界を決める場所がここと頼む側の 2 つになる。
	// 頼んでくるのは Pi のプロセスの中の拡張で、sandbox の中のコマンドからは届かない。頼まずに起こすこともできる相手なので、
	// ここを通ることは強制できない (README の「できないこと」)。
	// 固定の forbid は効かせる。confirm の規則と ask の確認は掛けない: 何を走らせるかを承認するのは頼んだ拡張の仕事で
	// (verify なら `/verify add` を打った人)、ここで訊くと、人が登録したコマンドをタスクの終端のたびに訊き直すことになる。
	pi.events.on(BASH_CHANNEL, (data) => {
		const request = data as { command?: unknown; cwd?: unknown; env?: NodeJS.ProcessEnv; reply?: unknown } | null;
		if (typeof request?.reply !== "function" || typeof request.command !== "string" || typeof request.cwd !== "string") return;
		try {
			const rule = evaluate(BASH_RULES, request.command);
			if (rule?.decision === "forbid") throw new Error(`guard[${rule.id}]: ${rule.reason}`);
			if (mode !== "full" && !sandboxAvailable()) throw new Error(`guard[sandbox]: The OS sandbox is unavailable, so nothing was run in ${mode} mode.`);
			// readonly かどうかも返す。書けずに落ちたコマンドを、頼んだ側がコードの失敗として扱わないようにするため (verify)。
			request.reply({ ...sandboxed({ command: request.command, cwd: request.cwd, env: request.env ?? process.env }), readonly: mode === "readonly" });
		} catch (error) {
			request.reply({ error: (error as Error).message });
		}
	});

	// ほかの拡張が sandbox の外で起こす道具 (checkpoint と verify の git) の実体を訊く口。名前だけで起こすと PATH を探し、
	// PATH の要素が書ける場所の中にあれば (root の中の `.venv/bin`、allowWrite で開けた mise の shims)、モデルの置いたものが sandbox の外で走る。
	// 見つからなければ undefined を返す。返事が無い (guard が居ない) のとは別で、頼んだ側は名前で起こし直さない。
	pi.events.on(BINARY_CHANNEL, (data) => {
		const request = data as { name?: unknown; reply?: unknown } | null;
		if (typeof request?.reply === "function" && typeof request.name === "string") request.reply(binary(request.name, plantable()));
	});

	/**
	 * subagent の worktree のための git を走らせる (worktree.ts)。full 以外では sandbox の中で、どの sandbox かは下の 2 つが決める。
	 * Pi のプロセスでそのまま打たないのは、子が書いた後の作業ツリーと `.git` の上で git を動かすことになるから。
	 */
	const gitIn = (sandbox: () => string[] | undefined): Run => async (script, args) => {
		const argv = mode === "full" ? [] : sandbox();
		if (!argv) throw new Error(`guard[sandbox]: no OS sandbox on ${process.platform}.`);
		const [command, ...rest] = [...argv, "/bin/bash", "-c", script, "bash", ...args];
		try {
			return (await promisify(execFile)(command, rest, { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout;
		} catch (error) {
			throw new Error(String((error as { stderr?: string }).stderr || (error as Error).message).trim());
		}
	};
	// worktree を作る git は bash と同じ sandbox。root と git の common dir に書く。
	const git = gitIn(() => sandboxArgv(roots(), readDenied(), [...gitLocks(root, gitDir), ...cacheLocks()]));
	// 子が終わった後の差分を取る git は、どこにも書けない sandbox で打つ。子は自分の worktree の中に、その上で走る git が
	// 実行する設定を用意できる (向け直した commondir の先の config、index に載せた入れ子のリポジトリの config)。
	// bash と同じ書ける場所つきで打つと、子の用意したスクリプトが親の root と隣の worktree に書く。
	// 設定を 1 つずつ無効にする (`-c core.fsmonitor=false` など) 道は取らない。git がコマンドを起こす設定は数え切れない。
	const inspect = gitIn(() => sandboxArgv([], readDenied()));
	/** worktree つきで通した subagent の呼び出し。結果が来たら差分を付ける。 */
	const worktrees = new Map<string, Worktree[]>();

	/** 確認で人が承認した edit / write。呼び出しの id → 承認されたパス (`tool_call` で判定したもの)。 */
	const approved = new Map<string, string>();
	// 承認の後で実行されなかった呼び出し (後ろの拡張の `tool_call` が遮断した、実行の前に中断された) は fileIO を通らない。
	// `tool_result` は実行された呼び出しにしか来ないので、どの終わり方でも来るこちらで消す。
	pi.on("tool_execution_end", (event) => {
		approved.delete(event.toolCallId);
		worktrees.delete(event.toolCallId);
	});

	/**
	 * edit / write の I/O。full では Pi の既定 (Pi のプロセス内の fs) に任せ、ほかは sandbox の中で行う。
	 * `tool_call` のパス判定が決めるのは呼び出しを通すかどうかだけ。判定と実際に開くパスがずれても、読み書きは OS の境界で止まる。
	 * モードは呼び出しのたびに読むので、定義を呼び出しごとに作る (公式 sample の ssh.ts と同じ形)。
	 *
	 * 人が確認で承認した呼び出しも Pi の既定に任せる。承認されるのは sandbox が止める先 (書ける場所の外、git の場所) なので、
	 * sandbox の中で行うと承認が嘘になる。承認は id とパスの両方に結び、1 回で消す。id だけに結ぶと、承認の後で
	 * ほかの拡張の `tool_call` が書き換えた path まで外で開く。
	 */
	function fileIO(id: string, path: string, cwd: string) {
		const allowed = approved.get(id);
		approved.delete(id);
		if (mode === "full" || allowed === targetPath(path, cwd)) return undefined;
		const argv = sandboxArgv(roots(), readDenied(), [...gitLocks(root, gitDir), ...cacheLocks()]);
		if (!argv) throw new Error(`guard[sandbox]: no OS sandbox on ${process.platform}.`);
		return fileOperations(argv);
	}
	pi.registerTool({
		...createWriteToolDefinition(process.cwd()),
		execute: async (id, params, signal, onUpdate, ctx) =>
			createWriteToolDefinition(process.cwd(), { operations: fileIO(id, params.path, ctx.cwd) }).execute(id, params, signal, onUpdate, ctx),
	});
	pi.registerTool({
		...createEditToolDefinition(process.cwd()),
		execute: async (id, params, signal, onUpdate, ctx) =>
			createEditToolDefinition(process.cwd(), { operations: fileIO(id, params.path, ctx.cwd) }).execute(id, params, signal, onUpdate, ctx),
	});

	pi.registerCommand("permissions", {
		description: "Show or set tool permissions: full, normal (sandboxed bash), ask, readonly",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (requested) {
				if (!isPermissionMode(requested)) {
					ctx.ui.notify("Usage: /permissions [full|normal|ask|readonly]", "warning");
					return;
				}
				if (inherited) {
					ctx.ui.notify(`Permissions: ${mode}, inherited from the parent Pi session and cannot be changed here.`, "warning");
					return;
				}
				pi.appendEntry(PERMISSIONS_ENTRY, { version: 1, mode: requested } satisfies PermissionState);
				const tightened = STRICTNESS.indexOf(requested) > STRICTNESS.indexOf(mode);
				mode = requested;
				publish();
				show(ctx);
				if (tightened) await monitor.stopAll();
			}
			const excluded = rootExcluded(root);
			const extra = extras();
			const tilde = (path: string) => path.replace(homedir(), "~");
			const extraLine = extra.ignored
				? `guard.json ignored: ${extra.file} is writable from the sandbox.`
				: [
						extra.paths.length > 0 ? `Extra write paths in normal/ask (guard.json allowWrite; nonexistent ones are skipped): ${extra.paths.map(tilde).join(", ")}.` : "",
						extra.rejected.length > 0 ? `guard.json allowWrite rejected: ${extra.rejected.map(({ path, reason }) => `${tilde(path)} (${reason === "home" ? "contains your home directory" : "overlaps a directory guard relies on being unwritable"})`).join(", ")}.` : "",
					].filter(Boolean).join(" ");
			ctx.ui.notify(
				[
					`Permissions: ${mode}${inherited ? " (inherited from the parent Pi session)" : ""}. Write root: ${excluded ? `none (${root} ${excluded === "home" ? "contains your home directory" : "overlaps a path the sandbox must not read"}, so it is not writable; start Pi in a project directory)` : root}`,
					`full: no sandbox. normal (default): the bash tool, monitor jobs and the file I/O of edit/write run in an OS sandbox that can write only to the write root, the temp dir and a few tool caches, and cannot write git's hooks or config; edit/write outside those need confirmation, and a confirmed one is done outside the sandbox. Outside full, the sandbox cannot read ${READ_DENIED_PATHS.map((entry) => entry().replace(homedir(), "~")).join(", ")}, and read/grep/find/ls/edit on those paths (or grep/find on a directory containing them) need confirmation. ask: normal, plus confirmation for every tool that is not read-only. readonly: bash and monitor run with a read-only filesystem (private TMPDIR only, plus the per-user temp dir on macOS); edit/write and tools without a trusted readOnlyHint are blocked.`,
					...(extraLine ? [extraLine] : []),
					`Sandbox: ${mode === "full" ? "off" : sandboxAvailable() ? "available" : "UNAVAILABLE, bash and edit/write are blocked"}. Fixed guard rules apply in every mode.`,
					"Not covered: your own ! commands, MCP and other extension tools (readOnlyHint is not verified), processes outside Pi. Network and all other reads are not restricted, and secrets already in Pi's environment variables stay visible to bash. Mode is persisted per session and branch; subagents inherit it.",
				].join("\n"),
				"info",
			);
		},
	});

	/**
	 * bash の結果に、書かせない git の場所 (gitLocks) のせいで起きたことの説明を足す。
	 * config を書けなかった git は、error の行のあとに成功の文面を出して終了コード 0 で終わることがあり (`git branch -u` など)、
	 * モデルが成功と読み違える。git の設定や環境変数で非ゼロ終了にする手は無いので、結果のほうに書く。
	 * 自分で clone したリポジトリを消せないのも、理由が出力からは分からない。
	 * full では足さない (sandbox が無く、書けている)。見るのは届いた文面だけなので、モデルが stderr を捨てたときと、
	 * Pi が切り詰めた分に行があったときは拾えない (README)。
	 * structuredContent (bash を呼んだスクリプトが読む出力と終了コード) はそのまま返す。content だけを返すと Pi が落とす。
	 */
	function explainGitLocks({ content, structuredContent }: ToolResultEvent, cwd: string): Pick<ToolResultEvent, "content" | "structuredContent"> | undefined {
		if (mode === "full") return undefined;
		const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		const lines = text.split("\n");
		const unsaved = lines.flatMap((line) => configNotWritten(line) ?? []);
		// `.git` という名前でない common dir (bare に近い置き方、separate-git-dir) の config は、guard が守っている場所と照らす。
		const guarded = (path: string) => GIT_CONFIG_PATH.test(path) || inside(gitLocks(root, gitDir).map((lock) => lock.path), resolve(cwd, path));
		// 行が何本あっても説明は 1 つずつ。既に入っている結果 (もう一度通された) には足し直さない。
		const notes = [
			...(unsaved.some(guarded) ? [GIT_CONFIG_NOT_SAVED] : []),
			...(lines.some((line) => configNotWritten(line) === undefined && GIT_LOCK_REFUSED.test(line)) ? [GIT_LOCK_KEPT] : []),
		].filter((note) => !text.includes(note));
		return notes.length > 0 ? { content: [...content, ...notes.map((note) => ({ type: "text" as const, text: note }))], structuredContent } : undefined;
	}

	// 子の Pi で guard が読み込まれない (拡張の読み込み失敗、別の agent dir) か、PI_GUARD を継がない (環境変数を作り直す
	// spawner) と、子は規則表も sandbox も無しで動き、どこにも出ない。子は止められない (起こすのは別の拡張) ので、
	// 終わった後で結果に書き足す。見るのは公式 sample の subagent が返す details の形だけ。
	//
	// 中断された subagent は例外で終わり (sample の "Subagent was aborted")、Pi はその結果の details を空にする。結果だけを見ると、
	// guard の無い子が道具を使った後で止められたときに何も出ない。途中経過にも同じ形の details が載るので、最後に届いたものを
	// 結果が来るまで覚えておく。sample は子ごとの result を書き足しながら同じものを渡し、子が終わってから例外を投げるので、
	// 覚えた result の stderr は途中経過の時点で切れていない。
	const partials = new Map<string, unknown>();
	pi.on("tool_execution_update", (event) => {
		if (event.toolName === "subagent") partials.set(event.toolCallId, (event.partialResult as { details?: { results?: unknown } } | undefined)?.details?.results);
	});
	pi.on("tool_result", async (event, ctx) => {
		// monitor の job の出力 (monitor / jobs ツール) は見ない。
		if (event.toolName === "bash") return explainGitLocks(event, ctx.cwd);
		if (event.toolName !== "subagent") return undefined;
		const made = worktrees.get(event.toolCallId);
		const isolated = made ? [{ type: "text" as const, text: await report(inspect, made) }] : [];
		const reported: unknown = (event.details as { results?: unknown } | undefined)?.results;
		const found = Array.isArray(reported) ? reported : partials.get(event.toolCallId);
		partials.delete(event.toolCallId);
		const results: Array<{ agent?: unknown; messages?: unknown; stderr?: unknown; exitCode?: unknown; stopReason?: unknown; errorMessage?: unknown } | null> = Array.isArray(found) ? found : [];
		const unguarded = results.flatMap((result) => {
			// messages が空の子はセッションを始めていない (未知の agent、spawn の失敗)。何も実行していないので数えない。
			const ran = Array.isArray(result?.messages) && result.messages.length > 0;
			return ran && !String(result?.stderr ?? "").includes(GUARD_LOADED) ? [String(result?.agent)] : [];
		});
		// sample は、失敗した子の説明に errorMessage、無ければ stderr、それも無ければ子の最後の出力を使う。知らせの 1 行で stderr が
		// 空でなくなったので、そのままだと最後の出力の代わりにこの行が親のモデルに届く。説明に入った stderr を、行を除いたものに戻す。
		// stderr をそのまま説明に入れる、という sample の形に頼っている。形が変われば何も置き換えず、知らせの行が説明に残る。
		let content = event.content;
		for (const result of results) {
			// 説明に stderr が使われるのは、失敗して errorMessage の無い子だけ (sample の isFailedResult と getResultOutput)。
			// 絞らないと、同じ 1 行だけの stderr を持つ成功した子の出力が、並列の別の子の説明に入る。
			const failed = result?.exitCode !== 0 || result?.stopReason === "error" || result?.stopReason === "aborted";
			if (!failed || result?.errorMessage) continue;
			const stderr = String(result?.stderr ?? "");
			if (!stderr.includes(GUARD_LOADED) || !content.some((part) => part.type === "text" && part.text.includes(stderr))) continue;
			const shown = stderr.replace(`${GUARD_LOADED}\n`, "") || lastOutput(result?.messages) || "(no output)";
			content = content.map((part) => (part.type === "text" ? { ...part, text: part.text.replace(stderr, () => shown) } : part));
		}
		if (unguarded.length === 0) return content === event.content && !made ? undefined : { content: [...content, ...isolated] };
		const warning = `guard[subagent]: The subagent(s) ${unguarded.join(", ")} ran without guard: no rule table and no sandbox applied to their tool calls. Treat what they did as unchecked, tell the user, and do not delegate again until the user has confirmed that the guard extension loads in subagents.`;
		if (ctx.hasUI) ctx.ui.notify(warning, "warning");
		return { content: [...content, { type: "text", text: warning }, ...isolated] };
	});

	// worktree を作るのは、下の判定 (規則表、モード、確認) が通した後。断られた呼び出しのために作らない。
	pi.on("tool_call", async (event, ctx) => {
		const verdict = await judge(event, ctx);
		const input = event.input as SubagentInput;
		if (verdict || event.toolName !== "subagent") return verdict;
		// worktree に絞られた子が起こす孫は、PI_GUARD の root (親の root) を継ぎ、自分の cwd から絞り直す。worktree の外を
		// cwd に指定されると、孫は親の root や隣の worktree に書ける。相対の cwd は sample が spawn にそのまま渡すので、taskRoot と同じく Pi の cwd から数える。
		if (inherited && root !== inherited.root) {
			// 孫が絞られる先が自分の worktree の中 (自分の worktree そのものか、その中の worktree) なら通す。
			const escaping = [input, ...(input.tasks ?? []), ...(input.chain ?? [])].find((task) => task.cwd !== undefined && !inside([root], taskRoot(inherited.root, String(task.cwd)) ?? inherited.root));
			if (escaping) {
				return { block: true, reason: `guard[worktree]: cwd ${String(escaping.cwd)} is outside this session's worktree (${root}), and a subagent started there could write outside it. No subagent was started. Do not retry or route around this; delegate without cwd, or with a cwd inside the worktree.` };
			}
		}
		if (input.worktree !== true) return undefined;
		if (mode !== "full" && !sandboxAvailable()) {
			return { block: true, reason: "guard[sandbox]: The OS sandbox is unavailable, so the worktrees cannot be created. No subagent was started. Stop and tell the user." };
		}
		try {
			worktrees.set(event.toolCallId, await addWorktrees(git, root, input));
		} catch (error) {
			return { block: true, reason: `guard[worktree]: ${(error as Error).message} No subagent was started. Do not retry with the same arguments; report this, or delegate without worktree.` };
		}
		return undefined;
	});

	async function judge(event: ToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
		let rule: Rule | undefined;
		let subject = "";
		const shell = event.toolName === "bash" || event.toolName === "monitor";
		const file = event.toolName === "edit" || event.toolName === "write";
		if (isToolCallEventType("bash", event)) {
			subject = event.input.command;
			rule = evaluate(BASH_RULES, subject);
		} else if (event.toolName === "monitor") {
			subject = String((event.input as { command?: unknown }).command ?? "");
			rule = evaluate(BASH_RULES, subject);
		} else if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			subject = targetPath(event.input.path, ctx.cwd);
			const rules = [...PATH_RULES, chezmoiRule(ctx)];
			// edit は書く前に読み、結果の diff で周りの行を返す。
			if (mode !== "full" && event.toolName === "edit") rules.push(readDeniedPath(readDenied()));
			if (mode === "normal" || mode === "ask") rules.push(gitLocked(gitLocks(root, gitDir)), outsideRoots(roots()));
			rule = evaluate(rules, subject);
		} else if (mode !== "full" && ["read", "grep", "find", "ls"].includes(event.toolName)) {
			// read 以外は path を省け、そのとき cwd を見る。
			subject = targetPath((event.input as { path?: string }).path || ".", ctx.cwd);
			const rules = [readDeniedPath(readDenied())];
			if (event.toolName === "grep" || event.toolName === "find") rules.push(containsReadDenied(readDenied()));
			rule = evaluate(rules, subject);
		}
		// 固定の forbid はモードやメタデータ、確認ダイアログより先に適用する。
		if (rule?.decision === "forbid") {
			if (ctx.hasUI) ctx.ui.notify(`guard[${rule.id}] blocked: ${head(subject)}`, "warning");
			return { block: true, reason: `guard[${rule.id}]: ${rule.reason}` };
		}

		// sandbox が無いのに通すと、normal も readonly も名前だけになる。黙って素の bash や Pi のプロセス内の fs に落とさない。
		if ((shell || file) && mode !== "full" && !sandboxAvailable()) {
			const reason = `guard[sandbox]: The OS sandbox is unavailable, so ${event.toolName} is disabled in ${mode} mode. Stop and tell the user: install bubblewrap (Linux, with unprivileged user namespaces enabled), or switch with /permissions full. Do not retry or route around this.`;
			if (ctx.hasUI) ctx.ui.notify(reason, "warning");
			return { block: true, reason };
		}

		const permission = judgePermission(
			mode,
			event.toolName,
			mode === "full" || mode === "normal" ? undefined : pi.getAllTools().find((tool) => tool.name === event.toolName),
		);
		if (permission === "forbid") {
			const reason = `guard[readonly]: ${event.toolName} is not an allowed read-only tool.`;
			if (ctx.hasUI) ctx.ui.notify(reason, "warning");
			return { block: true, reason };
		}

		if (!rule) {
			if (permission !== "confirm") return undefined;
			const answer = await confirm(ctx, "guard: ask", `${event.toolName}\n\n${head(JSON.stringify(event.input))}\n\nAllow?`);
			if (answer === undefined) return { block: true, reason: `guard[ask]: ${event.toolName} needs the user's approval and no user can be asked in this session. Do not retry or route around this; report what you wanted to do.` };
			if (answer) return undefined;
			return { block: true, reason: `guard[ask]: ${event.toolName} was not approved.` };
		}

		const answer = rule.decision === "confirm" ? await confirm(ctx, `guard: ${rule.id}`, `${head(subject)}\n\n${rule.reason}\n\nAllow?`) : undefined;
		if (answer) {
			if (file) approved.set(event.toolCallId, subject);
			return undefined;
		}
		if (answer === false) return { block: true, reason: `guard[${rule.id}]: denied by the user. ${rule.reason}` };
		if (ctx.hasUI) ctx.ui.notify(`guard[${rule.id}] blocked: ${head(subject)}`, "warning");
		// forbid は上で返したので、ここに来るのは訊けなかった confirm。誰にも訊いていないことを理由に書く。
		return { block: true, reason: `guard[${rule.id}]: ${rule.reason} No user can be asked in this session.` };
	}
}
