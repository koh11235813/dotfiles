/**
 * UI を持たない子の Pi の確認を、親の Pi の UI に回す受け渡し。
 *
 * 子と親をつなぐ口はファイルしか無い。公式 sample の subagent は子を stdin 無し (`stdio: ["ignore", "pipe", "pipe"]`) で
 * 起こし、stdout / stderr は終わってからしか親の拡張に届かない。だから置き場のディレクトリに、子が `<id>.request` を、
 * 親が `<id>.answer` を置く。どちらも一定間隔で見に行く (fs.watch は取りこぼすと子が待ち続ける)。
 *
 * 置き場は sandbox の中から書けない場所でなければならない。書けると、モデルが bash で `.answer` を置いて自分で承認できる。
 * 場所を決めて、書けないことを確かめるのは index.ts。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 置き場を見に行く間隔。 */
const POLL_MS = 200;

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM は、居るが自分のものではないプロセス。
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
};

/** 別名で書いてから rename する。書きかけを相手に読ませない。 */
function put(path: string, data: unknown): void {
	writeFileSync(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}

/** 置き場の名前。持ち主 (受け付ける親) の pid を入れる。 */
export const askDirName = (pid: number): string => `ask-${pid}`;

/**
 * home の下にある、持ち主の Pi がもう居ない置き場を消す。Pi がクラッシュすると `session_shutdown` が呼ばれず残る。
 * 選び方は readonly の一時ディレクトリ (sandbox.ts の sweepScratch) と同じで、古さではなく持ち主の pid。
 * 失敗は捨てる。掃除できなくても Pi は使える。
 */
export function sweepAsks(home: string): void {
	let names: string[] = [];
	try {
		names = readdirSync(home);
	} catch {}
	for (const name of names) {
		const pid = Number(/^ask-(\d+)$/.exec(name)?.[1]);
		if (!pid || alive(pid)) continue;
		try {
			rmSync(join(home, name), { recursive: true, force: true });
		} catch {}
	}
}

/** ダイアログに出す依頼の上限。置き場に書けるプロセスなら何でも置けるので、画面を埋めさせない。 */
const TITLE_CHARS = 200;
const MESSAGE_CHARS = 2000;

/**
 * いま受け付けている親を止める手続き。モジュールの変数ではなく globalThis に置く (sandbox.ts の gitCommonDirs と同じ理由)。
 * 置き場はプロセスごとに 1 つなので、受け付けるのも 1 つにする。2 つが同じ依頼を拾うと、ダイアログが二重に出る。
 */
const serving = ((globalThis as { piGuardAsks?: { stop?: () => void } }).piGuardAsks ??= {});

/**
 * dir に置かれた依頼を confirm に回し、答えを置く。戻り値は受け付けをやめる手続きで、置き場ごと消す。
 * ダイアログは 1 つずつ出す (並列の subagent が同時に訊いてくる)。訊いた子がもう居ない依頼は捨てる。
 * 読めない依頼と、confirm の失敗 (セッションが入れ替わった後の ctx は触ると例外を投げる) は、承認しない答えにする。
 *
 * 子が居るかは、ダイアログを出す前だけでなく出している間も見る。親で subagent を止めると、子は依頼を消さずに終わる
 * (公式 sample が SIGTERM を送り、`-p` の Pi は process.exit する)。出す前にしか見ないと、誰も待っていないダイアログが
 * 残り、後ろに並んだ子の確認も出ない。居なくなったら signal で閉じ、答えも置かない (読む者の居ない答えは置き場に残る)。
 */
export function serveAsks(dir: string, confirm: (title: string, message: string, signal: AbortSignal) => Promise<boolean>): () => void {
	serving.stop?.();
	// 同じ pid だった前のプロセスの残りを引き継がない。
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const taken = new Set<string>();
	let queue = Promise.resolve();
	const answer = async (name: string, id: string, child: number): Promise<void> => {
		try {
			if (alive(child)) {
				let approved = false;
				const gone = new AbortController();
				const watch = setInterval(() => alive(child) || gone.abort(), POLL_MS);
				watch.unref();
				try {
					const request = JSON.parse(readFileSync(join(dir, name), "utf8"));
					approved = (await confirm(String(request.title).slice(0, TITLE_CHARS), String(request.message).slice(0, MESSAGE_CHARS), gone.signal)) === true;
				} catch {
				} finally {
					clearInterval(watch);
				}
				if (alive(child)) put(join(dir, `${id}.answer`), { approved });
			}
			rmSync(join(dir, name), { force: true });
		} catch {}
	};
	const timer = setInterval(() => {
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {}
		for (const name of names) {
			const match = /^((\d+)-[0-9a-f]+)\.request$/.exec(name);
			if (!match || taken.has(name)) continue;
			taken.add(name);
			queue = queue.then(() => answer(name, match[1], Number(match[2])));
		}
	}, POLL_MS);
	// 受け付けているだけで Pi の終了を引き止めない。
	timer.unref();
	const stop = () => {
		clearInterval(timer);
		// 後から始まった受け付けが同じ置き場を使っている。そちらのものは消さない。
		if (serving.stop !== stop) return;
		serving.stop = undefined;
		rmSync(dir, { recursive: true, force: true });
	};
	serving.stop = stop;
	return stop;
}

/**
 * 親に訊く。誰にも訊けなかったら undefined (断られた false と区別する)。
 * 時間では打ち切らない。人が席を外しているだけかもしれず、打ち切ると「断られた」と同じ結果になる。
 * 待つのをやめるのは、親のプロセスが居なくなったときと、依頼が答えの無いまま消えたとき。依頼が消えるのは、親が
 * 受け付けをやめた (置き場ごと消した) か、`/reload` などで置き場を作り直したとき。置き場の有無だけを見ていると、
 * 作り直された置き場の前で待ち続ける。
 */
export async function askParent(dir: string, parent: number, title: string, message: string): Promise<boolean | undefined> {
	const base = join(dir, `${process.pid}-${randomBytes(4).toString("hex")}`);
	try {
		put(`${base}.request`, { title, message });
		for (;;) {
			// 親は答えを置いてから依頼を消す。依頼が無いのを先に見てから答えを探せば、その間に置かれた答えを取りこぼさない。
			const pending = existsSync(`${base}.request`);
			if (existsSync(`${base}.answer`)) {
				const answer = JSON.parse(readFileSync(`${base}.answer`, "utf8"));
				rmSync(`${base}.answer`, { force: true });
				return answer.approved === true;
			}
			if (!pending || !alive(parent)) return undefined;
			await new Promise((done) => setTimeout(done, POLL_MS));
		}
	} catch {
		return undefined;
	} finally {
		// 答えた親が先に消している。残っているのは、訊くのをやめたとき。
		rmSync(`${base}.request`, { force: true });
	}
}
