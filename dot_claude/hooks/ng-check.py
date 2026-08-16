#!/usr/bin/env python3
"""NG 表現検出 hook (Stop / PostToolUse 共用)。

過去にレビューで却下された表現 (ng-patterns.tsv) が assistant の応答や
Write/Edit/MultiEdit の書き込み内容に再出現したとき、
{"decision": "block", "reason": ...} で Claude に知らせて修正を促す。

設計上の不変条件:
  - グローバル設置 (~/.claude/settings.json、全プロジェクトで発火) のため、
    いかなる異常系でも exit 0 + 無出力で抜ける (fail-open)。hook の不具合が
    セッションを止めることがあってはならない。
  - Python シグナルは C レベルの re マッチ中に配送されないため、
    catastrophic backtracking 対策は SIGALRM ではなく fork した子プロセスの
    kill で行う (NG_TIMEOUT 秒、既定 4)。settings 側 timeout=10 は最終防壁。
  - 検出は阻止ではない: PostToolUse 時点で書き込みは反映済み。block の
    reason は「修正するか、文脈上合法ならその旨を1回宣言して続行」の指示。

復旧手順: この hook が誤動作したら `claude --safe-mode` で hook 無効起動し、
~/.claude/settings.json の Stop / PostToolUse エントリを外す。

テスト: python3 ~/.claude/hooks/tests/test_ng_check.py (stdlib unittest のみ)
"""
import json
import os
import re
import select
import signal
import sys
from pathlib import Path

# スキャン上限。巨大な Write content や transcript で hang しないための予算。
SCAN_CAP = 200_000
TARGET_EXTENSIONS = {".tex", ".md", ".txt"}
MAX_REPORTED = 20

# インラインコード。パターン自体を引用して議論する文章 (この hook の設計を
# 説明する文書など) が自分のパターンに当たって block されるのを防ぐ。
# 改行をまたがないので、バッククォートの対応がずれても被害が1行に収まる。
INLINE_CODE = re.compile(r"`[^`\n]*`")


def load_patterns():
    """TSV (正規表現<TAB>カテゴリ<TAB>理由) を読む。壊れた行は黙って捨てる。"""
    path = os.environ.get("NG_PATTERNS_FILE") or str(
        Path(__file__).resolve().parent / "ng-patterns.tsv")
    patterns = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.rstrip("\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) < 3:
            continue
        raw, category, reason = fields[0], fields[1], fields[2]
        try:
            patterns.append((re.compile(raw), raw, category, reason))
        except re.error:
            continue
    return patterns


def mask_code(text):
    """インラインコードを NUL で潰す。長さを変えないので元の位置がずれない。

    フェンス (``` ブロック) は扱わない。全 transcript で測ると、除外しても
    em ダッシュが doc 106件 / chat 169件減るだけで他のパターンは1件も動かず、
    その中身はコードブロック内の行だった。得るものに対して、フェンスの
    対応付けは壊れたときの被害が大きすぎる (正規表現でペアリングした実装では
    チャット履歴の 54% が「コード」と誤判定された)。
    """
    return INLINE_CODE.sub(lambda m: "\x00" * (m.end() - m.start()), text)


def scan(patterns, text):
    """パターンごとに最初のマッチ + 件数を返す。

    判定はコードを潰した側で行い、snippet は元テキストから切る (潰した文字を
    見せても読み手が何を直せばいいか分からないため)。
    """
    masked = mask_code(text)
    findings = []
    for rx, raw, category, reason in patterns:
        matches = rx.findall(masked)
        if not matches:
            continue
        m = rx.search(masked)
        start = max(0, m.start() - 15)
        snippet = text[start:m.end() + 15].replace("\n", " ")
        findings.append({"pattern": raw, "category": category,
                         "reason": reason, "snippet": snippet,
                         "count": len(matches)})
    return findings


def guarded_scan(patterns, text, timeout):
    """fork した子でスキャンし、timeout 秒で強制終了 (regex hang 対策)。

    SIGALRM は re の C ループを中断できないので、プロセスごと殺すしかない。
    """
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:  # 子: スキャンして結果 JSON をパイプへ
        os.close(read_fd)
        try:
            payload = json.dumps(scan(patterns, text), ensure_ascii=False)
            os.write(write_fd, payload.encode("utf-8"))
        except Exception:
            pass
        finally:
            os._exit(0)
    os.close(write_fd)
    chunks = []
    import time
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        ready, _, _ = select.select([read_fd], [], [], remaining)
        if not ready:
            break
        chunk = os.read(read_fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(read_fd)
    done, _ = os.waitpid(pid, os.WNOHANG)
    if done == 0:  # まだ生きている = hang → kill
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    if not chunks:
        return []
    try:
        return json.loads(b"".join(chunks).decode("utf-8"))
    except Exception:
        return []


def last_assistant_text_from_transcript(path):
    """transcript JSONL から最後の assistant メッセージの全 text を連結。

    「最後の1行」ではなく message 単位で選ぶ (1 メッセージ = 複数 text block)。
    巨大 transcript はファイル末尾 2MB だけ読む。
    """
    p = Path(path)
    size = p.stat().st_size
    with open(p, "rb") as f:
        if size > 2_000_000:
            f.seek(size - 2_000_000)
            f.readline()  # 途中から読むので先頭の欠け行を捨てる
        data = f.read().decode("utf-8", errors="replace")
    last_text = ""
    for line in data.splitlines():
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        message = obj.get("message") or {}
        if message.get("role") != "assistant":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        texts = [b.get("text", "") for b in content
                 if isinstance(b, dict) and b.get("type") == "text"]
        if texts:
            last_text = "\n".join(texts)
    return last_text


def collect_text(data):
    """イベント種別ごとにスキャン対象テキストを取り出す。対象外なら None。"""
    event = data.get("hook_event_name")
    if event == "Stop":
        if data.get("stop_hook_active"):
            return None  # 再帰防止: block への応答後の再 Stop は素通し
        text = data.get("last_assistant_message")
        if isinstance(text, str) and text:
            return text
        transcript = data.get("transcript_path")
        if isinstance(transcript, str) and transcript:
            return last_assistant_text_from_transcript(transcript)
        return None
    if event == "PostToolUse":
        tool = data.get("tool_name")
        tool_input = data.get("tool_input")
        if not isinstance(tool_input, dict):
            return None
        file_path = tool_input.get("file_path")
        if not isinstance(file_path, str):
            return None
        if Path(file_path).suffix.lower() not in TARGET_EXTENSIONS:
            return None
        if tool == "Write":
            content = tool_input.get("content")
            return content if isinstance(content, str) else None
        if tool == "Edit":
            new = tool_input.get("new_string")
            return new if isinstance(new, str) else None
        if tool == "MultiEdit":
            edits = tool_input.get("edits")
            if not isinstance(edits, list):
                return None
            parts = [e.get("new_string") for e in edits
                     if isinstance(e, dict) and isinstance(e.get("new_string"), str)]
            return "\n".join(parts) if parts else None
    return None


def build_reason(findings):
    lines = ["NG表現を検出しました (ng-check hook):"]
    for f in findings[:MAX_REPORTED]:
        times = f" ×{f['count']}" if f["count"] > 1 else ""
        lines.append(
            f"・[{f['category']}]{times} 「…{f['snippet']}…」 — {f['reason']}")
    if len(findings) > MAX_REPORTED:
        lines.append(f"…ほか {len(findings) - MAX_REPORTED} 件")
    lines.append(
        "該当表現を修正してください。文脈上合法な場合 (固有名詞・コード識別子・"
        "正当な不確実性表現など) は、その旨を1回明示的に宣言して続行して構いません。")
    return "\n".join(lines)


def main():
    data = json.loads(sys.stdin.read())
    text = collect_text(data)
    if not text:
        return
    text = text[:SCAN_CAP]
    timeout = float(os.environ.get("NG_TIMEOUT", "4"))
    findings = guarded_scan(load_patterns(), text, timeout)
    if findings:
        print(json.dumps({"decision": "block", "reason": build_reason(findings)},
                         ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # fail-open: hook の不具合でセッションを壊さない
    sys.exit(0)
