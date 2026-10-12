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

function isBaseline(data: unknown): data is Baseline {
	if (!data || typeof data !== "object") return false;
	const saved = data as Partial<Baseline>;
	// tree は git の引数になる。セッションファイルから来るので、object id の形だけを通す。
	return saved.version === 1 && typeof saved.top === "string" && typeof saved.tree === "string" && /^[0-9a-f]{40,64}$/.test(saved.tree);
}

/**
 * hook と fsmonitor を切るのは、リポジトリの設定がモデルの書ける場所にあり、ここは sandbox の外で走るため。
 * パスは git の出力か人の入力なので、pathspec の記号として解釈させない。
 */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, tolerated?: number, input: string | Buffer = ""): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--literal-pathspecs", ...args],
			{ cwd, env: { ...process.env, ...env }, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
			(error, stdout) => (error && error.code !== tolerated ? reject(error) : resolve(stdout)),
		);
		// 起動に失敗したときの EPIPE は、上の callback が同じ失敗を伝えるので捨てる。
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});
}

/**
 * リポジトリの設定 (.git/config とそこからの include) にある filter を空で上書きする環境変数と、その filter の名前。
 * この設定もモデルの書ける場所にあり、clean / process は git add が sandbox の外で走らせる。
 * 利用者の設定 (~/.gitconfig など) の filter は止めない。モデルの書ける場所ではなく、止めると LFS が pointer のまま扱われる。
 * `-c` で渡さないのは、filter の名前に "=" が入ると鍵と値の切れ目がずれるため。
 */
async function repoFilters(top: string): Promise<{ env: NodeJS.ProcessEnv; names: Set<string> }> {
	// 並びは "<scope>" NUL "<鍵>" NUL の繰り返し。1 つも無いと git は 1 で終わる。
	const pattern = "^filter\\..*\\.(clean|smudge|process|required)$";
	const fields = (await git(top, ["config", "--show-scope", "--name-only", "-z", "--get-regexp", pattern], {}, 1)).toString().split("\0");
	const env: NodeJS.ProcessEnv = {};
	const names = new Set<string>();
	let count = 0;
	for (let i = 0; i + 1 < fields.length; i += 2) {
		if (fields[i] !== "local" && fields[i] !== "worktree") continue;
		const key = fields[i + 1];
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
async function snapshot(cwd: string): Promise<{ top: string; tree: string } | undefined> {
	// 作業ツリーの外では git は 128 で終わり、何も出さない。それ以外の失敗 (git を起動できないなど) は「外」に数えず、呼び出し元に伝える。
	const [top, gitDir] = (await git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir"], {}, 128)).toString().trimEnd().split("\n");
	if (!gitDir) return undefined;
	const dir = mkdtempSync(join(tmpdir(), "pi-checkpoint-"));
	try {
		const env = { ...(await repoFilters(top)).env, GIT_INDEX_FILE: join(dir, "index") };
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

async function changes(top: string, from: string, to: string): Promise<Change[]> {
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
async function baselineFingerprint(baseline: Baseline, path: string): Promise<string | null> {
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

const DIFF_LINES = 200;
/** 確認なしで戻してよい唯一の状態。 */
const OWN = "Pi が書いたまま";

export default function (pi: ExtensionAPI) {
	let baseline: Baseline | undefined;
	/** Pi の write / edit が最後に書いた中身。メモリの中だけにあり、reload や再起動で消える。 */
	const written = new Map<string, string | null>();

	/** Pi が書く直前に、基準とも Pi の前回の書き込みとも違っていたファイル。Pi の上書きで見えなくなる変更を覚えておく。 */
	const mixed = new Set<string>();

	function origin(path: string) {
		if (!written.has(path)) return "Pi の write / edit 以外の変更";
		return !mixed.has(path) && written.get(path) === fingerprint(join(baseline!.top, path)) ? OWN : "Pi と別の変更が混じっている";
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!baseline || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const path = repoPath(String(event.input.path), ctx.cwd, baseline.top);
		if (!path) return;
		try {
			const known = written.has(path) ? written.get(path) : await baselineFingerprint(baseline, path);
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

	function forget() {
		baseline = undefined;
		written.clear();
		mixed.clear();
	}

	/** 取れたら true。取れなかったら、前の基準と Pi の記録には触らない。 */
	async function take(ctx: ExtensionContext) {
		try {
			const taken = await snapshot(ctx.cwd);
			if (!taken) {
				if (baseline) ctx.ui.notify("checkpoint: git の作業ツリーの外なので基準を取れなかった。前の基準をそのまま使う。", "warning");
				return false;
			}
			forget();
			baseline = { version: 1, ...taken };
			pi.appendEntry("checkpoint", baseline);
			return true;
		} catch (error) {
			ctx.ui.notify(`checkpoint: 基準を取れなかった (${error instanceof Error ? error.message : String(error)})${baseline ? "。前の基準をそのまま使う。" : ""}`, "warning");
			return false;
		}
	}

	// 枝 (getBranch) ではなくセッション全体から探す。/tree で会話を戻してもファイルは戻らないので、基準も動かさない。
	pi.on("session_start", async (_event, ctx) => {
		forget();
		let saved: Baseline | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "checkpoint" && isBaseline(entry.data)) saved = entry.data;
		}
		if (!saved) return;
		try {
			// 別のリポジトリで再開したときと、tree が git gc で消えたときは使わず、次の依頼で取り直す。
			const top = (await git(ctx.cwd, ["rev-parse", "--show-toplevel"])).toString().trimEnd();
			await git(ctx.cwd, ["cat-file", "-e", `${saved.tree}^{tree}`]);
			if (top === saved.top) baseline = saved;
		} catch {}
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
			const taken = verb === "new" && (await take(ctx));
			if (!baseline) {
				ctx.ui.notify("checkpoint: 基準が無い。git の作業ツリーの中で、最初の依頼を送った時点か /checkpoint new で取る。", "info");
				return;
			}
			if (verb === "new") {
				if (taken) ctx.ui.notify(`checkpoint: 今の作業ツリーを新しい基準にした (${baseline.tree.slice(0, 12)})。`, "info");
				return;
			}
			const now = await snapshot(baseline.top);
			if (!now) throw new Error(`checkpoint: ${baseline.top} is no longer a git work tree`);
			const list = await changes(baseline.top, baseline.tree, now.tree);
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
				if (!ctx.isIdle()) {
					ctx.ui.notify("checkpoint: Pi が動いている間は戻さない。止まってからやり直す。", "warning");
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
					if ((await repoFilters(baseline.top)).names.has(filter)) {
						ctx.ui.notify(`checkpoint: ${path} にはリポジトリの設定にある filter「${filter}」が掛かる。その filter を通さずに取った基準は作業ツリーの形と合わないことがあるので戻さない。`, "warning");
						return;
					}
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
				const before = await snapshot(baseline.top);
				if (fingerprint(join(baseline.top, path)) !== seen || obstacle(baseline.top, path)) {
					ctx.ui.notify(`checkpoint: ${path} は確認の間に中身が変わったので戻さなかった。/checkpoint からやり直す。`, "warning");
					return;
				}
				if (change.status === "A") rmSync(join(baseline.top, path));
				// 利用者の index で skip-worktree の付いたパスを、git restore は既定では「合うパスが無い」として断る。
				else await git(baseline.top, ["restore", `--source=${baseline.tree}`, "--worktree", "--ignore-skip-worktree-bits", "--", path]);
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
