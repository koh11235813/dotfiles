import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import verify, { limits } from "../index.ts";
import { run } from "../run.ts";
import { fingerprint } from "../worktree.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

// 実機の ~/.pi/agent と利用者の git 設定 (署名や hook) を巻き込まない。
const base = realpathSync(mkdtempSync(join(tmpdir(), "verify-")));
process.env.PI_CODING_AGENT_DIR = join(base, "agent");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

type App = ReturnType<typeof extensionHost>;
const apps: App[] = [];
/** 端末の生の入力を聞いているハンドラ。共有の host には口が無いので、ここで足す。 */
const terminal = new Map<App, Set<(data: string) => unknown>>();
/** 入力 (steer / follow-up) が待っているセッション。これも共有の host に口が無い。 */
const queued = new Set<App>();
after(async () => {
	for (const app of apps) await app.emit("session_shutdown", { reason: "quit" });
	rmSync(base, { recursive: true, force: true });
});

let count = 0;
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, stdio: "pipe" });
/** 1 つ commit のある git リポジトリ。 */
function repo() {
	const dir = join(base, `repo-${++count}`);
	mkdirSync(dir);
	writeFileSync(join(dir, "a.txt"), "one\n");
	git(dir, "init", "-q");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

const boundary = { outcome: "completed", entries: [] as unknown[], continue: false };

async function until(condition: () => boolean) {
	for (let i = 0; !condition(); i++) {
		if (i > 500) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** verify を載せたセッション。cwd は渡したディレクトリ。 */
async function session(cwd: string) {
	const app = extensionHost();
	apps.push(app);
	verify(app.pi);
	const listeners = new Set<(data: string) => unknown>();
	terminal.set(app, listeners);
	Object.assign(app.ctx.ui, {
		onTerminalInput: (handler: (data: string) => unknown) => {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
	});
	Object.assign(app.ctx, { hasPendingMessages: () => queued.has(app) });
	app.ctx.cwd = cwd;
	await app.emit("session_start");
	return app;
}

/** 1 つのタスク。開始 → work → 終端 (agent_before_settle が続行を返す間は work を繰り返す) → agent_settled。 */
async function task(app: App, work: (round: number) => void | Promise<void> = () => {}, settled: Record<string, unknown> = { aborted: false }) {
	const boundaries: Array<{ entries?: Array<{ type: string; customType: string; content: string }>; continue?: boolean } | undefined> = [];
	for (let round = 0; ; round++) {
		await app.emit("agent_start");
		await work(round);
		const result = (await app.emit("agent_before_settle", boundary)) as (typeof boundaries)[number];
		boundaries.push(result);
		if (!result?.continue) break;
	}
	await app.emit("agent_settled", settled);
	return boundaries;
}

const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : []);

test("登録した検証コマンドは、ファイルを変えたタスクの終端でだけ走る", async () => {
	const dir = repo();
	const mark = join(base, "mark-1");
	const app = await session(dir);
	await app.command("verify", `add echo ran >> ${mark}`);

	await task(app);
	assert.deepEqual(lines(mark), [], "変更の無いタスクでは走らない");

	await task(app, () => writeFileSync(join(dir, "a.txt"), "two\n"));
	assert.deepEqual(lines(mark), ["ran"]);

	await task(app, () => writeFileSync(join(dir, "new.txt"), "untracked\n"));
	assert.deepEqual(lines(mark), ["ran", "ran"], "未追跡ファイルの追加も変更に数える");
});

test("登録は project ごとで、セッションをまたいで残り、外せる", async () => {
	const dir = repo();
	const other = repo();
	const mark = join(base, "mark-2");
	await (await session(dir)).command("verify", `add echo ran >> ${mark}`);

	const elsewhere = await session(other);
	await task(elsewhere, () => writeFileSync(join(other, "a.txt"), "two\n"));
	assert.deepEqual(lines(mark), [], "別の project には効かない");

	mkdirSync(join(dir, "sub"));
	const again = await session(join(dir, "sub"));
	await again.command("verify");
	assert.match(again.notices.at(-1)!, /1\. echo ran >> /, "同じリポジトリなら下の階層から起動しても同じ登録を使う");
	await task(again, () => writeFileSync(join(dir, "a.txt"), "two\n"));
	assert.deepEqual(lines(mark), ["ran"]);

	const linked = join(base, "linked-worktree");
	git(dir, "worktree", "add", "-q", linked);
	const inWorktree = await session(linked);
	await task(inWorktree, () => writeFileSync(join(linked, "a.txt"), "in worktree\n"));
	assert.deepEqual(lines(mark), ["ran", "ran"], "同じリポジトリの worktree も同じ project として扱う");

	await again.command("verify", "remove 1");
	await task(again, () => writeFileSync(join(dir, "a.txt"), "three\n"));
	assert.deepEqual(lines(mark), ["ran", "ran"], "外した後は走らない");
});

test("タスクの途中で登録を全部外したら、何も走らせずに成功とは言わない", async () => {
	const dir = repo();
	const app = await session(dir);
	await app.command("verify", "add true");
	app.notices.length = 0;
	await task(app, async () => {
		writeFileSync(join(dir, "a.txt"), "two\n");
		await app.command("verify", "remove 1");
		app.notices.length = 0;
	});
	assert.deepEqual(app.notices, []);
	assert.equal(app.statuses.get("verify"), undefined);
	await app.command("verify", "add true");
	assert.match(app.statuses.get("verify")!, /^検証: 未実行/);
});

test("git リポジトリの外では登録を断る", async () => {
	const dir = join(base, "plain");
	mkdirSync(dir);
	const app = await session(dir);
	await app.command("verify", "add true");
	assert.match(app.notices.at(-1)!, /git/);
	await app.command("verify");
	assert.doesNotMatch(app.notices.at(-1)!, /1\. true/);
});

test("失敗は agent_before_settle で出力の末尾と一緒にモデルへ戻し、直ったら agent_settled で成功を知らせる", async () => {
	const dir = repo();
	const app = await session(dir);
	await app.command("verify", "add pwd");
	await app.command("verify", "add echo checking; grep -q fixed a.txt || { echo 'a.txt is not fixed' >&2; exit 3; }");
	app.notices.length = 0;

	const boundaries = await task(app, (round) => writeFileSync(join(dir, "a.txt"), round === 0 ? "broken\n" : "fixed\n"));

	assert.equal(boundaries.length, 2);
	assert.equal(boundaries[0]!.continue, true);
	const [entry] = boundaries[0]!.entries!;
	assert.equal(entry!.type, "custom_message");
	assert.equal(entry!.customType, "verify");
	assert.match(entry!.content, /grep -q fixed a\.txt/, "どのコマンドが落ちたか");
	assert.match(entry!.content, /終了コード 3/);
	assert.match(entry!.content, /checking\na\.txt is not fixed/, "stdout と stderr の末尾");
	assert.equal(boundaries[1], undefined, "通ったら続行しない");
	assert.equal(app.notices.length, 1, "途中の失敗では知らせず、最終結果を 1 度だけ知らせる");
	assert.match(app.notices[0]!, /検証: 成功/);
});

test("他の拡張が積んだ entry を落とさず、続行が既に決まっているか入力が待っているときは検証を後に回す", async () => {
	const dir = repo();
	const mark = join(base, "mark-defer");
	const app = await session(dir);
	await app.command("verify", `add echo ran >> ${mark}; false`);
	await app.emit("agent_start");
	writeFileSync(join(dir, "a.txt"), "two\n");

	assert.equal(await app.emit("agent_before_settle", { ...boundary, continue: true }), undefined);
	queued.add(app);
	assert.equal(await app.emit("agent_before_settle", boundary), undefined);
	queued.delete(app);
	assert.deepEqual(lines(mark), []);

	const other = { type: "custom", customType: "other" };
	const result = (await app.emit("agent_before_settle", { ...boundary, entries: [other] })) as { entries: unknown[] };
	assert.equal(result.entries.length, 2);
	assert.equal(result.entries[0], other);
	await app.emit("agent_settled", { aborted: false });
});

test("後に回したまま境界が来ずにタスクが終わったら、前の成功を残さず未実行にする", async () => {
	const dir = repo();
	const app = await session(dir);
	await app.command("verify", "add true");
	await task(app, () => writeFileSync(join(dir, "a.txt"), "two\n"));
	assert.equal(app.statuses.get("verify"), "検証: 成功");

	// 他の拡張の続行は、Pi が退けることがある (続けられる文脈が無いとき)。そのときはこの境界が最後になる。
	await app.emit("agent_start");
	writeFileSync(join(dir, "a.txt"), "three\n");
	assert.equal(await app.emit("agent_before_settle", { ...boundary, continue: true }), undefined);
	await app.emit("agent_settled", { aborted: false });
	assert.match(app.statuses.get("verify")!, /^検証: 未実行 \(確かめないままタスクが終わった/);
	assert.match(app.notices.at(-1)!, /^検証: 未実行 \(確かめないままタスクが終わった/);
});

test("未実行と成功を status と /verify に出し、検証の前に中断されたタスクは未実行として知らせる", async () => {
	const dir = repo();
	const app = await session(dir);
	assert.equal(app.statuses.get("verify"), undefined, "登録の無い project では何も出さない");
	await app.command("verify", "add true");
	assert.match(app.statuses.get("verify")!, /^検証: 未実行/);

	await task(app, () => writeFileSync(join(dir, "a.txt"), "two\n"));
	assert.equal(app.statuses.get("verify"), "検証: 成功");
	await app.command("verify");
	assert.match(app.notices.at(-1)!, /検証: 成功/);

	app.notices.length = 0;
	await task(app);
	assert.equal(app.statuses.get("verify"), "検証: 成功", "変更の無いタスクは前の結果を変えない");
	assert.deepEqual(app.notices, [], "変更の無いタスクでは知らせない");

	// Esc で止めたタスクには agent_before_settle が来ない。
	await app.emit("agent_start");
	writeFileSync(join(dir, "a.txt"), "three\n");
	await app.emit("agent_settled", { aborted: true });
	assert.match(app.statuses.get("verify")!, /^検証: 未実行 \(.*中断/);
	assert.match(app.notices.at(-1)!, /^検証: 未実行 \(.*中断/);

	const resumed = await session(dir);
	assert.match(resumed.statuses.get("verify")!, /^検証: 未実行/, "結果はセッションをまたがない");
});

test("合格は確かめた時点のファイル状態に結び付き、後の変更で無効になる。commit では無効にならない", async () => {
	const dir = repo();
	const app = await session(dir);
	await app.command("verify", "add true");
	await task(app, () => writeFileSync(join(dir, "a.txt"), "two\n"));
	assert.equal(app.statuses.get("verify"), "検証: 成功");

	git(dir, "commit", "-qam", "two");
	await app.command("verify");
	assert.match(app.notices.at(-1)!, /検証: 成功/);

	writeFileSync(join(dir, "a.txt"), "by hand\n");
	await app.command("verify");
	assert.match(app.notices.at(-1)!, /検証: 未実行 \(.*後にファイルが変わった/);
	assert.match(app.statuses.get("verify")!, /^検証: 未実行/);

	// タスクの外で変わった分は、次のタスクが何も変えなくても合格に戻さない。
	writeFileSync(join(dir, "a.txt"), "two\n");
	await task(app, () => writeFileSync(join(dir, "a.txt"), "three\n"));
	assert.equal(app.statuses.get("verify"), "検証: 成功");
	writeFileSync(join(dir, "a.txt"), "by hand again\n");
	await task(app);
	assert.match(app.statuses.get("verify")!, /^検証: 未実行/);
});

test("自動修正へ戻すのは上限まで。モデルが何も変えなければ走らせ直さない", async () => {
	const dir = repo();
	const mark = join(base, "mark-limit");
	const app = await session(dir);
	await app.command("verify", `add echo ran >> ${mark}; false`);
	app.notices.length = 0;

	const boundaries = await task(app, (round) => writeFileSync(join(dir, "a.txt"), `attempt ${round}\n`));
	assert.equal(limits.maxFixes, 2);
	assert.deepEqual(boundaries.map((result) => result?.continue), [true, true, undefined]);
	assert.equal(lines(mark).length, 3);
	assert.match(boundaries[0]!.entries![0]!.content, /1\/2/, "何回目の差し戻しかをモデルに伝える");
	assert.equal(app.notices.length, 1);
	assert.match(app.notices[0]!, /^検証: 失敗 \(.*上限 2 回/);
	assert.match(app.statuses.get("verify")!, /^検証: 失敗/);

	const idle = await task(app, (round) => {
		if (round === 0) writeFileSync(join(dir, "a.txt"), "next task\n");
	});
	assert.deepEqual(idle.map((result) => result?.continue), [true, undefined], "差し戻しても何も変わらなければそこで終える");
	assert.equal(lines(mark).length, 4, "同じファイル状態を 2 度は確かめない");
	assert.match(app.statuses.get("verify")!, /^検証: 失敗/);
});

test("エラーで終わったタスクは確かめるが、モデルへは戻さない", async () => {
	const dir = repo();
	const app = await session(dir);
	await app.command("verify", "add false");
	await app.emit("agent_start");
	writeFileSync(join(dir, "a.txt"), "two\n");
	assert.equal(await app.emit("agent_before_settle", { ...boundary, outcome: "error" }), undefined);
	await app.emit("agent_settled", { aborted: false });
	assert.match(app.statuses.get("verify")!, /^検証: 失敗/);
});

test("timeout を過ぎたコマンドは子孫ごと止めて失敗にする", async () => {
	const dir = repo();
	const pidFile = join(base, "pid-timeout");
	const app = await session(dir);
	await app.command("verify", `add sleep 30 & echo $! > ${pidFile}; wait`);
	const previous = limits.timeoutMs;
	limits.timeoutMs = 200;
	try {
		const started = Date.now();
		const boundaries = await task(app, (round) => {
			if (round === 0) writeFileSync(join(dir, "a.txt"), "two\n");
		});
		assert.ok(Date.now() - started < 10_000);
		assert.match(boundaries[0]!.entries![0]!.content, /timeout/);
		assert.match(app.statuses.get("verify")!, /^検証: 失敗 \(.*timeout/);
		await until(() => !alive(Number(readFileSync(pidFile, "utf8"))));
	} finally {
		limits.timeoutMs = previous;
	}
});

for (const [name, cancel] of [
	["/verify stop", (app: App) => app.command("verify", "stop")],
	["Esc", async (app: App) => [...terminal.get(app)!].forEach((handler) => handler("\x1b"))],
	["セッションの終わり", (app: App) => app.emit("session_shutdown", { reason: "quit" })],
] as const) {
	test(`走っている検証は ${name} で止まり、中断として残る。モデルへは戻さない`, async () => {
		const dir = repo();
		const mark = join(base, `mark-cancel-${count}`);
		const app = await session(dir);
		await app.command("verify", "add sleep 30");
		await app.command("verify", `add echo ran >> ${mark}`);
		await app.emit("agent_start");
		writeFileSync(join(dir, "a.txt"), "two\n");
		const started = Date.now();
		const pending = app.emit("agent_before_settle", boundary);
		await until(() => /実行中.*sleep 30/.test(app.statuses.get("verify") ?? ""));
		await cancel(app);
		assert.equal(await pending, undefined);
		assert.ok(Date.now() - started < 10_000);
		assert.deepEqual(lines(mark), [], "止めた後のコマンドは走らせない");
		assert.equal(terminal.get(app)!.size, 0, "端末の入力を聞くのは走っている間だけ");
		assert.match(app.statuses.get("verify")!, /^検証: 中断/, "「実行中」の表示を残さない");
		await app.emit("agent_settled", { aborted: name === "Esc" });
		assert.match(app.statuses.get("verify")!, /^検証: 中断/);
		assert.match(app.notices.at(-1)!, /^検証: 中断/);
	});
}

for (const [name, command] of [
	["成功", "echo generated >> a.txt"],
	["失敗", "echo generated >> a.txt; false"],
] as const) {
	test(`検証中にファイルが変わったら、${name}で終わっても結果を使わず未実行にする`, async () => {
		const dir = repo();
		const app = await session(dir);
		await app.command("verify", `add ${command}`);
		const boundaries = await task(app, () => writeFileSync(join(dir, "a.txt"), "two\n"));
		assert.deepEqual(boundaries, [undefined], "当てにならない結果でモデルへ戻さない");
		assert.match(app.statuses.get("verify")!, /^検証: 未実行 \(検証中にファイルが変わった/);
		assert.match(app.notices.at(-1)!, /^検証: 未実行 \(検証中にファイルが変わった/);
	});
}

test("git が無視しているファイルは、検証中に変わっても結果に響かない", async () => {
	const dir = repo();
	writeFileSync(join(dir, ".gitignore"), "build/\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "ignore");
	const app = await session(dir);
	await app.command("verify", "add mkdir -p build && date +%N > build/out");
	await task(app, () => writeFileSync(join(dir, "a.txt"), "two\n"));
	assert.equal(app.statuses.get("verify"), "検証: 成功");
});

test("登録を変えたら、前の成功も失敗も今の登録の結果として残さない", async () => {
	const dir = repo();
	const app = await session(dir);
	await app.command("verify", "add true");
	await task(app, () => writeFileSync(join(dir, "a.txt"), "two\n"));
	assert.equal(app.statuses.get("verify"), "検証: 成功");

	await app.command("verify", "add false");
	assert.match(app.statuses.get("verify")!, /^検証: 未実行 \(確かめた後に登録が変わった/, "走らせていないコマンドがあるのに成功とは言わない");
	assert.match(app.notices.at(-1)!, /^検証: 未実行 \(確かめた後に登録が変わった/);
	await task(app);
	assert.match(app.statuses.get("verify")!, /^検証: 未実行/, "変更の無いタスクの後も成功に戻さない");

	await task(app, (round) => {
		if (round === 0) writeFileSync(join(dir, "a.txt"), "three\n");
	});
	assert.match(app.statuses.get("verify")!, /^検証: 失敗 \(false/);
	await app.command("verify", "remove 2");
	assert.match(app.statuses.get("verify")!, /^検証: 未実行 \(確かめた後に登録が変わった/, "外したコマンドの失敗を残さない");
});

test("別のセッションが登録を変えたときも、前の結果を残さず、同じファイル状態でも確かめ直す", async () => {
	const dir = repo();
	const mark = join(base, "mark-other-session");
	const app = await session(dir);
	const other = await session(dir);
	await app.command("verify", "add false");

	const boundaries = await task(app, async (round) => {
		if (round === 0) writeFileSync(join(dir, "a.txt"), "two\n");
		else {
			await other.command("verify", "remove 1");
			await other.command("verify", `add echo ran >> ${mark}`);
		}
	});
	assert.deepEqual(boundaries.map((result) => result?.continue), [true, undefined]);
	assert.deepEqual(lines(mark), ["ran"], "モデルが何も変えていなくても、登録が変わっていれば走らせる");
	assert.equal(app.statuses.get("verify"), "検証: 成功");

	await other.command("verify", "add false");
	await app.command("verify");
	assert.match(app.notices.at(-1)!, /^検証: 未実行 \(確かめた後に登録が変わった/);

	// 境界の後、agent_settled までの間に変わった分。
	await other.command("verify", "remove 2");
	await task(app, () => writeFileSync(join(dir, "a.txt"), "three\n"));
	assert.equal(app.statuses.get("verify"), "検証: 成功");
	await app.emit("agent_start");
	await other.command("verify", "add false");
	await app.emit("agent_settled", { aborted: false });
	assert.match(app.statuses.get("verify")!, /^検証: 未実行 \(確かめた後に登録が変わった/);
});

test("verify.json の projects が配列なら知らない形として扱い、登録したことにしない", async () => {
	const store = join(process.env.PI_CODING_AGENT_DIR!, "verify.json");
	const saved = readFileSync(store);
	const odd = JSON.stringify({ version: 1, projects: [] });
	writeFileSync(store, odd);
	try {
		const app = await session(repo());
		await app.command("verify", "add true");
		assert.match(app.notices.at(-1)!, /verify\.json/);
		assert.equal(readFileSync(store, "utf8"), odd);
	} finally {
		writeFileSync(store, saved);
	}
});

test("verify.json が壊れていたら登録を書き換えず、他の project の登録を消さない", async () => {
	const store = join(process.env.PI_CODING_AGENT_DIR!, "verify.json");
	const dir = repo();
	const other = repo();
	await (await session(dir)).command("verify", "add true");
	assert.equal(statSync(store).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(process.env.PI_CODING_AGENT_DIR!).filter((name) => name.startsWith("verify.json")), ["verify.json"], "書きかけの一時ファイルを残さない");

	const saved = readFileSync(store);
	// 書き込み途中のクラッシュや手編集の誤りに相当する。
	truncateSync(store, saved.length - 3);
	try {
		const broken = readFileSync(store);
		const app = await session(other);
		await app.command("verify", "add echo b");
		assert.match(app.notices.at(-1)!, /verify\.json/);
		assert.deepEqual(readFileSync(store), broken);
		await app.command("verify", "remove 1");
		assert.deepEqual(readFileSync(store), broken);
	} finally {
		writeFileSync(store, saved);
	}
});

test("作業ツリーの中にある別の git リポジトリの中身も、ファイル状態に入る", () => {
	const dir = repo();
	const nested = join(dir, "nested");
	mkdirSync(nested);
	writeFileSync(join(nested, "x.txt"), "one\n");
	git(nested, "init", "-q");
	git(nested, "add", "-A");
	git(nested, "commit", "-q", "-m", "init");
	const before = fingerprint(dir);
	writeFileSync(join(nested, "x.txt"), "two\n");
	const changed = fingerprint(dir);
	assert.notEqual(changed, before);
	writeFileSync(join(nested, "untracked.txt"), "new\n");
	assert.notEqual(fingerprint(dir), changed);
});

const never = new AbortController().signal;

test("出力は末尾の 80 行・8 KiB までを返し、マルチバイト文字の途中で切らない", async () => {
	const numbered = await run("seq 1 200", base, { timeoutMs: 10_000, signal: never });
	assert.deepEqual(numbered.tail.split("\n"), Array.from({ length: 80 }, (_, index) => String(121 + index)));

	// 先頭の 2 バイトで、8 KiB の切れ目が 3 バイト文字の途中に来るようにずらす。
	const wide = await run(`printf ab; printf 'あ%.0s' $(seq 1 4000)`, base, { timeoutMs: 10_000, signal: never });
	assert.match(wide.tail, /^あ+$/);
	assert.ok(Buffer.byteLength(wide.tail) <= 8 * 1024 && Buffer.byteLength(wide.tail) > 8 * 1024 - 3);
});

test("SIGTERM を無視するコマンドは SIGKILL で止める", async () => {
	const pidFile = join(base, "pid-kill");
	const started = Date.now();
	const result = await run(`trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`, base, { timeoutMs: 100, signal: never });
	assert.equal(result.ended, "timed_out");
	assert.ok(Date.now() - started < 10_000);
	await until(() => !alive(Number(readFileSync(pidFile, "utf8"))));
});

test("シェルが終わった後に残った子は止め、グループを抜けて出力を握り続ける子は待たない", async () => {
	const pidFile = join(base, "pid-left");
	const left = await run(`sleep 30 & echo $! > ${pidFile}; echo done`, base, { timeoutMs: 20_000, signal: never });
	assert.deepEqual(left, { ended: "exited", code: 0, tail: "done" });
	await until(() => !alive(Number(readFileSync(pidFile, "utf8"))));

	// 抜け切る前にシェルが終わると、グループへの SIGKILL に巻き込まれる。抜けた側が pid を書くのを待つ。
	const escapedPid = join(base, "pid-escaped");
	const started = Date.now();
	const escaped = await run(`setsid sh -c 'echo $$ > ${escapedPid}; exec sleep 30' & until [ -s ${escapedPid} ]; do sleep 0.01; done; echo done`, base, { timeoutMs: 20_000, signal: never });
	const pid = Number(readFileSync(escapedPid, "utf8"));
	try {
		assert.deepEqual(escaped, { ended: "exited", code: 0, tail: "done" });
		assert.ok(Date.now() - started < 10_000);
	} finally {
		process.kill(pid, "SIGKILL");
	}
});

test("ファイル状態は、パス・実行ビット・symlink のリンク先・追跡下のファイルが消えたことで変わる", () => {
	const dir = repo();
	const seen = new Set([fingerprint(dir)]);
	const step = (message: string, change: () => void) => {
		change();
		const now = fingerprint(dir);
		assert.ok(now && !seen.has(now), message);
		seen.add(now);
	};
	step("実行ビット", () => chmodSync(join(dir, "a.txt"), 0o755));
	step("symlink", () => symlinkSync("a.txt", join(dir, "link")));
	step("同じ中身のファイルを足した", () => writeFileSync(join(dir, "b.txt"), "one\n"));
	step("リンク先 (指す先の中身は同じ)", () => {
		rmSync(join(dir, "link"));
		symlinkSync("b.txt", join(dir, "link"));
	});
	step("パス (中身は同じ)", () => renameSync(join(dir, "b.txt"), join(dir, "c.txt")));
	step("追跡下のファイルを空にした", () => writeFileSync(join(dir, "a.txt"), ""));
	step("追跡下のファイルを消した (空とは別)", () => rmSync(join(dir, "a.txt")));
});

test("ファイル状態を取るときに、.git/config の fsmonitor を走らせない", () => {
	const dir = repo();
	const mark = join(base, "mark-fsmonitor");
	const hook = join(base, "fsmonitor.sh");
	writeFileSync(hook, `#!/bin/sh\necho ran >> ${mark}\n`, { mode: 0o755 });
	git(dir, "config", "core.fsmonitor", hook);
	assert.ok(fingerprint(dir));
	assert.deepEqual(lines(mark), []);
});

test("git からファイル状態を取れなければ、走らせずに未実行にする", async () => {
	const dir = repo();
	const mark = join(base, "mark-git-broken");
	const app = await session(dir);
	await app.command("verify", `add echo ran >> ${mark}`);
	await task(app, () => {
		writeFileSync(join(dir, "a.txt"), "two\n");
		writeFileSync(join(dir, ".git", "index"), "broken");
	});
	assert.deepEqual(lines(mark), []);
	assert.match(app.statuses.get("verify")!, /^検証: 未実行 \(git から/);
	assert.match(app.notices.at(-1)!, /^検証: 未実行 \(git から/);
});

test("同じインスタンスで session_start が来たら、前のセッションの結果を持ち越さない", async () => {
	const dir = repo();
	const app = await session(dir);
	await app.command("verify", "add true");
	await task(app, () => writeFileSync(join(dir, "a.txt"), "two\n"));
	assert.equal(app.statuses.get("verify"), "検証: 成功");
	await app.emit("session_start");
	assert.match(app.statuses.get("verify")!, /^検証: 未実行 \(このセッション/);
});

test("走っている間に /verify を打っても、実行中の表示と結果を書き換えない", async () => {
	const dir = repo();
	const gate = join(base, "gate-running");
	const app = await session(dir);
	await app.command("verify", `add until [ -e ${gate} ]; do sleep 0.02; done`);
	writeFileSync(gate, "");
	await task(app, () => writeFileSync(join(dir, "a.txt"), "two\n"));
	assert.equal(app.statuses.get("verify"), "検証: 成功");
	rmSync(gate);

	await app.emit("agent_start");
	writeFileSync(join(dir, "a.txt"), "three\n");
	const pending = app.emit("agent_before_settle", boundary);
	await until(() => /実行中/.test(app.statuses.get("verify") ?? ""));
	await app.command("verify");
	assert.match(app.statuses.get("verify")!, /^検証: 実行中/);
	writeFileSync(gate, "");
	await pending;
	await app.emit("agent_settled", { aborted: false });
	assert.equal(app.statuses.get("verify"), "検証: 成功");
});

test("止めた検証がファイルを変えていても、中断として残す", async () => {
	const dir = repo();
	const app = await session(dir);
	await app.command("verify", "add echo generated >> a.txt; sleep 30");
	await app.emit("agent_start");
	writeFileSync(join(dir, "a.txt"), "two\n");
	const pending = app.emit("agent_before_settle", boundary);
	await until(() => readFileSync(join(dir, "a.txt"), "utf8").includes("generated"));
	await app.command("verify", "stop");
	await pending;
	assert.match(app.statuses.get("verify")!, /^検証: 中断/);
	await app.emit("agent_settled", { aborted: false });
	assert.match(app.statuses.get("verify")!, /^検証: 中断/);
});

test("セッションの終わりは、SIGTERM を無視する検証が止まり切るまで待つ", async () => {
	const dir = repo();
	const pidFile = join(base, "pid-shutdown");
	const app = await session(dir);
	await app.command("verify", `add trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`);
	await app.emit("agent_start");
	writeFileSync(join(dir, "a.txt"), "two\n");
	const pending = app.emit("agent_before_settle", boundary);
	await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
	await app.emit("session_shutdown", { reason: "quit" });
	assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false);
	await pending;
	await app.emit("agent_settled", { aborted: false });
});

test("submodule の中身もファイル状態に入り、初期化していない submodule があっても状態を取れる", () => {
	const source = repo();
	const dir = repo();
	git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
	git(dir, "commit", "-q", "-m", "sub");
	const before = fingerprint(dir);
	writeFileSync(join(dir, "sub", "a.txt"), "two\n");
	assert.notEqual(fingerprint(dir), before);

	git(dir, "submodule", "deinit", "-q", "-f", "sub");
	const empty = fingerprint(dir);
	assert.ok(empty);
	writeFileSync(join(dir, "a.txt"), "two\n");
	assert.notEqual(fingerprint(dir), empty, "外側の変更は外側の一覧で拾う");
});

test("guard が居れば、検証コマンドは guard が準備した形で走らせる。断られたら走らせずに未実行にする", async () => {
	const dir = repo();
	const mark = join(base, "mark-guard");
	const app = await session(dir);
	await app.command("verify", `add echo ran >> ${mark}`);
	const asked: Array<{ command: string; cwd: string }> = [];
	let refuse = false;
	// guard の代わり。guard の wrap と同じく、元のコマンドは環境変数で運び、command は差し替える。
	app.pi.events.on("guard:bash", (data) => {
		const request = data as { command: string; cwd: string; env: NodeJS.ProcessEnv; reply: (answer: unknown) => void };
		asked.push({ command: request.command, cwd: request.cwd });
		if (refuse) return request.reply({ error: "guard[sandbox]: The OS sandbox is unavailable." });
		request.reply({ command: `echo wrapped >> ${mark}; eval "$CARRIED"`, cwd: request.cwd, env: { ...request.env, CARRIED: request.command } });
	});

	await task(app, () => writeFileSync(join(dir, "a.txt"), "two\n"));
	assert.deepEqual(asked, [{ command: `echo ran >> ${mark}`, cwd: dir }]);
	assert.deepEqual(lines(mark), ["wrapped", "ran"], "guard が返した command と env で起こす");
	assert.equal(app.statuses.get("verify"), "検証: 成功");

	refuse = true;
	const boundaries = await task(app, () => writeFileSync(join(dir, "a.txt"), "three\n"));
	assert.deepEqual(lines(mark), ["wrapped", "ran"], "断られたコマンドを sandbox なしで走らせない");
	assert.match(app.statuses.get("verify")!, /^検証: 未実行 \(.*OS sandbox is unavailable/);
	assert.deepEqual(boundaries, [undefined], "コードの失敗ではないので、モデルへは戻さない");
});
