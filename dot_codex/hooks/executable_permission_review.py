#!/usr/bin/env python3
"""Approve only narrowly scoped find deletions after an independent model review.

Any unsupported request or backend failure emits no decision, leaving the normal
Codex approval flow in charge. Never print the request, model output, or API key.
"""

import json
import math
import os
import platform
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


SCHEMA = Path(__file__).with_name("permission_review_schema.json")
JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_THRESHOLD = 0.95  # Provisional; calibrate against reviewed requests.


def narrow_find_delete(command, cwd):
    """Return argv for one simple, bounded find deletion; otherwise None."""
    match = re.fullmatch(
        r"find ([A-Za-z0-9._/-]+) -type f -name '(\*\.tmp)' -delete",
        command,
    )
    if not match:
        return None
    root, pattern = match.groups()
    if not isinstance(cwd, str) or not Path(cwd).is_absolute() or not Path(root).is_absolute():
        return None
    expected = Path(cwd) / "build"
    if Path(root) != expected or expected.is_symlink():
        return None
    return ("find", root, "-type", "f", "-name", pattern, "-delete")


def fm_available():
    if platform.system() != "Darwin":
        return False
    try:
        major = int(platform.mac_ver()[0].split(".")[0])
        if major < 27 or not Path("/usr/bin/fm").is_file():
            return False
        result = subprocess.run(
            ["/usr/bin/fm", "available", "--model", "system"],
            capture_output=True, text=True, timeout=3, check=False,
        )
        return result.returncode == 0 and "System model available" in result.stdout
    except (ValueError, OSError, subprocess.TimeoutExpired):
        return False


def review_with_fm(command):
    prompt = (
        "Decide whether this exact command is safe to approve without a human. "
        "It deletes files. Allow only when the target and filename pattern are narrow, "
        "the effects are clear, and there is no plausible sensitive or user-owned data loss. "
        "When uncertain, set allow to false. Reply through the supplied schema.\n"
        f"Command: {command}"
    )
    result = subprocess.run(
        ["/usr/bin/fm", "respond", "--model", "system", "--no-stream", "--schema", str(SCHEMA)],
        input=prompt, capture_output=True, text=True, timeout=20, check=False,
    )
    if result.returncode != 0:
        return False
    answer = json.loads(result.stdout)
    return answer.get("allow") is True and isinstance(answer.get("reason"), str)


def review_with_jev(command, key):
    body = {
        "model": "jev-latest",
        "state": {"decision": "Should this exact find deletion be automatically approved?"},
        "questions": {"permission": {
            "type": "choice",
            "instructions": (
                "Choose allow only if this deletion is narrow and clearly safe. "
                "Otherwise choose defer. Command: " + command
            ),
            "criteria": {
                "allow": "Safe to execute without human approval; no plausible sensitive or user-owned data loss.",
                "defer": "Needs human review or the risk is uncertain.",
                "none_of_these": "The command cannot be judged safely from the supplied information."
            },
        }},
    }
    request = urllib.request.Request(
        JEV_URL, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        answer = json.load(response)["answers"]["permission"]
    probabilities = answer["probabilities"]
    return (
        type(probabilities.get("allow")) in (int, float)
        and math.isfinite(probabilities["allow"])
        and probabilities["allow"] >= JEV_THRESHOLD
        and probabilities["allow"] > probabilities.get("defer", 1)
        and probabilities["allow"] > probabilities.get("none_of_these", 1)
        and isinstance(answer.get("confidence"), (int, float))
        and answer["confidence"] >= 0.7
    )


def decide(event):
    if event.get("hook_event_name") != "PermissionRequest" or event.get("tool_name") != "Bash":
        return False
    tool_input = event.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str) or narrow_find_delete(command, event.get("cwd")) is None:
        return False
    if fm_available():
        return review_with_fm(command)
    key = os.environ.get("JEV_API_KEY")
    return bool(key) and review_with_jev(command, key)


def main():
    try:
        event = json.load(sys.stdin)
        if decide(event):
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}
            }}))
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired, urllib.error.URLError):
        # No decision: Codex's configured reviewer handles the request.
        pass


if __name__ == "__main__":
    main()
