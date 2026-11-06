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
        scratch = Path(os.environ.get("TMPDIR", Path.home() / ".hermes/cache/scratch"))
        scratch.mkdir(parents=True, exist_ok=True)
        workspace = tempfile.TemporaryDirectory(prefix="hermes-custom-roll-", dir=scratch)
        self.addCleanup(workspace.cleanup)
        self.root = Path(workspace.name)
        self.source = self.root / "source"
        self.home = self.root / "home with spaces"
        self.source.mkdir()
        self.home.mkdir()
        self.hermes_home = self.home / ".hermes"
        self.hermes_home.mkdir(mode=0o700)
        self.env = {**os.environ, "HOME": str(self.home), "HERMES_HOME": str(self.hermes_home), "TMPDIR": str(scratch)}
        self.shared_role = self.source / "dot_agents/custom-roll/ereshkigal.md"
        self.shared_role.parent.mkdir(parents=True)
        self.shared_content = (ROOT / "dot_agents/custom-roll/ereshkigal.md").read_bytes()
        self.shared_role.write_bytes(self.shared_content)
        self.role = self.source / "private_dot_hermes/custom-roll/ereshkigal.md"
        self.role.parent.mkdir(parents=True)
        self.content = '# Role Setting: Ereshkigal\n\nWrite final answers in English.\n$(touch "$HERMES_HOME/evaluated")\n'
        self.role.write_text(self.content, encoding="utf-8")
        shutil.copytree(
            ROOT / "private_dot_hermes/plugins/plamo-translate",
            self.source / "private_dot_hermes/plugins/plamo-translate",
            ignore=shutil.ignore_patterns("__pycache__"),
        )
        self.config = self.hermes_home / "config.yaml"
        self.config.write_text(json.dumps({
            "model": {"default": "preserved-model"},
            "agent": {"max_turns": 37, "system_prompt": "manual overlay", "personalities": {"other": "Keep me"}},
            "display": {"skin": "default", "personality": "other"},
            "plugins": {"enabled": ["preserved-plugin"]},
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

    def assert_shared_unchanged(self):
        self.assertEqual(self.shared_role.read_bytes(), self.shared_content)
        self.assertEqual((ROOT / "dot_agents/custom-roll/ereshkigal.md").read_bytes(), self.shared_content)
        self.assertEqual((self.home / ".agents/custom-roll/ereshkigal.md").read_bytes(), self.shared_content)

    def test_apply_registers_hermes_markdown_as_selected_personality(self):
        self.apply()

        self.assertEqual(self.get("personalities.custom-roll.system_prompt"), self.content.rstrip("\n"))
        self.assertEqual(self.get("display.personality"), "custom-roll")
        self.assertEqual(self.get("model.default"), "preserved-model")
        self.assertEqual(self.get("agent.max_turns"), 37)
        self.assertEqual(self.get("agent.system_prompt"), "manual overlay")
        self.assertEqual(self.get("agent.personalities.other"), "Keep me")
        self.assertEqual(self.get("display.skin"), "default")
        self.assertIn("plamo-translate", self.get("plugins.enabled"))
        self.assertIn("preserved-plugin", self.get("plugins.enabled"))
        self.assertFalse((self.hermes_home / "evaluated").exists())
        self.assert_shared_unchanged()
        self.assertEqual((self.hermes_home / "custom-roll/ereshkigal.md").read_text(encoding="utf-8"), self.content)

    def test_unchanged_apply_preserves_manual_personality_selection(self):
        self.apply()
        result = self.command(shutil.which("hermes"), "config", "set", "display.personality", "none")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        result = self.command(shutil.which("hermes"), "plugins", "disable", "plamo-translate")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        before = self.config.read_bytes()

        self.apply()

        self.assertEqual(self.config.read_bytes(), before)
        self.assertEqual(self.get("display.personality"), "none")

    def test_role_markdown_is_registered_without_yaml_warnings(self):
        role = ROOT / "private_dot_hermes/custom-roll/ereshkigal.md"
        self.assertTrue(role.is_file(), "Hermes-only English role is missing")
        content = role.read_text(encoding="utf-8")
        self.assertIn("Write final answers in English", content)
        self.assertIn("Do not output these Japanese examples", content)
        self.role.write_text(content, encoding="utf-8")

        result = self.apply()

        self.assertNotIn("Warning:", result.stderr)
        self.assertEqual(self.get("personalities.custom-roll.system_prompt"), content.rstrip("\n"))
        self.assert_shared_unchanged()

    def test_role_change_refreshes_registered_body(self):
        self.apply()
        updated = "# Role Setting: Ereshkigal\n\nUpdated English body (no trailing newline)."
        self.role.write_text(updated, encoding="utf-8")

        self.apply()

        self.assertEqual(self.get("personalities.custom-roll.system_prompt"), updated)
        self.assertEqual(self.get("display.personality"), "custom-roll")
        self.assert_shared_unchanged()


if __name__ == "__main__":
    unittest.main()
