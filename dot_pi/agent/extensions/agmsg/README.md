# agmsg

Pi を agmsg (`~/.agents/skills/agmsg`、v1.5.3 で確かめた) につなぐ拡張。
用語は Notify (何かが起きたという事実だけを伝える)、Message (agent が別の agent に宛てた本文)、Delivery (Message の本文をモデルに届けること)。未読があると伝えるだけの Notify は Delivery ではない。

することは 2 つだけ。

1. **identity の claim。** `session_start` で、この project に登録された Pi の名前を、この Pi のものとして名乗る。
2. **未読の Notify。** その名前に未読の Message があると、件数だけをモデルに知らせる。

しないこと: spawn / resume、Delivery (Message の本文をモデルに届けること)、`/agmsg` コマンド、自動の join、名前の自動の引き継ぎ。
本文を読むのは、モデルが Pi 向けの skill (`~/.pi/agent/skills/agmsg`) の手順で `inbox.sh` を打ったとき。

## 使い方

join は人が Pi の外で 1 度打つ。拡張は join しない。

```sh
~/.agents/skills/agmsg/scripts/join.sh <team> <name> pi "$PWD"
# この dotfiles なら
~/.agents/skills/agmsg/scripts/join.sh dotfiles pi pi ~/Development/github/dotfiles
```

あとは、join したディレクトリで Pi を起こすだけ。footer の status に出るもの:

| status | 意味 |
| --- | --- |
| (何も出ない) | この cwd に Pi の登録が無い、agmsg が入っていない、UI の無い Pi |
| `agmsg: <name>` | 名乗れた。未読を見張っている |
| `agmsg: <name> は別のセッション (<owner>) が名乗っている。Notify は受けない` | 2 つ目の Pi (下) |
| `agmsg: <name> を名乗れなかった (status=…)。Notify は受けない` | claim が held 以外の理由で通らなかった (`status=unverified …` など) |
| `agmsg: この project に Pi の登録が複数ある (…) ので名乗らない` | 同じ cwd に Pi の名前が 2 つ以上 join してある |
| `agmsg: Codex driver の watch-once.sh が無いので何もしない (…)` | 下の「借りている script」 |
| `agmsg: script の置き場 (…) が作業ディレクトリと重なるので起こさない` | 下の「決めたこと」。登録を訊く前に決まるので、Pi の登録が無い cwd でも出る |
| `agmsg: 一時ファイルの置き場 (…) が作業ディレクトリの中にあるので起こさない` | 下の「決めたこと」。これも登録が無くても出る |
| `agmsg: 未読の監視が止まった (…)` | `watch-once.sh` が失敗した、または返らないので止めた (`exit -1`)。括弧の中は stderr の 1 行目か終了コード。`/reload` で取り直す |

未読が来ると、guard の monitor の入口 (`pi.events` の `monitor:event`) に `received` を 1 つ流す。
中身は `source: "agmsg"`、`summary: "未読の Message が N 件ある"`、`wake: true`、`id` は `watch-once.sh` の `max_id`。
monitor が、待機中の Pi のターンを起こしてこれをモデルに渡す。

## 何を起こすか

どれも `~/.agents/skills/agmsg/scripts/` の下の script を、絶対パスで、シェルを通さず (`spawn`、`shell` なし)、Pi のプロセスから起こす。モデルの bash の sandbox は変えていない。
`execFile` でないのは、script をその子 (sqlite3・sed・sleep) ごと止めるためにプロセスグループを分ける (`detached`) から。`execFile` は `detached` を渡せない。

環境変数は 2 つだけ変えて、残りは Pi の環境のまま渡す。

- `AGMSG_AGENT_PID` を空にする。空だと agmsg は祖先のプロセスを辿らない (`lib/resolve-project.sh` の `agmsg_agent_pid`)。辿らせると、Claude Code や Codex の下で起こした Pi が、その祖先の project を引く。
- `TMPDIR` を `~/.pi/agent/agmsg-tmp` (拡張が 0700 で作る) にする。理由は下の「決めたこと」。
- ほかの `AGMSG_*` (`AGMSG_WATCH_ONCE_INTERVAL`、`AGMSG_RESOLVE_PROJECT`、`AGMSG_STORAGE_PATH`、`AGMSG_CODEX_OWNER_ID` など) は、Pi を起こしたシェルにあればそのまま効く。Codex の下で Pi を起こして動きがおかしいときは、まずここを見る。`AGMSG_WATCH_ONCE_TIMEOUT` と `AGMSG_CODEX_OWNER_ID` は、引数 (`--timeout`、`--owner`) が勝つので効かない。

| 順 | script と引数 | 見るもの |
| --- | --- | --- |
| 1 | `identities.sh <cwd> pi` | `<team>\t<name>` の行。無ければここで終わり、何も出さない |
| 2 | `actas-claim.sh <cwd> pi <name> <session id>.<pid>` | stdout の `status=` の行と終了コード。`status=ok team=…` (0)、`status=held team=… owner=…` (1)、`status=unverified team=… reason=…` (1)、`status=not_registered` (2)。`status=` の前に sync の案内が出ることがあるので、行で探す |
| 3 | `drivers/types/codex/watch-once.sh <cwd> pi --name <name> --owner <session id>.<pid> --timeout 300` | `status=pending count=N max_id=X` (0)、`status=timeout` (2、300 秒後)、それ以外は失敗 |

3 は終わるたびに起こし直す。`--owner` は 2 に渡したものと同じ文字列。
`--name` は、今の実装では数える範囲を変えない (登録が複数あると名乗らないので、3 に届く時点で名前は 1 つ)。`--name` なしだと誰も名乗っていない別名の受信箱も数える (`lib/subscription.sh`) ので、複数登録で止める決まりを外すときのために渡してある。
1 と 2 は 30 秒、3 は 312 秒 (300 秒 + Codex の bridge と同じ余裕) で返らなければ止める。

## 決めたこと

- **2 つ目の Pi は名乗らない。** 同じ名前を別の生きている Pi が持っていると claim は `held` で返る。そのときは Notify を受けず、status に出すだけ。自動では引き継がない。先の Pi が終われば、次の `session_start` (`/reload` か起こし直し) で取れる。
- **claim は手放さない (shutdown で release を呼ばない)。** 持ち主は `<session id>.<pid>` で、agmsg は pid が死んでいれば空きとして扱う (`lib/instance-id.sh` の `agmsg_instance_alive`) ので、Pi が終われば次の claim がそのまま通る。new / resume / fork では session id が変わるが、pid が同じなら claim は通る (`actas_lock_reclaim_same_process`)。手放すための script も無い: `scripts/release/` はリリース作業の道具、`leave.sh` は登録そのものを消す、`session-end.sh` は Claude Code の hook の入力を前提にしている。残るのは `run/` の 2 つ: lock (`actas.<id>.session`) と `role-session.<team>__<name>`。
- **空回りさせない。** 未読がある間、`watch-once.sh` はすぐ 0 で返り、モデルが読むまで同じ `max_id` で返り続ける。前に起こしてから 30 秒 (`limits.repeatMs`) 空けて起こし直す。300 秒待って timeout で返ったときは、もう 30 秒経っているのですぐ起こし直す。起こし直すのは、未読ありと、終了コード 2 で `status=timeout` の行があるときだけ。ほかは失敗として止める (bash は構文エラーでも 2 を返すので、終了コードだけでは見分けない)。
- **同じ未読を 2 度知らせない。** 拡張は直前の `max_id` と比べ、monitor も同じ `kind`・`source`・`id` を 1 度しか届けない。`max_id` は未読の集合の checksum なので、未読が増えても減っても変わる (1 件読んで残りがあると、もう 1 度知らせる)。
- **reload・new・resume・fork では取り直す。** `session_start` のたびに前の watcher を止め、新しい session id で claim からやり直す。`session_shutdown` でも止める。
- **UI の無い Pi (`pi -p`、subagent の子) では何もしない。** 子は親と同じ project で起きる。親が居れば子の claim は `held` になるだけだが、親が居ない間に子が名前を取ると、後から起こした人の Pi が `held` になる。Notify を受けても、1 回きりの実行にはターンを起こす相手が居ない。
- **script の置き場と cwd が重なるときは起こさない。** `~` や `~/.agents` で Pi を起こすと、モデルが sandbox の中から script を書き換えられ、それを拡張が sandbox の外で起こすことになる。symlink を解いてから比べ、登録を訊く (`identities.sh`) より前にやめる。
- **script の一時ファイルは、sandbox から書けない場所に作らせる。** `watch-once.sh` は未読があるたびに、`$TMPDIR` に作った一時ファイルへ SQL を書き、それを sqlite3 の標準入力に流す。sqlite3 は標準入力の `.shell` をそのまま実行する。Pi と sandbox の中の bash は同じ `$TMPDIR` を使い、そこと `/tmp` はモデルが書ける (`../guard/sandbox.ts` の `writeRoots`) ので、一時ファイルに書き足せば sandbox の外でコマンドが動く。未読は `send.sh` でモデルが自分で作れる。それで、script に渡す `TMPDIR` を `~/.pi/agent/agmsg-tmp` にしている。agent dir は guard が `allowWrite` に足させない場所で、書けるのは cwd が含むときだけなので、そのときは起こさない。
- **止めるときは script をその子ごと止める。** script ごとにプロセスグループを分け、グループに SIGKILL を送る。`session_shutdown`、次の `session_start`、上限の時間を過ぎたときの 3 か所。
- **project には cwd をそのまま渡す。** `actas-claim.sh` と `watch-once.sh` は、渡したパスから登録のある祖先や worktree の本体を自分で探す。

## 借りている script

未読を待つのに、Codex driver の `scripts/drivers/types/codex/watch-once.sh` を、その場所のまま呼んでいる。Codex の app-server bridge のための script で、Pi のためのものではない。
agmsg の更新でこの script の場所・引数・出力が変わると、Notify は止まる (無ければ status に出して claim もしない。出力が変われば「未読の監視が止まった」になる)。upstream には伝えていない。

Pi 用の driver (`scripts/drivers/types/pi/` の `type.conf`・`_delivery.sh`・`template.md`) も upstream (fujibee/agmsg) には無い。この dotfiles が配っている。無いと `join.sh … pi …` が型を知らないと断る。

## できないこと

- **guard の monitor が要る。** `monitor:event` を受けるのは guard (`../guard/monitor/`) だけ。guard が読み込まれていなければ、名乗りはするが、未読の Notify は誰にも届かない。代わりの経路は作っていない。
- **Pi 向けの skill には、join / drop (`reset.sh`) / spawn / despawn の手順が残っている。** agmsg が描いたままで、driver の中身を変えない決まりなので削っていない。「join は人が Pi の外で打つ」「spawn はしない」は拡張の決まりで、モデルが skill の手順で打つのは止めていない。`join.sh` と `reset.sh` が書くのは `teams/<team>/config.json` で、`guard.json` の `allowWrite` (`db` だけ) に入っていないので normal の sandbox では書けないはずだが、打っては確かめていない。通った場合、`reset.sh` は登録を消すので、次の `session_start` から拡張は黙って何もしなくなる。skill の actas は「名乗る名前を変える」だけで lock に触れないので、モデルが名乗る FROM と拡張が claim した名前がずれうる。本文は `/agmsg` と案内するが、Pi の口は `/skill:agmsg`。
- **`settings.json` に `skills` が既にあるホストでは、共有の skill の除外が入らない。** `modify_settings.json` は実ファイルにある key を残す。手で `"-~/.agents/skills/agmsg"` を足す。足さないと同名の skill がぶつかって Pi が警告を出す (使われるのは Pi 向け)。
- **lock が消えると排他が効かない。** `watch-once.sh --owner` が外すのは、別の生きている session が持っている名前だけ (`lib/subscription.sh`)。`run/` の lock が消えると (`reset.sh`、手で消す)、先の Pi は受け続け、2 つ目の Pi も claim できる。script 単体で見ただけで、拡張を通しては確かめていない。
- **claim が 30 秒で打ち切られると、lock を持ったまま Notify を受けないことがありうる。** `actas-claim.sh` は lock を取った後で pane の名付けと sync の起動をしてから `status=ok` を出す。そこで打ち切ると status は「名乗れなかった (exit -1)」になり、ほかの Pi は `held` になる。`/reload` で取り直せる (同じ pid の再 claim は通る)。起こしてはいない。
- **sandbox の中のモデルは、他の agent の受信箱を読めて、既読にできる。** `inbox.sh` と `send.sh` は持ち主を確かめず、モデルの bash は agmsg の db に書ける (`guard.json` の `allowWrite`)。他の名前で送ることもできる。claim が守るのは「誰が Notify を受けるか」だけ。受け入れた制約。
- **join したディレクトリより下で Pi を起こすと、何も起きない。** `identities.sh` は渡したパスそのものしか見ない (祖先を探すのは `actas-claim.sh` と `whoami.sh`)。登録が無いのと見分けられないので、status にも出ない。
- **Notify が届いても、モデルが読むとは限らない。** 伝えるのは件数だけで、読むかどうかはモデルが決める。monitor は、人の入力なしに続けて起こすターンを 3 回までにしている (`../guard/monitor/README.md`)。
- **Pi が後始末なしに死ぬと、watcher が残る。** `session_shutdown` が呼ばれなかったとき。`watch-once.sh` は読むだけで、固まらなければ自分の timeout (300 秒) で終わる。固まったものを止めるのは Pi なので、Pi が居なければ残り続ける。プロセスグループを分けてあるので、端末を閉じたときの SIGHUP も届かない。
- **止めるときは SIGKILL なので、後始末は走らない。** SIGTERM にしないのは、`watch-once.sh` が一時ファイルを消す間だけ TERM を trap していて、そこに当たると止まらないから。消している最中に当たれば `~/.pi/agent/agmsg-tmp` に小さな一時ファイルが 1 つ残る。拡張は消さない。
- **`~/.pi/agent/agmsg-tmp` は、agmsg が入っていれば、Pi の登録が無い cwd でも作られる。** 登録を訊く `identities.sh` にも同じ `TMPDIR` を渡すため。
- **`identities.sh` が失敗したとき (sqlite3 が無いなど) は、登録が無いのと同じく何も出さない。**
- **pid の使い回し。** Pi が死んだ後、同じ pid を別のプロセスが使っている間は、lock は生きている Pi のものに見え、次の Pi の claim が `held` になる。
- **`actas-claim.sh` は claim のほかに、端末の pane の名付けと、remote につないだ team の sync の起動も試みる。** agmsg の他の agent と同じ動きで、拡張からは止めていない。
- **`guard.json` の `allowWrite` に agmsg の `scripts/` を含む場所を足すと、cwd と重なっていなくても script を書き換えられる。** 拡張が見ているのは cwd との重なりだけ。`teams/`・`plugins/`・`~/.agents/agmsg/config.json` も同じ (どの driver を source するかがそこで決まる)。今の `db` だけなら、`db/trusted-plugins` を書けても、source されるファイルの側 (`plugins/`) を書けないので通らない。
- **script が sandbox から書ける場所を読む箇所は、見切れていない。** 塞いだのは `$TMPDIR` を見る一時ファイルだけ。読んで見つけた残り: `drivers/terminals/tmux/ops.sh` は `$TMPDIR` を見ずに `/tmp/.agmsg-tmux-err.<pid>` へ tmux の stderr を書く (名前が読めるので、先に symlink を置かれると、その先のファイルが上書きされる。実行はされない。claim の pane の名付けがここを通るかは確かめていない)。`lib/resolve-project.sh` は cwd で `git rev-parse --git-common-dir` を打つ (guard 自身も同じことを sandbox の外でしている)。cwd の中のファイルを source や eval する箇所は見つけていないが、全部は読んでいない。
- 実物の Pi では確かめていない。確かめたのは、偽の Pi (`../../tests/extension-host.ts`) と偽の script でのテストと、agmsg の script を使い捨ての場所に写したもの (team も db もその中) に対する claim・held・未読の検出まで。status の見え方、monitor がターンを起こすところ、reload / new / resume / fork の実際の順序は見ていない。型検査もしていない (このリポジトリに tsc が無い)。

## テスト

```sh
node dot_pi/agent/tests/run.mjs
```

`tests/agmsg.test.ts` は、使い捨てのディレクトリに置いた偽の script (呼ばれた引数・環境変数・pid を log に書く小さな shell script) で確かめる。本物の `~/.agents/skills/agmsg` には触らない。
script の置き場と待ち時間は `index.ts` の `limits` を書き換えて差し替える (環境変数の口は無い)。
