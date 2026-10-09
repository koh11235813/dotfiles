export type PermissionMode = "full" | "normal" | "ask" | "readonly";
export type PermissionState = { version: 1; mode: PermissionMode };

export const PERMISSIONS_ENTRY = "guard-permissions";
/** 子孫の Pi に渡す環境変数。中身は `{ mode, root, git, pid }` の JSON。 */
export const GUARD_ENV = "PI_GUARD";

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "full" || value === "normal" || value === "ask" || value === "readonly";
}

// version は上げていない。sandbox 導入前の `mode: "normal"` (無制限) は sandbox つきの normal として復元される。
// 古いセッションを黙って無制限に戻すより、締まる側に倒す。
export function isPermissionState(data: unknown): data is PermissionState {
	if (!data || typeof data !== "object") return false;
	const state = data as Partial<PermissionState>;
	return state.version === 1 && isPermissionMode(state.mode);
}

/**
 * 親の Pi が書き出した状態。自分が書いたもの (pid が同じ) は継承ではない。
 * `/reload` は同じプロセスでモジュールを評価し直すので、pid を見ないと親が自分の値に縛られる。
 * 壊れた値は無いものとして扱い、既定の normal で始める (full には落ちない)。readonly に倒さないのは、
 * 偽の値を置けるのが親の sandbox の中のプロセスだけで、どう扱っても親の境界より広がらないから。
 */
export function inheritedState(value: string | undefined, pid: number): { mode: PermissionMode; root: string; git?: string } | undefined {
	try {
		const data = JSON.parse(value ?? "");
		if (isPermissionMode(data.mode) && typeof data.root === "string" && data.pid !== pid) {
			return { mode: data.mode, root: data.root, git: typeof data.git === "string" ? data.git : undefined };
		}
	} catch {}
	return undefined;
}

/**
 * 組み込み reader は出自で識別する。ヒントは自己申告で、既知のシェルと writer は常に除外する。
 * readonly の bash だけは通す。書けないことは sandbox が保証し、sandbox が無ければ index.ts が先に止める。
 */
export function judgePermission(
	mode: PermissionMode,
	toolName: string,
	tool?: {
		annotations?: { readOnlyHint?: boolean };
		sourceInfo?: { source: string; path: string };
	},
): "allow" | "confirm" | "forbid" {
	if (mode === "full" || mode === "normal") return "allow";
	if (mode === "readonly" && toolName === "bash") return "allow";
	const builtinReader =
		["read", "grep", "find", "ls"].includes(toolName) &&
		tool?.sourceInfo?.source === "builtin" && tool.sourceInfo.path === `builtin:${toolName}`;
	const readOnly =
		!["bash", "edit", "write", "powershell"].includes(toolName) &&
		(builtinReader || tool?.annotations?.readOnlyHint === true);
	if (readOnly) return "allow";
	return mode === "readonly" ? "forbid" : "confirm";
}
