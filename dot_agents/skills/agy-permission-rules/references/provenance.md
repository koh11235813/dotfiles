# Binary Provenance (`agy 1.5.10`)

Observed from Mach-O symbol disassembly (`debug/macho`, `debug/gosym`, `/usr/bin/objdump`) of `/Users/kinoko/.local/bin/agy` version `1.5.10` (`darwin_arm64`) on 2026-11-18/19.

## Inspected symbols

| Symbol | Internal Go source | Address range | Observed behavior |
|---|---|---|---|
| `shared.ParseCLIGrantString` | `third_party/jetski/cortex/shared/permission_grant.go:143` | `0x100dfb560..0x100dfb990` | Extracts `action` and inner target via `regexp.(*Regexp).FindStringSubmatch`; accepts nested `)` inside `command(regex:...)`. |
| `shared.PermissionGrant.Covers` | `third_party/jetski/cortex/shared/permission_grant.go:275` | `0x100dfc3f0..0x100dfc970` | Dispatches command grants to `coversCommand`. |
| `shared.coversCommand` | `third_party/jetski/cortex/shared/permission_resource.go:294` | `0x100dfd320..0x100dfd470` | Returns `true` for `*`; routes `exactMatch=true` to `MatchesConfigAnyRaw` and `exactMatch=false` to `extractSimpleCommands` + `MatchesConfigAny(..., allowPrefix=true)`. |
| `commandutils.matchParts` | `command_matching.go:13` | `0x100b5e2e0..0x100b5e4b0` | Word-by-word comparison (with optional `allowPrefix` and `isRegex`). |
| `commandutils.MatchesConfig` | `command_matching.go:47` | `0x100b5e4b0..0x100b5e5f0` | Wrapper invoking `matchParts`. |
| `commandutils.MatchesConfigAny` | `command_matching.go:79` | `0x100b5e5f0..0x100b5e720` | Trims rule, strips `"regex:"`, splits pattern string via `SplitCommandStringToParts`, calls `MatchesConfig`. |
| `commandutils.MatchesConfigAnyRaw` | `command_matching.go:111` | `0x100b5e720..0x100b5e8d0` | Trims rule and command; if `"regex:"`, compiles `"^(?:" + pat + ")$"` with Go `regexp`; otherwise checks exact equality (`runtime.memequal`). |
| `terminal.extractSimpleCommands` | `third_party/jetski/terminal/parse_utils.go:164` | `0x100b54560..0x100b54650` | Parses shell AST (`mvdan/sh`) into simple command word slices. |
| `terminal.hasUnsafeRune` | `third_party/jetski/terminal/parse_utils.go:504` | `0x100b55400..0x100b55500` | Rejects non-ASCII unsafe/control/Unicode-space runes from plain matching. |
| `terminal.isPlainCommandName` | `third_party/jetski/terminal/parse_utils.go:520` | `0x100b55500..0x100b555f0` | Requires single ASCII literal word containing none of `\`, `'`, `"`, `` ` ``, `$`. |
| `terminal.ExtractAllWordsClean` | `third_party/jetski/terminal/parse_utils.go:579` | `0x100b558c0..0x100b559a0` | Walks parsed `mvdan/sh` AST for words, falling back to `strings.Fields` on parse error. |
| `terminal.SplitCommandStringToParts` | `third_party/jetski/terminal/parse_utils.go:602` | `0x100b559a0..0x100b55a30` | Uses single simple-command words when `!RequiresExactMatch`, else falls back to `ExtractAllWordsClean`. |
| `terminal.hasGlobOrBraceOrVarExpansion` | `third_party/jetski/terminal/parse_utils.go:612` | `0x100b55a30..0x100b55b10` | Walks `mvdan/sh` AST for globs, brace expansion, or variable expansion. |
| `terminal.callExprRequiresExactMatch` | `third_party/jetski/terminal/parse_utils.go:863` | `0x100b56120..0x100b565e0` | Checks plain command name, expansion, redirections, `gitHgTouchesConfigOrRemote`, and hijacking flags. |
| `terminal.RequiresExactMatch` | `third_party/jetski/terminal/parse_utils.go:1396` | `0x100b57390..0x100b574d0` | Top-level exact-match predicate invoked by `checkLocal` and `SplitCommandStringToParts`. |
| `permissions.(*permissionManager).EnsurePermissions` | `third_party/jetski/cortex/permissions/permission_manager.go:564` | `0x10166b9c0..0x10166cff0` | Orchestrates custom owners, grant parsing, and permission checks. |
| `permissions.(*permissionManager).checkSingleTarget` | `third_party/jetski/cortex/permissions/permission_manager.go:801` | `0x10166cff0..0x10166d0d0` | Calls `checkSingleTargetOnce`; on `ASK` (`1`) with settings refresh handle, calls `refreshFromSettingsStore` and retries once. |
| `permissions.(*permissionManager).checkSingleTargetOnce` | `third_party/jetski/cortex/permissions/permission_manager.go:810` | `0x10166d0d0..0x10166e810` | Evaluates one target against `PermissionGrantStore`. |
| `permissions.(*permissionManager).checkLocal` | `third_party/jetski/cortex/permissions/permission_manager.go:1044` | `0x10166eb60..0x10166f240` | Splits command; routes to `checkSingleTarget(..., exactMatch=true)` or `checkCompound`. |
| `permissions.(*permissionManager).checkCompound` | `third_party/jetski/cortex/permissions/permission_manager.go:1135` | `0x10166f240..0x10166f4c0` | Checks each subcommand (`exactMatch=false`); stops on `DENY` (`0`), falls back at line `1168` (`0x10166f418`) to `checkSingleTarget(rawCmd, exactMatch=true)` on overridable `ASK` (`1`). |
| `permissions.(*PermissionGrantStore).LookupEffective` | `third_party/jetski/cortex/permissions/permission_grant_store.go:397` | `0x101667360..0x101667500` | Read-locks store and delegates to `findMatchInList`. |
| `permissions.(*PermissionGrantStore).findMatchInList` | `third_party/jetski/cortex/permissions/permission_grant_store.go:479` | `0x101667d50..0x101667f40` | Linearly matches via `grantMatchesResource` (checking `isExecuteURLAskSupersededByAllow`). |
| `permissions.(*PermissionGrantStore).grantMatchesResource` | `third_party/jetski/cortex/permissions/permission_grant_store.go:493` | `0x101667f40..0x101668330` | Invokes grant coverage matching against the requested resource. |

## Secondary matcher observed

- `command.matchesRegexAny` (`third_party/jetski/cortex/command/auto_run.go:15`, `0x1015ddda0..0x1015dde90`): joins command words with `" "` (`strings.Join`) and runs `regexp.MatchString`.
- `command.CheckCommandLists` (`third_party/jetski/cortex/command/auto_run.go:96`, `0x1015dde90..0x1015de2d0`): checks legacy allow/deny/regex command lists via `SplitCommandStringToParts`, `MatchesConfigAny`, `MatchesConfigAnyRaw`, and `matchesRegexAny`.

## Unverified boundary

- `hooks.(*PreToolHookConverter).applyPreToolHooks` (`third_party/jetski/cortex/customization/hooks/pretoolhook.go:144`, `0x101727d70..0x1017284c0`): confirmed `decision == "deny"` rejection and `continue` -> `"allow"`/`"deny"` normalization. Whether a `PreToolUse` hook returning `{"decision":"ask"}` overrides a `permissions.allow` match was not traced to its caller and must be verified live.

## Re-verifying after an `agy` upgrade

1. Run `agy --version` and confirm the binary path (`which agy`).
2. Load the Mach-O `__gopclntab` section with Go `debug/macho` + `debug/gosym` and search for `coversCommand`, `MatchesConfigAny`, `MatchesConfigAnyRaw`, `RequiresExactMatch`, `checkLocal`, and `checkCompound`.
3. Disassemble those address ranges with `/usr/bin/objdump -d --start-address=... --stop-address=...` and confirm whether:
   - `MatchesConfigAny` still runs `SplitCommandStringToParts` on `regex:` patterns,
   - `MatchesConfigAnyRaw` still uses `memequal` for non-regex rules and `^(?:...)$` for `regex:` rules, and
   - `checkCompound` still falls back to `exactMatch=true` on overridable `ASK`.
