#!/usr/bin/env python3
"""Syntax lint and JSON Schema type checker for JSON, JSONC, and JSONL files.

Stdlib-only so it runs identically on local hosts and GitHub Actions runners.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = REPO_ROOT / ".github" / "schemas"

REPO_SCHEMA_MAP: dict[str, str] = {
    "dot_claude/settings.json": "claude-settings.schema.json",
    "dot_claude/external_plugins/github/.mcp.json": "claude-mcp.schema.json",
    "dot_codex/hooks.json": "codex-hooks.schema.json",
    "dot_config/opencode/opencode.jsonc": "opencode.schema.json",
    "dot_gemini/antigravity-cli/settings.json": "gemini-settings.schema.json",
    "dot_pi/agent/guard.json": "pi-guard.schema.json",
    "dot_pi/agent/models.json": "pi-models.schema.json",
}

RENDERED_SCHEMA_MAP: dict[str, str] = {
    ".claude/settings.json": "claude-settings.schema.json",
    ".claude/external_plugins/github/.mcp.json": "claude-mcp.schema.json",
    ".codex/hooks.json": "codex-hooks.schema.json",
    ".config/opencode/opencode.jsonc": "opencode.schema.json",
    ".gemini/antigravity-cli/settings.json": "gemini-settings.schema.json",
    ".gemini/antigravity/settings.json": "gemini-settings.schema.json",
    ".gemini/config/hooks.json": "gemini-hooks.schema.json",
    ".gemini/config/mcp_config.json": "gemini-mcp.schema.json",
    ".gemini/config/skills.json": "gemini-skills.schema.json",
    ".pi/agent/guard.json": "pi-guard.schema.json",
    ".pi/agent/models.json": "pi-models.schema.json",
    ".pi/agent/settings.json": "pi-settings.schema.json",
}


def strip_jsonc_comments(text: str) -> str:
    """Strip // line comments and /* ... */ block comments outside string literals."""
    out: list[str] = []
    i = 0
    n = len(text)
    in_string = False
    escaped = False
    while i < n:
        ch = text[i]
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            i += 1
            continue

        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
        elif ch == "/" and i + 1 < n and text[i + 1] == "/":
            i += 2
            while i < n and text[i] != "\n":
                i += 1
        elif ch == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                if text[i] == "\n":
                    out.append("\n")
                i += 1
            i += 2 if i + 1 < n else 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _matches_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "null":
        return value is None
    return True


def _type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def validate_schema(value: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    """Validate a parsed JSON value against a subset of JSON Schema."""
    errors: list[str] = []

    if "anyOf" in schema:
        sub_errors: list[list[str]] = []
        for branch in schema["anyOf"]:
            branch_err = validate_schema(value, branch, path)
            if not branch_err:
                break
            sub_errors.append(branch_err)
        else:
            errors.append(f"{path}: does not match any allowed schema ({'; '.join(e[0] for e in sub_errors if e)})")
            return errors

    if "type" in schema:
        expected_types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_matches_type(value, t) for t in expected_types):
            errors.append(f"{path}: expected {'|'.join(expected_types)}, got {_type_name(value)}")
            return errors

    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: value {value!r} not in enum {schema['enum']!r}")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: value {value} is less than minimum {schema['minimum']}")

    if isinstance(value, dict):
        for req in schema.get("required", []):
            if req not in value:
                errors.append(f"{path}: missing required key {req!r}")

        props = schema.get("properties", {})
        pat_props = [(re.compile(pat), sub) for pat, sub in schema.get("patternProperties", {}).items()]
        addl = schema.get("additionalProperties", True)

        for key, item_val in value.items():
            child_path = f"{path}.{key}"
            matched = False
            if key in props:
                errors.extend(validate_schema(item_val, props[key], child_path))
                matched = True
            for regex, sub_schema in pat_props:
                if regex.search(key):
                    errors.extend(validate_schema(item_val, sub_schema, child_path))
                    matched = True
            if not matched:
                if addl is False:
                    errors.append(f"{path}: unexpected property {key!r}")
                elif isinstance(addl, dict):
                    errors.extend(validate_schema(item_val, addl, child_path))

    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: expected at least {schema['minItems']} items, got {len(value)}")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for idx, elem in enumerate(value):
                errors.extend(validate_schema(elem, item_schema, f"{path}[{idx}]"))

    return errors


def load_schema(schema_path: Path) -> dict[str, Any]:
    return json.loads(schema_path.read_text(encoding="utf-8"))


def check_file(file_path: Path, schema: dict[str, Any] | None = None, display_name: str | None = None) -> list[str]:
    label = display_name or str(file_path)
    try:
        raw = file_path.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"{label}: failed to read: {exc}"]

    suffix = file_path.suffix.lower()
    if suffix == ".jsonl":
        errors: list[str] = []
        for lineno, line in enumerate(raw.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError as exc:
                errors.append(f"{label}:{lineno}: invalid JSONL line ({exc.msg} at col {exc.colno})")
                continue
            if schema is not None:
                for err in validate_schema(data, schema):
                    errors.append(f"{label}:{lineno}: {err}")
        return errors

    text = strip_jsonc_comments(raw) if suffix == ".jsonc" else raw
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return [f"{label}:{exc.lineno}:{exc.colno}: invalid JSON ({exc.msg})"]

    if schema is not None:
        return [f"{label}: {err}" for err in validate_schema(data, schema)]
    return []


def _schema_for(rel_posix: str, mapping: dict[str, str], schema_dir: Path) -> dict[str, Any] | None:
    schema_name = mapping.get(rel_posix)
    if not schema_name:
        return None
    return load_schema(schema_dir / schema_name)


def check_repo(repo_root: Path, schema_dir: Path) -> tuple[int, list[str]]:
    res = subprocess.run(
        ["git", "-C", str(repo_root), "ls-files", "*.json", "*.jsonc", "*.jsonl"],
        capture_output=True, text=True, check=True,
    )
    tracked = sorted(set(res.stdout.splitlines()))
    # Include newly created untracked schema files if any
    for p in sorted(schema_dir.glob("*.schema.json")):
        rel = p.relative_to(repo_root).as_posix()
        if rel not in tracked:
            tracked.append(rel)

    errors: list[str] = []
    checked = 0
    for rel in sorted(tracked):
        name = Path(rel).name
        if name.startswith("modify_"):
            continue
        path = repo_root / rel
        if not path.is_file():
            continue
        schema = _schema_for(rel, REPO_SCHEMA_MAP, schema_dir)
        errors.extend(check_file(path, schema=schema, display_name=rel))
        checked += 1
    return checked, errors


def check_rendered_root(rendered_root: Path, schema_dir: Path) -> tuple[int, list[str]]:
    errors: list[str] = []
    checked = 0
    for ext in ("*.json", "*.jsonc", "*.jsonl"):
        for path in sorted(rendered_root.rglob(ext)):
            if not path.is_file():
                continue
            rel = path.relative_to(rendered_root).as_posix()
            schema = _schema_for(rel, RENDERED_SCHEMA_MAP, schema_dir)
            errors.extend(check_file(path, schema=schema, display_name=rel))
            checked += 1
    return checked, errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate JSON, JSONC, and JSONL files.")
    parser.add_argument("--repo", action="store_true", help="Check tracked JSON/JSONC/JSONL files in repo")
    parser.add_argument("--rendered-root", type=Path, help="Check rendered files under a chezmoi destination dir")
    parser.add_argument("--schema", type=Path, help="Schema file to apply when checking explicit file arguments")
    parser.add_argument("files", nargs="*", type=Path, help="Explicit files to check")
    args = parser.parse_args(argv)

    all_errors: list[str] = []
    total_checked = 0

    if args.repo:
        n, errs = check_repo(REPO_ROOT, SCHEMA_DIR)
        total_checked += n
        all_errors.extend(errs)

    if args.rendered_root is not None:
        n, errs = check_rendered_root(args.rendered_root, SCHEMA_DIR)
        total_checked += n
        all_errors.extend(errs)

    if args.files:
        schema = load_schema(args.schema) if args.schema else None
        for file_path in args.files:
            all_errors.extend(check_file(file_path, schema=schema))
            total_checked += 1

    if not args.repo and args.rendered_root is None and not args.files:
        parser.print_help()
        return 2

    if all_errors:
        for err in all_errors:
            print(f"FAIL {err}", file=sys.stderr)
        print(f"check_json: {len(all_errors)} error(s) across {total_checked} file(s)", file=sys.stderr)
        return 1

    print(f"check_json: ok ({total_checked} file(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
