/**
 * rules.ts の検証。
 *
 * 実行: node --test ~/.pi/agent/extensions/guard/tests/rules.test.ts
 * 依存: node 標準のみ (22.18 以降の型除去で .ts を直接読む)。
 * Pi が読み込むのは index.ts だけなので、このファイルが拡張として動くことはない。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASH_RULES, chezmoiTarget, evaluate, type Rule } from "../rules.ts";

const bash = (command: string): string | undefined => evaluate(BASH_RULES, command)?.id;
const forcePush = BASH_RULES.find((rule) => rule.id === "git-force-push")!;

test("force push はフラグの位置と書き方を問わず止める", () => {
	for (const command of [
		"git push --force",
		"git push -f origin main",
		"git push origin main --force",
		"git push --force-with-lease origin main",
		"git push --force-if-includes origin main",
		"git push --mirror",
		"git push -uf origin main",
		"git -C repo push origin +main",
		"cd repo && git push origin main -f",
	]) {
		assert.equal(bash(command), "git-force-push", command);
	}
});

test("通常の push と、push でない -f は通す", () => {
	for (const command of [
		"git push",
		"git push -u origin feat/foo",
		"git push origin main --follow-tags",
		"git status && rm -f tmp.txt",
		"git checkout -f main",
		"git push origin main && git checkout -f main",
		"git fetch -f; git push",
	]) {
		assert.equal(forcePush.matches(command), false, command);
	}
});

test("破壊的な操作は確認に回す", () => {
	for (const [command, id] of [
		["git push", "git-push"],
		["git -C repo push -u origin feat/foo", "git-push"],
		["git add -A && git commit -m x && git push", "git-push"],
		["git reset --hard HEAD~1", "git-reset-hard"],
		["git clean -fd", "git-clean"],
		["git checkout -- src/a.ts", "git-discard-changes"],
		["git checkout .", "git-discard-changes"],
		["git checkout -f main", "git-discard-changes"],
		["git restore src/a.ts", "git-discard-changes"],
		["git restore --staged --worktree a.ts", "git-discard-changes"],
		["git branch -D feat/foo", "git-branch-force-delete"],
		["git branch --delete --force feat/foo", "git-branch-force-delete"],
		["rm -rf build", "rm"],
		["ls | xargs rm", "rm"],
		["echo $(rm a.txt)", "rm"],
		["/bin/rm a.txt", "rm"],
		["cd build;rm -rf .", "rm"],
		["test -d build&&rm -rf build", "rm"],
		["find . -name '*.log' -exec rm {} +", "rm"],
		["rmdir build", "rmdir"],
		["sudo pacman -S foo", "sudo"],
		["find . -name '*.log' -delete", "find-delete"],
	] as const) {
		assert.equal(bash(command), id, command);
	}
});

test("同じ語を含むだけの無害なコマンドは通す", () => {
	for (const command of [
		"git status",
		"git log --oneline | head",
		"git commit -m 'clean up the push logic'",
		"git reset HEAD~1",
		"git reset --soft HEAD~1",
		"git clean -n",
		"git clean -fd --dry-run",
		"git checkout main",
		"git checkout -b feat/foo",
		"git restore --staged a.ts",
		"git branch -d feat/foo",
		"git stash push",
		"docker run --rm alpine true",
		"npm run confirm",
		"ls platform/",
		"find . -name '*.log' -print",
		"cat docs/sudoers.md",
	]) {
		assert.equal(bash(command), undefined, command);
	}
});

test("chezmoi が管理するファイルだけを確認に回す", () => {
	const rules = [chezmoiTarget(new Set(["/home/u/.zshrc"]))];
	assert.equal(evaluate(rules, "/home/u/.zshrc")?.id, "chezmoi-target");
	assert.equal(evaluate(rules, "/home/u/.zshrc.bak"), undefined);
	assert.equal(evaluate(rules, "/home/u/src/dot_zshrc"), undefined);
});

test("forbid は confirm より先に並んでいなくても優先される", () => {
	const rule = (id: string, decision: Rule["decision"]): Rule => ({ id, decision, reason: "", matches: () => true });
	assert.equal(evaluate([rule("a", "confirm"), rule("b", "forbid")], "x")?.id, "b");
	assert.equal(evaluate([rule("a", "confirm"), rule("c", "confirm")], "x")?.id, "a");
	assert.equal(evaluate([], "x"), undefined);
});
