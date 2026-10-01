#!/usr/bin/env python3
"""Auto-approve read-only find, regenerable rm, agmsg scripts, and reviewed find -delete.

The hook also sees sandbox escalations and cannot tell them apart, so every allow
must be safe to run outside the sandbox.

Read-only find is allowed without a model. A filtered -delete whose roots stay
inside the workspace is dry-run first; Jev sees only match counts per extension,
never file names, and a dry run that fails, matches too much, or reaches into
.git goes to a human. Jev is the only reviewer: in trials the on-device fm model
denied even safe deletions and was swayed by rewording.

rm is allowed without a model when every target is inside the workspace, has no
tracked file, holds no .git, and is either gitignored or a known cache name.

agmsg's inbox, history, and delivery status run as-is; delivery set turn codex
must name the session cwd. send and join are left out because they start
ext-tool drivers that post to Slack or Jev.

The payload omits the shell tool's workdir, so an otherwise eligible -delete or
rm with a relative path is denied with a request to retry using absolute paths.
Any unsupported request or backend failure emits no decision, leaving the normal
Codex approval flow in charge. Never print the request, model output, or API key.
"""

import json
import math
import os
import re
import shlex
import subprocess
import sys
import urllib.request
from collections import Counter


JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_THRESHOLD = 0.95  # Provisional; calibrate against reviewed requests.
MAX_MATCHES = 200

READ_ONLY = "read_only"
DELETE = "delete"
RETRY = "retry"
ALLOW = "allow"
DENY = "deny"
RETRY_MESSAGE = (
    "The permission hook cannot see the shell tool's workdir, so find -delete or rm "
    "with relative paths is not reviewed. Re-run the same command with each path "
    "written as the absolute path you intend."
)
SHELL_METACHARS = set(";&|$`<>(){}!#~\\\n")
GLOB_CHARS = set("*?[")
WRITING_ACTIONS = {"-delete", "-exec", "-execdir", "-ok", "-okdir",
                   "-fprint", "-fprint0", "-fprintf", "-fls"}
ROOT_RE = r"[A-Za-z0-9._/-]+"
PATTERN_ARGS = {"-name": r"[A-Za-z0-9._*?-]+", "-iname": r"[A-Za-z0-9._*?-]+",
                "-path": r"[A-Za-z0-9._*?/-]+", "-ipath": r"[A-Za-z0-9._*?/-]+"}
VALUE_ARGS = {"-type": r"[fd]", "-maxdepth": r"[0-9]+", "-mindepth": r"[0-9]+",
              "-mtime": r"[+-]?[0-9]+"}
RM_FLAG_RE = r"-[rRfdv]+|--force|--recursive"
CACHE_NAMES = {".DS_Store", "__pycache__"}
CACHE_EXTENSIONS = {".pyc", ".pyo"}
AGMSG_SCRIPTS = os.path.expanduser("~/.agents/skills/agmsg/scripts")


def shell_safe(command):
    """Reject metacharacters and globs the shell would expand outside quotes."""
    # shlex splits words on \r but the shell does not, so their argv could diverge.
    if SHELL_METACHARS & set(command) or not command.isprintable():
        return False
    quote = None
    for char in command:
        if quote:
            quote = None if char == quote else quote
        elif char in "'\"":
            quote = char
        elif char in GLOB_CHARS:
            return False
    return True


def find_argv(command):
    """Return argv for a plain find invocation; otherwise None."""
    if not shell_safe(command):
        return None
    try:
        argv = shlex.split(command)
    except ValueError:
        return None
    return argv if argv and argv[0] == "find" else None


def workspace_root(root, cwd):
    """Return root relative to cwd when it resolves inside cwd; otherwise None."""
    if not re.fullmatch(ROOT_RE, root):
        return None
    base = os.path.realpath(cwd)
    real = os.path.realpath(os.path.join(cwd, root))
    if real != base and not real.startswith(base.rstrip(os.sep) + os.sep):
        return None
    relative = os.path.relpath(real, base)
    # A symlinked root resolves to a name the model will read, so recheck it.
    if not re.fullmatch(ROOT_RE, relative):
        return None
    # macOS volumes are usually case-insensitive, so .GIT names the same directory.
    if touches_git(root.split("/") + relative.split(os.sep)):
        return None
    return relative


def touches_git(parts):
    return ".git" in (part.lower() for part in parts)


def delete_expression_ok(expression):
    """Accept only allowlisted AND-ed tests, with -delete once and last."""
    if expression.count("-delete") != 1 or expression[-1] != "-delete":
        return False
    tokens, filtered = iter(expression[:-1]), False
    for token in tokens:
        if token == "-empty":
            continue
        pattern = PATTERN_ARGS.get(token) or VALUE_ARGS.get(token)
        value = next(tokens, None)
        if pattern is None or value is None or not re.fullmatch(pattern, value):
            return False
        if token in PATTERN_ARGS:
            # A pattern without a literal, such as '*', filters nothing.
            if not re.search(r"[A-Za-z0-9]", value):
                return False
            filtered = True
    return filtered


def classify_find(command, cwd):
    """Return (READ_ONLY, ()), (DELETE, relative roots), (RETRY, ()), or None."""
    argv = find_argv(command)
    if argv is None:
        return None
    if not WRITING_ACTIONS & set(argv):
        return READ_ONLY, ()
    if not isinstance(cwd, str) or not os.path.isabs(cwd):
        return None
    count = next((i for i, token in enumerate(argv[1:]) if token.startswith("-")),
                 len(argv) - 1)
    if count == 0 or not delete_expression_ok(argv[1 + count:]):
        return None
    roots = tuple(workspace_root(root, cwd) for root in argv[1:1 + count])
    if None in roots:
        return None
    # The hook checked relative roots against the session cwd, not the real workdir.
    if not all(os.path.isabs(root) for root in argv[1:1 + count]):
        return RETRY, ()
    return DELETE, roots


def classify_rm(command, cwd):
    """Return (DELETE, relative targets), (RETRY, ()), or None."""
    if not shell_safe(command):
        return None
    try:
        argv = shlex.split(command)
    except ValueError:
        return None
    if not argv or argv[0] != "rm" or not isinstance(cwd, str) or not os.path.isabs(cwd):
        return None
    targets, options_done = [], False
    for token in argv[1:]:
        if not options_done and token == "--":
            options_done = True
        elif token.startswith("-"):
            # GNU rm reads options after operands too; after -- they are odd names.
            if options_done or not re.fullmatch(RM_FLAG_RE, token):
                return None
        else:
            targets.append(token)
    relative = tuple(workspace_root(target, cwd) for target in targets)
    if not targets or None in relative or "." in relative:
        return None
    if not all(os.path.isabs(target) for target in targets):
        return RETRY, ()
    return DELETE, relative


def git(cwd, *args):
    try:
        return subprocess.run(["git", "-C", cwd, *args], capture_output=True,
                              timeout=4, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None


def regenerable(target, cwd):
    """True when deleting target loses nothing git tracks or a build cannot recreate."""
    tracked = git(cwd, "ls-files", "-z", "--", target)
    if tracked is None or tracked.returncode not in (0, 128) or tracked.stdout:
        return False
    path = os.path.join(cwd, target)
    if os.path.isdir(path) and not os.path.islink(path):
        for _, dirs, files in os.walk(path):
            if touches_git(dirs + files):
                return False
    if tracked.returncode == 0:
        ignored = git(cwd, "check-ignore", "-q", "--", target)
        if ignored is None or ignored.returncode not in (0, 1):
            return False
        if ignored.returncode == 0:
            return True
    name = os.path.basename(target)
    return name in CACHE_NAMES or os.path.splitext(name)[1] in CACHE_EXTENSIONS


def quoted_argv(command):
    """Return argv when the shell would expand nothing outside quotes; otherwise None."""
    script_start = len("bash ") if command.startswith("bash ") else 0
    quote, previous = None, " "
    for index, char in enumerate(command):
        if quote == "'":
            quote = None if char == "'" else quote
            if quote and not (char.isprintable() or char in "\n\t"):
                return None
        elif quote == '"':
            if char in "$`\\" or not (char.isprintable() or char in "\n\t"):
                return None
            quote = None if char == '"' else quote
        elif char in "'\"":
            quote = char
        elif char == "~" and index == script_start and command[index + 1:index + 2] == "/":
            pass
        elif (char in SHELL_METACHARS or char in GLOB_CHARS or not char.isprintable()
              or (char == "=" and previous == " ")):
            return None
        previous = char
    if quote:
        return None
    try:
        return shlex.split(command)
    except ValueError:
        return None


def agmsg_allowed(command, cwd):
    """True for agmsg scripts that touch only agmsg state or the session's own hooks."""
    if not isinstance(cwd, str) or not os.path.isabs(cwd):
        return False
    argv = quoted_argv(command)
    if argv and argv[0] == "bash":
        argv = argv[1:]
    if not argv:
        return False
    script, args = os.path.expanduser(argv[0]), argv[1:]
    name = os.path.basename(script)
    if not os.path.isabs(script) or os.path.realpath(script) != os.path.realpath(
            os.path.join(AGMSG_SCRIPTS, name)):
        return False
    if name in ("inbox.sh", "history.sh"):
        return True
    if name != "delivery.sh" or not args:
        return False
    if args[0] == "status":
        return True
    return (args[:3] == ["set", "turn", "codex"] and len(args) == 4
            and os.path.isabs(args[3])
            and os.path.realpath(args[3]) == os.path.realpath(cwd))


def extension_bucket(path):
    extension = os.path.splitext(os.path.basename(path))[1]
    if not extension:
        return "(none)"
    return extension if re.fullmatch(r"\.[A-Za-z0-9]{1,10}", extension) else "other"


def dry_run_summary(argv, cwd):
    """Summarize what the deletion would match; None when a human must decide."""
    try:
        result = subprocess.run(
            argv[:-1] + ["-print0"], cwd=cwd, capture_output=True, timeout=4, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    paths = [os.fsdecode(entry) for entry in result.stdout.split(b"\0") if entry]
    if len(paths) > MAX_MATCHES or any(touches_git(path.split(os.sep)) for path in paths):
        return None
    # File names are attacker-controlled text, so the model only sees counts.
    counts = Counter(extension_bucket(path) for path in paths)
    by_extension = ", ".join(f"{bucket} x{count}" for bucket, count in sorted(counts.items()))
    return f"{len(paths)} matches" + (f" ({by_extension})" if by_extension else "")


def review_with_jev(command, roots, summary, key):
    body = {
        "model": "jev-latest",
        "state": {"decision": "Should this workspace-confined find deletion be automatically approved?"},
        "questions": {"permission": {
            "type": "choice",
            "instructions": (
                "The deletion roots are already confined to the workspace, but files may "
                "match anywhere below them. Choose allow only if every matched file is "
                "plausibly regenerable (for example *.tmp, *.pyc, __pycache__, .DS_Store, "
                "or build, dist, or .cache contents). Otherwise choose defer. "
                "Command: " + command + " Roots relative to the workspace: " + ", ".join(roots)
                + " Dry-run matches by extension (names withheld): " + summary
            ),
            "criteria": {
                "allow": "Every matched file is plausibly regenerable; no source, documentation, secrets, or env files.",
                "defer": "It could match source, documentation, secrets, env files, or the risk is uncertain.",
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
        return None
    tool_input = event.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str):
        return None
    cwd = event.get("cwd")
    # Paths were checked against the event cwd; a different workdir runs elsewhere.
    elsewhere = any(tool_input.get(key) not in (None, cwd) for key in ("workdir", "cwd"))
    if agmsg_allowed(command, cwd):
        return None if elsewhere else ALLOW
    verdict = classify_rm(command, cwd)
    if verdict is not None:
        kind, targets = verdict
        if kind == RETRY:
            return DENY
        if elsewhere or not all(regenerable(target, cwd) for target in targets):
            return None
        return ALLOW
    verdict = classify_find(command, cwd)
    if verdict is None:
        return None
    kind, roots = verdict
    if kind == READ_ONLY:
        return ALLOW
    if kind == RETRY:
        return DENY
    if elsewhere:
        return None
    summary = dry_run_summary(find_argv(command), event["cwd"])
    if summary is None:
        return None
    key = os.environ.get("JEV_API_KEY")
    return ALLOW if key and review_with_jev(command, roots, summary, key) else None


def main():
    try:
        event = json.load(sys.stdin)
        decision = decide(event)
        if decision is not None:
            body = {"behavior": decision}
            if decision == DENY:
                body["message"] = RETRY_MESSAGE
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PermissionRequest", "decision": body
            }}))
    except Exception:
        # No decision: Codex's configured reviewer handles the request.
        pass


if __name__ == "__main__":
    main()
