/*
 * roll-start — custom-roll 注入 (claude / codex の SessionStart hook 移植)。
 *
 * 対応関係:
 *   claude  dot_claude/scripts/custom-roll.sh + settings.json SessionStart hook
 *           (zsh の claude 関数は --append-system-prompt で注入、hook はフォールバック)
 *   codex   dot_codex/scripts/custom-roll.sh + dot_codex/hooks/session_start.sh
 *   opencode (本プラグイン): SessionStart に相当するフックが存在しない。opencode は
 *           モデル要求ごとに system を組み立て直すため、context hook に注入するのが
 *           同等の効果を持ち、compact で注入が薄れない (claude の zsh ラッパー導入の
 *           理由と同じ絵を、opencode では hook の形で達成できる)。
 *
 * 選び方 (claude と codex の合成):
 *   - claude 版は起動のたび /dev/urandom で無作為抽出。codex 版は日付シードで
 *     「その日のうちは1件」(resume 後の compact でも混ざらない、#13)。
 *   - opencode はランダム抽出を「セッション単位」で固定する: sha256(sessionID) を
 *     シードにする。起動のたびに変わる (claude と同じ) / 同じセッション内では変わらない
 *     (codex と同じ) を両方満たす。セッション ID は resume で引き継がれるため、
 *     resume + compact でも混ざらない。
 *
 * ここは Claude の設計則を引き継ぐ: 何があっても fail-open (セッションを壊さない)。
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export default {
  id: "roll-start",
  async setup(ctx: any) {
    const dir = path.join(os.homedir(), ".config/opencode/custom-roll")

    const listRolls = (): string[] => {
      try {
        if (!fs.existsSync(dir)) return []
        // custom-roll は ~/.agents/custom-roll への symlink。readdirSync は経由起点を
        // たどる (find -H 相当)。-type f 相当の通常ファイルだけを見る。
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isFile() && d.name.endsWith(".md"))
          .map((d) => d.name)
          .sort()
      } catch {
        return []
      }
    }

    await ctx.session.hook("context", (event: any) => {
      try {
        const rolls = listRolls()
        if (rolls.length === 0) return
        // 下位ビット偏りの話は codex 版 custom-roll.sh のコメントと同じ類。
        // セッション ID の sha256 は雪崩効果があるので、先頭8hexで十分 (codex 版の実測準拠)。
        const seed = crypto.createHash("sha256").update(event?.sessionID ?? "").digest("hex")
        const index = parseInt(seed.slice(0, 8), 16) % rolls.length
        const file = path.join(dir, rolls[index])
        const roll = fs.readFileSync(file, "utf8").trim()
        if (!roll) return
        event.system.push({ type: "text", text: roll })
      } catch {
        // fail-open
      }
    })
  },
}
