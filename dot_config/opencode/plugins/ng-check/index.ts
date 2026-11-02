/*
 * ng-check — NG 表現検出 (claude の PostToolUse / Stop hook 移植)。
 *
 * 対応関係:
 *   claude  dot_claude/hooks/ng-check.py (PostToolUse: Write|Edit|MultiEdit の書き込み内容、
 *           Stop: 直近の assistant 応答) + ng-patterns.tsv (chezmoitemplates で共有)
 *   opencode (本プラグイン):
 *           PostToolUse に相当するのは tool.hook("execute.after")。write/edit/patch の
 *           書き込み内容をスキャンし、検出があれば tool 結果に注意書きを足す。
 *           claude と同じで検出は阻止ではない (書き込みは反映済み、モデルに修正を促す)。
 *           Stop に相当する hook がないため、context hook で直近の assistant 本文を
 *           見て、system に同じ注意書きを足す。
 *
 * claude からの意味を保つ点:
 *   - パターンは hooks/ng-patterns.tsv。claude の TSV 形式をそのまま読む。
 *     毎回読み直すので、追記すれば次の発火から有効 (claude と同じ)。
 *   - インライン `...` はマスク (パターン自体の引用を自分で引かないため)。
 *   - スキャン上限 SCAN_CAP、報告上限 MAX_REPORTED、対象拡張子は claude と同じ値。
 *   - fail-open: いかなる例外でもセッションを壊さない。
 *   - 文面 (category 接頭・修正を促す結び) も claude の build_reason と同じ。
 *
 * 見送った移植 (claude にあるが opencode では入れない):
 *   - regex 暴走対策の fork+kill (claude は SIGALRM では re の C ループを止められないため、
 *     子プロセスごと kill している)。node には軽量な fork がなく、worker を立てるほどの
 *     価値がない。代わりに SCAN_CAP (claude と同じ 200000 文字) で入力を切るので、
 *     パターンを追記する側は、線形時間で走る正規表現を保つこと。
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SCAN_CAP = 200_000
const MAX_REPORTED = 20
const TARGET_EXTENSIONS = new Set([".tex", ".md", ".txt"])
const INLINE_CODE = /`[^`\n]*`/g

type Pattern = { raw: string; rx: RegExp; category: string; reason: string }
type Finding = { raw: string; category: string; reason: string; snippet: string; count: number }

export default {
  id: "ng-check",
  async setup(ctx: any) {
    const patternsFile =
      process.env.NG_PATTERNS_FILE || path.join(os.homedir(), ".config/opencode/hooks/ng-patterns.tsv")

    // --- claude の ng-check.py と同じ部品 ---

    const maskCode = (text: string): string =>
      text.replace(INLINE_CODE, (m) => "\x00".repeat(m.length))

    const scan = (text: string, patterns: Pattern[]): Finding[] => {
      const masked = maskCode(text)
      const findings: Finding[] = []
      for (const p of patterns) {
        let count = 0
        let first: RegExpExecArray | null = null
        let m: RegExpExecArray | null
        p.rx.lastIndex = 0
        while ((m = p.rx.exec(masked)) !== null) {
          count++
          if (!first) first = m
          if (count >= 10_000) break // 万一の正規表現暴走でも回数で打ち切る
        }
        if (!first || count === 0) continue
        const start = Math.max(0, first.index - 15)
        const snippet = text.slice(start, first.index + first[0].length + 15).replace(/\n/g, " ")
        findings.push({ raw: p.raw, category: p.category, reason: p.reason, snippet, count })
      }
      return findings
    }

    const buildReason = (findings: Finding[]): string => {
      const lines = ["NG表現を検出しました (ng-check hook):"]
      for (const f of findings.slice(0, MAX_REPORTED)) {
        const times = f.count > 1 ? ` ×${f.count}` : ""
        lines.push(`・[${f.category}]${times} 「…${f.snippet}…」 — ${f.reason}`)
      }
      if (findings.length > MAX_REPORTED) {
        lines.push(`…ほか ${findings.length - MAX_REPORTED} 件`)
      }
      lines.push(
        "該当表現を修正してください。文脈上合法な場合 (固有名詞・コード識別子・" +
          "正当な不確実性表現など) は、その旨を1回明示的に宣言して続行して構いません。",
      )
      return lines.join("\n")
    }

    const loadPatterns = (): Pattern[] => {
      const patterns: Pattern[] = []
      try {
        for (const line of fs.readFileSync(patternsFile, "utf8").split("\n")) {
          if (!line.trim() || line.trimStart().startsWith("#")) continue
          const fields = line.split("\t")
          if (fields.length < 3) continue
          try {
            // g フラグ: exec を繰り回して全マッチ数を数えるため (無いと同じ位置で停止する)
            patterns.push({ raw: fields[0], rx: new RegExp(fields[0], "g"), category: fields[1], reason: fields[2] })
          } catch {
            // 壊れた正規表現は黙って捨てる (claude と同じ)
          }
        }
      } catch {
        // TSV が無くても fail-open
      }
      return patterns
    }

    // --- PostToolUse 相当: write / edit / patch の書き込み内容をスキャン ---
    // claude は file_path の拡張子で .tex/.md/.txt に絞っていた。opencode の3ツール
    // (write/edit/patch) はいずれも対象パスを付けられるので、同じ絞り方を移植する。

    const hasTargetExtension = (p: unknown): boolean => {
      if (typeof p !== "string" || !p) return false
      const name = p.split("/").pop() ?? ""
      const dot = name.lastIndexOf(".")
      if (dot <= 0) return false
      return TARGET_EXTENSIONS.has(name.slice(dot).toLowerCase())
    }

    // patch の対象行だけを抜く (claude の MultiEdit=1 file_path に対応する絞り方)。
    // *** Add File / *** Update File セクションの + 行が対象。Delete は内容を持たない。
    const patchAdditions = (patchText: string): string => {
      const out: string[] = []
      let keep = false
      for (const line of patchText.split("\n")) {
        const header = line.match(/^\*\*\* (?:Add|Update) File: (.+)$/)
        if (header) {
          keep = hasTargetExtension(header[1])
          continue
        }
        if (line.startsWith("*** Delete File:")) {
          keep = false
          continue
        }
        if (keep && line.startsWith("+") && !line.startsWith("+++")) out.push(line)
      }
      return out.join("\n")
    }

    await ctx.tool.hook("execute.after", (event: any) => {
      try {
        if (event?.status !== "completed") return
        const tool = String(event?.tool ?? "")
        const input = event?.input ?? {}
        let text: string | null = null

        if (tool === "write") {
          if (!hasTargetExtension(input?.path)) return
          text = typeof input.content === "string" ? input.content : null
        } else if (tool === "edit") {
          if (!hasTargetExtension(input?.path)) return
          text = typeof input.newString === "string" ? input.newString : null
        } else if (tool === "patch") {
          const patchText = typeof input.patchText === "string" ? input.patchText : ""
          text = patchAdditions(patchText) || null
        } else {
          return
        }
        if (!text) return
        text = text.slice(0, SCAN_CAP)
        const findings = scan(text, loadPatterns())
        if (findings.length === 0) return
        const result = event.result
        if (result && Array.isArray(result.content)) {
          event.result = { ...result, content: [...result.content, { type: "text", text: "\n\n" + buildReason(findings) }] }
        }
      } catch {
        // fail-open
      }
    })

    // --- Stop 相当: 直近の assistant 本文を context hook で見る ---
    // opencode は Turn 終了で hook がない。context hook はトークン要求のたびに走るので、
    // 直近 assistant 本文が NG を見つけるたびに system に足す。同一セッションで同じ
    // findings を繰り返し告知しないため、findings の署名をメモとして session ごとに保持し、
    // 「文脈上合法なら1回宣言して続行」の claude の文面に合う重みにする。

    const reported = new Map<string, string>()

    await ctx.session.hook("context", (event: any) => {
      try {
        const messages = Array.isArray(event?.messages) ? event.messages : []
        let text: string | null = null
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          const role = message?.role ?? message?.info?.role
          if (role !== "assistant") continue
          const content = Array.isArray(message?.content) ? message.content : []
          const texts = content
            .filter((block: any) => typeof block?.text === "string")
            .map((block: any) => block.text)
          if (texts.length > 0) text = texts.join("\n")
          break
        }
        if (!text) {
          reported.delete(String(event?.sessionID ?? ""))
          return
        }
        text = text.slice(0, SCAN_CAP)
        const findings = scan(text, loadPatterns())
        const sessionKey = String(event?.sessionID ?? "")
        if (findings.length === 0) {
          reported.delete(sessionKey)
          return
        }
        // 本文が block 型 text を持ち、直近 assistant が pure text である応答のみを対象にする。
        const key = crypto.createHash("sha256").update(findings.map((f) => `${f.raw}\u0001${f.snippet}`).join("\u0002")).digest("hex")
        if (reported.get(sessionKey) === key) return
        reported.set(sessionKey, key)
        event.system.push({ type: "text", text: buildReason(findings) })
      } catch {
        // fail-open
      }
    })
  },
}
