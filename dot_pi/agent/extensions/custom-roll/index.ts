import { randomInt } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Roll = { version: 1; name: string; content: string };

function isRoll(data: unknown): data is Roll {
	if (!data || typeof data !== "object") return false;
	const roll = data as Partial<Roll>;
	return roll.version === 1 && typeof roll.name === "string" &&
		typeof roll.content === "string" && !!roll.content.trim();
}

function chooseRoll(): Roll | undefined {
	const agentDir = (process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"))
		.replace(/^~(?=\/|$)/, homedir());
	const dir = join(agentDir, "custom-roll");
	const rolls: Roll[] = [];
	try {
		for (const file of readdirSync(dir, { withFileTypes: true })) {
			if (!file.isFile() || !file.name.endsWith(".md")) continue;
			try {
				const content = readFileSync(join(dir, file.name), "utf8");
				if (content.trim()) rolls.push({ version: 1, name: file.name, content });
			} catch {
				// One unreadable role must not prevent using the other roles.
			}
		}
	} catch {
		// A missing or inaccessible optional role directory must not stop Pi.
	}
	return rolls.length ? rolls[randomInt(rolls.length)] : undefined;
}

export default function customRoll(pi: ExtensionAPI) {
	let roll: Roll | undefined;
	function restore(ctx: ExtensionContext) {
		roll = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "custom-roll" && isRoll(entry.data)) {
				roll = entry.data;
			}
		}
		if (!roll) {
			roll = chooseRoll();
			if (roll) pi.appendEntry("custom-roll", roll);
		}
	}
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("before_agent_start", (event) => {
		if (roll) event.systemPromptOptions.sections.custom_roll = roll.content;
		else delete event.systemPromptOptions.sections.custom_roll;
	});
}
