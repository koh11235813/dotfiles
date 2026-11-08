import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = Path(".chezmoiscripts/run_onchange_after_hermes-custom-roll.sh.tmpl")


class CustomRollTests(unittest.TestCase):
    def setUp(self):
        workspace = tempfile.TemporaryDirectory(prefix="hermes-custom-roll-")
        self.addCleanup(workspace.cleanup)
        self.root = Path(workspace.name)
        self.source = self.root / "source"
        self.home = self.root / "home with spaces"
        self.source.mkdir()
        self.home.mkdir()
        self.hermes_home = self.home / ".hermes"
        self.hermes_home.mkdir(mode=0o700)
        self.env = {**os.environ, "HERMES_HOME": str(self.hermes_home)}
        self.role = self.source / "dot_agents/custom-roll/ereshkigal.md"
        self.role.parent.mkdir(parents=True)
        self.content = '# Role Setting: エレシュキガル\n\n「私」の口調。\n$(touch "$HERMES_HOME/evaluated")\n'
        self.role.write_text(self.content, encoding="utf-8")
        self.config = self.hermes_home / "config.yaml"
        self.config.write_text(json.dumps({
            "model": {"default": "preserved-model"},
            "agent": {"max_turns": 37, "system_prompt": "manual overlay", "personalities": {"other": "Keep me"}},
            "display": {"skin": "default", "personality": "other"},
        }), encoding="utf-8")
        self.assertTrue((ROOT / TEMPLATE).is_file(), "custom-roll の chezmoi 登録処理がない")
        target = self.source / TEMPLATE
        target.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / TEMPLATE, target)

    def command(self, *args):
        return subprocess.run(args, env=self.env, text=True, capture_output=True, timeout=60)

    def apply(self):
        result = self.command(
            shutil.which("chezmoi"), "--source", str(self.source),
            "--destination", str(self.home), "--config", "/dev/null", "--config-format", "toml",
            "--persistent-state", str(self.root / "state.boltdb"),
            "--cache", str(self.root / "cache"), "--no-tty", "apply",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def get(self, key):
        result = self.command(shutil.which("hermes"), "config", "get", "--json", key)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_apply_registers_shared_markdown_as_selected_personality(self):
        self.apply()

        self.assertEqual(self.get("agent.personalities.custom-roll.system_prompt"), self.content.rstrip("\n"))
        self.assertEqual(self.get("display.personality"), "custom-roll")
        self.assertEqual(self.get("model.default"), "preserved-model")
        self.assertEqual(self.get("agent.max_turns"), 37)
        self.assertEqual(self.get("agent.system_prompt"), "manual overlay")
        self.assertEqual(self.get("agent.personalities.other"), "Keep me")
        self.assertEqual(self.get("display.skin"), "default")
        self.assertFalse((self.hermes_home / "evaluated").exists())
        self.assertEqual((self.home / ".agents/custom-roll/ereshkigal.md").read_text(encoding="utf-8"), self.content)

    def test_unchanged_apply_preserves_manual_personality_selection(self):
        self.apply()
        result = self.command(shutil.which("hermes"), "config", "set", "display.personality", "none")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        before = self.config.read_bytes()

        self.apply()

        self.assertEqual(self.config.read_bytes(), before)
        self.assertEqual(self.get("display.personality"), "none")

    def test_role_markdown_is_registered_without_yaml_warnings(self):
        self.role.write_bytes((ROOT / "dot_agents/custom-roll/ereshkigal.md").read_bytes())

        result = self.apply()

        self.assertNotIn("Warning:", result.stderr)

    def test_role_change_refreshes_registered_body(self):
        self.apply()
        updated = "# Role Setting: エレシュキガル\n\n更新した本文（末尾の改行なし）。"
        self.role.write_text(updated, encoding="utf-8")

        self.apply()

        self.assertEqual(self.get("agent.personalities.custom-roll.system_prompt"), updated)
        self.assertEqual(self.get("display.personality"), "custom-roll")


if __name__ == "__main__":
    unittest.main()
