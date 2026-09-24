import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "executable_permission_review.py"
SPEC = importlib.util.spec_from_file_location("permission_review", MODULE_PATH)
review = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review)


class PermissionReviewTests(unittest.TestCase):
    CWD = "/tmp/permission-review-test"
    COMMAND = "find /tmp/permission-review-test/build -type f -name '*.tmp' -delete"

    def test_only_simple_find_delete_is_eligible(self):
        self.assertIsNotNone(review.narrow_find_delete(self.COMMAND, self.CWD))
        for command in (
            "rm -rf /home", "find / -type f -name '*.tmp' -delete",
            "find . -type f -name '*.tmp' -delete",
            "find /tmp/permission-review-test/build -type f -name '*.md' -delete",
            "find /tmp/permission-review-test/build -type f -name '*.py' -delete",
            "find /tmp/permission-review-test/build -type f -name '*.tmp' -exec rm {} +",
            "find /tmp/permission-review-test/build -type f -name '*.tmp' -delete; echo done",
            "find /tmp/permission-review-test/build -type f -name *.tmp -delete",
            "find /tmp/other/build -type f -name '*.tmp' -delete",
        ):
            with self.subTest(command=command):
                self.assertIsNone(review.narrow_find_delete(command, self.CWD))
        self.assertIsNone(review.narrow_find_delete(self.COMMAND, "/tmp/other"))

    def test_non_matching_request_never_calls_a_model(self):
        event = {"hook_event_name": "PermissionRequest", "tool_name": "Bash", "cwd": self.CWD,
                 "tool_input": {"command": "rm -rf /home"}}
        with patch.object(review, "fm_available") as available:
            self.assertFalse(review.decide(event))
            available.assert_not_called()

    def test_fm_is_preferred_to_jev(self):
        event = {"hook_event_name": "PermissionRequest", "tool_name": "Bash", "cwd": self.CWD,
                 "tool_input": {"command": self.COMMAND}}
        with patch.object(review, "fm_available", return_value=True), \
             patch.object(review, "review_with_fm", return_value=True) as fm, \
             patch.object(review, "review_with_jev") as jev:
            self.assertTrue(review.decide(event))
            fm.assert_called_once()
            jev.assert_not_called()

    def test_jev_requires_high_probability_and_confidence(self):
        def response(allow, confidence):
            return io.BytesIO(json.dumps({"answers": {"permission": {
                "confidence": confidence,
                "probabilities": {"allow": allow, "defer": 1 - allow,
                                  "none_of_these": 0},
            }}}).encode())

        with patch.object(review.urllib.request, "urlopen", return_value=response(0.96, 0.8)):
            self.assertTrue(review.review_with_jev(self.COMMAND, "test-key"))
        for probability, confidence in ((0.94, 0.8), (0.96, 0.6)):
            with patch.object(review.urllib.request, "urlopen",
                              return_value=response(probability, confidence)):
                self.assertFalse(review.review_with_jev(
                    self.COMMAND, "test-key"))

    def test_backend_failure_emits_no_approval(self):
        event = {"hook_event_name": "PermissionRequest", "tool_name": "Bash", "cwd": self.CWD,
                 "tool_input": {"command": self.COMMAND}}
        output = io.StringIO()
        with patch.object(review.sys, "stdin", io.StringIO(json.dumps(event))), \
             patch.object(review.sys, "stdout", output), \
             patch.object(review, "fm_available", return_value=True), \
             patch.object(review, "review_with_fm", side_effect=TimeoutError):
            review.main()
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
