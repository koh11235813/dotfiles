#!/usr/bin/env python3
"""
Antigravity PreInvocation Hook: plan-report
plan モードのターンだけ、plan artifact の中身を本文で説明させる指示を差し込む。

plan モードの agy はユーザ入力に <PLAN> ブロックを足し、その中で
"The user will automatically see any new and modified plans you create,
so DO NOT re-summarize the plan." と指示する。CLI では artifact は自動表示されず
パスが1行出るだけなので、この指示に従うと本文に何も説明が残らない。

判定は transcript の最新 USER_INPUT に <PLAN> があるかどうか。
hook の不具合でセッションを止めないよう、異常系はすべて空の injectSteps で抜ける。
"""

import json
import sys
from pathlib import Path

# transcript が大きくても末尾だけ読めば最新の USER_INPUT は取れる
TAIL_BYTES = 2_000_000

MESSAGE = """<cli_plan_reporting source="hook">
This session runs in the terminal CLI. The user does not see artifacts automatically; they see only a path.
This overrides the plan-mode note "DO NOT re-summarize the plan".
After creating or updating a plan artifact, write in the chat body: the answer or proposed change in a few lines, the decisions and open questions that need the user, then the artifact path.
If the request is only a question, answer it in the chat body.
</cli_plan_reporting>"""


def last_user_input(transcript_path):
    p = Path(transcript_path)
    size = p.stat().st_size
    with open(p, "rb") as f:
        if size > TAIL_BYTES:
            f.seek(size - TAIL_BYTES)
            f.readline()  # 途中から読むので先頭の欠け行を捨てる
        data = f.read().decode("utf-8", errors="replace")
    content = ""
    for line in data.splitlines():
        try:
            step = json.loads(line)
        except ValueError:
            continue
        if step.get("type") == "USER_INPUT":
            content = step.get("content") or ""
    return content


def main():
    steps = []
    try:
        payload = json.load(sys.stdin)
        transcript = payload.get("transcriptPath") or ""
        if transcript and "<PLAN>" in last_user_input(transcript):
            steps.append({"ephemeralMessage": MESSAGE})
    except Exception as e:
        sys.stderr.write(f"[plan-report] {e}\n")
    print(json.dumps({"injectSteps": steps}, ensure_ascii=False))


if __name__ == "__main__":
    main()
