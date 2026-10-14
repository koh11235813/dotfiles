import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import agmsg, { limits } from "../index.ts";
import { extensionHost } from "../../../tests/extension-host.ts";

// 本物の agmsg (~/.agents/skills/agmsg) には触らない。script は全部ここに置いた偽物。
const base = realpathSync(mkdtempSync(join(tmpdir(), "agmsg-")));
limits.repeatMs = 1000;
limits.tmpDir = join(base, "private-tmp");

type App = ReturnType<typeof extensionHost>;
const apps: App[] = [];
after(async () => {
	for (const app of apps) await app.emit("session_shutdown", { reason: "quit" });
	rmSync(base, { recursive: true, force: true });
});

async function until(condition: () => boolean) {
	for (let i = 0; !condition(); i++) {
		if (i > 500) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

let count = 0;
/**
 * 偽の agmsg。script は呼ばれたことを log に 1 行ずつ足し、隣のファイルに書いてある出力と終了コードを返す。
 * watch-once.sh は `watch.out` が無ければ返らない (本物が未読を待っている状態)。
 */
function skill(options: { identities?: string; claim?: string; claimCode?: number; claimBody?: string; watchOnce?: boolean; watchBody?: string } = {}, root = join(base, `skill-${++count}`)) {
	const scripts = join(root, "scripts");
	const codex = join(scripts, "drivers", "types", "codex");
	mkdirSync(codex, { recursive: true });
	const script = (path: string, body: string) => {
		writeFileSync(path, `#!/bin/bash\ncd "${root}"\n${body}\n`);
		chmodSync(path, 0o755);
	};
	script(join(scripts, "identities.sh"), 'echo "identities $*" >> log\ncat identities.out');
	script(join(scripts, "actas-claim.sh"), `echo "claim $*" >> log\n${options.claimBody ?? ""}\ncat claim.out\nexit "$(cat claim.code)"`);
	if (options.watchOnce !== false) {
		script(
			join(codex, "watch-once.sh"),
			`echo "watch pid=$$ env=\${AGMSG_AGENT_PID+set}:\${AGMSG_AGENT_PID-} tmp=$TMPDIR args=$*" >> log\nif [ -f watch.out ]; then cat watch.out; exit "$(cat watch.code 2>/dev/null || echo 0)"; fi\n${options.watchBody ?? "exec sleep 30"}`,
		);
	}
	writeFileSync(join(root, "identities.out"), options.identities ?? "dotfiles\tpi\n");
	writeFileSync(join(root, "claim.out"), options.claim ?? "AGMSG: connected, but not syncing.\n\nstatus=ok team=dotfiles\n");
	writeFileSync(join(root, "claim.code"), String(options.claimCode ?? 0));
	return {
		root,
		log: () => (existsSync(join(root, "log")) ? readFileSync(join(root, "log"), "utf8").trim().split("\n") : []),
		calls: (name: string) => (existsSync(join(root, "log")) ? readFileSync(join(root, "log"), "utf8").trim().split("\n") : []).filter((line) => line.startsWith(`${name} `)),
		/** watch-once.sh の次の返事。未読の本文に当たるものを混ぜて、それが Notify に載らないことも見る。 */
		pending: (unread: number, maxId: string) => writeFileSync(join(root, "watch.out"), `body: secret text from the sender\nstatus=pending count=${unread} max_id=${maxId}\n`),
	};
}
type Skill = ReturnType<typeof skill>;

const watcherPid = (line: string) => Number(/pid=(\d+)/.exec(line)![1]);

/** agmsg を載せたセッション。cwd は偽の agmsg の外。 */
async function session(fake: Skill, options: { cwd?: string; hasUI?: boolean } = {}) {
	limits.skillDir = fake.root;
	const app = extensionHost();
	apps.push(app);
	agmsg(app.pi);
	const events: Array<Record<string, unknown>> = [];
	app.pi.events.on("monitor:event", (event) => events.push(event as Record<string, unknown>));
	const cwd = options.cwd ?? join(base, `cwd-${++count}`);
	mkdirSync(cwd, { recursive: true });
	app.ctx.cwd = cwd;
	if (options.hasUI === false) Object.assign(app.ctx, { hasUI: false, mode: "print" });
	await app.emit("session_start", { reason: "startup" });
	return { app, events, cwd, owner: `${app.manager.getSessionId()}.${process.pid}` };
}

test("登録が無ければ何も起こさず、何も出さない", async () => {
	const fake = skill({ identities: "" });
	const { app, events, cwd } = await session(fake);
	await until(() => fake.log().length > 0);
	await pause(100);

	assert.deepEqual(fake.log(), [`identities ${cwd} pi`]);
	assert.equal(app.statuses.get("agmsg"), undefined);
	assert.deepEqual(app.notices, []);
	assert.deepEqual(events, []);
});

test("agmsg が入っていなければ何も出さない", async () => {
	const { app } = await session({ root: join(base, "nowhere") } as Skill);
	await pause(50);

	assert.equal(app.statuses.get("agmsg"), undefined);
	assert.deepEqual(app.notices, []);
});

test("claim が通ると、watcher が同じ owner・空の AGMSG_AGENT_PID・sandbox から書けない TMPDIR で起きる", async () => {
	const fake = skill();
	const { app, cwd, owner } = await session(fake);
	await until(() => fake.calls("watch").length > 0);

	assert.deepEqual(fake.calls("claim"), [`claim ${cwd} pi pi ${owner}`]);
	// set: は「渡してあって空」。渡していないと agmsg は祖先のプロセスを辿る。
	assert.match(fake.calls("watch")[0], new RegExp(`^watch pid=\\d+ env=set: tmp=${limits.tmpDir} args=${cwd} pi --name pi --owner ${owner.replace(".", "\\.")} --timeout 300$`));
	assert.ok(existsSync(limits.tmpDir));
	assert.equal(app.statuses.get("agmsg"), "agmsg: pi");
	assert.deepEqual(app.notices, []);
});

test("held なら watcher を起こさず、status に出す", async () => {
	const fake = skill({ claim: "status=held team=dotfiles owner=other-session.4242\n", claimCode: 1 });
	const { app, events } = await session(fake);
	await until(() => app.statuses.get("agmsg") !== undefined);
	await pause(100);

	assert.equal(app.statuses.get("agmsg"), "agmsg: pi is claimed by another session (other-session.4242). Notify is off");
	assert.deepEqual(fake.calls("watch"), []);
	assert.deepEqual(events, []);
});

test("held 以外で claim が通らなかったときは、held とは別の文面で出す", async () => {
	const fake = skill({ claim: "status=unverified team=dotfiles reason=lock_unreadable\n", claimCode: 1 });
	const { app } = await session(fake);
	await until(() => app.statuses.get("agmsg") !== undefined);

	assert.equal(app.statuses.get("agmsg"), "agmsg: could not claim pi (status=unverified team=dotfiles reason=lock_unreadable). Notify is off");
	assert.deepEqual(fake.calls("watch"), []);
});

test("登録された名前が複数あれば名乗らない", async () => {
	const fake = skill({ identities: "dotfiles\tpi\ndotfiles\treviewer\n" });
	const { app } = await session(fake);
	await until(() => app.statuses.get("agmsg") !== undefined);

	assert.equal(app.statuses.get("agmsg"), "agmsg: not claiming: this project has more than one Pi registration (pi, reviewer)");
	assert.deepEqual(fake.calls("claim"), []);
});

test("未読が来ると、件数だけの received が wake つきで出る。同じ max_id では空回りせず、新しい max_id でまた出る", async () => {
	const fake = skill();
	fake.pending(2, "1111");
	const { events } = await session(fake);
	await until(() => events.length > 0);

	assert.deepEqual(events, [{ kind: "received", source: "agmsg", id: "1111", summary: "unread Messages: 2", wake: true }]);

	// 偽の watch-once.sh は同じ max_id ですぐ返り続ける。起こし直すのは repeatMs を待ってから。
	await pause(300);
	assert.equal(fake.calls("watch").length, 1);
	await until(() => fake.calls("watch").length === 2);
	assert.equal(events.length, 1);

	fake.pending(3, "2222");
	await until(() => events.length === 2);
	assert.deepEqual(events[1], { kind: "received", source: "agmsg", id: "2222", summary: "unread Messages: 3", wake: true });
	assert.ok(!JSON.stringify(events).includes("secret"));
});

test("watch-once.sh が失敗したら起こし直さず、status に出す", async () => {
	const fake = skill();
	writeFileSync(join(fake.root, "watch.out"), "");
	writeFileSync(join(fake.root, "watch.code"), "1");
	const { app } = await session(fake);
	await until(() => app.statuses.get("agmsg")?.includes("stopped") === true);
	await pause(100);

	assert.equal(app.statuses.get("agmsg"), "agmsg: stopped watching for unread Messages (exit 1)");
	assert.equal(fake.calls("watch").length, 1);
});

test("未読なしの timeout (終了コード 2 と status=timeout) なら起こし直す", async () => {
	const fake = skill();
	writeFileSync(join(fake.root, "watch.out"), "status=timeout\n");
	writeFileSync(join(fake.root, "watch.code"), "2");
	const { app, events } = await session(fake);
	await until(() => fake.calls("watch").length === 2);

	assert.equal(app.statuses.get("agmsg"), "agmsg: pi");
	assert.deepEqual(events, []);
});

test("終了コード 2 でも status=timeout が無ければ (構文エラーなど) 起こし直さず、status に出す", async () => {
	const fake = skill();
	writeFileSync(join(fake.root, "watch.out"), "");
	writeFileSync(join(fake.root, "watch.code"), "2");
	const { app } = await session(fake);
	await until(() => app.statuses.get("agmsg")?.includes("stopped") === true);
	await pause(limits.repeatMs + 300);

	assert.equal(app.statuses.get("agmsg"), "agmsg: stopped watching for unread Messages (exit 2)");
	assert.equal(fake.calls("watch").length, 1);
});

test("watch-once.sh が自分の timeout を過ぎても返らなければ、子ごと止めて status に出す", async (t) => {
	const saved = { ...limits };
	t.after(() => Object.assign(limits, saved));
	Object.assign(limits, { watchSeconds: 0, watchGraceMs: 300 });
	// TERM を無視する bash と、その子。bash だけを止めても、TERM を送っても、子が残る。
	const fake = skill({ watchBody: "trap '' TERM\nsleep 30 &\necho \"child $!\" >> log\nwait" });
	const { app } = await session(fake);
	await until(() => fake.calls("child").length > 0);
	const pids = [watcherPid(fake.calls("watch")[0]), Number(fake.calls("child")[0].split(" ")[1])];
	assert.ok(pids.every(alive));
	await until(() => app.statuses.get("agmsg")?.includes("stopped") === true);

	assert.equal(app.statuses.get("agmsg"), "agmsg: stopped watching for unread Messages (exit -1)");
	await until(() => !pids.some(alive));
	assert.equal(fake.calls("watch").length, 1);
});

test("claim が返らなければ打ち切って、status に出す", async (t) => {
	const saved = limits.claimTimeoutMs;
	t.after(() => (limits.claimTimeoutMs = saved));
	limits.claimTimeoutMs = 300;
	const fake = skill({ claimBody: "sleep 30" });
	const { app } = await session(fake);
	await until(() => app.statuses.get("agmsg") !== undefined);

	assert.equal(app.statuses.get("agmsg"), "agmsg: could not claim pi (exit -1). Notify is off");
	assert.deepEqual(fake.calls("watch"), []);
});

test("session_shutdown で watcher が、TERM を無視する bash もその子も止まる", async () => {
	const fake = skill({ watchBody: "trap '' TERM\nsleep 30 &\necho \"child $!\" >> log\nwait" });
	const { app } = await session(fake);
	await until(() => fake.calls("child").length > 0);
	const pids = [watcherPid(fake.calls("watch")[0]), Number(fake.calls("child")[0].split(" ")[1])];
	assert.ok(pids.every(alive));

	await app.emit("session_shutdown", { reason: "quit" });
	await until(() => !pids.some(alive));
});

test("未読が残ったまま session_shutdown しても、起こし直さない", async () => {
	const fake = skill();
	fake.pending(1, "1111");
	const { app, events } = await session(fake);
	// received が出た時点で、次の起こし直しのタイマーが掛かっている。
	await until(() => events.length > 0);

	await app.emit("session_shutdown", { reason: "quit" });
	await pause(limits.repeatMs + 300);
	assert.equal(fake.calls("watch").length, 1);
});

test("未読が残ったまま 2 度目の session_start が来ても、前の watcher は起こし直さない", async () => {
	const fake = skill();
	fake.pending(1, "1111");
	const { app, events, owner } = await session(fake);
	await until(() => events.length > 0);

	app.replaceSession();
	await app.emit("session_start", { reason: "new" });
	await until(() => fake.calls("watch").length === 2);
	await pause(limits.repeatMs + 300);
	// 新しい watcher の 1 回目と、repeatMs 後の起こし直しだけ。前の owner のものは最初の 1 回きり。
	assert.equal(fake.calls("watch").filter((line) => line.includes(`--owner ${owner} `)).length, 1);
	assert.ok(fake.calls("watch").length <= 3);
});

test("session_shutdown で watcher の子が止まる", async () => {
	const fake = skill();
	const { app } = await session(fake);
	await until(() => fake.calls("watch").length > 0);
	const pid = watcherPid(fake.calls("watch")[0]);
	assert.ok(alive(pid));

	await app.emit("session_shutdown", { reason: "quit" });
	await until(() => !alive(pid));
	await pause(100);
	assert.equal(fake.calls("watch").length, 1);
});

test("2 度目の session_start は前の watcher を止めて、新しい session id で取り直す", async () => {
	const fake = skill();
	const { app, cwd, owner } = await session(fake);
	await until(() => fake.calls("watch").length > 0);
	const pid = watcherPid(fake.calls("watch")[0]);

	app.replaceSession();
	const next = `${app.manager.getSessionId()}.${process.pid}`;
	assert.notEqual(next, owner);
	await app.emit("session_start", { reason: "new" });
	await until(() => !alive(pid));
	await until(() => fake.calls("watch").length === 2);

	assert.deepEqual(fake.calls("claim"), [`claim ${cwd} pi pi ${owner}`, `claim ${cwd} pi pi ${next}`]);
	assert.ok(fake.calls("watch")[1].includes(`--owner ${next} `));
	assert.ok(alive(watcherPid(fake.calls("watch")[1])));
});

test("watch-once.sh が無ければ claim もせず、status に出す", async () => {
	const fake = skill({ watchOnce: false });
	const { app, cwd } = await session(fake);
	await until(() => app.statuses.get("agmsg") !== undefined);
	await pause(100);

	assert.match(app.statuses.get("agmsg")!, /^agmsg: doing nothing: the Codex driver's watch-once\.sh is missing/);
	assert.deepEqual(fake.log(), [`identities ${cwd} pi`]);
});

test("script の置き場が cwd の中にあるときは何も起こさない", async () => {
	const cwd = join(base, `cwd-${++count}`);
	const fake = skill({}, join(cwd, "vendor", "agmsg"));
	const { app } = await session(fake, { cwd });
	await pause(100);

	assert.match(app.statuses.get("agmsg")!, /^agmsg: not started: the script directory .* overlaps the working directory$/);
	assert.deepEqual(fake.log(), []);
});

test("cwd が script の置き場の中にあるときも何も起こさない", async () => {
	const fake = skill();
	const { app } = await session(fake, { cwd: join(fake.root, "scripts") });
	await pause(100);

	assert.match(app.statuses.get("agmsg")!, /overlaps the working directory$/);
	assert.deepEqual(fake.log(), []);
});

test("一時ファイルの置き場が cwd の中にあるときは何も起こさない", async (t) => {
	const saved = limits.tmpDir;
	t.after(() => (limits.tmpDir = saved));
	const cwd = join(base, `cwd-${++count}`);
	limits.tmpDir = join(cwd, "tmp");
	const fake = skill();
	const { app } = await session(fake, { cwd });
	await pause(100);

	assert.match(app.statuses.get("agmsg")!, /^agmsg: not started: the temp directory .* is inside the working directory$/);
	assert.deepEqual(fake.log(), []);
});

test("UI の無い Pi では何も起こさない", async () => {
	const fake = skill();
	const { app } = await session(fake, { hasUI: false });
	await pause(100);

	assert.deepEqual(fake.log(), []);
	assert.equal(app.statuses.get("agmsg"), undefined);
});
