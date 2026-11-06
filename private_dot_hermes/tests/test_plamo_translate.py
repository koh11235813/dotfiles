import importlib.util
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


PLUGIN = Path(__file__).resolve().parents[1] / "plugins/plamo-translate/__init__.py"
spec = importlib.util.spec_from_file_location("plamo_translate", PLUGIN)
assert spec is not None and spec.loader is not None
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class TranslationTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.responses = ["確認が完了した。"]
        self.status = 200
        self.finish_reason = "stop"
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                owner.requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                if owner.status != 200:
                    self.send_response(owner.status)
                    self.send_header("Location", owner.settings["base_url"] + "/redirected")
                    self.end_headers()
                    return
                content = owner.responses.pop(0)
                body = json.dumps({"choices": [{"message": {"content": content}, "finish_reason": owner.finish_reason}]}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.settings = {"base_url": f"http://127.0.0.1:{self.server.server_port}"}
        self.registrations = []
        ctx = SimpleNamespace(
            get_config=lambda key, default=None: self.settings.get(key, default),
            register_hook=lambda name, callback, **kwargs: self.registrations.append((name, callback, kwargs)),
        )
        plugin.register(ctx)
        name, self.translate, options = self.registrations[0]
        self.assertEqual(name, "transform_llm_output")
        self.assertEqual(options, {"hold_stream": True})

    def test_code_paths_urls_and_special_tokens_survive_translation(self):
        source = "Run `git status` in /tmp/repo and visit https://example.org/x. Literal <|plamo:tag|>.\n\n```sh\necho hello\n```\n"
        self.responses = ["⟦KEEP0⟧を⟦KEEP1⟧で実行し、⟦KEEP2⟧を開く。リテラル⟦KEEP3⟧。"]
        result = self.translate(response_text=source)
        self.assertEqual(result, "`git status`を/tmp/repoで実行し、https://example.org/xを開く。リテラル<|plamo:tag|>。\n\n```sh\necho hello\n```\n")
        request_text = self.requests[0]["messages"][-1]["content"]
        self.assertNotIn("<|plamo:", request_text)
        self.assertNotIn("echo hello", request_text)
        self.assertNotIn("git status", request_text)

    def test_multiple_paragraphs_and_code_only_or_japanese_are_preserved(self):
        self.responses = ["最初の確認だ。", "次の確認だ。"]
        source = "First check.\n\n~~~sh\necho hello\n~~~\n\nNext check.\n"
        self.assertEqual(self.translate(response_text=source), "最初の確認だ。\n\n~~~sh\necho hello\n~~~\n\n次の確認だ。\n")
        for source in ("", "```py\nprint('hello')\n", "確認したわ。`git status`", "    echo hello\n", "https://example.org"):
            self.assertEqual(self.translate(response_text=source), source)
        self.assertEqual(len(self.requests), 2)

    def test_missing_placeholder_falls_back_without_partial_translation(self):
        self.responses = ["最初の確認だ。", "コマンドを実行する。"]
        source = "First check.\n\nRun `git status`."
        self.assertEqual(self.translate(response_text=source), source)

    def test_rejects_nonlocal_endpoint_before_sending_text(self):
        self.settings["base_url"] = "https://example.org"
        source = "Private answer."
        with patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("no network")) as network:
            self.assertEqual(self.translate(response_text=source), source)
            network.assert_not_called()
        self.assertEqual(self.requests, [])

    def test_long_paragraph_is_bounded_without_losing_text(self):
        source = ("This is a complete sentence. " * 100).strip()
        self.responses = ["確認した。"] * 10
        result = self.translate(response_text=source)
        self.assertNotEqual(result, source)
        self.assertGreater(len(self.requests), 1)
        texts = [request["messages"][-1]["content"] for request in self.requests]
        self.assertTrue(all(len(text) <= 1600 for text in texts))
        self.assertEqual(" ".join(text.strip() for text in texts), source)

    def test_http_failure_and_redirect_do_not_discard_or_forward_answer(self):
        source = "Keep my original answer."
        for status in (500, 307):
            self.status = status
            self.requests.clear()
            self.assertEqual(self.translate(response_text=source), source)
            self.assertEqual(len(self.requests), 1)

    def test_truncated_output_returns_original(self):
        self.finish_reason = "length"
        source = "Keep the complete answer."
        self.assertEqual(self.translate(response_text=source), source)

    def test_network_timeout_returns_original(self):
        source = "Keep the answer on timeout."
        with patch("urllib.request.OpenerDirector.open", side_effect=TimeoutError):
            self.assertEqual(self.translate(response_text=source), source)

    def test_form_and_context_are_forwarded_explicitly(self):
        self.settings.update(form="polite", context="The speaker is a goddess.")
        self.translate(response_text="The checks have finished.")
        kwargs = self.requests[0]["chat_template_kwargs"]
        self.assertEqual(kwargs["form"], "polite")
        self.assertEqual(kwargs["context"], "The speaker is a goddess.")

    def test_invalid_translation_returns_original_instead_of_withholding_reply(self):
        self.responses = [None]
        source = "Keep this answer if translation fails."
        self.assertEqual(self.translate(response_text=source), source)

    def test_hook_returns_only_japanese_and_explicit_translation_request(self):
        result = self.translate(response_text="The checks have finished.", session_id="test", future_field=True)
        self.assertEqual(result, "確認が完了した。")
        request = self.requests[0]
        self.assertEqual(request["chat_template_kwargs"]["source_lang"], "en")
        self.assertEqual(request["chat_template_kwargs"]["target_lang"], "ja")
        self.assertNotIn("form", request["chat_template_kwargs"])
        self.assertFalse(request["stream"])


if __name__ == "__main__":
    unittest.main()
