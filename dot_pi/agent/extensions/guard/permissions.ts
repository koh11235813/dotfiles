export type PermissionMode = "normal" | "ask" | "readonly";
export type PermissionState = { version: 1; mode: PermissionMode };

export const PERMISSIONS_ENTRY = "guard-permissions";

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "normal" || value === "ask" || value === "readonly";
}

export function isPermissionState(data: unknown): data is PermissionState {
	if (!data || typeof data !== "object") return false;
	const state = data as Partial<PermissionState>;
	return state.version === 1 && isPermissionMode(state.mode);
}

/** 組み込み reader は出自で識別する。ヒントは自己申告で、既知のシェルと writer は常に除外する。 */
export function judgePermission(
	mode: PermissionMode,
	toolName: string,
	tool?: {
		annotations?: { readOnlyHint?: boolean };
		sourceInfo?: { source: string; path: string };
	},
): "allow" | "confirm" | "forbid" {
	if (mode === "normal") return "allow";
	const builtinReader =
		["read", "grep", "find", "ls"].includes(toolName) &&
		tool?.sourceInfo?.source === "builtin" && tool.sourceInfo.path === `builtin:${toolName}`;
	const readOnly =
		!["bash", "edit", "write", "powershell"].includes(toolName) &&
		(builtinReader || tool?.annotations?.readOnlyHint === true);
	if (readOnly) return "allow";
	return mode === "readonly" ? "forbid" : "confirm";
}
