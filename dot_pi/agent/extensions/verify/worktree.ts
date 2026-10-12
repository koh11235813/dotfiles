/**
 * 作業ツリーの「ファイル状態」を 1 つの値にする。検証の合格はこの値に結び付き、値が変われば合格は無効になる。
 *
 * git が無視していないファイル (追跡済みと未追跡) の中身から作る。commit や `git add` では変わらない。
 * edit / write の成功だけを数える方式にしないのは、bash 経由 (sed、formatter、mv) と人や別 agent の変更を見落とすため。
 * 一時 index に `git add -A` して tree の hash を取る方式にしないのは、利用者の `.git/objects` に書き込むため。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { join } from "node:path";

/** fsmonitor は `.git/config` から任意のコマンドを起こせる。状態を読むだけの git には使わせない。 */
function git(cwd: string, args: string[]): Buffer | undefined {
	try {
		return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 30 });
	} catch {
		return undefined;
	}
}

export interface Project {
	/** 登録の鍵。worktree が共有する git ディレクトリなので、同じリポジトリの worktree は同じ project になる。 */
	id: string;
	/** cwd を含む作業ツリーの最上位。検証コマンドはここで走らせる。 */
	root: string;
}

/** cwd を含む git リポジトリ。リポジトリの外 (と bare リポジトリの中) なら無し。 */
export function project(cwd: string): Project | undefined {
	const [id, root] = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"])?.toString().split("\n") ?? [];
	return id && root ? { id, root } : undefined;
}

function hashFile(path: string, hash: ReturnType<typeof createHash>) {
	const fd = openSync(path, "r");
	try {
		const chunk = Buffer.allocUnsafe(1 << 16);
		for (let read: number; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0; ) hash.update(chunk.subarray(0, read));
	} finally {
		closeSync(fd);
	}
}

/** 作業ツリーの状態。git から一覧を取れなければ無し。 */
export function fingerprint(root: string): string | undefined {
	const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	if (!listed) return undefined;
	const hash = createHash("sha256");
	// 衝突の途中の index は同じパスを複数回出す。
	for (const path of [...new Set(listed.toString().split("\0").filter(Boolean))].sort()) {
		hash.update(`\0${path}\0`);
		try {
			const stat = lstatSync(join(root, path));
			if (stat.isSymbolicLink()) hash.update(`link ${readlinkSync(join(root, path))}`);
			else if (stat.isFile()) {
				hash.update(stat.mode & 0o111 ? "exec " : "file ");
				hashFile(join(root, path), hash);
			}
			// 一覧にディレクトリが出るのは、中に別の git リポジトリ (submodule も) があるときだけ。git はその中身を出さないので、そこで取り直す。
			// `.git` を確かめるのは、空の submodule の中で git を走らせると外側のリポジトリを見に行くため。
			else if (stat.isDirectory() && existsSync(join(root, path, ".git"))) hash.update(`repo ${fingerprint(join(root, path)) ?? "unreadable"}`);
			else hash.update("other");
		} catch {
			// 消えたファイルと読めないファイルは区別しない。どちらも「中身が無い」として値に入る。
			hash.update("missing");
		}
	}
	return hash.digest("hex");
}
