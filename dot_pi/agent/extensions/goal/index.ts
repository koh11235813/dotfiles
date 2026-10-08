import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Goal = { version: 1; text: string };

function isGoal(data: unknown): data is Goal {
	if (!data || typeof data !== "object") return false;
	const goal = data as Partial<Goal>;
	return goal.version === 1 && typeof goal.text === "string";
}

export default function (pi: ExtensionAPI) {
	let goal = "";

	function updateWidget(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		if (!goal) {
			ctx.ui.setWidget("goal", undefined);
			return;
		}
		const summary = goal.replace(/\s+/g, " ");
		ctx.ui.setWidget("goal", [
			`Goal: ${summary.length > 100 ? `${summary.slice(0, 99)}…` : summary}`,
		]);
	}

	function restore(ctx: ExtensionContext) {
		goal = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "goal" && isGoal(entry.data)) {
				goal = entry.data.text.trim();
			}
		}
		updateWidget(ctx);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.registerCommand("goal", {
		description: "Set, show, or clear the current goal",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (text) {
				goal = text === "clear" ? "" : text;
				pi.appendEntry("goal", { version: 1, text: goal } satisfies Goal);
				updateWidget(ctx);
			}
			ctx.ui.notify(goal ? `Goal: ${goal}` : "No goal is set. Use /goal TEXT to set one.", "info");
		},
	});

	pi.on("before_agent_start", (event) => {
		if (goal) {
			event.systemPromptOptions.sections.goal = goal;
		} else {
			delete event.systemPromptOptions.sections.goal;
		}
	});
}
