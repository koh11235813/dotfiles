import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

// Resolve the SDK from the managed Pi release without installing project dependencies.
export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (error) {
		if (!specifier.startsWith("@earendil-works/") || error.code !== "ERR_MODULE_NOT_FOUND") throw error;
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		const version = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim();
		return nextResolve(specifier, {
			...context,
			parentURL: pathToFileURL(join(agentDir, "install", "releases", version, "pi-tests.mjs")).href,
		});
	}
}

if (isMainThread) {
	const script = fileURLToPath(import.meta.url);
	const extensionsDir = join(dirname(script), "..", "extensions");
	const tests = readdirSync(extensionsDir, { recursive: true })
		.filter((path) => path.endsWith(".test.ts"))
		.sort()
		.map((path) => join(extensionsDir, path));
	const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-loader", script, "--test", ...tests], { stdio: "inherit" });
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}
