/*
 * model-prompts — モデル別プロンプト注入 (claude の UserPromptSubmit hook 移植)。
 *
 * 対応関係:
 *   claude  dot_claude/scripts/prompt-by-model.sh + settings.json UserPromptSubmit hook
 *           prompts/by-model/ から default.md → <family>.md → <version>.md を連結注入。
 *           モデル名は settings 側 SessionStart の model-state.sh が書いた
 *           ~/.claude/state/model.d/<session_id> 経由で取得。
 *   opencode (本プラグイン): Claude Code hook の model-state に相当する土管が opencode
 *           にはないが、context hook は event.model を直接渡してくる。state ファイルは
 *           不要で、毎要求の system 組立てに自然な形で接続する。
 *           並びは claude と同じ重ね順 + provider 拡張:
 *             1. default.md            どのモデルにも
 *             2. claude-* モデル: <family>.md → <version>.md  (claude と同じ版・家族の決め方)
 *                claude-opus-5-5[1m] → default + opus + opus-5-5
 *                (opus-5.md は照合しない。claude hook もしない)
 *             3. <providerID>.md       claude 以外の provider 家族 (opencode 由来の拡張点)
 *
 * fail-open: 何があってもセッションを壊さない。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export default {
  id: "model-prompts",
  async setup(ctx: any) {
    const dir = path.join(os.homedir(), ".config/opencode/prompts/by-model")

    const firstExisting = (names: string[]): string => {
      for (const name of names) {
        try {
          const file = path.join(dir, name)
          if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            const text = fs.readFileSync(file, "utf8").trim()
            if (text) return text
          }
        } catch {
          // fail-open: 読み失敗はその段だけ消える
        }
      }
      return ""
    }

    await ctx.session.hook("context", (event: any) => {
      try {
        const modelID = String(event?.model?.id ?? "")
        const providerID = String(event?.model?.providerID ?? "")
        const parts: string[] = []

        const def = firstExisting(["default.md"])
        if (def) parts.push(def)

        // claude 版と同じ解釈: 家族・版の抽出は claude- 接頭付きモデルにだけ行う
        // (claude hook の case パターンと一致)。それ以外のモデルは default のみ + 次の provider。
        if (/^claude./.test(modelID)) {
          const variant = modelID.split("[")[0]
          const version = variant.slice("claude-".length)
          const family = version.split("-")[0]
          if (family) parts.push(firstExisting([`${family}.md`]))
          if (version !== family) parts.push(firstExisting([`${version}.md`]))
        }
        // opencode 拡張: provider 家族ごとのチューニング (ファイルがあれば)
        if (providerID) parts.push(firstExisting([`${providerID}.md`]))

        const text = parts.filter(Boolean).join("\n")
        if (text) event.system.push({ type: "text", text })
      } catch {
        // fail-open
      }
    })
  },
}
