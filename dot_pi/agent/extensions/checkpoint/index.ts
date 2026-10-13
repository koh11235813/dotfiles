import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** タスク開始時の作業ツリー。tree は git の tree object で、commit でも stash でもない。 */
type Baseline = { version: 1; top: string; tree: string };
type Change = { status: string; path: string };
/** 実体の決まった git (下の run に binary を渡したもの)。 */
type Git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv, tolerated?: number, input?: string | Buffer) => Promise<Buffer>;

function isBaseline(data: unknown): data is Baseline {
	if (!data || typeof data !== "object") return false;
	const saved = data as Partial<Baseline>;
	// tree は git の引数になる。セッションファイルから来るので、object id の形だけを通す。
	return saved.version === 1 && typeof saved.top === "string" && typeof saved.tree === "string" && /^[0-9a-f]{40,64}$/.test(saved.tree);
}

/**
 * hook と fsmonitor を切るのは、リポジトリの設定がモデルの書ける場所にあり、ここは sandbox の外で走るため。
 * hook は 2 通りある。hooks ディレクトリのものは core.hooksPath で、設定に書いたもの (hook.<名前>.event / command) は event ごとの
 * hook.<event>.enabled で止める。event は、ここの git が出す 2 つ: index を書く add / update-index / write-tree の post-index-change と、
 * restore の post-checkout。この鍵が効くのは git 2.56 から。設定に書いた hook を読むのにこの鍵を知らない版 (下の HOOKS_UNSTOPPABLE) では、
 * hook の起きうる git を起こさない。その版に名前ごとの hook.<名前>.enabled=false を渡さないのも、filter のように設定から名前を読んで
 * 1 つずつ止めないのも、読んでから git が走るまでの間に、sandbox の中の job が新しい名前を足せるため。
 * remote へも行かせない。設定に promisor remote を足して object を 1 つ消すと、git は欠けた object を取りに行き、
 * remote の設定 (`ext::` の url、core.sshCommand) がコマンドを起こす。GIT_NO_LAZY_FETCH は取りに行くこと自体を止め (知らない古い git もある)、
 * 空の GIT_ALLOW_PROTOCOL はどの transport も許さない (設定の protocol.*.allow より強い)。ここの git は remote を使わない。
 * `-c protocol.allow=never` にしないのは、設定の protocol.ext.allow=always がそれに勝つため。
 * パスは git の出力か人の入力なので、pathspec の記号として解釈させない。
 */
function run(binary: string, cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, tolerated?: number, input: string | Buffer = ""): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			binary,
			["-c", "core.hooksPath=/dev/null", "-c", "hook.post-index-change.enabled=false", "-c", "hook.post-checkout.enabled=false", "-c", "core.fsmonitor=false", "--literal-pathspecs", ...args],
			{ cwd, env: { ...process.env, ...env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" }, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
			(error, stdout) => (error && error.code !== tolerated ? reject(error) : resolve(stdout)),
		);
		// 起動に失敗したときの EPIPE は、上の callback が同じ失敗を伝えるので捨てる。
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});
}

/**
 * 設定に書いた hook を読むのに、event ごとに止める鍵 (hook.<event>.enabled) を知らない git の版 ("<major>.<minor>")。
 * それより古い版を入れないのは、設定に書いた hook という仕組み自体が無いため。実物で確かめたのは 2.47.3 だけで、
 * 2.48〜2.53 は upstream の Documentation/config/hook.adoc を版ごとに比べて「2.54 から」と読んだ。
 * 表にして export しているのは、テストが門を外す (空にする) ため。環境変数にしないのは、モデルが触れる経路になりうるため。
 */
export const HOOKS_UNSTOPPABLE: string[] = ["2.54", "2.55"];

/** `git --version` の出力から、その git では基準を取らない理由を返す。取ってよければ無し。読めない版は取らない側に倒す。 */
export function hookGate(output: string): string | undefined {
	// 版の後ろに "(Apple Git-157)" や ".windows.1" が付くことがある。
	const [, version, series] = output.match(/^git version ((\d+\.\d+)\S*)/) ?? [];
	if (!version) return "checkpoint: 基準を取らない (git の版を読めない。設定に書いた hook を止められる git 2.56 以上が要る)";
	if (HOOKS_UNSTOPPABLE.includes(series)) return `checkpoint: 基準を取らない (git ${version} は設定に書いた hook を止められない。git 2.56 以上が要る)`;
}

/**
 * 設定にある filter をすべて空で上書きする環境変数と、その filter の名前。clean / process は git add が、smudge は git restore が sandbox の外で走らせる。
 * リポジトリの設定 (.git/config とそこからの include) は、モデルの書ける場所にある。
 * 利用者の設定 (~/.gitconfig や system) の filter を残さないのは、どのファイルに掛けるかを決める .gitattributes をモデルが書けるため。
 * 絶対パスでない filter (`git lfs install` が書く `git-lfs clean -- %f`) は git が PATH から探すので、PATH で本物より前に
 * sandbox の中から書ける場所があれば、そこに置かれた同じ名前のものが走る。
 * `-c` で渡さないのは、filter の名前に "=" が入ると鍵と値の切れ目がずれるため。
 */
async function filters(git: Git, top: string): Promise<{ env: NodeJS.ProcessEnv; names: Set<string> }> {
	// 並びは "<鍵>" NUL の繰り返し。1 つも無いと git は 1 で終わる。
	const pattern = "^filter\\..*\\.(clean|smudge|process|required)$";
	const keys = (await git(top, ["config", "--name-only", "-z", "--get-regexp", pattern], {}, 1)).toString().split("\0");
	const env: NodeJS.ProcessEnv = {};
	const names = new Set<string>();
	let count = 0;
	for (const key of keys) {
		if (!key) continue;
		env[`GIT_CONFIG_KEY_${count}`] = key;
		// required も空 (偽) にする。残すと、空にした filter を git が失敗として扱い、add が止まる。
		env[`GIT_CONFIG_VALUE_${count++}`] = "";
		names.add(key.slice("filter.".length, key.lastIndexOf(".")));
	}
	env.GIT_CONFIG_COUNT = String(count);
	return { env, names };
}

/**
 * 今の作業ツリーを tree object にする。git の作業ツリーの中でなければ無し。
 * `git stash create` を使わないのは、未追跡ファイルを拾わず、変更が無いと何も返さないため。
 * 一時 index を使うのは、利用者の index (staging) を動かさないため。
 */
async function snapshot(git: Git, cwd: string): Promise<{ top: string; tree: string } | undefined> {
	// 作業ツリーの外では git は 128 で終わり、何も出さない。それ以外の失敗 (git を起動できないなど) は「外」に数えず、呼び出し元に伝える。
	const [top, gitDir] = (await git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"], {}, 128)).toString().trimEnd().split("\n");
	if (!gitDir) return undefined;
	const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-"));
	try {
		const env = { ...(await filters(git, top)).env, GIT_INDEX_FILE: join(dir, "index") };
		// 空の index から始めると全ファイルを読み直す。commit が無いリポジトリには index が無い。
		try { copyFileSync(join(gitDir, "index"), env.GIT_INDEX_FILE); } catch {}
		// skip-worktree (S) / assume-unchanged (小文字) の印が付いたファイルを git add は見ない。
		// 写しを捨てて空から読み直さないのは、追跡済みで .gitignore に当たるファイルが tree から落ちるため。写しの側の印だけを外す。
		// 並びは "<印> <パス>" NUL の繰り返し。
		const flagged = (await git(top, ["ls-files", "-v", "-z"], env)).toString("latin1").split("\0").filter((entry) => /^[Sa-z] /.test(entry));
		if (flagged.length > 0) {
			const paths = Buffer.from(flagged.map((entry) => `${entry.slice(2)}\0`).join(""), "latin1");
			// 2 つを 1 回で渡すと、git は assume-unchanged の側しか外さない。
			for (const flag of ["--no-skip-worktree", "--no-assume-unchanged"]) await git(top, ["update-index", flag, "-z", "--stdin"], env, undefined, paths);
		}
		// 読めないファイルや commit の無い入れ子リポジトリが 1 つあるだけで全体を諦めない。そのとき git は残りを入れて 1 で終わる。
		await git(top, ["add", "-A", "--ignore-errors"], env, 1);
		return { top, tree: (await git(top, ["write-tree"], env)).toString().trim() };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function changes(git: Git, top: string, from: string, to: string): Promise<Change[]> {
	// 並びは ":<旧 mode> <新 mode> <旧 id> <新 id> <状態>" NUL "<パス>" NUL の繰り返し。
	const fields = (await git(top, ["diff-tree", "-r", "-z", "--raw", from, to])).toString().split("\0");
	const list: Change[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) list.push({ status: fields[i].split(" ")[4][0], path: fields[i + 1] });
	return list;
}

/**
 * ファイルの指紋。symlink は辿らず、指す先の文字列で比べる。無ければ null。
 * 中身だけにしないのは、git が覚える実行ビットも戻すと書き換わるため。人の chmod を「Pi が書いたまま」に数えない。
 */
function fingerprint(path: string): string | null {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
		if (!stat.isFile()) return "other";
		// git と同じく、持ち主の実行ビットだけを見る。
		return `${stat.mode & 0o100 ? "100755" : "100644"}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
	} catch {
		return null;
	}
}

/** 基準の tree に入っている path の指紋。fingerprint と同じ形で返す。 */
async function baselineFingerprint(git: Git, baseline: Baseline, path: string): Promise<string | null> {
	// 並びは "<mode> <種類> <id>" TAB "<パス>" NUL。
	const entry = (await git(baseline.top, ["ls-tree", "-z", baseline.tree, "--", path])).toString();
	if (!entry) return null;
	const [mode, type, id] = entry.split(/[ \t]/);
	if (type !== "blob") return "other";
	const data = await git(baseline.top, ["cat-file", "blob", id]);
	return mode === "120000" ? `link:${data}` : `${mode}:${createHash("sha256").update(data).digest("hex")}`;
}

/**
 * write / edit の引数が指すファイルを、top からの相対パスにする。top の外なら無し。
 * 前半は Pi の resolveToCwd (utils/paths.js の resolvePath) の写し。SDK が export していない。
 * ずれても「Pi が書いた」記録が付かないだけで、そのファイルは確認に回る側へ倒れる。
 * 最後の要素を辿らないのは、symlink そのものを 1 つのファイルとして扱うため。
 */
function repoPath(input: string, cwd: string, top: string): string | undefined {
	let path = input.replace(/[  -   　]/g, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	else if (/^file:\/\//.test(path)) path = fileURLToPath(path);
	path = resolve(cwd, path);
	try {
		path = join(realpathSync(dirname(path)), basename(path));
	} catch {
		return undefined;
	}
	const rel = relative(top, path);
	return rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) ? rel : undefined;
}

/**
 * path を戻すと巻き添えで消える、path とは別のもの。無ければ無し。
 * git restore は、途中の階にあるファイルや symlink も、path の位置にあるディレクトリの中身も、黙って消して置き換える。
 */
function obstacle(top: string, path: string): string | undefined {
	const parts = path.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const at = parts.slice(0, i).join("/");
		try {
			const isDirectory = lstatSync(join(top, at)).isDirectory();
			if (i < parts.length ? !isDirectory : isDirectory && readdirSync(join(top, at)).length > 0) return at;
		} catch {
			return undefined;
		}
	}
}

/** guard の monitor に job の一覧を訊く口 (guard/monitor/index.ts の JOBS_CHANNEL)。 */
const MONITOR_JOBS = "monitor:jobs";
/** guard に、sandbox の外で起こす道具の実体を訊く口 (guard/index.ts の BINARY_CHANNEL)。 */
const GUARD_BINARY = "guard:binary";
const DIFF_LINES = 200;
/** 確認なしで戻してよい唯一の状態。 */
const OWN = "Pi が書いたまま";
/** guard が「書ける場所の外に git は無い」と答えたときの失敗。 */
const NO_GIT = "sandbox の中から書けない場所の PATH に git が無い";

export default function (pi: ExtensionAPI) {
	let baseline: Baseline | undefined;
	/** Pi の write / edit が最後に書いた中身。メモリの中だけにあり、reload や再起動で消える。 */
	const written = new Map<string, string | null>();

	/** Pi が書く直前に、基準とも Pi の前回の書き込みとも違っていたファイル。Pi の上書きで見えなくなる変更を覚えておく。 */
	const mixed = new Set<string>();
	/** git の実体が無いことを、このセッションでもう知らせたか。 */
	let toldNoGit = false;

	/**
	 * guard が居れば、git の実体を guard に訊いてから起こす。名前だけで起こすと PATH を探し、PATH の要素が sandbox の中から
	 * 書ける場所にあると (root の中の `.venv/bin`、allowWrite で開けた mise の shims)、モデルの置いた git がここ (sandbox の外) で走る。
	 * 返事が無ければ guard は居ない。sandbox も無いので、名前のまま起こす。
	 * 「無い」という返事なら起こさない。名前で起こし直すと、guard が飛ばした候補を拾う。
	 * 覚えずに毎回訊く。PATH も書ける場所もセッションの途中で変わりうる。
	 */
	const git: Git = async (cwd, ...rest) => {
		let binary: string | undefined = "git";
		pi.events.emit(GUARD_BINARY, { name: "git", reply: (found?: string) => (binary = found) });
		if (!binary) throw new Error(NO_GIT);
		return run(binary, cwd, ...rest);
	};

	function origin(path: string) {
		if (!written.has(path)) return "Pi の write / edit 以外の変更";
		return !mixed.has(path) && written.get(path) === fingerprint(join(baseline!.top, path)) ? OWN : "Pi と別の変更が混じっている";
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!baseline || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const path = repoPath(String(event.input.path), ctx.cwd, baseline.top);
		if (!path) return;
		try {
			const known = written.has(path) ? written.get(path) : await baselineFingerprint(git, baseline, path);
			if (fingerprint(join(baseline.top, path)) !== known) mixed.add(path);
		} catch {
			// tool_call の handler が投げると Pi はそのツール呼び出しを止める。分からないときは確認に回す側へ倒す。
			mixed.add(path);
		}
	});

	pi.on("tool_result", (event, ctx) => {
		if (!baseline || event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const path = repoPath(String(event.input.path), ctx.cwd, baseline.top);
		if (path) written.set(path, fingerprint(join(baseline.top, path)));
	});

	/**
	 * guard の monitor が走らせている job の id。guard が読み込まれていなければ空 (job を起こす道具も無い)。
	 * 返事は emit の中で来る。Pi のイベントバスは聞き手を emit の中で同期に呼ぶ (dist/core/event-bus.js)。
	 * ここから job を止めないのは、どの job が戻すファイルを書くのかを見分けられず、関係の無い長いビルドまで止めるため。
	 * 止めるか待つかは人が決める。
	 */
	function runningJobs(): string[] {
		let jobs: Array<{ id: string; state: string }> = [];
		pi.events.emit(MONITOR_JOBS, { reply: (given: typeof jobs) => (jobs = given) });
		return jobs.filter((job) => job.state === "running").map((job) => job.id);
	}

	/** いま戻すと、動いている Pi か走っている job が、戻した後で書き換えうる。その断り文。戻してよければ無し。 */
	function stillWriting(ctx: ExtensionContext): string | undefined {
		if (!ctx.isIdle()) return "checkpoint: Pi が動いている間は戻さない。止まってからやり直す。";
		const busy = runningJobs();
		if (busy.length === 0) return undefined;
		// /jobs stop は、シグナルの届かない job (sudo で root になったものなど) を止められず、running のまま残す (monitor の README)。
		return `checkpoint: monitor の job が走っている間は戻さない (${busy.join(", ")})。書いている最中に戻すと、戻した後でまた書き換えられる。/jobs stop <id> で止めるか、終わるのを待ってからやり直す。止めても running のまま残る job は、そのプロセスを自分で終わらせるか、Pi を起動し直す。`;
	}

	function forget() {
		baseline = undefined;
		written.clear();
		mixed.clear();
	}

	/**
	 * いまの git では基準を取らない理由 (hookGate)。取ってよければ無し。add と restore の前に訊く。
	 * 理由を status に出すのは、依頼のたびに訊くので、notify だと同じ warning を繰り返すため。
	 * 覚えずに毎回訊くのは git の実体と同じ理由で、答えが変われば status も変わる。
	 * git を起こせない失敗は、版を読めないのとは別に、そのまま投げる。
	 */
	async function gate(ctx: ExtensionContext): Promise<string | undefined> {
		const reason = hookGate((await git(ctx.cwd, ["--version"])).toString());
		ctx.ui.setStatus("checkpoint", reason);
		return reason;
	}

	/** 取れたら true。取れなかったら、前の基準と Pi の記録には触らない。asked は、人が頼んだ (/checkpoint new) か。 */
	async function take(ctx: ExtensionContext, asked = false) {
		try {
			if (await gate(ctx)) return false;
			const taken = await snapshot(git, ctx.cwd);
			if (!taken) {
				if (baseline) ctx.ui.notify("checkpoint: git の作業ツリーの外なので基準を取れなかった。前の基準をそのまま使う。", "warning");
				return false;
			}
			forget();
			baseline = { version: 1, ...taken };
			pi.appendEntry("checkpoint", baseline);
			return true;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			// git の実体が無いことを毎回は知らせない。次の依頼でも同じ理由で取れず、同じ warning が続く。知らせるのは 1 セッションに 1 度と、人が頼んだとき。
			if (reason !== NO_GIT || asked || !toldNoGit) ctx.ui.notify(`checkpoint: 基準を取れなかった (${reason})${baseline ? "。前の基準をそのまま使う。" : ""}`, "warning");
			toldNoGit ||= reason === NO_GIT;
			return false;
		}
	}

	// 枝 (getBranch) ではなくセッション全体から探す。/tree で会話を戻してもファイルは戻らないので、基準も動かさない。
	pi.on("session_start", async (_event, ctx) => {
		forget();
		toldNoGit = false;
		let saved: Baseline | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "checkpoint" && isBaseline(entry.data)) saved = entry.data;
		}
		if (!saved) return;
		try {
			// 設定に書いた hook を止められない git では、残っていた基準も使わない。使えば /checkpoint が add と restore を起こす。
			if (await gate(ctx)) return;
			// 別のリポジトリで再開したときと、tree が git gc で消えたときは使わず、次の依頼で取り直す。
			const top = (await git(ctx.cwd, ["rev-parse", "--show-toplevel"])).toString().trimEnd();
			await git(ctx.cwd, ["cat-file", "-e", `${saved.tree}^{tree}`]);
			if (top === saved.top) baseline = saved;
		} catch (error) {
			// 別のリポジトリや消えた tree は、黙って次の依頼で取り直す。git の実体が無いときは次の依頼でも取り直せないので、ここで知らせる。
			if (!(error instanceof Error) || error.message !== NO_GIT) return;
			toldNoGit = true;
			ctx.ui.notify(`checkpoint: セッションに残った基準を使えない (${NO_GIT})。`, "warning");
		}
	});

	// 依頼のたびに取り直さない。1 つのタスクが何往復にもなると、途中の依頼で基準が進んで最初の状態に戻れなくなる。
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!baseline) await take(ctx);
	});

	pi.registerCommand("checkpoint", {
		description: "Show what changed since the task started, and restore single files",
		handler: async (args, ctx) => {
			// 動詞の後の空白 1 つだけを区切りにする。全部削ると、名前の頭や末尾に空白があるファイルを渡せない。
			const [, verb, raw = ""] = args.match(/^\s*(\S*)(?:\s(.*))?$/s)!;
			// 基準が残っていても (セッションの途中で git が変わった)、設定に書いた hook を止められない git で下の add / restore を起こさない。
			// 版を訊けない (git を起こせない) ときは、基準を使う動詞ならここで投げて先へ進ませない。
			// new は take が訊き直して知らせ、基準が無ければ下で git を起こさずに終わるので、進ませる。
			const refused = await gate(ctx).catch((error) => {
				if (baseline && verb !== "new") throw error;
				return undefined;
			});
			if (refused) {
				ctx.ui.notify(refused, "warning");
				return;
			}
			const taken = verb === "new" && (await take(ctx, true));
			if (!baseline) {
				ctx.ui.notify("checkpoint: 基準が無い。git の作業ツリーの中で、最初の依頼を送った時点か /checkpoint new で取る。", "info");
				return;
			}
			if (verb === "new") {
				if (taken) ctx.ui.notify(`checkpoint: 今の作業ツリーを新しい基準にした (${baseline.tree.slice(0, 12)})。`, "info");
				return;
			}
			const now = await snapshot(git, baseline.top);
			if (!now) throw new Error(`checkpoint: ${baseline.top} is no longer a git work tree`);
			const list = await changes(git, baseline.top, baseline.tree, now.tree);
			if (list.length === 0) {
				ctx.ui.notify("checkpoint: 基準から変わったファイルは無い。", "info");
				return;
			}
			// 入力そのままの名前が一覧にあればそれを、無ければ前後の空白を除いた名前を指したものとして扱う。
			const path = list.some((item) => item.path === raw) ? raw : raw.trim();
			if (verb === "diff") {
				const range = [baseline.tree, now.tree];
				const lines = (await git(baseline.top, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", ...range, ...(path ? ["--", path] : [])]))
					.toString()
					.trimEnd()
					.split("\n");
				const rest = lines.length - DIFF_LINES;
				if (rest > 0) lines.splice(DIFF_LINES, rest, `… 残り ${rest} 行。全部は git diff ${range.join(" ")}`);
				ctx.ui.notify(lines.join("\n") || `checkpoint: ${path} に差分は無い。`, "info");
				return;
			}
			if (verb === "restore") {
				const change = list.find((item) => item.path === path);
				if (!change) {
					ctx.ui.notify(`checkpoint: 「${path}」は復元候補に無い。/checkpoint の一覧にあるパスをそのまま渡す。`, "warning");
					return;
				}
				const busy = stillWriting(ctx);
				if (busy) {
					ctx.ui.notify(busy, "warning");
					return;
				}
				const blocker = obstacle(baseline.top, path);
				if (blocker) {
					ctx.ui.notify(`checkpoint: ${path} を戻すと「${blocker}」が消えるので戻さない。先に「${blocker}」を戻すか、どかす。`, "warning");
					return;
				}
				if (change.status !== "A") {
					// 並びは "<パス>" NUL "filter" NUL "<値>" NUL。
					const filter = (await git(baseline.top, ["check-attr", "-z", "filter", "--", path])).toString().split("\0")[2];
					if ((await filters(git, baseline.top)).names.has(filter)) {
						ctx.ui.notify(`checkpoint: ${path} には filter「${filter}」が掛かる。その filter を通さずに取った基準は作業ツリーの形と合わないことがあるので戻さない。`, "warning");
						return;
					}
				}
				// 基準の中身が欠けている (object を消された、gc された) まま git restore を打つと、git は作業ツリーのファイルを消してから失敗する。
				if (change.status !== "A" && !(await baselineFingerprint(git, baseline, path).catch(() => undefined))) {
					ctx.ui.notify(`checkpoint: ${path} の基準の中身を git から読めないので戻さない。`, "warning");
					return;
				}
				const seen = fingerprint(join(baseline.top, path));
				const from = origin(path);
				if (from !== OWN) {
					if (!ctx.hasUI) {
						ctx.ui.notify(`checkpoint: ${path} は「${from}」。確認を取れないので戻さない。`, "warning");
						return;
					}
					// 基準を取ったとき ignore されていたファイルは、前からあっても基準に入っておらず、A として出る。
					const asked =
						change.status === "A"
							? ctx.ui.confirm(`${path} を消す?`, `このファイルは「${from}」で、基準に無い。基準を取ったとき .gitignore に当たっていたファイルなら、タスクの前からあったものでも消える。`)
							: ctx.ui.confirm(`${path} を基準に戻す?`, `このファイルは「${from}」。戻すと、Pi 以外が加えた変更も消える。`);
					if (!(await asked)) {
						ctx.ui.notify(`checkpoint: ${path} は戻さなかった。`, "info");
						return;
					}
				}
				// 確認を待つ間にも中身は変わりうるので、控えは書き換える直前に取る。
				const before = await snapshot(git, baseline.top);
				// 上で filter の掛からないパスだと確かめていても、確認を待つ間に .gitattributes は書き換えられる。戻す git にも filter を空にして渡す。
				const { env } = await filters(git, baseline.top);
				// 中身が同じでも、最初の確かめだけでは足りない。確認と上の git を待つ間に、job の知らせがターンを起こし
				// (monitor は Pi が idle のときに起こす)、そのターンが、まだ何も書いていない job を起こしていることがある。
				const late = stillWriting(ctx);
				if (late) {
					ctx.ui.notify(late, "warning");
					return;
				}
				if (fingerprint(join(baseline.top, path)) !== seen || obstacle(baseline.top, path)) {
					ctx.ui.notify(`checkpoint: ${path} は確認の間に中身が変わったので戻さなかった。/checkpoint からやり直す。`, "warning");
					return;
				}
				if (change.status === "A") rmSync(join(baseline.top, path));
				// 利用者の index で skip-worktree の付いたパスを、git restore は既定では「合うパスが無い」として断る。
				else await git(baseline.top, ["restore", `--source=${baseline.tree}`, "--worktree", "--ignore-skip-worktree-bits", "--", path], env);
				written.delete(path);
				mixed.delete(path);
				ctx.ui.notify(`checkpoint: ${path} を基準に戻した。戻す前の作業ツリーは tree ${before?.tree} (git show ${before?.tree}:<パス> で読める)。`, "info");
				return;
			}
			ctx.ui.notify(
				[
					`checkpoint: 基準 (${baseline.tree.slice(0, 12)}) から変わったファイル`,
					...list.map((change) => `${change.status}  ${change.path}  ${origin(change.path)}`),
					"差分は /checkpoint diff [パス]、戻すには /checkpoint restore <パス>",
				].join("\n"),
				"info",
			);
		},
	});
}
