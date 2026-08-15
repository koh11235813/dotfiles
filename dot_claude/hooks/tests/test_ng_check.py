#!/usr/bin/env python3
"""ng-check.py の検証。

グローバル hook (全プロジェクト・全セッションで発火) なので、
「NG を検出できること」と同じ重みで「どんな異常入力でもセッションを
壊さないこと (fail-open = exit 0・無出力)」を検査する。

実行: python3 ~/.claude/hooks/tests/test_ng_check.py
依存: stdlib のみ (pytest 不要。グローバル環境に何も要求しない)。
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "ng-check.py"
REAL_TSV = SCRIPT.parent / "ng-patterns.tsv"


def run_hook(payload, env_extra=None, timeout=20):
    """hook を本番同様サブプロセスで起動し stdin JSON を食わせる。"""
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    data = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=data, capture_output=True, text=True, env=env, timeout=timeout,
    )


def block_reason(proc):
    """stdout の decision JSON を解釈。無出力なら None。"""
    if not proc.stdout.strip():
        return None
    out = json.loads(proc.stdout)
    assert out.get("decision") == "block"
    return out.get("reason", "")


class NgCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tsv = self.write_tsv("テスト用NG\tテスト\t理由X")
        self.env = {"NG_PATTERNS_FILE": self.tsv}

    def write_tsv(self, *lines):
        path = Path(self.tmp.name) / "patterns.tsv"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return str(path)

    def write_transcript(self, *assistant_texts):
        """assistant メッセージ列を持つ偽 transcript JSONL を作る。"""
        path = Path(self.tmp.name) / "transcript.jsonl"
        rows = []
        for text in assistant_texts:
            rows.append(json.dumps({
                "message": {"role": "assistant",
                            "content": [{"type": "text", "text": text}]}
            }, ensure_ascii=False))
            rows.append(json.dumps({"message": {"role": "user", "content": "u"}}))
        path.write_text("\n".join(rows) + "\n", encoding="utf-8")
        return str(path)

    # --- Stop イベント -------------------------------------------------

    def test_stop_detects_ng_in_last_assistant_message(self):
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "last_assistant_message": "これはテスト用NGを含む文。"},
                        self.env)
        self.assertEqual(proc.returncode, 0)
        reason = block_reason(proc)
        self.assertIsNotNone(reason)
        self.assertIn("理由X", reason)

    def test_stop_clean_text_passes_silently(self):
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "last_assistant_message": "問題のない普通の文。"},
                        self.env)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")

    def test_stop_hook_active_guard_prevents_recursion(self):
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": True,
                         "last_assistant_message": "テスト用NGがあっても素通し。"},
                        self.env)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")

    def test_stop_transcript_fallback_scans_only_last_assistant(self):
        # NG が最後の assistant メッセージにある → 検出
        t1 = self.write_transcript("昔の発言", "テスト用NGを含む最新発言")
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "transcript_path": t1}, self.env)
        self.assertIsNotNone(block_reason(proc))
        # NG が古いメッセージにしかない → 検出しない
        t2 = self.write_transcript("テスト用NGは過去の発言", "最新はクリーン")
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "transcript_path": t2}, self.env)
        self.assertEqual(proc.stdout.strip(), "")

    # --- PostToolUse イベント ------------------------------------------

    def test_post_write_tex_detected(self):
        proc = run_hook({"hook_event_name": "PostToolUse", "tool_name": "Write",
                         "tool_input": {"file_path": "/x/poster.tex",
                                        "content": "テスト用NGを書いた"}},
                        self.env)
        self.assertIsNotNone(block_reason(proc))

    def test_post_write_non_target_extension_skipped(self):
        proc = run_hook({"hook_event_name": "PostToolUse", "tool_name": "Write",
                         "tool_input": {"file_path": "/x/main.py",
                                        "content": "テスト用NGでもコードは対象外"}},
                        self.env)
        self.assertEqual(proc.stdout.strip(), "")

    def test_post_edit_new_string_detected(self):
        proc = run_hook({"hook_event_name": "PostToolUse", "tool_name": "Edit",
                         "tool_input": {"file_path": "/x/memo.md",
                                        "old_string": "旧",
                                        "new_string": "テスト用NGに差し替え"}},
                        self.env)
        self.assertIsNotNone(block_reason(proc))

    def test_post_multiedit_scans_every_edit(self):
        proc = run_hook({"hook_event_name": "PostToolUse", "tool_name": "MultiEdit",
                         "tool_input": {"file_path": "/x/doc.txt",
                                        "edits": [
                                            {"old_string": "a", "new_string": "клин"},
                                            {"old_string": "b",
                                             "new_string": "2件目にテスト用NG"},
                                        ]}},
                        self.env)
        self.assertIsNotNone(block_reason(proc))

    # --- fail-open 系 ---------------------------------------------------

    def test_broken_stdin_fails_open(self):
        proc = run_hook("これはJSONではない{{{", self.env)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")

    def test_missing_patterns_file_fails_open(self):
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "last_assistant_message": "テスト用NG"},
                        {"NG_PATTERNS_FILE": "/nonexistent/ng.tsv"})
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")

    def test_malformed_tool_input_fails_open(self):
        proc = run_hook({"hook_event_name": "PostToolUse", "tool_name": "Write",
                         "tool_input": {"file_path": None, "content": 123}},
                        self.env)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")

    def test_invalid_regex_line_skipped_but_others_work(self):
        tsv = self.write_tsv("(壊れた\tテスト\t不正な正規表現",
                            "テスト用NG\tテスト\t理由X")
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "last_assistant_message": "テスト用NGあり"},
                        {"NG_PATTERNS_FILE": tsv})
        self.assertIsNotNone(block_reason(proc))

    def test_scan_size_cap(self):
        # cap (200KB) より後ろの NG は見えない / 前なら見える
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "last_assistant_message": "x" * 250_000 + "テスト用NG"},
                        self.env)
        self.assertEqual(proc.stdout.strip(), "")
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "last_assistant_message": "テスト用NG" + "x" * 250_000},
                        self.env)
        self.assertIsNotNone(block_reason(proc))

    def test_catastrophic_regex_times_out_and_fails_open(self):
        # (a+)+$ は "a"*35+"b" に対し指数時間 — 時間ガードが殺すこと
        tsv = self.write_tsv("(a+)+$\tテスト\tevil")
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "last_assistant_message": "a" * 35 + "b"},
                        {"NG_PATTERNS_FILE": tsv, "NG_TIMEOUT": "1"},
                        timeout=10)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")

    def test_broken_transcript_lines_fail_open(self):
        path = Path(self.tmp.name) / "broken.jsonl"
        path.write_text('{"message": {"role": "assistant"\nガラクタ行\n',
                        encoding="utf-8")
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "transcript_path": str(path)}, self.env)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")

    # --- 出荷パターン (実 TSV) の煙テスト --------------------------------

    def test_shipped_patterns_detect_known_ng(self):
        self.assertTrue(REAL_TSV.exists())
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "last_assistant_message": "CeforeEmu を公開した。"},
                        {"NG_PATTERNS_FILE": str(REAL_TSV)})
        reason = block_reason(proc)
        self.assertIsNotNone(reason)
        self.assertIn("ReCefore", reason)

    def test_shipped_patterns_pass_clean_sentence(self):
        proc = run_hook({"hook_event_name": "Stop", "stop_hook_active": False,
                         "last_assistant_message":
                             "ReCefore は再現性を柱の一つとする。実測値は 20.8 Mbps。"},
                        {"NG_PATTERNS_FILE": str(REAL_TSV)})
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
