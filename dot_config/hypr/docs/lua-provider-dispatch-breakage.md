# Lua config provider による `hyprctl dispatch` 破壊 — 調査レポート (2026-08-20)

`lua-migration-research.md` の続編。設定を `hyprland.conf` → `hyprland.lua` へ移行した副作用として、
**Hyprland にディスパッチを送る全てのソフトが同時に壊れた** 件の記録。

## 結論

Hyprland 0.55 以降、`hyprland.lua` が使われていると
（`hyprctl systeminfo` → `configProvider: lua`）、
IPC ソケット `.socket.sock` に送られる `dispatch <引数>` は **Lua 式として評価される**。

wiki `Using-hyprctl`: "Dispatch is a shorthand for `eval 'hl.dispatch(...)'`"

つまりレガシー構文のディスパッチャ呼び出しは全てパースエラーになる。

```
$ hyprctl dispatch exit
error: return hl.dispatch(exit):1: hl.dispatch: expected a dispatcher (e.g. hl.dsp.window.close())
rc=7

$ hyprctl dispatch workspace 1
error: [string "return hl.dispatch(workspace 1)"]:1: ')' expected near '1'
rc=7

$ hyprctl dispatch dpms off
error: [string "return hl.dispatch(dpms off)"]:1: ')' expected near 'off'
rc=7
```

新構文なら通る:

```
$ hyprctl dispatch 'hl.dsp.exit()'
$ hyprctl dispatch 'hl.dsp.focus({ workspace = 1 })'
$ hyprctl dispatch 'hl.dsp.dpms({ action = "enable" })'
ok
```

**互換モードは存在しない。** `ConfigManager.cpp` (v0.56.2) では provider が
設定ファイルの拡張子のみで決まり、env var もフラグも無い。

```cpp
if (filePath.extension() == ".lua") { ... makeUnique<Lua::CConfigManager>(); }
else                                { ... makeUnique<Legacy::CConfigManager>(); }
```

唯一の抜け道は `hyprctl reload full-reset`（provider ごと切り替える）だが、
wiki に "should not be used unless really necessary" とある。

## 影響範囲の見分け方

| 種別 | 例 | 影響 |
|---|---|---|
| **書き込み系**（`dispatch`） | `hyprctl dispatch exit` / Waybar のワークスペースクリック | **壊れる**。Lua 評価を通る |
| 読み取り系 | `hyprctl activewindow -j` / `hyprctl workspaces -j` / socket2 のイベント購読 | 無傷。Lua 評価を通らない |

「表示は正常なのに操作だけ効かない」という症状が出たら、まずこれを疑うこと。

## 構文の対応表

| レガシー | Lua |
|---|---|
| `dispatch exit` | `dispatch 'hl.dsp.exit()'` |
| `dispatch dpms off` | `dispatch 'hl.dsp.dpms({ action = "disable" })'` |
| `dispatch dpms on` | `dispatch 'hl.dsp.dpms({ action = "enable" })'` |
| `dispatch workspace 3` | `dispatch 'hl.dsp.focus({ workspace = 3 })'` |
| `dispatch exec foo` | `dispatch 'hl.dsp.exec_cmd("foo")'` |
| `dispatch killactive` | `dispatch 'hl.dsp.window.close()'` |

利用可能なディスパッチャの一覧は `/usr/share/hypr/stubs/hl.meta.lua` の
`HL.DspNamespace` を参照。

## 実際に壊れていた箇所（2026-08-20 修正）

| 場所 | 内容 | 症状 | 検証 |
|---|---|---|---|
| `waybar/scripts/power_menu.sh` | `hyprctl dispatch exit` → `uwsm stop` | Logout が無反応 | **未検証**（実行＝ログアウトのため） |
| `hypr/hypridle.conf:10,11` | `hyprctl dispatch dpms off/on` | 5分後の画面オフが動作せず | 済（disable/enable 双方 `ok`、3モニタ復帰を確認） |
| `hypr/hypridle.conf:4` | `... && dispatch dpms on && dispatch 'hl.dsp.dpms(...)'` | レガシー側が rc=7 で `&&` が短絡し、正しい Lua 版に到達しない | 済 |
| Waybar `hyprland/workspaces` | 上流バイナリがレガシー構文を送信 | クリックで切り替わらない | 目視確認要 |

**教訓**: `&&` でレガシー版と Lua 版を並べるのは最悪手。レガシー側が rc=7 で落ちるため、
後続の正しい呼び出しが実行されない。中途半端な移行は、どちらか片方だけより悪い。

## Waybar の非互換（上流バグ）

Waybar 0.15.0 のバイナリにはレガシー構文の文字列が埋まっている:

```
$ strings /usr/bin/waybar | grep 'dispatch '
dispatch workspace
dispatch workspace name:
dispatch focusworkspaceoncurrentmonitor
dispatch togglespecialworkspace
```

- 上流 issue: [Alexays/Waybar#5198](https://github.com/Alexays/Waybar/issues/5198)（open）
- 修正 PR: [#5013](https://github.com/Alexays/Waybar/pull/5013)（2026-05-04 マージ済み）
- **0.15.0 (2026-02-06) 以降リリースが無いため、修正は master にしか無い**
  → 対処として `waybar-git` を導入した（導入時点: **0.15.0.r970.g09e69e0-1**）。
    Waybar 0.16 がリリースされたら公式パッケージ (`pacman -S waybar`) に戻せる。
    なお r970 では CSS クラスに `.workspace-hover` と `.ws-<名前>`（ワークスペース名由来）が追加されている。

`hyprland/window` と `hyprland/submap` は read-only のため影響なし。

### 代替案 `ext/workspaces` を採用しなかった理由

`ext-workspace-v1`（Wayland 標準プロトコル）を使うため Hyprland IPC の影響を受けないが、
プロトコルに「フォーカスされている」という状態が存在しない。
Hyprland の `isActive()` は「その WS が自分の所属モニタ上で表示中か」を返すため、
**3モニタ構成では表示中の3つの WS が同時に `.active` になり、現在地を特定できない**。

その他の制約:
- `{id}` は使用不可。Hyprland は ext-workspace の `id` イベントを送らないため、
  Waybar 内部の生成順カウンタが表示される。`{name}` を使うこと。
- CSS クラスは `.active` / `.urgent` / `.hidden` のみ。`.visible` / `.empty` / `.persistent` は無い。
- `hidden` ビットは special（scratchpad）WS にのみ立つ。通常の非表示 WS は state `0`。

## Waybar CSS クラスの注意（lua 移行とは無関係）

`hyprland/workspaces` が付けるクラスは `.active` / `.empty` / `.visible` /
`.persistent` / `.special` / `.urgent` / `.hosting-monitor`。
**`.focused` は sway 用**であり、Hyprland では一度も適用されない。
sway の設定例をコピーすると現在地が強調されない状態になる。

同様に `"disable-scroll"` も sway/wayfire 専用で、`hyprland/workspaces` では読まれない
（0.15.0 にはネイティブのスクロール処理自体が無く、master では opt-in の `enable-bar-scroll` になった）。

## セッション復旧手順（uwsm）

ログアウトは `uwsm stop` を使う。uwsm v0.26.6 `man/uwsm.1.scd` Shutdown 節:

> Do not use compositor's native exit mechanism or kill its process directly.

コンポジタを直接終了させると、`graphical-session-pre.target` 停止時に
env preloader が行う環境変数のクリーンアップがスキップされる。

**ログアウトに失敗してセッションが半端に残った場合:**

1. `Ctrl+Alt+F2` で TTY に切り替え、ログイン
2. 状態確認
   ```
   systemctl --user status wayland-wm@hyprland.desktop.service
   systemctl --user is-active graphical-session.target
   ```
3. セッションを強制的に落とす
   ```
   systemctl --user start wayland-session-shutdown.target
   ```
4. それでも駄目なら
   ```
   loginctl terminate-session $XDG_SESSION_ID
   ```

**waybar を 0.15.0 に戻す場合:**

```
sudo pacman -U /var/cache/pacman/pkg/waybar-0.15.0-2-x86_64.pkg.tar.zst
```

## 既知の未対応事項

`waybar` / `mako` / `hypridle` / `fcitx5` / `steam` が
`session.slice/wayland-wm@hyprland.desktop.service` の cgroup 内で動いている。
`hyprland.lua` の `hl.on("hyprland.start", ...)` から生の `hl.exec_cmd` で起動しているため、
uwsm の `app.slice` に載っていない。

- コンポジタ停止時に cgroup ごと停止されるため、Steam 等が猶予なく終了する
- uwsm を導入した目的（アプリを systemd の管理単位に載せる）がバイパスされている
- `waybar.service` / `mako.service` / `hypridle.service` のユニットが存在するのに全て `disabled`

対処するなら `uwsm app -- <cmd>` 経由の起動か、既存の systemd user unit の有効化。
起動順序・環境変数伝搬・`fcitx5 --replace` の挙動検証が必要なため未着手。
