/**
 * guard の規則表。判定の枠は index.ts、ここは「何を止めるか」だけを持つ。
 *
 * 規則は対象文字列への述語なので、正規表現でも argv を解析する関数でも書ける。
 * 文字列一致は引用符の中 (commit メッセージや echo の引数) にも当たる。pi で動かすモデルは
 * 指示を読み落とす前提なので、取りこぼすより誤って止める側に倒している。
 */

/** forbid は常に遮断。confirm は人に訊き、訊けない (-p など UI なし) ときは遮断。 */
export type Decision = "forbid" | "confirm";

export interface Rule {
	/** 遮断理由に出す識別子。モデルと人の両方が読む。 */
	id: string;
	decision: Decision;
	/** モデルに返す文。何が禁止で、代わりに何をすべきかを書く。 */
	reason: string;
	matches: (subject: string) => boolean;
}

/** `;` `|` `&` と改行で切った断片。フラグをどのコマンドのものか取り違えないために使う。 */
const segments = (command: string): string[] => command.split(/[\n;|&]+/);

/**
 * コマンド名としての `name`。`xargs rm`、`$(rm …)`、`/bin/rm`、`\rm`、空白なしの `x;rm` は拾い、
 * `docker run --rm` や `confirm` のような別の語の一部は拾わない。
 */
const runs = (name: string): ((command: string) => boolean) => {
	const pattern = new RegExp(`(^|[\\s(\`/\\\\;&|])${name}(\\s|$)`);
	return (command) => pattern.test(command);
};

/**
 * `git <subcommand>` の断片。`git -C repo push` のように git 自身のオプションは挟める。
 * `.*` でつなぐと `git commit -m "clean up"` が clean に当たるので、サブコマンドの位置だけを見る。
 */
const git = (subcommand: string): ((command: string) => string[]) => {
	const pattern = new RegExp(`\\bgit\\s+(-[cC]\\s+\\S+\\s+|-\\S+\\s+)*${subcommand}(\\s|$)`);
	return (command) => segments(command).filter((segment) => pattern.test(segment));
};

const gitPush = git("push");
const gitReset = git("reset");
const gitClean = git("clean");
const gitCheckout = git("checkout");
const gitRestore = git("restore");
const gitBranch = git("branch");

/** bash ツールの `command` 全文に対する規則。 */
export const BASH_RULES: Rule[] = [
	{
		id: "git-force-push",
		decision: "forbid",
		reason: "Force pushing is prohibited. Use a normal push, or ask the user to do it manually.",
		// フラグは push の前後どちらにも置けるので位置を問わない。`+refspec` も強制更新。
		// 区切りごとに見ないと `git push && git checkout -f` の -f を push のものと取り違える。
		matches: (command) =>
			command
				.split(/[\n;|&]+/)
				.some(
					(segment) =>
						/\bgit\b.*\bpush\b/.test(segment) &&
						/\s(--force(-with-lease|-if-includes)?\b|--mirror\b|-[a-zA-Z]*f[a-zA-Z]*\b|\+[\w./-]+)/.test(segment),
				),
	},
	{
		id: "git-push",
		decision: "confirm",
		reason: "Pushing publishes commits and needs the user's approval. Do not retry or route around this; report what you wanted to push.",
		matches: (command) => gitPush(command).length > 0,
	},
	{
		id: "git-reset-hard",
		decision: "confirm",
		reason: "`git reset --hard` discards uncommitted work and needs the user's approval. Do not retry or route around this.",
		matches: (command) => gitReset(command).some((segment) => /\s--hard\b/.test(segment)),
	},
	{
		id: "git-clean",
		decision: "confirm",
		reason: "`git clean` deletes untracked files and needs the user's approval. Do not retry or route around this.",
		// -n / --dry-run は何も消さない。
		matches: (command) => gitClean(command).some((segment) => !/\s(--dry-run\b|-[a-zA-Z]*n[a-zA-Z]*\b)/.test(segment)),
	},
	{
		id: "git-discard-changes",
		decision: "confirm",
		reason: "This overwrites uncommitted changes in the working tree and needs the user's approval. Do not retry or route around this.",
		// checkout はブランチ切替なら通す。作業ツリーを上書きするのは `-- <path>`、`.`、-f のとき。
		// restore は --staged だけなら index しか触らない。
		matches: (command) =>
			gitCheckout(command).some((segment) => /\s(--|\.|-f|--force)(\s|$)/.test(segment)) ||
			gitRestore(command).some(
				(segment) => !/\s(--staged|-S)\b/.test(segment) || /\s(--worktree|-W)\b/.test(segment),
			),
	},
	{
		id: "git-branch-force-delete",
		decision: "confirm",
		reason: "Force-deleting a branch can drop unmerged commits and needs the user's approval. Do not retry or route around this.",
		matches: (command) =>
			gitBranch(command).some(
				(segment) =>
					/\s-[a-zA-Z]*D[a-zA-Z]*\b/.test(segment) ||
					(/\s(-d|--delete)\b/.test(segment) && /\s(-f|--force)\b/.test(segment)),
			),
	},
	{
		id: "rm",
		decision: "confirm",
		reason: "Deleting files needs the user's approval. Do not retry or route around this; report what you wanted to delete.",
		matches: runs("rm"),
	},
	{
		id: "rmdir",
		decision: "confirm",
		reason: "Deleting directories needs the user's approval. Do not retry or route around this; report what you wanted to delete.",
		matches: runs("rmdir"),
	},
	{
		id: "sudo",
		decision: "confirm",
		reason: "Running as root needs the user's approval. Do not retry or route around this; report the command you wanted to run.",
		matches: runs("sudo"),
	},
	{
		id: "find-delete",
		decision: "confirm",
		reason: "`find -delete` deletes every match and needs the user's approval. Do not retry or route around this.",
		matches: (command) => segments(command).some((segment) => /\bfind\b.*\s-delete\b/.test(segment)),
	},
];

/** edit / write ツールの `path` を cwd から絶対パスにしたものに対する規則。 */
export const PATH_RULES: Rule[] = [];

/**
 * chezmoi が生成したファイルへの edit / write。`managed` は `chezmoi managed` が返す絶対パス。
 * 一覧はホストごとに違い実行時にしか分からないので、PATH_RULES に並べず呼び出し側から受け取る。
 */
export function chezmoiTarget(managed: ReadonlySet<string>): Rule {
	return {
		id: "chezmoi-target",
		decision: "confirm",
		reason:
			"chezmoi generates this file, so the next `chezmoi apply` overwrites edits made here. Edit its source instead (`chezmoi source-path <file>` prints it), or ask the user.",
		matches: (path) => managed.has(path),
	};
}

/** 当たった規則のうち最も厳しいもの。forbid は confirm より優先する。 */
export function evaluate(rules: Rule[], subject: string): Rule | undefined {
	const hits = rules.filter((rule) => rule.matches(subject));
	return hits.find((rule) => rule.decision === "forbid") ?? hits[0];
}
