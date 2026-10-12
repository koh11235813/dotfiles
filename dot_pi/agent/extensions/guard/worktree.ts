/**
 * subagent のタスクごとの git worktree。作る・子の cwd に渡す・終わった後の差分を親に返す、まで。統合と削除はしない。
 *
 * subagent の拡張ではなく guard に置いている。`git worktree add` は checkout で、`git status` / `git diff` は子が書いた後の
 * 作業ツリーの上で、リポジトリの config・hooks・filter を読む。Pi のプロセス (sandbox の外) でそれを打つと、モデルの
 * 頼んだ git がホストで走る。だから git は guard の sandbox の中で打つ (index.ts が渡す Run)。sandbox を持つのは guard だけ。
 *
 * 置き場は root の下 (`.pi-worktrees/<id>`)。子は親の書ける場所を継ぐので、root の外に作ると子が書けない。
 * 外に作って書ける場所を足す案は捨てた (書ける場所を広げる向きで、広げてよい範囲を決める材料が無い)。
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const WORKTREES_DIR = ".pi-worktrees";

/** シェルの断片を、引数つきで走らせる。失敗は例外で、文面は stderr。 */
export type Run = (script: string, args: string[]) => Promise<string>;

export interface Worktree {
	/** 結果に出す名前 (agent 名、chain なら `chain`)。 */
	label: string;
	path: string;
	branch: string;
	/** 作ったときの HEAD。 */
	base: string;
}

interface Task {
	agent?: unknown;
	task?: unknown;
	cwd?: unknown;
}

/** subagent ツールの引数のうち、ここで読み書きするもの (公式 sample の SubagentParams)。 */
export interface SubagentInput extends Task {
	tasks?: Task[];
	chain?: Task[];
	worktree?: unknown;
}

const real = (path: string): string => {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
};

/**
 * cwd が root の下の worktree の中なら、その worktree。子の guard が、書ける場所を親の root から自分の worktree に絞るのに使う。
 * 見るのは場所だけで、本当に worktree かは確かめない。絞る向きにしか働かないので、誰が作ったディレクトリでも広がらない。
 * worktree の中の置き場にさらに worktree があれば、いちばん内側のものを返す。worktree に絞られた子が `worktree: true` で起こす
 * 孫の置き場は子の worktree の中で、1 段目で止めると孫がみな子の worktree 全体に書け、孫どうしが分かれない。
 */
export function taskRoot(root: string, cwd: string): string | undefined {
	const target = real(cwd);
	let found: string | undefined;
	for (let outer = real(root); ; outer = found) {
		const home = join(outer, WORKTREES_DIR);
		const below = relative(home, target);
		if (!below || below.startsWith("..") || isAbsolute(below)) return found;
		found = join(home, below.split(sep)[0]);
	}
}

// 置き場に `*` だけの .gitignore を置く。元の作業ツリーの status に未追跡として出続けると、`git add -A` で巻き込まれる。
const ADD = `set -e
mkdir -p "$1"
[ -e "$1/.gitignore" ] || echo '*' > "$1/.gitignore"
git -C "$2" worktree add -q -b "$3" "$4" HEAD`;

/**
 * 引数に合わせて worktree を作り、各タスクの cwd を書き換える。並列はタスクごとに 1 つ、chain は全段で 1 つ
 * (後ろの段は前の段の続きをする)、単発は 1 つ。cwd は worktree の中の、root がリポジトリの中で占めていたのと同じ位置。
 * 元の作業ツリーの未 commit の変更は入らない (HEAD から作る)。
 */
export async function addWorktrees(run: Run, root: string, input: SubagentInput): Promise<Worktree[]> {
	// 公式 sample は、単発・並列・chain のちょうど 1 つでない呼び出しを子を起こさずに返す (sample の modeCount)。
	// そこへ通すと、使われない worktree と枝だけが残る。
	if ([input.chain?.length, input.tasks?.length, input.agent && input.task].filter(Boolean).length !== 1) {
		throw new Error("subagent needs exactly one of agent + task, tasks, or chain, so no worktree was created.");
	}
	const targets: Array<{ label: string; tasks: Task[] }> = input.chain?.length
		? [{ label: "chain", tasks: input.chain }]
		: input.tasks?.length
			? input.tasks.map((task) => ({ label: String(task.agent), tasks: [task] }))
			: [{ label: String(input.agent), tasks: [input] }];
	if (targets.some((target) => target.tasks.some((task) => task.cwd !== undefined))) {
		throw new Error("worktree: true chooses the working directory, so it cannot be combined with cwd.");
	}
	const [base, prefix] = (await run('git -C "$1" rev-parse HEAD && git -C "$1" rev-parse --show-prefix', [root])).split("\n");
	const made: Worktree[] = [];
	for (const target of targets) {
		const id = randomUUID().slice(0, 8);
		const worktree = { label: target.label, path: join(root, WORKTREES_DIR, id), branch: `pi-subagent/${id}`, base };
		// 先に作った分は消さない。sandbox の中からは worktree を消せず (gitLocks)、外で git を打つことはしない。残したことを伝える。
		await run(ADD, [join(root, WORKTREES_DIR), root, worktree.branch, worktree.path]).catch((error: Error) => {
			throw new Error(made.length > 0 ? `${error.message} Already created by this call and kept: ${made.map((kept) => kept.path).join(", ")}.` : error.message);
		});
		made.push(worktree);
		for (const task of target.tasks) task.cwd = resolve(worktree.path, prefix ?? "");
	}
	delete input.worktree;
	return made;
}

/** 親のモデルに流す行数の上限。全部は worktree にあり、bash で読める。 */
const SHOWN = 40;

const REPORT = `cd "$1" || exit 1
section() { out=$("$@" 2>&1 | head -n ${SHOWN}); [ -z "$out" ] || printf '%s\\n%s\\n' "$title" "$out"; }
title='Uncommitted (git status --porcelain):' section git status --porcelain
title='Commits since the base:' section git log --oneline "$2"..HEAD
title='Diff against the base (git diff --stat):' section git diff --stat "$2"`;

/** worktree に残ったものの要約。差分の全文は流さない。 */
export async function report(run: Run, worktrees: Worktree[]): Promise<string> {
	const parts: string[] = [];
	for (const worktree of worktrees) {
		const found = await run(REPORT, [worktree.path, worktree.base]).then(
			(out) => out.trim() || "No changes.",
			(error: Error) => `Could not inspect it: ${error.message}`,
		);
		parts.push(`guard[worktree]: ${worktree.label} ran in ${worktree.path} (branch ${worktree.branch}, based on ${worktree.base.slice(0, 12)}).\n${found}`);
	}
	parts.push(
		`Nothing was merged and the worktrees are kept. Read the full diff with \`git -C <worktree> diff <base>\`. Integrate (merge, cherry-pick, apply) only after the user approves, and remove a worktree (\`git worktree remove\`) only when the user asks.`,
	);
	return parts.join("\n\n");
}
