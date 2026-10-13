# guard

Pi のツール呼び出しを規則表で止め、bash と edit / write を OS の sandbox (Linux は bubblewrap、macOS は sandbox-exec) に入れる拡張。
待たずに走らせる bash (`monitor` / `jobs`) は [monitor/README.md](monitor/README.md) にまとめてある。

| ファイル | 中身 |
| --- | --- |
| `index.ts` | 判定の枠。`tool_call` の遮断と確認、`/permissions`、bash・edit・write の差し替え |
| `rules.ts` | 規則表。何を止めるか (force push、`rm`、`sudo` など) |
| `sandbox.ts` | sandbox の部品。書ける場所、読ませない場所、書かせない git の場所、launcher の引数、sandbox の中でのファイル I/O |
| `permissions.ts` | モードの型と、ツールを読み取り専用とみなす判定、子の Pi に渡す状態 |
| `ask.ts` | UI を持たない子の Pi の確認を、親の UI に回す受け渡し |
| `worktree.ts` | subagent のタスクごとの git worktree (作る、子の cwd に渡す、差分を親に返す) |
| `monitor/` | バックグラウンド job |

## 使い方

`/permissions [full|normal|ask|readonly]` でモードを変える。引数なしで現在の状態を出す。
モードはセッションと枝ごとに保存され、subagent の子の Pi は親のモードと root を環境変数 `PI_GUARD` で継ぐ (子からは変えられない)。

| モード | bash / monitor | edit / write | そのほかのツール |
| --- | --- | --- | --- |
| `full` | sandbox なし | 確認なし | 確認なし |
| `normal` (既定) | sandbox の中 | 読み書きは sandbox の中。書ける場所の外と、書かせない git の場所は確認 | 確認なし |
| `ask` | sandbox の中。起動のたびに確認 | 読み書きは sandbox の中。毎回確認 | 読み取り専用でなければ確認 |
| `readonly` | 読み取り専用の sandbox の中 (専用の `TMPDIR` だけ書ける) | 遮断 | 読み取り専用でなければ遮断 |

規則表 (`rules.ts`) は full を含むどのモードでも効く。
現在のモードは footer の status に `guard: normal` の形で出し続ける。full だけ `guard: FULL (no sandbox)` と書く。色は付けていない。

### 書ける場所 (normal / ask)

- セッションの root (Pi を起動したディレクトリ)。ホームディレクトリを含む root と、読ませない場所と重なる root は外す。そのとき `/permissions` は `Write root: none (...)` と理由を出す。
- `os.tmpdir()`、`/tmp`、`/var/tmp`。
- git の common dir (root が linked worktree やリポジトリのサブディレクトリのとき)。
- 道具が黙って書く先の表 (`sandbox.ts` の `EXTRA_WRITE_PATHS`)。実在するものだけ。
- 人が `guard.json` の `allowWrite` で足した場所 (下の「人が足す場所」)。実在するものだけ。

| 道具 | 開けている場所 | 開けていない場所と、止まったままの作業 |
| --- | --- | --- |
| XDG / npm / macOS のキャッシュ | `~/.cache`、`~/.npm`、`~/Library/Caches` | |
| cargo | `~/.cargo/registry`、`~/.cargo/git` | `~/.cargo/bin` と `~/.cargo/config.toml`。`cargo install` は止まる |
| uv / pipx / mise | `~/.local/share/uv`、`~/.local/share/pipx`、`~/.local/share/mise` | `~/.local/share` のほかの場所 |
| Go | `~/go/pkg/mod` | `~/go/bin`。`GOMODCACHE` / `GOPATH` を変えたホスト。`~/go/pkg/sumdb` (下の注) |
| bun | `~/.bun/install/cache` | `~/.bun/bin`。`bun add -g` は止まる |
| gh | `~/.config/gh` | |
| chezmoi | `~/.config/chezmoi/chezmoistate.boltdb` | `~/.config/chezmoi/chezmoi.toml` |

issue #40 が挙げた名前より狭くしたのは cargo・bun・chezmoi の 3 つ。どれも、開けると「次に sandbox の外で実行されるもの」まで書けるようになるため。
chezmoi は特に、guard 自身が edit / write のたびに sandbox の外で `chezmoi managed` を呼ぶので、`chezmoi.toml` に hook を書かれるとその場で外に出られる。
Arch で確かめたこと: `~/.config/chezmoi` が読み取り専用でも `chezmoi managed` / `status` / `source-path` は通る。`~/.cargo` が `registry` と `git` だけ書ける状態で `cargo build` は通る。
bun・pipx・mise はこのホストに無く、uv は `~/.local/share/uv` が無いので、その行は動かして確かめていない。
Go は issue が挙げた `~/go/pkg/mod` だけを開けた。checksum の置き場 `~/go/pkg/sumdb` は開けていないので、それがまだ無いホストでは、`go.sum` に無い module の取得が、ダウンロードの後の検証で `open .../go/pkg/sumdb/sum.golang.org/latest: no such file or directory` と出て失敗する (レビューでの実測)。`sumdb` が既にあれば読み取り専用でも通った。`latest` の書き直しが要る場合にどうなるかは確かめていない。開けるかどうかは未決 (issue に無い名前なので足していない)。

**人が足す場所 (`guard.json` の `allowWrite`)。** Claude Code の `sandbox.filesystem.allowWrite` に当たるもの。

- 置き場は agent dir の `guard.json` (`getAgentDir()`、既定は `~/.pi/agent/guard.json`)。中身は `{ "allowWrite": ["~/some/dir", "/abs/path"] }` だけで、ほかのキーは読まない。
- `~` と `~/...` はホームディレクトリに展開する。相対パスと文字列でない要素は黙って飛ばす。
- bash と edit / write の呼び出しのたびに読む。書き換えたら次の呼び出しから効き、Pi を起動し直さなくてよい。
- 読めない、JSON でない、形が違うファイルは、何も足さないものとして扱う (エラーにしない)。
- 足した場所も表と同じ手順を通る。無い場所と、読ませない場所に重なる場所は落とす。
- 足さないもの。`/permissions` に `guard.json allowWrite rejected: ...` と理由つきで出す。
  - ホームディレクトリを含む場所 (`~`、`/`)。root のときと同じ理由。
  - agent dir と重なる場所 (agent dir 自身、その親、その中)。agent dir には `guard.json` 自身と `extensions/` と `auth.json` があり、書けると sandbox の中から書ける場所を自分で広げられる。
  - 子の確認の置き場 (`~/.local/state/pi-guard`) と重なる場所。書けると、モデルが bash で `.answer` を置いて自分で承認できる (下の「subagent の子の Pi」)。
- readonly では足さない。
- `guard.json` が sandbox の中から書ける場所にあるとき (agent dir やその親で Pi を起動した) は、ファイルごと読まない。`/permissions` に `guard.json ignored: ...` と出す。書けるかは、足す前の書ける場所で見る。
- project の中のファイルは読まない。root の中は sandbox の中から書けるので、モデルが自分で書ける場所を足せる。`shellPath` を外側のシェルに使わないのと同じ理由。
- **足した場所には、git の hooks と config を書かせない決まり (`gitLocks`) が掛からない。** 塞ぐのは root と、その git の common dir の分だけ。git の checkout を足すと、その `.git/hooks` と `.git/config` は sandbox の中から書け、次にホスト側でそのリポジトリの git を打ったときに外で実行される。
- 止めるのは上の 3 つだけ。シェルの rc のあるディレクトリ、`~/.config/chezmoi` などを足せば、そのまま開く。足した場所にある PATH の要素は、sandbox の外で起こす道具 (下の「そのほかの決めごと」) を探すときに飛ばす。
- full では `guard.json` を守るものが無い。full のモデルが書き足した場所は、normal に戻した後の呼び出しから開く。

### 書かせない git の場所 (normal / ask)

書ける場所の中にあっても、sandbox の中の bash と edit / write には次を書かせない (edit / write は確認)。

- `<git common dir>/hooks` と `<git common dir>/config`
- root の下にある `.git` ディレクトリの `hooks` と `config`。root 自身のものと、root から 3 段下までのディレクトリのもの (`app/.git`、`org/team/lib/.git`)。リポジトリをいくつか収めた親ディレクトリで Pi を起動した場合と、リポジトリでない root で起動した後に `git init` した場合の分
- `<git common dir>/commondir` (macOS だけ。Linux は下の「できないこと」)
- root の `.git` がファイルのとき (linked worktree)、そのファイル
- submodule の git dir (`<git common dir>/modules/<名前>`。入れ子も含む) の `hooks` と `config`

hook や config (`core.hooksPath`、`core.fsmonitor`、alias) を仕込まれると、次にホスト側で git を打ったとき sandbox の外で実行されるため。submodule の分は、ホスト側の `git status` が submodule の中でも git を起こすため。
`.git` ごと rename して作り直す道も塞いでいる (Linux は mount point にする、macOS は unlink を拒否する)。書ける場所から書かせない場所までの間のディレクトリ (`.git/modules`、`.git/modules/<名前>`) も同じ扱いで、動かせない。
root の下で見つけたリポジトリも同じで、sandbox の中からは `app/.git` も、それを収めたディレクトリ `app` も動かせない (`mv app app2` は失敗する)。
**消すこともできない。モデルが自分で作ったリポジトリも、次の呼び出しからは同じ扱いになる。** `git clone` や `git init` で作ったディレクトリを後の呼び出しで `rm -rf` すると、終了コード 1 で `cannot remove '.../.git/config': Device or resource busy` と出て、`.git/config` と `.git/hooks` だけの殻が残る。同じ名前への clone し直しも `already exists and is not an empty directory` で失敗する (Arch で確かめた)。中に `.git` を持つディレクトリの `rm -rf` (CMake の FetchContent が置く `build/_deps/<名前>-src`、vendor の checkout) と `git clean -ffdx` も同じ。作った呼び出しの中でなら消せる。残った殻は `!` か full で消す。
bubblewrap は mount point にしたものを消せなくするので、「塞ぐ」と「消せる」は両立しない。root の下を探して塞ぐのは issue #40 の項目 (`.git/hooks`・`.git/config`) に足した分で、やめれば BASE と同じく root の中は自由に消せるが、リポジトリをいくつか収めた親ディレクトリで Pi を起動したときに、その中の hooks と config を守るものが無くなる。どちらを取るかは未決。
`hooks` や `config` が symlink のとき (共有の hooks ディレクトリへ向けている) は、リンク先も書かせない場所に数える。sandbox はリンク先を読み取り専用に重ね、edit / write はリンク越しでもリンク先を直に指しても確認になる。
`modules` ごとは塞いでいない。submodule の中の commit・fetch・checkout が index と objects を書くため。submodule の git dir は呼び出しのたびに探し直し、一度見つけたものは Pi のプロセスが生きている間ずっと塞ぐ (目印の `HEAD` を消して外す道を塞ぐ)。

この代わりに、sandbox の中では config を書く git の操作が通らない。通らなさ方が 2 通りあり、後のほうはモデルが成功と読み違える。

- 失敗で終わるもの: `git config`、`git remote add` (終了コード 128)、`git sparse-checkout init` (1)、`git submodule init`、`git submodule update` (128。取得済みの submodule でも、毎回 git dir の config に `core.worktree` を書き直すため)。submodule の中での commit・fetch・checkout は通る。
- **成功の文面と終了コード 0 で終わり、設定だけが落ちるもの**: `git branch -u`、`git push -u`、`git checkout -b <名前> origin/<枝>`、remote 追跡の枝を自動で作る `git switch <枝>`、`git submodule add`。stderr に `error: could not write config file .git/config: Device or resource busy` が出るが、続けて `branch '<名前>' set up to track ...` と表示される。追跡は設定されておらず、後の `git pull` が `There is no tracking information for the current branch` で失敗する。

どちらも `!` で自分で打つか、full で行う。
hooks ディレクトリが無いリポジトリでは、Linux の sandbox が mount 先として空の `hooks` を作る (git は空の hooks を hook 無しとして扱う)。
`hooks` が切れた symlink (共有の hooks へ向けていて、その先が消えた) のときは、何も重ねずに飛ばす。重ねようとすると bubblewrap が起動に失敗し、どのコマンドも走らなくなるため。その `hooks` は塞がれていない。

root の下の `.git` は、bash と edit / write のたびに探し直す (`git` は呼ばず、ディレクトリを読むだけ)。3 段という深さは、毎回歩く費用との引き換えで決めた: 2 万ディレクトリの木を全部歩くと 1 回 140 ms、3 段までなら同じ木で 4 ms (Arch で実測)。捨てた案は、全部歩く (遅い)、見つけた結果を覚えて探し直さない (後から出来たリポジトリを拾えない)、`git` に訊き直す (下の「そのほかの決めごと」の理由で訊かない)。

### 読ませない場所 (full 以外)

`~/.ssh`、`~/.env`、`~/.zshenv`、`~/.aws`、`~/.netrc`、`~/.git-credentials`、`~/.pypirc`。

- sandbox の中の bash からは読めない (Linux では空に見え、macOS では失敗する)。
- read / grep / find / ls / edit がこれらを指したら確認する。
- grep / find が、これらを中に含むディレクトリ (`~`、`/` など) を探そうとしたら確認する。rg / fd は隠しファイルまで降りて読むため。ホームディレクトリで Pi を起動していると、path を省いた検索のたびに確認が出る。
- `~/.git-credentials` を塞いだので、`credential.helper=store` に頼った https の push / fetch は sandbox の中では認証できない。gh の credential helper を使うか、`!` で打つ。

### edit / write (full 以外)

edit と write も同名で差し替え、ファイルの読み書きを bash と同じ sandbox の中で行う (`sandbox.ts` の `fileOperations`。Pi が用意している `createWriteToolDefinition(cwd, { operations })` の口を使う)。
Pi の既定は Pi のプロセス内 (Node の fs) で動き、sandbox の外にある。`tool_call` でのパス判定が決めるのは呼び出しを通すかどうかだけで、通した後の読み書きは止められない。判定と実際に開くパスがずれたとき (判定の後で置かれた symlink、Pi のパス解決の変更) に止めるものが無かった。

- 書ける場所、書かせない git の場所、読ませない場所は bash と同じ表。edit が読む分も sandbox の中なので、読ませない場所の中身が diff で返ることも無い。読ませない場所は書ける場所から必ず外れるので、実際には edit は読む前の確かめで止まる (中は無いように見え、`Error code: ENOENT` になる)。読む段そのものが中身を返さないことは、同じ I/O を直に呼ぶテストで確かめている。
- 確認 (`outside-write-roots`、`git-locked`、`read-denied`、`chezmoi-target`) で人が承認した呼び出しは、sandbox を通さずに Pi のプロセス内で行う。承認されるのは sandbox が止める先なので、中で行うと承認が嘘になる。承認は「その呼び出しの id」と「判定したパス」の両方に結び、1 回で消す。sandbox を通さないのは人が承認したときだけで、モデルの側からは選べない。
- sandbox が使えないホストでは、bash と同じく full 以外の edit / write を遮断する。sandbox 無しのまま Pi のプロセス内の fs で書くことは無い。
- 1 回の write は sandbox を 2 回 (`mkdir -p` と書き込み)、edit は 3 回 (確かめる・読む・書く) 起こす。
- 中で使う道具は `/bin/bash`・`/bin/cat`・`/bin/mkdir` の絶対パスで、環境変数は渡さない。
- 捨てた案: パス判定を厳しくする (symlink を解決してから比べるのは今もしていて、ずれるのは判定と書き込みの間)、書く直前に `realpath` で確かめ直す (確かめてから開くまでの間が残る)、承認された呼び出しのためにそのパスだけ書ける sandbox を組む (bubblewrap は無いファイルを「作れる」ようにできず、親ディレクトリごと開けることになる)。

### subagent の子の Pi

subagent ツール (`extensions/subagent/` が読み込む Pi 同梱の公式 sample) は、子の Pi を `--mode json -p` で起こす。子は環境変数 `PI_GUARD` で親のモード・root・git の common dir を継ぎ、自分の bash・edit・write を同じ表の sandbox に入れる。

**guard が効いていない子の検知。** 継いだ子の guard は、セッションの始めに自分の stderr へ `guard[subagent]: loaded with the parent session's permissions.` と 1 行書く。公式 sample は子の stderr を結果の `details.results[].stderr` に集めるので、親の guard が `tool_result` でそれを探す。セッションを始めた (messages がある) のにこの行が無い子がいたら、結果の末尾に `guard[subagent]: The subagent(s) <名前> ran without guard ...` を足し、UI にも warning で出す。拡張の読み込みに失敗した子、別の agent dir を見ている子、`PI_GUARD` を継がなかった子 (環境変数を作り直す spawner) がこれに当たる。

- 分かるのは子が終わった後で、止めはしない。子を起こすのは別の拡張で、起動を待って確かめる口が無い。
- 中断 (Esc) で止めた subagent も見る。公式 sample は中断を例外で終え、Pi はその結果の `details` を空にするので、途中経過 (`tool_execution_update`) に載っていた `details.results` を覚えておいて使う。途中経過が 1 度も届かないうちに止めた子 (まだ何も実行していない) は数えない。
- 知らせの 1 行は、失敗した子の説明からは除く。公式 sample は失敗した子の説明に `errorMessage`、無ければ stderr、それも無ければ子の最後の出力を使うので、そのままだと最後の出力の代わりにこの行が親のモデルに届く。親の guard が結果の文面の中の stderr を、行を除いたもの (空になれば子の最後の出力、それも無ければ `(no output)`) に置き換える。sample が stderr をそのまま説明に入れている間だけ効く。`details.results[].stderr` にはこの行が残る。
- 子のモデルが出したものは道具の結果に入り、Pi のプロセスの stderr には出ないので、モデルがこの行を偽ることは想定していない。子の中の拡張なら書ける。
- 捨てた案: 置き場のファイルで知らせる (どの子が知らせたかを結果と対応づけられない。公式 sample は子の pid を返さない)、起動から一定時間で知らせが無ければ殺す (子を殺す口が無く、遅いホストで誤って殺す)。
- 実物の Pi 1.1.0 と公式 sample を、使い捨ての agent dir と偽の LLM サーバーで動かして確かめた (Arch)。guard を読み込んだ子では警告が出ず、guard の無い agent dir を見せた子では警告が出た。この確認はテストには入れていない (Pi を 2 つ起こすので遅い)。

**子の確認を親の UI に回す。** 子には UI が無いので、以前は confirm の規則 (`git push`、`rm`、書ける場所の外への write、ask モードの毎回の確認) がすべて遮断だった。いまは親が UI を持っていれば、親のダイアログに `[subagent] guard: <規則>` の題で出し、答えを子に返す。

- 受け渡しはファイル。親が `~/.local/state/pi-guard/ask-<親の pid>/` を作って `PI_GUARD` で渡し、子が `<子の pid>-<乱数>.request` を、親が `.answer` を置く。両方とも 0.2 秒ごとに見に行く。公式 sample は子を stdin 無しで起こし、stdout / stderr は終わってからしか親の拡張に届かないので、ほかに口が無い。
- 置き場は sandbox の中から書けない場所にしてある。書けると、モデルが bash で `.answer` を置いて自分で承認できる。一時ディレクトリは書ける場所なので使っていない。root が置き場を含む (`~/.local` で Pi を起動した) ときは受け付けない。
- 子は時間では待つのをやめない (人が席を外しているだけかもしれない)。やめるのは、親のプロセスが居なくなったときと、依頼が答えの無いまま消えたとき (親がセッションを終えて置き場を消した、`/reload` で置き場を作り直した)。そのときは「誰にも訊けなかった」として遮断する。親が `/reload` すると、出ていたダイアログの依頼は捨てられる。
- 親が UI を持たない (`-p` で動いている) ときは受け付けず、子は以前どおり遮断する。孫も同じ置き場で、いちばん上の親に訊く。
- ダイアログは 1 つずつ出す。訊いた子がもう居ない依頼は出さずに捨てる。出している間に子が居なくなったら (親で subagent を Esc で止めると、子は依頼を消さずに終わる)、ダイアログを閉じ、答えも置かない。閉じるのは `ctx.ui.confirm` に渡した `signal` で、子が居るかは 0.2 秒ごとに見る。
- 置き場はセッションの終わりに消す。Pi がクラッシュすると残るので、次に起動した Pi が、持ち主の pid がもう居ない `ask-<pid>` を消す (下の readonly の一時ディレクトリと同じ選び方で、同じ注意が当てはまる。親から継いだ Pi は掃除しない)。
- 子で承認された edit / write は、子の Pi のプロセス内で行う (上の「edit / write」と同じ)。
- 捨てた案: unix socket (macOS の一時ディレクトリの下ではパスが長すぎてテストが動かない恐れがあり、手元で確かめられない)、`fs.watch` (取りこぼすと子が待ち続ける)、置き場を一時ディレクトリに作って sandbox で読み取り専用に重ねる (重ね忘れた経路がそのまま自己承認の穴になる)。

### subagent の worktree

subagent ツールに `worktree: true` を付けると、タスクごとに git worktree を作り、子の Pi をその中で起こす。複数の子が並んでファイルを書くときに、同じ作業ツリーでぶつからないようにするためのもの。引数を足しているのは `extensions/subagent/` で、中身はここ (`worktree.ts`) にある。

| 呼び方 | worktree |
| --- | --- |
| 単発 (`agent` + `task`) | 1 つ |
| 並列 (`tasks`) | タスクごとに 1 つ |
| chain | 全段で 1 つ (後ろの段は前の段の続きをする) |

- **置き場は root の下の `.pi-worktrees/<8 桁の id>`、枝は `pi-subagent/<id>`、元は作ったときの HEAD。** 元の作業ツリーの未 commit の変更は入らない。子の cwd は、worktree の中の、root がリポジトリの中で占めていたのと同じ位置。置き場には `*` だけの `.gitignore` を置くので、元の作業ツリーの `git status` には出ない。
- **作るのは、規則表・モード・確認が通した後。** ask で断られた呼び出しのためには作らない。`cwd` と一緒には使えない (どちらが cwd を決めるのか分からなくなる)。単発・並列・chain のちょうど 1 つになっていない呼び出しにも作らない (公式 sample が子を起こさずに返す形で、作ると worktree だけが残る)。リポジトリでない root や、commit の無いリポジトリでは作れず、子を起こさずに理由を返す。
- **子が終わったら、worktree ごとの要約を結果の末尾に足す。** 未 commit の変更 (`git status --porcelain`)、元からの commit (`git log --oneline`)、元との差分の統計 (`git diff --stat`) を、それぞれ 40 行まで。差分の全文は流さない (worktree に残っていて、親が bash で読める)。公式 sample の `details.results` には触らない。
- **統合も削除もしない。** 結果の末尾に「何も merge していない。統合は人が承認してから。削除は人が頼んだときだけ」と書く。merge・cherry-pick・`git worktree remove` を guard が代わりに打つことは無い。worktree と枝は残り続けるので、要らなくなったら人が `git worktree remove` と `git branch -D` で消す。
- **git は sandbox の中で打つ** (full では sandbox が無いのでそのまま)。`git worktree add` は checkout で、`git status` / `git diff` は子が書いた後の作業ツリーの上で、リポジトリの config・hooks・filter を読む。Pi のプロセスでそれを打つと、モデルの頼んだ git がホストで走ることになる。sandbox の中なので、hooks と config を書けない制限 (上の「書かせない git の場所」) もそのまま掛かる。
  - **worktree を作る git は bash と同じ sandbox (書ける場所つき)、子が終わった後の要約を取る git はどこにも書けない sandbox で打つ。** 子は自分の worktree の中に、その上で走る git が実行する設定を用意できる (worktree の `commondir` を向け直した先の config、index に載せた入れ子のリポジトリの config。どちらも `core.fsmonitor` で実測)。書ける場所つきで要約を取ると、子の用意したスクリプトが親の root と隣の worktree に書く。どこにも書けない sandbox なら、走っても書けない (読むことと通信はできる。子が自分の sandbox の中でできることと同じ)。設定を 1 つずつ無効にする案は捨てた (git がコマンドを起こす設定は数え切れない)。
- **worktree の中で起こされた子は、書ける場所を自分の worktree に絞る。** 子の guard は、起こされた cwd が継いだ root の `.pi-worktrees/<名前>` の中なら、親の root ではなくその worktree を root にする (`/permissions` の `Write root` に出る)。worktree の中の置き場にさらに worktree があれば (worktree に絞られた子が `worktree: true` で起こした孫)、いちばん内側のものに絞るので、孫どうしも分かれる。子の bash・edit・write は、親の作業ツリーにも、隣の worktree にも書けない (親や人が後でその worktree の上で git を打ったときのことは、下の「できないこと」)。git の common dir は親から継いだものをそのまま使うので commit はできる。worktree の `.git` ファイル (git dir の向き先) は、root の `.git` がファイルのときの決まりで書けなくなる。
  - 親の sandbox からも、置き場の下の worktree の `.git` ファイルは書けない (`sandbox.ts` の `gitLocks`)。そのため sandbox の中からは worktree を消すことも動かすこともできない (`rm -rf .pi-worktrees/<id>` は失敗する)。`.git` がファイルのものを root の下から全部探して塞ぐ案は捨てた (submodule の作業ツリーまで動かせなくなる)。
  - 絞る判定は場所だけで、本当に worktree かは確かめない。絞る向きにしか働かないので、誰が作ったディレクトリでも書ける場所は広がらない。
  - 環境変数 `PI_GUARD` は並んで起こされる子に共通なので、子ごとの root をそこには載せられない。だから子が自分の cwd から決める。
  - 絞られた子は、自分の worktree の外を `cwd` にした subagent を起こせない (`guard[worktree]: cwd ... is outside this session's worktree` で遮断)。孫も `PI_GUARD` の root (親の root) を継いで自分の cwd から絞り直すので、外で起こされると親の作業ツリーや隣の worktree に書ける。`cwd` を省いた孫は子の cwd で起き、同じ worktree に絞られる。自分の worktree の中にある worktree を `cwd` にした孫は起こせる (孫はそこに絞られる)。見るのは subagent ツールの引数だけで、公式 sample が `cwd` をそのまま spawn に渡すことに頼っている。子が `PI_GUARD` を絞った root に書き直す案は捨てた (子孫は `PI_GUARD` を書かない、という `/reload` のための決まりを崩す)。
- 捨てた案:
  - root の外 (`~/.local/state` や一時ディレクトリ) に作って、子の書ける場所に足す。書ける場所を広げる向きで、どこまで広げてよいかを決める材料が無い。一時ディレクトリは、sandbox の中のどのコマンドからも書けるので分離にならない。
  - subagent の拡張が Pi のプロセスで git を打つ。上の理由 (ホストで git が走る) で捨てた。
  - `--detach` で作る。枝が無いと、worktree を消した後に子の commit へ辿り着く名前が残らない。
  - 元の作業ツリーの未 commit の変更を worktree に写す。写した時点で、どちらが正か分からない 2 つの作業ツリーができる。

### settings.json の `shellPath` と `shellCommandPrefix`

bash を同名で差し替えているので、Pi が組み込みの bash に渡す設定はそのままでは届かない。guard が呼び出しのたびに読んで足す (monitor も同じ)。

- `shellCommandPrefix` はコマンドの前の行に足す。sandbox の中で実行される。
- `shellPath` は sandbox の中でコマンドを実行するシェルになる。sandbox の外で launcher を起こすシェルは `/bin/bash` のまま変えない。`shellPath` は project の settings.json にも書けるので、外側に使うと sandbox の外で任意のものを実行できてしまう。full では `shellPath` がそのまま実行する。
- どのホストでも未設定なので、実際の設定で動かしたことは無い。Windows (WSL の bash を stdin で起こす経路) は扱っていない。

### ほかの拡張が自分で起こすコマンド

ほかの拡張は、自分で起こすコマンドの準備を guard に頼める。いま頼んでいるのは verify 拡張 (`extensions/verify/`) の検証コマンドだけ。

- 口は Pi のイベントバス。`pi.events.emit("guard:bash", { command, cwd, env, reply })` で頼むと、`reply` に準備済みの `{ command, cwd, env, readonly }` か、断る理由 `{ error }` が渡る。返事は `emit` から戻る前に来る。頼んだ側は、返ってきた `command` を `/bin/bash -c` に、`cwd` と `env` をそのまま渡して起こす。
- `readonly` は、readonly の sandbox で準備したかどうか。そこで落ちたコマンドは、書けずに落ちたのか、コードのせいで落ちたのかを見分けられない。頼んだ側がそれをコードの失敗として扱わないための印で、verify は readonly での失敗をモデルへ差し戻さない。sandbox の部品ではない。
- 準備は bash ツールと同じもの (設定の `shellPath` / `shellCommandPrefix`、モードごとの sandbox、readonly の `TMPDIR`)。full では何も包まずに返す。
- 規則表のうち固定の禁止 (force push) は効き、理由を返す。確認つきの規則と ask の確認は掛けない。何を走らせるかを承認するのは頼んだ拡張の仕事で (verify なら `/verify add` を打った人)、ここで訊くと、人が登録したコマンドを走らせるたびに訊き直すことになる。
- full 以外で sandbox が使えなければ断る。sandbox なしの形は返さない。
- sandbox の部品 (書ける場所、launcher の引数) は渡さない。渡すと、境界を決める場所が guard と頼む側の 2 つになる。monitor を guard の中に置いたのと同じ理由。
- 頼めるのは Pi のプロセスの中の拡張だけで、sandbox の中のコマンドからは届かない。頼まずに起こす拡張は包めない (下の「できないこと」の「MCP と他の拡張のツールは sandbox の外」)。

### ほかの拡張が sandbox の外で起こす道具

sandbox の外で道具を起こす拡張は、その実体を guard に訊ける。いま訊いているのは checkpoint と verify の `git`。

- 口は `pi.events.emit("guard:binary", { name, reply })`。`reply` に絶対パスか、見つからなければ `undefined` が渡る。返事は `emit` から戻る前に来る。
- 探し方は guard 自身の chezmoi と同じ (下の「そのほかの決めごと」)。PATH の相対の要素と、書ける場所の中にあるものを飛ばし、symlink を解いた先を返す。
- 訊かずに名前だけで起こすと PATH を探す。PATH の要素が sandbox の中から書ける場所にあると (root の中の `.venv/bin` を有効にしたシェルから Pi を起動した、mise の shims)、モデルが bash でそこに置いた同じ名前のものが、sandbox の外で走る。checkpoint と verify の `git` がこの形で、次の write / edit か次のターンの始めに、人の操作なしに外で走った (レビューでの実測)。
- 「見つからない」という返事と、返事が無い (guard が居ない) のは別。前者のとき、頼んだ側は名前で起こし直さない (guard が飛ばした候補を拾う)。後者なら sandbox も無いので、名前のまま起こしてよい。
- 訊くことは強制できない。訊かずに名前で起こす拡張と Pi 本体は、下の「できないこと」の「PATH 経由で sandbox の外に出る道」。

### sandbox が起動しなかったとき

probe が通った後でも起動は失敗しうる (user namespace を後から止められた、bind する先が消えた)。
そのときは launcher のエラーの後ろに `guard[sandbox]: The OS sandbox did not start, so nothing was executed ...` を付けて返す。monitor の job ではログの末尾に出る。
edit / write も同じで、失敗の文面 (`Could not edit file: ... Error: <launcher のエラー>` など) の後ろに同じ文が付く。付けないと普通の書き込み失敗に見え、モデルが sandbox の外にある別の道具で書こうとしうる。
見分け方は、sandbox の中の最初のシェルが継いだ fd に書く印。印が無ければ中まで届いていない。何も走らせずに終了コード 0 で終わった launcher も、印が無いので失敗にする。
write は sandbox を 2 回起こすので、`mkdir -p` が済んだ後で書き込みの起動だけが失敗すると、作られたディレクトリは残る (文面の「何も実行されていない」は、失敗したその 1 回のこと)。
終了コードや stderr の文面で見分ける案は捨てた (コマンド自身が同じものを出せる)。失敗した後に probe をやり直す案も捨てた (その間に状態が変わると「何も実行されていない」が嘘になる)。

### そのほかの決めごと

- **git の common dir は、root ごとに Pi のプロセスが生きている間 1 度しか訊かない。** `/reload` をまたいでも最初の答えを使う (答えを `globalThis` に置いている)。訊き直すと、モデルが `.git` を書き換えた後の答えで書ける場所が広がる。固定するのは書ける場所を決める側だけで、書かせない場所は呼ぶたびに探し直す (上の「書かせない git の場所」)。だから、リポジトリでない root で Pi を起動した後に `git init` しても common dir は付かないままだが、その `.git` は root の中なので書け、`hooks` と `config` は次の呼び出しから塞がれる。
- **sandbox の外で起こす道具 (guard の chezmoi と、checkpoint・verify の git) は PATH から探すが、相対の要素と、書ける場所の中にあるものは飛ばし、symlink を解いた先を起こす。** 書ける場所は、full でも normal のもので見る (full に切り替える前に sandbox の中から置かれたものかもしれない)。worktree に絞られた子の Pi でも、自分の worktree ではなく親の root で見る (親のモデルが親の root に置いたものかもしれない)。
  - PATH にあった候補のまま起こす案は捨てた。書ける場所に置いた symlink が書ける場所の外を指していると通り、確かめた後で掛け替えられる。
  - symlink の先の名前が違うもの (mise の shim のように、呼ばれた名前で振る舞いを変えるもの) は飛ばす。先を直に起こすと別のコマンドになる。
  - 決まった絶対パスだけを見る案は捨てた (置き場がホストごとに違い、見つからないと `chezmoi-target` の規則が黙って効かなくなる)。
  - それでも、chezmoi や git を mise で入れているホストでは、置き場 (`~/.local/share/mise`) が書ける場所なので拾われない。chezmoi なら `chezmoi-target` の規則が効かず、git なら checkpoint は基準を取れず、verify はリポジトリの外と同じ扱いになる (書ける場所の外にもう 1 つあれば、そちらを使う)。
- **readonly の一時ディレクトリは `pi-guard-<pid>-XXXXXX`。** Pi の起動時 (`session_start` の `startup`) に、持ち主の pid がもう居ないものを消す。古さで選ぶ案は捨てた (開いたままのセッションのものを消してしまう)。pid の無い古い名前 (`pi-guard-XXXXXX`) には触らないので、この版より前に残ったものは手で消す。親から継いだ Pi は掃除しない。持ち主が居るかどうかは自分の pid namespace で見るので、同じ `/tmp` を共有する別の pid namespace (コンテナなど、`PI_GUARD` を継がない経路) で Pi を起動すると、ホスト側で生きている Pi の一時ディレクトリを消しうる (uid が同じ場合。動かして確かめてはいない)。

## できないこと

- **git 経由で sandbox の外に出る道を全部は塞げない。** 塞いだのは hooks・config・向き先という直接の道だけ。git は、書き換えられる作業ツリーの上で安全に動くようには作られていない。Arch で確かめた抜け道が 3 つ残っている。
  - 作業ツリーの中に入れ子のリポジトリを作り、その config に `core.fsmonitor` を書いて `git add` する (gitlink)。ホスト側の `git status` がその config を読んで実行する。書くのは作業ツリーと index だけなので、sandbox では止められない。
  - Linux で、`.git/commondir` というファイルを新しく作って common dir をよそへ向ける。bubblewrap は無いファイルを「作らせない」ことができない (重ねるには実物の空ファイルが要り、空の `commondir` はホスト側の git を止める)。macOS はパスで拒否している。この道は、人が git を打つのを待たなくても踏める。Pi の中に、人の操作なしに sandbox の外で git を打つ拡張があるため (checkpoint が最初の依頼のたびに基準を取る `git add`。subagent の子の Pi でも走る)。向け直した先の config に書いた hook (`hook.<名前>.event` / `command`) がその `git add` で走り、モデルが bash で仕込んで subagent を呼ぶだけで外に出られた (レビューでの実測)。checkpoint の側で、その git が出す event の hook を止めた (checkpoint の README の「できないこと」)。sandbox の外で git を打つ拡張を足すときは、同じことが要る。
  - submodule のあるリポジトリで、submodule の作業ツリーにある `.git` ファイル (git dir の向き先) を書き換える。塞いだのは既にある git dir の hooks と config だけで、このファイルは書ける。git dir を書ける場所へ写して config に `core.fsmonitor` を足し、`.git` ファイルをそこへ向け直すと、ホスト側の `git status` がその config を読んで実行する。sandbox の中から新しく作った `modules/<名前>` も、作った呼び出しの間は塞がれていない (次の呼び出しから塞ぐ)。
  - リポジトリでない root で起動して `git init` した、または root の下に新しくリポジトリを作った、その同じ呼び出しの中では `hooks` も `config` も書ける (`git init && echo ... > .git/hooks/pre-commit`)。起動した時点で無い `.git` には何も重ねられない。次の呼び出しからは塞ぐ。
  - root から 4 段以上深いところにあるリポジトリと、root の下で見つけたリポジトリの submodule (`app/.git/modules/<名前>`) は塞いでいない。
  - ほかに、`core.hooksPath` が元から作業ツリーの中を指している、husky のように hook が追跡ファイルにある、linked worktree の `<common>/worktrees/<name>/commondir` の書き換え、hooks が symlink のときのリンクの掛け替え、も塞いでいない。
  - sandbox の中で作業させたリポジトリで git を打つ前に、`git status` ではなく差分を読んで確かめる以外の対策は guard には無い。
- **PATH 経由で sandbox の外に出る道を全部は塞げない。** PATH の要素が sandbox の中から書ける場所にあると (root の中の `.venv/bin` や `node_modules/.bin` を PATH に入れたシェルから Pi を起動した、mise の shims)、sandbox の外で道具を名前だけで起こすものが、そこに置かれた同じ名前のものを拾う。塞いだのは guard の chezmoi と、checkpoint・verify の git だけ (上の「そのほかの決めごと」)。残っているもの:
  - Pi 本体の footer (TUI だけ)。HEAD が `ref: refs/heads/.invalid` のとき、枝の名前を PATH の `git` に訊く (`dist/core/footer-data-provider.js` の `resolveBranchWithGitSync` / `resolveBranchWithGitAsync`)。`.git/HEAD` は sandbox の中から書ける。Pi 本体なので拡張からは直せない。コードを読んだだけで、動かして確かめてはいない。
  - guard が git の common dir を訊く `git` (`sandbox.ts` の `gitCommonDir`)。名前で起こすが、root ごとに Pi のプロセスで 1 度、セッションの始めだけ。そのセッションのモデルが置いたものは拾わないが、前のセッションで置かれて残っているものは拾う。sandbox 導入時からの挙動で、変えていない。
  - git が自分で起こすコマンド。checkpoint の git が、利用者の `~/.gitconfig` にある filter (`git-lfs` など) を起こすとき、その名前は git が PATH から探す (実測。checkpoint の README の「できないこと」)。
  - 訊かずに名前で起こす、ほかの拡張と MCP サーバー。
  - 確実なのは、sandbox の中から書ける場所を PATH に入れずに Pi を起動すること。
- **root が chezmoi の source ディレクトリのとき、`chezmoi managed` 経由で sandbox の外に出られる。** guard は edit / write のたびに sandbox の外で `chezmoi managed` を呼び、chezmoi はそのとき source の template を実行する。source に `.chezmoiignore` を `{{ output "touch" "..." }}` の中身で置くと、`chezmoi managed` がそれを実行することをレビューで実測している。この dotfiles リポジトリ (`~/.local/share/chezmoi`) を root にして Pi を使うと、normal の bash が `.chezmoiignore` を書き換えられ、次の edit / write で外で実行される。`chezmoi.toml` を開けなかったのと同じ出口が source 側に残っている。sandbox 導入前からの挙動で、塞ぐには「source が書ける場所の中にあるときは `chezmoi managed` を呼ばない」などの形になるが、そうすると `chezmoi-target` の規則がこのリポジトリで効かなくなる。どちらを取るかは未決。
- **uv / pipx / mise の置き場は、中に実行ファイルが入る。** ここに書けるものは、sandbox の外で次に動く道具を差し替えられる。入れる作業を通すことと両立しないので開けている。`~/.config/gh` も同じで、gh の alias を書ける。
- **`~/.ssh` は丸ごと読めない。** sandbox の中から ssh 経由の git は使えない。秘密鍵だけ塞いで `config` と `known_hosts` を読ませる形にはしていない。読める場所を広げる判断で、ssh-agent 越しに鍵を使えるようにするかどうかと合わせて決める必要がある。
- **環境変数の秘密は sandbox の中の `env` で見える。** 削ると、それを当てにしている道具 (gh の `GH_TOKEN`、各種 API キー) まで動かなくなる。どの名前を秘密とみなすかを決める材料が無い。
- **grep / find の確認は、探す先に読ませない場所が実在するときだけ。** 探す先の中の symlink の先までは見ない (rg / fd も既定では辿らない)。bash の中の `grep -r ~` は sandbox が止める。
- **MCP と他の拡張のツールは sandbox の外。** Pi 1.1.0 が拡張に渡す口は、`tool_call` での遮断と引数の書き換えだけ (`dist/core/extensions/types.d.ts` の `ToolCallEventResult` は `block`・`reason`・`terminate`)。プロセスの起こし方に口を挟めるのは、自分で登録するツールの `spawnHook` / `operations` だけで、ほかの拡張が登録したツールや、セッションの始めから常駐している MCP サーバーのプロセスには届かない。ask / readonly がツールを読み取り専用とみなす根拠は、組み込み reader の出自と `readOnlyHint` の自己申告のままで、実際の副作用は確かめていない。自己申告を信じない (組み込み以外は ask で毎回確認、readonly で遮断) 形にもできるが、読むだけの MCP ツールまで readonly で使えなくなるので入れていない。
- **子の Pi のプロセスそのものは sandbox に入れていない。** sandbox に入るのは、子の guard が包む bash・edit・write だけ。子で guard が読み込まれなければ、子は何の囲いも無く動く (上の検知は終わった後の知らせで、止めはしない。実物の Pi で確かめたとき、guard の無い子は root の外に書け、読ませない場所も読めた)。子の中の MCP とほかの拡張のツールも外のまま。
  - 入れられない理由: 公式 sample は `spawn(process.execPath, [...])` を自分で呼び、env も hook も受け取らない (`examples/extensions/subagent/index.ts` の `runSingleAgent`)。`extensions/subagent/index.ts` はそれを import するだけで、コピーは置かない方針。拡張の API に、ほかの拡張の起こすプロセスを包む口は無い。
  - 試さなかった案: Node の `child_process.spawn` を差し替えて、subagent の実行中に起きた spawn を bubblewrap で包む (技術的にはできそうだが、Pi のプロセス全体の組み込み関数を書き換える。公式 sample が起こし方を変えると、包めていないことに誰も気づかない)、`process.execPath` / `process.argv[1]` を一時的に書き換える (並んで動くほかの処理が巻き込まれる)、sample をコピーして直す (Pi の更新を取り込めなくなる)。
  - 包むと決めた場合に要ること (Arch で確かめた事実): bubblewrap の入れ子は動く (子の guard が子の bash をもう一度包める)。子の Pi は agent dir に書けないと `auth.json` の鍵を使えない (`settings.json` と `auth.json` は、読むだけでも隣に lock のディレクトリを作る。読み取り専用だと `Invalid settings file ...: EROFS ... mkdir '.../settings.json.lock'` の警告の後、`No API key found for the selected model.` で終了コード 1)。だから子には `~/.pi/agent` を書かせた上で、`extensions` や `settings.json` を個別に塞ぐ設計になる。macOS の sandbox-exec は入れ子にできないので、子の guard に「もう囲いの中にいる」と信じさせる別の道が要る。
- **worktree で分かれるのは、追跡ファイルの作業ツリーだけ。** `node_modules`・ビルドの出力・`.env` など追跡していないものは worktree に無い (子が自分で入れ直す)。ポート、環境変数、道具のキャッシュ (`~/.cache` など)、git の common dir (objects・refs・stash・config) は全部の worktree と元の作業ツリーで共有のまま。同じ枝を 2 つの worktree で checkout できない、という git の制限もそのまま。
- **worktree の検証結果は返さない。** 返すのは差分の要約だけ。検証コマンドを走らせる仕組みは別の拡張 (verify) で、ここからは呼んでいない。子の Pi にも verify は読み込まれるので、登録があれば子の中で検証は走る (verify の README の「print / json モードでも走る」) が、その結果を親に返る結果に載せることはしていない。
- **「統合は承認後」は文面だけ。** 結果にそう書いてモデルに伝えるが、親のモデルが自分の bash で `git merge pi-subagent/<id>` を打つのは止めていない (root の中の、普通の git の操作)。ask モードなら bash のたびに確認が出る。
- **子が書いた worktree の上で、親のモデルや人が git を打つと、子の用意した設定が実行されうる。** 子の bash は親の作業ツリーに直接は書けないが、自分の worktree の中に、その上で走る git が実行する設定を用意できる (上の「git は sandbox の中で打つ」の項の 2 つ)。guard 自身が打つ要約の git はどこにも書けない sandbox に入れたが、ほかは入れていない。
  - 親のモデルが bash で `git -C <worktree> diff <元>` や `git -C <worktree> status` を打つと (結果の末尾の文面がそう勧めている)、子の用意したスクリプトが親の sandbox の中で走り、親の root と隣の worktree に書ける。「子は隣の worktree に書けない」が破れる道がここに残っている。
  - 人がホスト側で同じ git を打つと、sandbox の外で走る (上の「git 経由で sandbox の外に出る道」と同じ)。
  - `<common>/worktrees/<id>/commondir` は既にあるファイルなので Linux でも読み取り専用に重ねられ、試すと向け直しは止まった。入れていないのは、止まるのがこの 1 本だけ (入れ子のリポジトリの道は残る) で、代わりに、後の呼び出しでの `git worktree remove` と `git worktree prune` が管理用のディレクトリを消せなくなるため (`error: failed to delete '.git/worktrees/<名前>': Device or resource busy` で、作業ツリーだけ消えて prunable な登録が残る。Arch で実測)。塞ぐなら `sandbox.ts` の `gitLocks` に `<common>/worktrees/*/commondir` を足す。未決。
  - 結果の末尾の文面 (`git -C <worktree> diff <base>` を勧める) は変えていない。文面を変えても、親のモデルが worktree の上で git を打つことは止められない。信用できない入力を読ませる子に `worktree: true` を付けても、親の作業ツリーが守られるとは考えないこと。worktree を作る前から走っている monitor の job は、その `.git` ファイルも書ける (sandbox は起動したときに組まれ、そのとき無かったファイルは塞がれていない)。作った後に起こす bash と job、それに子の側は塞がっている。
- **root がリポジトリの中で占める位置に追跡ファイルが無いと、子を起こせない。** 子の cwd は worktree の中の同じ位置で、追跡ファイルの無いディレクトリは worktree に作られない。公式 sample の spawn が失敗し、worktree は残る。
- **残った worktree は掃除しない。** 後ろの拡張が `tool_call` で遮断した呼び出しや、起動に失敗した子の worktree も残る。並列の途中で `git worktree add` が失敗したときも、先に作った分は残り (sandbox の中からは worktree を消せない)、遮断の理由にその場所を書く。数が増えたら人が消す。
- **worktree つきの subagent は、実物の Pi では動かしていない。** 引数の書き換えが実行に届くこと (`types.d.ts` の `ToolCallEventResult` の注記) と、公式 sample がタスクごとの `cwd` で子を起こすこと (`runSingleAgent`) はコードを読んで合わせ、テストでは `tool_call` と `tool_result` のイベントを流し、worktree の中身と、絞られた子の bash を実物の sandbox で確かめた。
- **`~/.pi/agent/auth.json` は読ませない場所に入れていない。** 入れるかどうかは「囲いの中から起こした Pi が認証できなくなる」こととの引き換え、というのが issue #40 の見立てだった。Arch で確かめた限り、この引き換えは今は成り立っていない: subagent の子は sandbox の外で起こされるので影響を受けず、sandbox の中の bash から起こした `pi` は、`auth.json` が読めても agent dir に lock を作れず、鍵を読めないまま `No API key found for the selected model.` で終わる (鍵を環境変数や `models.json` で渡している場合は動くが、それは `auth.json` を読まない)。つまり塞いでも、いま動いているものは止まらない。それでも入れていないのは、子の Pi を sandbox に入れる (上の項) と決めたときに、子のプロセスには読ませて道具には読ませない、という分け方が要るようになるため。入れるなら `sandbox.ts` の `READ_DENIED_PATHS` に 1 行。
- **ネットワークは絞っていない。** bubblewrap と sandbox-exec を直接呼ぶ方式では、全部許すか全部切るか (`--unshare-net`) しか選べない。全部切ると `npm install` も `git fetch` も通らない。ドメイン単位にするには、sandbox の外に許可表つきのプロキシを立て、ネットワークを切った sandbox の中からそこへ橋を渡す (unix socket と、中で動く中継) ことになる。中継に使う `socat` はこのホストに無く、依存は足さない方針。どのドメインを許すかの表も決まっていない。`HTTP_PROXY` を見ない道具 (ssh 経由の git など) は通らなくなる。
- **Pi の外のプロセスは覆っていない。**
- **full では、子の確認の置き場を守るものが無い。** full には sandbox が無いので、モデルの bash が `.answer` を置けば自分で承認できる。full は規則表 (文字列の一致) しか効いていないモードで、それも bash の書き方しだいで外せる。置き場を知るには `PI_GUARD` を読む必要がある。
- **子の確認のダイアログは、置き場に書けるプロセスなら何でも出せる。** sandbox の外で動く自分のプロセス全部。出せるだけで、答えは置いたプロセスにしか返らない。題に `[subagent]` が付く。
- **中断された subagent の検知と、失敗の説明から知らせの行を除く処理は、実物の Pi では動かしていない。** どちらも公式 sample と Pi のコード (`examples/extensions/subagent/index.ts` の `runSingleAgent` / `getResultOutput`、`pi-agent-core/dist/agent-loop.js` の `executePreparedToolCall`) を読んで合わせ、テスト用の host に同じ形のイベントを流して確かめただけ。sample の stderr が 50 KB を超えて切り詰められた並列の結果では、知らせの行は説明に残る。
- **ユーザーが自分で打つ `!` コマンドは sandbox に入れていない。** 意図したもの。
- **macOS では確かめていない。** この版で足した seatbelt の規則 (git の場所への書き込み拒否と、親の unlink 拒否) は Linux のホストで書いたもので、プロファイルの文面しかテストしていない。起動の印 (fd の受け渡し) も macOS では動かしていない。起動時の probe は書かせない場所の無いプロファイルで試すので、書かせない場所つきのプロファイルだけが `sandbox-exec` に拒否されると、probe は通ったまま git リポジトリでの normal / ask の bash が全部 `guard[sandbox]: The OS sandbox did not start ...` で終わる。macOS のホストに `chezmoi apply` する前に、git リポジトリで 1 度 bash を動かして確かめる必要がある。edit / write の sandbox 越しの読み書きも Linux でしか動かしていない。同じ profile で `/bin/bash`・`/bin/cat`・`/bin/mkdir` を起こすだけだが、macOS で 1 度 write と edit を動かして確かめる必要がある (こちらの起動の印は fd 3 で、`sandbox-exec` が継いだ fd をそのまま渡すことを当てにしている)。
- **実物の TUI での見え方は確かめていない。** status の表示と確認ダイアログは、テスト用の偽の `ctx.ui` に渡った内容で確かめている。子から回ってきた確認は、subagent ツールが走っている最中に、ツールの外 (タイマー) から `ctx.ui.confirm` を呼ぶ。実物の TUI でそのダイアログが出て答えられるかは、人が 1 度触って確かめる必要がある。出なかった場合、子は親が居る限り待ち続けるので、Esc で subagent を止める。子が居なくなったときに `signal` でダイアログが閉じることも、`modes/interactive/interactive-mode.js` の `showExtensionSelector` が `opts.signal` を見ているのを読んだだけで、実物では触っていない。

## テスト

```sh
node dot_pi/agent/tests/run.mjs
```

`guard/tests/` のテストは `os.tmpdir()` の下に `guard-*` を作り、終わったら消す。
時間切れの検証は `pgrep` でホスト全体から自分の `sleep` を数えるので、秒数に自分の pid を入れて、同じテストを並べて走らせている別のプロセスのものを拾わないようにしている。
本物の `/tmp` と `/var/tmp` を書ける場所から外すために、`SHARED_TMP_PATHS` を空にしてから始める (`EXTRA_WRITE_PATHS` の並びには依らない)。
