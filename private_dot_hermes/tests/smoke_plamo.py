"""Run against an already running local PLaMo server; no model output is mocked."""

import argparse
import importlib.util
import json
import time
from pathlib import Path
from types import SimpleNamespace


EXAMPLES = [
    "The checks have finished. No files were changed.",
    "Run `git status` in /Users/kinoko/Development/github/dotfiles.\n\n```sh\ngit status --short\n```\n",
    "Master, you did well. I am not embarrassed! I am simply glad that you are safe.\n\n"
    "As the ruler of the underworld, I will not permit this dangerous operation. Please step back.",
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--form", choices=("plain", "polite"))
    parser.add_argument("--context", help="Experimental translation context, not a system prompt")
    args = parser.parse_args()
    settings = {key: value for key, value in vars(args).items() if value is not None}
    path = Path(__file__).resolve().parents[1] / "plugins/plamo-translate/__init__.py"
    spec = importlib.util.spec_from_file_location("plamo_translate", path)
    assert spec is not None and spec.loader is not None
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    hooks = []
    plugin.register(SimpleNamespace(
        get_config=lambda key, default=None: settings.get(key, default),
        register_hook=lambda name, callback, **kwargs: hooks.append(callback),
    ))
    results = []
    for source in EXAMPLES:
        started = time.perf_counter()
        translated = hooks[0](response_text=source, session_id="plamo-smoke")
        results.append({
            "source": source, "translation": translated,
            "seconds": time.perf_counter() - started,
            "fallback": translated == source,
        })
    print(json.dumps(results, ensure_ascii=False, indent=2))
    if any(result["fallback"] for result in results):
        raise SystemExit("FAIL: at least one answer fell back to English")
    if "```sh\ngit status --short\n```" not in results[1]["translation"]:
        raise SystemExit("FAIL: code block was changed")


if __name__ == "__main__":
    main()
