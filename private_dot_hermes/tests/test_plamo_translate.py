import http.server
import importlib.util
import json
import threading
import time
import unittest
from pathlib import Path


PLUGIN = Path(__file__).resolve().parents[1] / "plugins/plamo-translate/__init__.py"
spec = importlib.util.spec_from_file_location("plamo_translate", PLUGIN)
plamo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plamo)


class FakeServer:
    """A loopback stand-in for llama-server: records each request and answers with `reply(text, kwargs)`."""

    def __init__(self, reply, finish="stop"):
        self.requests = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self._send({"status": "ok"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append(body)
                text = body["messages"][0]["content"]
                self._send({"choices": [{"finish_reason": finish,
                                         "message": {"content": reply(text, body["chat_template_kwargs"])}}]})

            def _send(self, obj):
                data = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def _serve_on(port):
    """A bare health endpoint on a fixed port, standing in for a llama-server another process started."""
    class Health(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            data = b'{"status": "ok"}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Health)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


class FakeContext:
    def __init__(self, **config):
        self.config, self.hooks = config, {}

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def register_hook(self, name, fn, **opts):
        self.hooks[name] = fn

    def register_middleware(self, kind, fn):
        self.hooks["middleware:" + kind] = fn


class PlamoTranslateTests(unittest.TestCase):
    def serve(self, reply, finish="stop"):
        server = FakeServer(reply, finish)
        self.addCleanup(server.close)
        ctx = FakeContext(base_url=server.url, model_path="/nonexistent.gguf", budget_seconds=10)
        plamo.register(ctx)
        return server, ctx

    def test_request_carries_soft_tokens_user_message_and_glossary(self):
        server, ctx = self.serve(lambda text, kw: "ふん、いいわ。")
        ctx.hooks["pre_llm_call"](session_id="s1", user_message="git の使い方を教えて", turn_id="t1")

        out = ctx.hooks["transform_llm_output"](response_text="Hmph, very well.", session_id="s1")

        self.assertEqual(out, "ふん、いいわ。")
        kw = server.requests[0]["chat_template_kwargs"]
        self.assertEqual(kw["context"], plamo.SOFT + "\ngit の使い方を教えて")
        self.assertEqual((kw["source_lang"], kw["target_lang"]), ("en", "ja"))
        self.assertEqual(kw["glossary"], plamo.GLOSSARY)
        self.assertNotIn("form", kw)
        self.assertEqual(server.requests[0]["temperature"], 0)

    def test_collapsed_anki_answer_is_redone_with_form_polite(self):
        server, ctx = self.serve(lambda text, kw: "説明します。仕組みはこうです。" if kw.get("form") else "説明する。仕組みはこうだ。")
        ctx.hooks["pre_llm_call"](session_id="s1", user_message="正確に答えて。DNS の TTL って何？")

        out = ctx.hooks["transform_llm_output"](response_text="I shall explain.", session_id="s1")

        self.assertEqual([r["chat_template_kwargs"].get("form") for r in server.requests], [None, "polite"])
        self.assertEqual(out, "説明します。仕組みはこうです。")

    def test_polite_anki_answer_is_not_redone(self):
        server, ctx = self.serve(lambda text, kw: "承知しました。説明します。")
        ctx.hooks["pre_llm_call"](session_id="s1", user_message="真面目に答えて")

        ctx.hooks["transform_llm_output"](response_text="Very well.", session_id="s1")

        self.assertEqual(len(server.requests), 1)

    def test_plain_warning_paragraph_is_redone_alone(self):
        en = "Hmph, here is the tip.\n\nOne caution: this deletes files.\n\nThat is all."

        def reply(text, kw):
            if kw.get("form"):
                return "ひとつ注意です。ファイルが消えます。"
            return "ふん、コツよ。\n\nひとつ注意。ファイルが消えるわ。\n\n以上よ。"
        server, ctx = self.serve(reply)

        out = ctx.hooks["transform_llm_output"](response_text=en, session_id="none")

        self.assertEqual(out, "ふん、コツよ。\n\nひとつ注意です。ファイルが消えます。\n\n以上よ。")
        self.assertEqual(server.requests[1]["messages"][0]["content"], "One caution: this deletes files.")

    def test_address_is_normalised_outside_code(self):
        _, ctx = self.serve(lambda text, kw: "あなたはこれを使いなさい。`echo あなた`")

        out = ctx.hooks["transform_llm_output"](response_text="You use this. `echo あなた`", session_id="x")

        self.assertEqual(out, "アナタはこれを使いなさい。`echo あなた`")

    def test_fenced_code_is_restored_from_the_english(self):
        en = "Look:\n\n```py\nx = 1  # keep this comment\n```"
        _, ctx = self.serve(lambda text, kw: "見なさい：\n\n```py\nx = 1  # このコメント\n```")

        out = ctx.hooks["transform_llm_output"](response_text=en, session_id="x")

        self.assertEqual(out, "見なさい：\n\n```py\nx = 1  # keep this comment\n```")

    def test_truncated_translation_falls_back_to_the_original(self):
        _, ctx = self.serve(lambda text, kw: "途中で", finish="length")

        self.assertEqual(ctx.hooks["transform_llm_output"](response_text="Long reply.", session_id="x"), "Long reply.")

    def test_non_loopback_url_falls_back_to_the_original(self):
        ctx = FakeContext(base_url="http://example.com:8091")
        plamo.register(ctx)

        self.assertEqual(ctx.hooks["transform_llm_output"](response_text="Hello.", session_id="x"), "Hello.")

    def test_missing_server_and_model_fall_back_to_the_original(self):
        ctx = FakeContext(base_url="http://127.0.0.1:9", model_path="/nonexistent.gguf", budget_seconds=2)
        plamo.register(ctx)

        self.assertEqual(ctx.hooks["transform_llm_output"](response_text="Hello.", session_id="x"), "Hello.")


    def test_long_reply_falls_back_to_paragraphs(self):
        def reply(text, kw):
            return "段落の訳よ。"
        server = FakeServer(reply, finish="stop")
        self.addCleanup(server.close)
        original = server.httpd.RequestHandlerClass.do_POST

        def do_post(handler):
            body = json.loads(handler.rfile.read(int(handler.headers["Content-Length"])))
            server.requests.append(body)
            whole = "\n\n" in body["messages"][0]["content"]
            handler._send({"choices": [{"finish_reason": "length" if whole else "stop",
                                        "message": {"content": "途中" if whole else "段落の訳よ。"}}]})
        server.httpd.RequestHandlerClass.do_POST = do_post
        self.addCleanup(setattr, server.httpd.RequestHandlerClass, "do_POST", original)
        ctx = FakeContext(base_url=server.url, model_path="/nonexistent.gguf", budget_seconds=10)
        plamo.register(ctx)

        out = ctx.hooks["transform_llm_output"](response_text="First.\n\nSecond.", session_id="x")

        self.assertEqual(out, "段落の訳よ。\n\n段落の訳よ。")
        self.assertEqual(len(server.requests), 3)

    def test_user_message_is_capped_in_context(self):
        server, ctx = self.serve(lambda text, kw: "ふん。")
        ctx.hooks["pre_llm_call"](session_id="s", user_message="ログ" * 5000)

        ctx.hooks["transform_llm_output"](response_text="Hmph.", session_id="s")

        self.assertEqual(len(server.requests[0]["chat_template_kwargs"]["context"]), len(plamo.SOFT) + 1 + plamo.USER_CHARS)

    def test_inline_code_is_restored_from_the_english(self):
        _, ctx = self.serve(lambda text, kw: "`権限がありません` と出たら `sudo` を使いなさい。")

        out = ctx.hooks["transform_llm_output"](response_text="If you see `Permission denied`, use `sudo`.", session_id="x")

        self.assertEqual(out, "`Permission denied` と出たら `sudo` を使いなさい。")

    def test_subagent_reply_is_left_for_the_parent(self):
        server, ctx = self.serve(lambda text, kw: "訳")
        ctx.hooks["pre_llm_call"](session_id="child", user_message="task", parent_session_id="parent")

        self.assertIsNone(ctx.hooks["transform_llm_output"](response_text="Report: done.", session_id="child"))
        self.assertEqual(server.requests, [])

    def test_server_started_elsewhere_is_used_after_our_start_fails(self):
        import os, socket, stat, tempfile
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        model = Path(tmp.name) / "m.gguf"
        model.write_bytes(b"")
        fake = Path(tmp.name) / "llama-server"
        fake.write_text("#!/bin/sh\nexit 1\n")
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        old_path = os.environ["PATH"]
        os.environ["PATH"] = tmp.name + os.pathsep + old_path
        self.addCleanup(os.environ.__setitem__, "PATH", old_path)
        late = {}
        # The other process's server comes up on the same port two seconds after ours has died.
        timer = threading.Timer(2.0, lambda: late.setdefault("srv", _serve_on(port)))
        timer.start()
        self.addCleanup(timer.cancel)
        self.addCleanup(lambda: late.get("srv") and late["srv"].shutdown())

        plamo.Server().ensure(f"http://127.0.0.1:{port}", str(model), time.monotonic() + 15)

    def test_code_answers_go_to_the_8b_when_it_is_configured(self):
        small = FakeServer(lambda text, kw: "2B の訳よ。")
        large = FakeServer(lambda text, kw: "8B の訳よ。")
        self.addCleanup(small.close)
        self.addCleanup(large.close)
        ctx = FakeContext(base_url=small.url, base_url_8b=large.url, model_path="/nonexistent.gguf",
                          model_path_8b="/nonexistent-8b.gguf", budget_seconds=10)
        plamo.register(ctx)

        code = ctx.hooks["transform_llm_output"](response_text="Run:\n\n```sh\nls\n```", session_id="x")
        chat = ctx.hooks["transform_llm_output"](response_text="Hmph, thank you.", session_id="x")

        self.assertEqual((code, chat), ("8B の訳よ。", "2B の訳よ。"))
        self.assertEqual((len(large.requests), len(small.requests)), (1, 1))

    def test_unconfigured_8b_leaves_code_answers_on_the_2b(self):
        server, ctx = self.serve(lambda text, kw: "2B の訳よ。")

        ctx.hooks["transform_llm_output"](response_text="Use `a`, `b` and `c`.", session_id="x")

        self.assertEqual(len(server.requests), 1)

    def test_unavailable_8b_falls_back_to_the_2b(self):
        small = FakeServer(lambda text, kw: "2B の訳よ。")
        self.addCleanup(small.close)
        ctx = FakeContext(base_url=small.url, base_url_8b="http://127.0.0.1:9", model_path="/nonexistent.gguf",
                          model_path_8b="/nonexistent-8b.gguf", budget_seconds=10)
        plamo.register(ctx)

        out = ctx.hooks["transform_llm_output"](response_text="Use `a`, `b` and `c`.", session_id="x")

        self.assertEqual(out, "2B の訳よ。")

    def test_paragraph_left_in_english_is_translated_again(self):
        en = "Use `!$` for the last word.\n\n...It is not as though I am trying to be helpful. Forget I said that."

        def reply(text, kw):
            if text.startswith("...It is"):
                return "……別に、親切にしたいわけじゃないのよ。今のは忘れなさい。"
            return "最後の単語には `!$` を使いなさい。\n\n...It is not as though I am trying to be helpful. Forget I said that."
        server, ctx = self.serve(reply)

        out = ctx.hooks["transform_llm_output"](response_text=en, session_id="x")

        self.assertEqual(out, "最後の単語には `!$` を使いなさい。\n\n……別に、親切にしたいわけじゃないのよ。今のは忘れなさい。")
        self.assertEqual(len(server.requests), 2)

    def test_english_command_paragraph_is_not_retranslated(self):
        en = "Run this:\n\n`git status`"
        server, ctx = self.serve(lambda text, kw: "これを実行しなさい：\n\n`git status`")

        ctx.hooks["transform_llm_output"](response_text=en, session_id="x")

        self.assertEqual(len(server.requests), 1)

    def roll_files(self):
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        en, ja = Path(tmp.name) / "en.md", Path(tmp.name) / "ja.md"
        en.write_text("Act as Ereshkigal.\nAnswer in English.\n", encoding="utf-8")
        ja.write_text("エレシュキガルとして振る舞う。\n", encoding="utf-8")
        return str(en), str(ja)

    def test_claude_session_gets_the_japanese_roll_and_no_translation(self):
        en, ja = self.roll_files()
        server = FakeServer(lambda text, kw: "訳")
        self.addCleanup(server.close)
        ctx = FakeContext(base_url=server.url, model_path="/nonexistent.gguf", en_roll=en, ja_roll=ja, budget_seconds=5)
        plamo.register(ctx)
        request = {"model": "claude-haiku-5-5", "messages": [
            {"role": "system", "content": "SOUL\n\nAct as Ereshkigal.\nAnswer in English.\n\nTools..."},
            {"role": "user", "content": "こんにちは"}]}

        out = ctx.hooks["middleware:llm_request"](request=request, model="claude-haiku-5-5")
        reply = ctx.hooks["transform_llm_output"](response_text="ふん、こんにちは。", session_id="x", model="claude-haiku-5-5")

        self.assertEqual(out["request"]["messages"][0]["content"], "SOUL\n\nエレシュキガルとして振る舞う。\n\nTools...")
        self.assertEqual(out["request"]["messages"][1], request["messages"][1])
        self.assertIn("Act as Ereshkigal", request["messages"][0]["content"])  # the original request is not mutated
        self.assertIsNone(reply)
        self.assertEqual(server.requests, [])

    def test_glm_session_keeps_the_english_roll_and_is_translated(self):
        en, ja = self.roll_files()
        server = FakeServer(lambda text, kw: "ふん、訳よ。")
        self.addCleanup(server.close)
        ctx = FakeContext(base_url=server.url, model_path="/nonexistent.gguf", en_roll=en, ja_roll=ja, budget_seconds=5)
        plamo.register(ctx)
        request = {"messages": [{"role": "system", "content": "Act as Ereshkigal.\nAnswer in English."}]}

        self.assertIsNone(ctx.hooks["middleware:llm_request"](request=request, model="glm-5.3-flash"))
        self.assertEqual(ctx.hooks["transform_llm_output"](response_text="Hmph.", session_id="x", model="glm-5.3-flash"), "ふん、訳よ。")

    def test_roll_swap_covers_content_parts_and_a_top_level_system(self):
        en, ja = self.roll_files()
        ctx = FakeContext(en_roll=en, ja_roll=ja)
        plamo.register(ctx)
        request = {"system": [{"type": "text", "text": "Act as Ereshkigal.\nAnswer in English.", "cache_control": {"type": "ephemeral"}}],
                   "messages": [{"role": "user", "content": "hi"}]}

        out = ctx.hooks["middleware:llm_request"](request=request, model="anthropic/claude-haiku-5-5")

        self.assertEqual(out["request"]["system"][0]["text"], "エレシュキガルとして振る舞う。")
        self.assertEqual(out["request"]["system"][0]["cache_control"], {"type": "ephemeral"})

    def test_no_swap_when_the_english_roll_is_not_in_the_prompt(self):
        en, ja = self.roll_files()
        ctx = FakeContext(en_roll=en, ja_roll=ja)
        plamo.register(ctx)

        self.assertIsNone(ctx.hooks["middleware:llm_request"](request={"messages": [{"role": "system", "content": "other"}]},
                                                              model="claude-haiku-5-5"))

if __name__ == "__main__":
    unittest.main()
