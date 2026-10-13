/**
 * agmsg との接続。することは 2 つだけ: この Pi が project に登録された名前を名乗ること (claim) と、未読の Notify。
 *
 * Message の本文は運ばない (Delivery はしない)。読むのはモデルが skill の手順で `inbox.sh` を打ったとき。
 * 起こすのは agmsg の決まった script を決まった引数で、Pi のプロセス (sandbox の外) から。モデルの bash の sandbox は変えない。
 * join はしない。人が Pi の外で 1 度打つ。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

/** 設定の口ではない。テストが偽の script に差し替え、待ちを短くするために外から触れる形にしてある。 */
export const limits = {
	/** agmsg の置き場。 */
	skillDir: join(homedir(), ".agents", "skills", "agmsg"),
	/**
	 * script に渡す TMPDIR。モデルの sandbox から書ける場所 ($TMPDIR、/tmp) に置かない。watch-once.sh は一時ファイルに書いた SQL を
	 * sqlite3 の標準入力に流すので、そこに書き足せると `.shell` で sandbox の外のコマンドが動く。
	 */
	tmpDir: join(getAgentDir(), "agmsg-tmp"),
	/** watch-once.sh を起こし直すまでの最短の間隔。 */
	repeatMs: 30_000,
	/** identities.sh と claim を待つ上限。actas-claim.sh は claim の後で端末の名付けと sync の起動も試みる。 */
	claimTimeoutMs: 30_000,
	/** watch-once.sh に渡す `--timeout` (秒)。未読が無ければこの長さで返る。 */
	watchSeconds: 300,
	/** watch-once.sh が自分の timeout を過ぎても返らないとき、止めるまでの余裕。Codex の bridge と同じ考え方 (interval + 10 秒)。 */
	watchGraceMs: 12_000,
};

const TYPE = "pi";
const STATUS = "agmsg";
/** guard の monitor が Notify を受け取る口 (guard/monitor/index.ts の EVENT_CHANNEL)。 */
const MONITOR_EVENT = "monitor:event";

/** child が parent と同じか、その中にある。 */
function within(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

const firstLine = (text: string): string => text.trim().split("\n")[0];

export default function (pi: ExtensionAPI) {
	// 止めた後に届く script の終了とタイマーは、世代が違えば捨てる。入れ替え後の ctx は触っただけで例外を投げる。
	let generation = 0;
	let child: ChildProcess | undefined;
	let timer: NodeJS.Timeout | undefined;

	/**
	 * script を、その子 (sqlite3・sed・sleep) ごと止める。bash だけを止めると子が残り、固まった子は残り続ける。
	 * SIGTERM にしない。watch-once.sh は一時ファイルを消す間だけ TERM を trap していて、そこに当たると消した後も回り続ける。
	 */
	function kill(script: ChildProcess) {
		try {
			if (script.pid) process.kill(-script.pid, "SIGKILL");
		} catch {}
	}

	function stop() {
		generation++;
		clearTimeout(timer);
		if (child) kill(child);
		child = undefined;
	}

	/**
	 * AGMSG_AGENT_PID を空で渡すと、agmsg は祖先のプロセスを辿らない (lib/resolve-project.sh の agmsg_agent_pid)。
	 * 辿らせると、Claude Code や Codex の下で起こした Pi が、その祖先の project を自分のものとして引く。
	 *
	 * execFile ではなく spawn なのは、プロセスグループを分ける (detached) ため。execFile は detached を spawn に渡さない。
	 * シェルは通さない。limit を過ぎたら止めて、終了コード -1 で返す。
	 */
	function run(script: string, args: string[], limit: number, done: (code: number, stdout: string, stderr: string) => void) {
		const started = spawn(script, args, { env: { ...process.env, AGMSG_AGENT_PID: "", TMPDIR: limits.tmpDir }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		child = started;
		const out = ["", ""];
		started.stdout?.on("data", (chunk) => (out[0] += chunk));
		started.stderr?.on("data", (chunk) => (out[1] += chunk));
		const overdue = setTimeout(() => kill(started), limit);
		let finished = false;
		// 起こせなかったとき (error) は close が来ないことがある。
		const finish = (code: number | null) => {
			if (finished) return;
			finished = true;
			clearTimeout(overdue);
			if (child === started) child = undefined;
			done(code ?? -1, out[0], out[1]);
		};
		started.on("error", () => finish(-1));
		started.on("close", finish);
	}

	pi.on("session_start", (_event, ctx) => {
		// reload・new・resume・fork でもう 1 度来る。前の watcher を止めてから取り直す。
		stop();
		// UI の無い Pi (`-p`、subagent の子) は名乗らない。親と同じ project で起きるので、親の居ない間に名前を取ると
		// 後から来た人の Pi が held になる。Notify を受けてもターンを起こす相手が居ない。
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS, undefined);
		const mine = generation;
		const show = (text: string) => {
			if (mine === generation) ctx.ui.setStatus(STATUS, text);
		};
		const scripts = join(limits.skillDir, "scripts");
		const identities = join(scripts, "identities.sh");
		const watchOnce = join(scripts, "drivers", "types", "codex", "watch-once.sh");
		if (!existsSync(identities)) return;
		// script が cwd の中 (か cwd が置き場の中) にあると、モデルが sandbox の中から script を書き換えられる。
		// それを sandbox の外で起こすことになるので、登録を訊く前にやめる。
		const cwd = ctx.cwd;
		const [root, home] = [realpathSync(cwd), realpathSync(limits.skillDir)];
		if (within(root, home) || within(home, root)) return show(`agmsg: script の置き場 (${home}) が作業ディレクトリと重なるので起こさない`);
		// 一時ファイルの置き場が cwd の中にあると、sandbox の中から書ける。
		mkdirSync(limits.tmpDir, { recursive: true, mode: 0o700 });
		if (within(root, realpathSync(limits.tmpDir))) return show(`agmsg: 一時ファイルの置き場 (${limits.tmpDir}) が作業ディレクトリの中にあるので起こさない`);
		const owner = `${ctx.sessionManager.getSessionId()}.${process.pid}`;

		/** 未読がある間、watch-once.sh はすぐ返る。同じ max_id で返り続ける間は repeatMs ごとにしか起こさない。 */
		let last: string | undefined;
		function watch(name: string) {
			const started = Date.now();
			run(watchOnce, [cwd, TYPE, "--name", name, "--owner", owner, "--timeout", String(limits.watchSeconds)], limits.watchSeconds * 1000 + limits.watchGraceMs, (code, stdout, stderr) => {
				if (mine !== generation) return;
				const pending = code === 0 ? /^status=pending count=(\d+) max_id=(\S+)$/m.exec(stdout) : null;
				// 2 と `status=timeout` は未読なしの timeout。それ以外は設定か実行の失敗で、起こし直してもすぐ同じ形で返る。
				// 2 だけでは見分けない。bash は構文エラーでも 2 を返す。
				if (!pending && !(code === 2 && /^status=timeout$/m.test(stdout))) return show(`agmsg: 未読の監視が止まった (${firstLine(stderr) || `exit ${code}`})`);
				const wait = Math.max(0, limits.repeatMs - (Date.now() - started));
				if (pending && pending[2] !== last) {
					last = pending[2];
					// 件数だけ。本文も送り主も載せない。同じ max_id をもう 1 度流しても、monitor が重複として捨てる。
					pi.events.emit(MONITOR_EVENT, { kind: "received", source: "agmsg", id: last, summary: `未読の Message が ${pending[1]} 件ある`, wake: true });
				}
				timer = setTimeout(() => watch(name), wait);
				timer.unref();
			});
		}

		run(identities, [cwd, TYPE], limits.claimTimeoutMs, (code, stdout) => {
			if (mine !== generation || code !== 0) return;
			const names = [...new Set(stdout.split("\n").flatMap((line) => line.split("\t")[1] ?? []))];
			if (names.length === 0) return;
			if (names.length > 1) return show(`agmsg: この project に Pi の登録が複数ある (${names.join(", ")}) ので名乗らない`);
			if (!existsSync(watchOnce)) return show(`agmsg: Codex driver の watch-once.sh が無いので何もしない (${watchOnce})`);
			const [name] = names;
			run(join(scripts, "actas-claim.sh"), [cwd, TYPE, name, owner], limits.claimTimeoutMs, (claimed, out) => {
				if (mine !== generation) return;
				// status の行の前に、sync の案内などが出ることがある。
				const status = /^status=(\S+).*$/m.exec(out);
				if (claimed === 0 && status?.[1] === "ok") {
					show(`agmsg: ${name}`);
					return watch(name);
				}
				if (status?.[1] === "held") return show(`agmsg: ${name} は別のセッション (${/owner=(\S+)/.exec(status[0])?.[1]}) が名乗っている。Notify は受けない`);
				show(`agmsg: ${name} を名乗れなかった (${status?.[0] ?? `exit ${claimed}`})。Notify は受けない`);
			});
		});
	});

	// claim は手放さない。持ち主は `<session id>.<pid>` で、Pi が終われば agmsg が pid を見て空きとして扱う (README)。
	pi.on("session_shutdown", () => stop());
}
