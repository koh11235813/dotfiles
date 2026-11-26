#!/usr/bin/env python3
"""Tests for .github/scripts/check_json.py (stdlib unittest only)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_json


class CheckJsonTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def write(self, name: str, content: str) -> Path:
        p = self.dir / name
        p.write_text(content, encoding="utf-8")
        return p

    def test_valid_and_invalid_json(self):
        ok = self.write("ok.json", '{"a": 1, "b": "x"}\n')
        bad = self.write("bad.json", '{"a": }\n')
        self.assertEqual(check_json.check_file(ok), [])
        errs = check_json.check_file(bad)
        self.assertEqual(len(errs), 1)
        self.assertIn("invalid JSON", errs[0])

    def test_jsonc_strips_comments_and_preserves_urls_in_strings(self):
        p = self.write(
            "ok.jsonc",
            """{
  // leading comment
  "url": "https://example.com/a//b/*not-comment*/",
  /* block
     comment */
  "escaped": "quote \\" // still string",
  "ok": true
}
""",
        )
        schema = {
            "type": "object",
            "required": ["url", "ok"],
            "properties": {
                "url": {"type": "string"},
                "escaped": {"type": "string"},
                "ok": {"type": "boolean"},
            },
        }
        self.assertEqual(check_json.check_file(p, schema=schema), [])

    def test_jsonl_valid_lines_and_blank_lines(self):
        p = self.write(
            "ok.jsonl",
            '{"id": "a", "count": 1}\n\n{"id": "b", "count": 2}\n',
        )
        schema = {
            "type": "object",
            "required": ["id", "count"],
            "properties": {
                "id": {"type": "string"},
                "count": {"type": "integer", "minimum": 0},
            },
        }
        self.assertEqual(check_json.check_file(p, schema=schema), [])

    def test_jsonl_reports_exact_line_on_syntax_and_type_errors(self):
        p = self.write(
            "bad.jsonl",
            '{"id": "a", "count": 1}\n'
            '{"id": "b", "count": true}\n'
            '{broken\n',
        )
        schema = {
            "type": "object",
            "required": ["id", "count"],
            "properties": {
                "id": {"type": "string"},
                "count": {"type": "integer"},
            },
        }
        errs = check_json.check_file(p, schema=schema)
        self.assertEqual(len(errs), 2)
        self.assertIn(":2: $.count: expected integer, got boolean", errs[0])
        self.assertIn(":3: invalid JSONL line", errs[1])

    def test_schema_validation_nested_enum_and_additional_properties(self):
        schema = {
            "type": "object",
            "required": ["items"],
            "properties": {
                "mode": {"type": "string", "enum": ["allow", "deny"]},
                "items": {
                    "type": "array",
                    "minItems": 1,
                    "items": {"type": "string"},
                },
            },
            "additionalProperties": False,
        }
        p = self.write(
            "bad_schema.json",
            json.dumps({"mode": "ask", "items": [123], "extra": True}),
        )
        errs = check_json.check_file(p, schema=schema)
        self.assertEqual(len(errs), 3)
        joined = "\n".join(errs)
        self.assertIn("$.mode: value 'ask' not in enum", joined)
        self.assertIn("$.items[0]: expected string, got integer", joined)
        self.assertIn("unexpected property 'extra'", joined)


if __name__ == "__main__":
    unittest.main(verbosity=2)
