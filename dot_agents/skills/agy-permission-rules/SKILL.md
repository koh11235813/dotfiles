---
name: agy-permission-rules
description: >-
  Internal command-rule evaluation model of Antigravity CLI (agy) settings.json
  permissions (allow, ask, deny). Use when writing or auditing command(...) and
  command(regex:...) rules, debugging unexpected approval prompts in auto mode,
  or reasoning about exactMatch vs compound command splitting.
---

# Antigravity CLI (`agy`) Permission Rule Evaluation

Public documentation (`https://antigravity.google/docs/permissions`) covers rule syntax (`action(target)`), `command(regex:...)`, `/permissions`, and `Deny > Ask > Allow`, but omits how `agy` splits compound commands and switches between word-prefix matching and raw full-string matching.

Verified against `/Users/kinoko/.local/bin/agy` `1.5.10` (`darwin_arm64`). For symbol names, internal Go paths, line numbers, and re-verification steps on newer binaries, read [references/provenance.md](references/provenance.md).

## Evaluation flow

1. **Grant parsing (`ParseCLIGrantString`)**: parses `action(target)` (e.g., `command`, `read_file`, `write_file`, `read_url`, `execute_url`, `mcp`). Nested `)` characters inside `command(regex:...)` are preserved.
2. **Entry dispatch (`checkLocal`)**: extracts simple commands with `ExtractSimpleCommandStrings(cmd)` and tests `RequiresExactMatch(cmd)`.
   - **Exact-match path (`exactMatch=true`)**: taken when shell parsing fails, no simple commands are extracted, or `RequiresExactMatch(cmd)` returns `true`. Calls `checkSingleTarget(rawCmd, exactMatch=true)` on the full raw command string.
   - **Compound path (`exactMatch=false`)**: otherwise calls `checkCompound`, running `checkSingleTarget(subCmd, exactMatch=false)` on each extracted simple command.
     - Any `DENY` stops immediately and returns `DENY`.
     - If every subcommand returns `ALLOW`, returns `ALLOW`.
     - If one or more subcommands return `ASK` from an overridable source, `checkCompound` falls back to `checkSingleTarget(rawCmd, exactMatch=true)` on the original full command string; if that matches `ALLOW`, the compound command is allowed.
3. **Settings refresh (`checkSingleTarget`)**: if `checkSingleTargetOnce` returns `ASK` and a settings-store refresh handle is present, `agy` calls `refreshFromSettingsStore` and re-evaluates once.
4. **Precedence**: `Deny > Ask > Allow`. Within a list, `PermissionGrantStore.findMatchInList` scans linearly via `grantMatchesResource` (except `execute_url` ask entries superseded by allow).

## What forces `exactMatch=true`

`RequiresExactMatch` and `callExprRequiresExactMatch` force the raw full-string path whenever a command contains any of:

- Non-POSIX shell syntax or shell parse errors
- `hasUnsafeRune`: non-ASCII control, space, or unsafe Unicode runes
- `!isPlainCommandName`: command name is not a single ASCII literal, or contains `\`, `'`, `"`, `` ` ``, or `$`
- `hasGlobOrBraceOrVarExpansion`: unquoted globs, braces, or variable expansions (`*`, `?`, `[`, `{`, `$`)
- Redirections (`redirectionRequiresExactMatch`, e.g., `2>&1`, `>/dev/null`, `> file`)
- `git`/`hg` config or remote flags (`gitHgTouchesConfigOrRemote`, e.g., `-c`, `--config-env`)
- Execution-hijacking flags

## Matcher split (`coversCommand`)

`command(*)` matches unconditionally on both paths. Every other `command(...)` rule behaves differently depending on `exactMatch`:

| Property | `exactMatch=false` (`MatchesConfigAny`) | `exactMatch=true` (`MatchesConfigAnyRaw`) |
|---|---|---|
| Input compared | Extracted word slice `[]string` per simple command | Trimmed raw command string |
| Plain rule `command(foo bar)` | Split via `SplitCommandStringToParts`; **word-prefix match** (`allowPrefix=true`) | **Exact byte equality (`memequal`)**, NOT prefix |
| `command(regex:...)` | Strips `regex:`, then passes the **pattern string** through `SplitCommandStringToParts` and matches per-word | Strips `regex:`, compiles Go `regexp` (RE2) wrapped as `^(?:<pattern>)$` |
| Multi-command / alternating regex | Broken by token splitting; fails against simple single commands | Works reliably on full chained strings |

Go `regexp` (RE2) specifics: linear-time NFA, no lookarounds (`(?=...)`, `(?!...)`), no backreferences (`\1`), and `.` excludes `\n` unless `(?s:...)` is set.

## Rule authoring rules

Apply all four when editing `permissions` in `~/.gemini/antigravity-cli/settings.json` (or its chezmoi source `dot_gemini/antigravity-cli/settings.json`):

1. **Pair plain prefixes with chained `command(regex:...)`**:
   - Put safe single commands and read-only subcommands as plain entries (`command(jq)`, `command(chezmoi diff)`, `command(pacman -Q)`) so simple commands and `checkCompound` (`exactMatch=false`) hit `ALLOW` directly.
   - Put a `command(regex:...)` entry for globs (`git status *`), env prefixes (`FOO=1 go test ./...`), redirections (`2>&1`, `/dev/null`), and chains (`&&`, `||`, `;`, `|`, `|&`, `\n`) handled on `exactMatch=true`.
2. **Never rely on plain `ask`/`deny` rules to block a broad `allow` regex**:
   - On `exactMatch=true`, `"ask": ["command(pacman -S)"]` and `"deny": ["command(rm -rf .git)"]` check exact byte equality (`memequal`), so they do **not** match `"ls * && pacman -S vim"` or `"ls * && rm -rf .git"`.
   - Explicitly exclude every `ask`/`deny` target inside every `allow` regex (for example, restrict `pacman` to `-Q`/`--query` and omit `rm` altogether).
3. **Block shell-injection primitives and two-stage evaluation builtins**:
   - Reject unquoted `$(...)`, `$[...]`, backticks, `<(...)`/`>(...)`, `(` / `)`, single background `&`, and arbitrary file redirections (`>` / `<` outside fd duplications like `2>&1` and `/dev/null`).
   - Reject `$(`, `$[`, and backticks inside **both** double quotes `"..."` and single quotes `'...'`. Single quotes only suppress expansion during the shell's initial parse pass; builtins that evaluate variable names or array subscripts in arithmetic context still execute command substitution delivered as literal arguments (verified in `bash` and `zsh` for `read 'a[$(touch ...)]' < /dev/null` and `printf -v 'a[$(touch ...)]' 1`, and in `bash` for `test -v` and `[[ -v ... ]]`).
   - Exclude arithmetic-evaluating builtins (`read`, `printf`, `test`, `[`, `[[`) from broad allowlists and regexes altogether: even when `$(` is blocked inside quotes, shell word concatenation (`'a[''$''(touch ...)]'`) or escaped `\$` (`"a[\$(touch ...)]"`) still assembles literal `$(...)` in `argv` before the builtin runs, and plain `command(read)` matches `read 'a[$(...)]'` on `exactMatch=false`.
   - Keep command wrappers that execute arbitrary binaries (`env`, `command`) out of plain `command(...)` rules, since `allowPrefix=true` would match `env rm -rf /`. Allow them only with constrained syntax inside `command(regex:...)` (e.g., `command -v`, `env` with `VAR=val` followed by an allowlisted command).
   - Recognize the hard boundary of regex allowlists: any allowlisted interpreter or exec-capable CLI (`python3`, `node`, `awk`, `find`, `xargs`, `git`, `make`, `go`, `cargo`, `npm`) can execute arbitrary code without shell metacharacters, so regex rules bound shell syntax and chaining while `enableTerminalSandbox` (OS jail) provides containment.
4. **Test the JSON-decoded regex with Go `regexp`**:
   - Remember JSON doubles every backslash (`\s` -> `\\s`, `\.` -> `\\.`).
   - Unmarshal the actual `settings.json`, extract the `regex:` payload, compile `^(?:<payload>)$` with Go `regexp`, and assert both positive cases (globs, quotes, pipes, `&&`, `\n`, env prefixes, `2>&1`) and negative cases (`rm`, `sudo`, `pacman -S`, `curl | sh`, `$(...)`, backticks, `> file`, `\n` chaining).

## Debugging unexpected prompts

Check in order when a command still prompts under `"agentMode": "auto"`:

1. Confirm `"agentMode": "auto"` in the active `~/.gemini/antigravity-cli/settings.json` (and `~/.gemini/antigravity/settings.json` if included from it).
2. Determine whether the command triggered `RequiresExactMatch` (`*`, `$`, redirection, non-plain binary name, `git -c`).
   - If `exactMatch=false`: verify every subcommand matches a plain `command(...)` entry (or that the full raw command matches a `command(regex:...)` rule via `checkCompound`'s `ASK` fallback).
   - If `exactMatch=true`: verify the trimmed raw command matches `^(?:<pattern>)$` in Go `regexp`.
3. Check whether an `ask` or `deny` rule matched first (`Deny > Ask > Allow`).
4. Check active `PreToolUse` hooks (`~/.gemini/config/hooks.json`). A hook returning `deny` blocks before execution; verify live whether any hook returning `{"decision":"ask"}` prompts independently of `permissions.allow`.
