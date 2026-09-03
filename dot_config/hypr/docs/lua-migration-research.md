# Hyprland Lua 設定移行 — Research レポート (2026-08-12)

## 結論

| 対象 | 判断 | 理由 |
|---|---|---|
| hyprland.conf | **Lua へ移行する** | 0.55 から Lua がデフォルト。hyprlang は非推奨で 0.57 前後に廃止見込み |
| hypridle.conf | **移行しない（.conf 維持）** | 公式方針。Lua 対応の計画なし |
| hyprlock.conf | **移行しない（.conf 維持）** | 同上 |
| hyprpaper / hyprsunset | **移行しない（.conf 維持）** | 同上 |

## 1. Lua 設定の公式ステータス

- **Hyprland 0.55 で導入され、デフォルト化**。公式アナウンス: [Lua-ification of Hyprland configs](https://hypr.land/news/26_lua/)。
  [v0.55.0 リリースノート](https://github.com/hyprwm/Hyprland/releases/tag/v0.55.0): "config: use lua by default, generate lua if no config present"
- 安定版・推奨。[wiki の Start ページ](https://wiki.hypr.land/Configuring/Start/): "Since Hyprland 0.55, hyprlang is deprecated in favor of lua"
- **hyprlang（.conf）は 0.55 から「1〜2リリース」でサポート終了予定**。新機能の追加もなし。ローカルの Hyprland は **v0.56.2** → 0.57 でサポートが切られる可能性がある。
- [0.56（2026-07 リリース）](https://github.com/hyprwm/Hyprland/releases/tag/v0.56.0)で Lua API が大幅拡張（events, gestures, layout API, hyprctl Lua REPL）。破壊的変更なし。

## 2. ファイルの優先順位と切替の注意（v0.56.2 ソース確認済み）

- `hyprland.lua` が存在すると `hyprland.conf` の**代わりに**読まれる（マージされない。ソース: `ConfigManager.cpp` — lua パスを先に探索）。
- この判定は**起動時に一度だけ**。`.conf` ⇔ `.lua` の切替には **Hyprland の再起動が必要**（`hyprctl reload` では切り替わらない）。
- フォーマット内のホットリロードは有効（inotify 監視、`require` したファイルも対象）。構文エラーは事前チェックされ、既存バインドは保持される。エラー時＋バインド0件なら緊急バインド（SUPER+Q ターミナル / SUPER+R ランチャー / SUPER+M 終了）が入る。
- `source=` 相当は `require("file")`（`~/.config/hypr/` 基準、glob `require("./rules/*.lua")` も可）。

## 3. 周辺ツールが .conf のままである根拠

公式アナウンス（上記 news 記事）より: 周辺ツール（hypridle, hyprlock, hyprpaper 等）は意図的に hyprlang を維持 —
「これらのツールの多くはシンプルであり、単純な構文で十分機能する。Turing 完全なスクリプト言語を必要としない」。
各リポジトリ（hyprwm/hypridle, hyprwm/hyprlock, hyprwm/hyprpaper）にも Lua 対応の計画・PR なし。
ローカル版（hypridle 0.1.8 / hyprlock 0.9.6 / hyprpaper 0.8.4）はすべて .conf のみ対応。

→ **`hypridle.conf` / `hyprlock.conf` はそのまま維持するのが正解。** 変換ツールも不要。

## 4. 移行の注意点

- 公式コンバータは存在せず、今後も提供されない方針（[discussion #14463](https://github.com/hyprwm/Hyprland/discussions/14463) で vaxerski が却下）。コミュニティ製: [hyprlang2lua](https://github.com/EIonTusk/hyprlang2lua) 等（本移行は stubs + ソース照合による手書き）。
- `$変数` は廃止 → Lua の `local` 変数で代替。
- `exec-once` → `hl.on("hyprland.start", ...)`。トップレベルの `hl.exec_cmd` は毎リロード実行（旧 `exec` 相当）。リロード時は Lua state が全再構築されるため、トップレベルの副作用は毎回走る。
- permission 設定はホットリロード不可（再起動必要）。
- プラグイン設定（`plugin:*`）は各プラグインの Lua 対応に依存。
- 型補完: `/usr/share/hypr/stubs/hl.meta.lua` を lua-language-server に読ませると補完が効く。

## 5. HyprSettings への影響

ローカルの `hyprsettings.toml` は [acropolis914/hyprsettings](https://github.com/acropolis914/hyprsettings)（GUI 設定ツール、v0.9.0.r34）のもの。
**HyprSettings は `hyprland.conf` のみ読み書きし、Lua 非対応**（README に言及なし）。

⚠️ **移行後、HyprSettings で `.conf` を編集しても Hyprland には一切反映されない**（`.lua` が優先されるため）。設定変更は `hyprland.lua` を直接編集すること。

## 6. 検証で確定した API 事実（v0.56.2 ソース照合）

- windowrule の `float = false` は**強制タイル**（`WindowRuleApplicator.cpp`: `EFFECT_FLOAT: floating = value` / `EFFECT_TILE: floating = !value`。legacy `float off` と同一の効果）。
- `hl.dsp.window.fullscreen()`（引数なし）= toggle + mode fullscreen（旧 `fullscreen` dispatcher と同義）。
- `bindel` = `{ locked = true, repeating = true }` / `bindl` = `{ locked = true }` / `bindm` = `mouse:NNN` キー。
- `hl.workspace_rule` の `workspace` は文字列必須。
- `hl.exec_cmd` はシェル経由実行（`${VAR:-default}` 展開・パイプ・`&&` 有効）。
