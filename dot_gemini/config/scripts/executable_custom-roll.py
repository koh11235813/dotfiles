#!/usr/bin/env python3
"""
Antigravity PreInvocation Hook: custom-roll
Selects a role setting markdown from ~/.gemini/custom-roll/*.md,
caches it per conversationId to keep consistency within the conversation session,
and injects it as an ephemeralMessage before model invocation.
"""

import json
import os
import random
import sys
from pathlib import Path

CACHE_DIR = Path("/tmp/antigravity-custom-roll")
PRIMARY_ROLL_DIR = Path.home() / ".gemini" / "custom-roll"
FALLBACK_ROLL_DIR = Path.home() / ".claude" / "custom-roll"


def get_available_roles():
    target_dir = PRIMARY_ROLL_DIR if PRIMARY_ROLL_DIR.is_dir() else FALLBACK_ROLL_DIR
    if not target_dir.is_dir():
        return []
    return sorted(list(target_dir.glob("*.md")))


def select_role_file(conversation_id: str):
    roles = get_available_roles()
    if not roles:
        return None

    if conversation_id:
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            cache_file = CACHE_DIR / f"{conversation_id}.txt"
            if cache_file.is_file():
                cached_path = Path(cache_file.read_text(encoding="utf-8").strip())
                if cached_path.is_file():
                    return cached_path

            # Pick a random role and cache it
            chosen = random.choice(roles)
            cache_file.write_text(str(chosen), encoding="utf-8")
            return chosen
        except Exception as e:
            sys.stderr.write(f"[custom-roll] Cache error: {e}\n")

    return random.choice(roles)


def main():
    conversation_id = ""
    try:
        if not sys.stdin.isatty():
            input_data = sys.stdin.read()
            if input_data.strip():
                payload = json.loads(input_data)
                conversation_id = payload.get("conversationId", "")
    except Exception as e:
        sys.stderr.write(f"[custom-roll] Failed to read stdin JSON: {e}\n")

    role_file = select_role_file(conversation_id)
    if not role_file or not role_file.is_file():
        # Nothing to inject
        print(json.dumps({"injectSteps": []}))
        return

    try:
        content = role_file.read_text(encoding="utf-8")
        result = {
            "injectSteps": [
                {
                    "ephemeralMessage": content
                }
            ]
        }
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        sys.stderr.write(f"[custom-roll] Failed to read role file: {e}\n")
        print(json.dumps({"injectSteps": []}))


if __name__ == "__main__":
    main()
