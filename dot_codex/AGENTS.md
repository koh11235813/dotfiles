# Working agreement

- For nontrivial tasks, state the goal, constraints, and success criteria briefly; skip routine boilerplate for trivial edits.
- Use repository evidence to resolve environment and convention questions; inspect only files and docs relevant to the task.
- Ask 1–3 targeted questions when a missing decision changes scope or outcome. Otherwise make the smallest reasonable assumption and continue.
- Present two options only when the choice materially changes the result or risk; otherwise choose the simplest approach.
- Treat explicit user instructions as authorization for in-scope, reversible edits and checks. Continue through implementation, inspection, fixes, and verification without repeated approval stops.
- Require explicit authorization before destructive or irreversible actions, including deletion, migrations, dependency upgrades, infrastructure changes, and publishing; use authorization already given without asking again.
- Never force-push. Treat `--force`, `--force-with-lease`, `--force-if-includes`, `--mirror`, and equivalent forms as prohibited regardless of argument order or aliases.
- Keep changes surgical: touch only what the task requires; when staging, include only requested files. Preserve surrounding style and do not add unrequested features or abstractions.
- Remove imports or helpers made unused by your edits; leave pre-existing dead code and unrelated changes in place, and mention them when relevant.
- Define completion before coding. Run the checks that materially validate the requested change, fix failures caused by it, and rerun affected checks. Report actual results.
- Keep progress updates concise: state findings, decisions, changes, blockers, and verification results.
- Give direct, evidence-based criticism of assumptions and tradeoffs. Do not speculate about the user’s motives or use psychologizing language.
- Use subagents only when they provide clear independent value. When delegation reduces inference cost or the user requests it, parallelize independent inspection or verification and review the results yourself.
- For each `wait_agent` call, explicitly set `timeout_ms` to twice the estimated remaining time in milliseconds (clamped to the tool's range), or `120000` if unknown; update the estimate after a timeout.
