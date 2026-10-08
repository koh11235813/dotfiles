import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Pi is the external boundary; session storage is the real SDK implementation. */
export function extensionHost() {
	const handlers = new Map<string, Function[]>();
	const commands = new Map<string, { handler: Function }>();
	const shortcuts = new Map<string, { handler: Function }>();
	const notices: string[] = [];
	const widgets = new Map<string, string[] | undefined>();
	const statuses = new Map<string, string | undefined>();
	const confirmations: string[] = [];
	let approved = false;
	let manager = SessionManager.inMemory(process.cwd());
	const tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean }; sourceInfo?: { source: string; path: string } }> = [
		{ name: "read", annotations: { readOnlyHint: true } },
		{ name: "bash", annotations: { readOnlyHint: false } },
		{ name: "edit", annotations: { readOnlyHint: false } },
		{ name: "write", annotations: { readOnlyHint: false } },
	];
	const ui = {
		notify: (message: string) => { notices.push(message); },
		setWidget: (key: string, lines: string[] | undefined) => { widgets.set(key, lines); },
		setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); },
		confirm: async (title: string, message: string) => { confirmations.push(`${title}\n${message}`); return approved; },
	};
	const ctx = {
		ui, cwd: process.cwd(), mode: "tui", hasUI: true,
		get sessionManager() { return manager; },
		getContextUsage: () => ({ tokens: 200, contextWindow: 1000, percent: 20 }),
		isIdle: () => true,
	} as unknown as ExtensionCommandContext;
	const pi = {
		on: (name: string, handler: Function) => {
			const list = handlers.get(name) ?? [];
			list.push(handler); handlers.set(name, list);
			return () => handlers.set(name, list.filter((item) => item !== handler));
		},
		registerCommand: (name: string, command: { handler: Function }) => { commands.set(name, command); },
		registerShortcut: (key: string, shortcut: { handler: Function }) => { shortcuts.set(key, shortcut); },
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
		getAllTools: () => tools,
	} as unknown as ExtensionAPI;
	return {
		pi, ctx, notices, widgets, statuses, confirmations, commands, shortcuts, tools,
		resetRuntime: () => { handlers.clear(); commands.clear(); shortcuts.clear(); },
		get manager() { return manager; },
		replaceSession: (next = SessionManager.inMemory(process.cwd())) => { manager = next; },
		approve: (value: boolean) => { approved = value; },
		command: async (name: string, args = "") => {
			const command = commands.get(name);
			if (!command) throw new Error(`Command /${name} is not registered`);
			return command.handler(args, ctx);
		},
		emit: async (name: string, event: Record<string, unknown> = {}) => {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx as ExtensionContext);
			return result;
		},
		prompt: async (sections: Record<string, string> = { other: "Keep me" }) => {
			for (const handler of handlers.get("before_agent_start") ?? []) {
				await handler({ type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: { sections } }, ctx);
			}
			return sections;
		},
	};
}
