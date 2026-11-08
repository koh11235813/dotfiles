"""Translate Hermes's English replies into Ereshkigal's Japanese with the fine-tuned PLaMo 3 Translate GGUF (#68).

The GGUF was trained on whole answers with 16 rare-token rows and the user's message in `context`, so each reply is
sent in one request. Register repair and address normalisation follow, as measured in #68.
"""

import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

LOG = logging.getLogger(__name__)

SOFT = "⽇⼈⽤⼤⼀⽉⼊⽣⾏აირეოვღ"  # the trained soft-prompt rows; they must lead `context`
GLOSSARY = [{"source": "underworld", "target": "冥界"}, {"source": "Master", "target": "マスター"}]
# The roll's Anki triggers without ちゃんと, which also fires on 「エレちゃんと」 and casual thanks.
ANKI = re.compile("真面目に|正確に|厳密に|冗談抜きで|冗談なしで")
SEP = re.compile(r"(\n\s*\n)")
# A paragraph that opens as a warning; inside a casual answer the translator keeps it in plain form.
WARN_OPEN = re.compile(r"^\W*(?:(?:one|a|another|final|last)\s+)?(?:more\s+)?(?:warning|caution)\b", re.I)
POLITE_END = re.compile(r"(です|ます|ません|ました|でした|ましょう|ください)[。！？!?」』…）)]*\s*$")
FENCE = re.compile(r"```.*?```", re.S)
INLINE = re.compile(r"`[^`\n]+`")
CODE = re.compile(r"```.*?```|`[^`\n]*`", re.S)
JAPANESE = re.compile(r"[぀-ヿ㐀-鿿]")
DEFAULT_URL = "http://127.0.0.1:8091"
DEFAULT_MODEL = "~/.hermes/plamo/plamo-3-translate-2b-ereshkigal-en-ja.gguf"
DEFAULT_URL_8B = "http://127.0.0.1:8092"
DEFAULT_BUDGET = 150.0  # capped below plugins.hook_callback_timeout: a timed-out held hook withholds the reply
USER_CHARS = 2000  # the user's message goes into `context`; a pasted log must not crowd out the answer


def polite_ratio(ja):
    sents = [s for s in re.split(r"(?<=[。！？!?])|\n", ja) if re.search(r"[ぁ-んァ-ン一-龥]", s)]
    return sum(bool(POLITE_END.search(s.strip())) for s in sents) / len(sents) if sents else 1.0


def normalize_address(text):
    """The roll addresses the user as アナタ; the translator sometimes writes あなた inside formal warnings."""
    parts, last = [], 0
    for m in CODE.finditer(text):
        parts.append(re.sub("あなた|あんた", "アナタ", text[last:m.start()]))
        parts.append(m.group(0))
        last = m.end()
    parts.append(re.sub("あなた|あんた", "アナタ", text[last:]))
    return "".join(parts)


def restore_code(en, ja):
    """The translator also rewrites comments, strings and inline spans; the roll promises backticked text is kept,
    so put the English code back wherever the counts line up (order is assumed kept)."""
    en_blocks, ja_blocks = FENCE.findall(en), FENCE.findall(ja)
    if en_blocks and len(en_blocks) == len(ja_blocks):
        blocks = iter(en_blocks)
        ja = FENCE.sub(lambda m: next(blocks), ja)
    en_inline, ja_inline = INLINE.findall(FENCE.sub("", en)), INLINE.findall(FENCE.sub("", ja))
    if not en_inline or len(en_inline) != len(ja_inline) or sorted(en_inline) == sorted(ja_inline):
        return ja
    spans = iter(en_inline)
    parts, last = [], 0
    for m in FENCE.finditer(ja):
        parts.append(INLINE.sub(lambda _: next(spans), ja[last:m.start()]))
        parts.append(m.group(0))
        last = m.end()
    parts.append(INLINE.sub(lambda _: next(spans), ja[last:]))
    return "".join(parts)


def needs_8b(en):
    """Technical answers (a code block, or three or more inline code spans) are where the 2B mistranslates terms:
    on 22 held-out tech answers the 8B scored +1.47 ± 0.32 of 20 (fidelity 4.11 vs 3.36 of 5, #68 round 17)."""
    blocks = len(FENCE.findall(en))
    inline = len(INLINE.findall(FENCE.sub("", en)))
    return blocks >= 1 or inline >= 3


def kwargs_for(user_message):
    return {"source_lang": "en", "target_lang": "ja", "context": SOFT + "\n" + user_message[-USER_CHARS:], "glossary": GLOSSARY}


def translate_answer(translate, en, user_message):
    """One translation; redo with form=polite only where the register collapsed (polite_ratio < 0.5)."""
    kw = kwargs_for(user_message)
    polite = {**kw, "form": "polite"}
    ja = translate(en, kw)
    if ANKI.search(user_message):
        if polite_ratio(ja) < 0.5:
            ja = translate(en, polite)
    else:
        en_parts, ja_parts = SEP.split(en.strip()), SEP.split(ja.strip())
        if len(en_parts) == len(ja_parts):  # even indices are paragraphs, odd ones the separators
            for i in range(0, len(en_parts), 2):
                if WARN_OPEN.match(en_parts[i]) and polite_ratio(ja_parts[i]) < 0.5:
                    ja_parts[i] = translate(en_parts[i], polite).strip()
            ja = "".join(ja_parts)
    return normalize_address(restore_code(en, ja))


def _loopback(base_url):
    url = urlsplit(base_url)
    if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "::1") or url.username or url.password
            or url.path.strip("/") or url.query or url.fragment or not url.port):
        raise ValueError("base_url must be an HTTP loopback origin with a port")
    return url


def _opener():
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            raise ValueError("translation endpoint redirected")
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def _healthy(base_url):
    try:
        with _opener().open(base_url + "/health", timeout=2) as r:
            return json.load(r).get("status") == "ok"
    except (OSError, ValueError):
        return False


class Server:
    """Starts llama-server on first use when nothing answers on the loopback port; later replies reuse it."""

    GRACE = 30.0  # after our llama-server exits (another process won the port), keep waiting this long for theirs

    def __init__(self):
        self.lock = threading.Lock()
        self.proc = None

    def ensure(self, base_url, model_path, deadline):
        if _healthy(base_url):
            return
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                model = Path(os.path.expanduser(model_path))
                binary = shutil.which("llama-server")
                if not model.is_file() or not binary:
                    raise FileNotFoundError("translator GGUF or llama-server missing")
                url = _loopback(base_url)
                self.proc = subprocess.Popen(
                    [binary, "-m", str(model), "--jinja", "--no-prefill-assistant", "--alias", "plamo",
                     "--host", url.hostname, "--port", str(url.port), "-c", "16384", "-ngl", "99"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    start_new_session=True)
        exited = None
        while time.monotonic() < deadline:
            if _healthy(base_url):
                return
            proc = self.proc
            if proc is not None and proc.poll() is not None:
                exited = exited or time.monotonic()
                if time.monotonic() - exited > self.GRACE:
                    raise RuntimeError("llama-server exited and nothing else answered")
            time.sleep(0.5)
        raise TimeoutError("llama-server did not become healthy")


class TooLong(ValueError):
    """The output hit max_tokens or the prompt overflowed the server context."""


def _request(base_url, text, kw, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("translation budget exhausted")
    body = {"model": "plamo", "temperature": 0, "max_tokens": 4096, "stream": False,
            "messages": [{"role": "user", "content": text}], "chat_template_kwargs": kw}
    req = urllib.request.Request(base_url + "/v1/chat/completions", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    try:
        with _opener().open(req, timeout=remaining) as r:
            choice = json.load(r)["choices"][0]
    except urllib.error.HTTPError as exc:
        if exc.code == 400:  # llama-server rejects a prompt longer than its context
            raise TooLong("prompt exceeds the server context") from exc
        raise
    ja = choice["message"]["content"]
    if choice.get("finish_reason") == "length":
        raise TooLong("translation hit max_tokens")
    if choice.get("finish_reason") != "stop" or not isinstance(ja, str) or not JAPANESE.search(ja):
        raise ValueError("invalid translation")
    return ja


def _translate(base_url, text, kw, deadline):
    """Whole text first (the GGUF was trained on whole answers); if too long, paragraph by paragraph."""
    try:
        return _request(base_url, text, kw, deadline)
    except TooLong:
        parts = SEP.split(text.strip())
        if len(parts) < 3:
            raise
        return "".join(p if i % 2 else _translate(base_url, p, kw, deadline) for i, p in enumerate(parts))


def _hook_timeout():
    try:
        from hermes_cli.plugins import _resolve_hook_callback_timeout
        return float(_resolve_hook_callback_timeout())
    except Exception:  # outside Hermes (tests) or a changed private API: assume the registered 180 s
        return 180.0


def _text(user_message):
    if isinstance(user_message, str):
        return user_message
    if isinstance(user_message, list):  # multimodal turns: keep the text parts
        return "\n".join(p.get("text", "") for p in user_message if isinstance(p, dict))
    return ""


def register(ctx):
    server, server_8b = Server(), Server()
    users = {}  # session_id -> the user's latest message, which the translator reads after the soft tokens
    children = {}  # delegated subagent sessions: their replies go back to the parent model, not to the user

    def remember(session_id="", user_message=None, parent_session_id="", **kwargs):
        if parent_session_id:
            children[session_id] = True
        users[session_id] = _text(user_message)
        for d in (users, children):
            while len(d) > 64:
                d.pop(next(iter(d)), None)

    def translate_reply(response_text, session_id="", **kwargs):
        if session_id in children:
            return None  # leave a subagent's report in English for its parent
        started = time.monotonic()
        try:
            base_url = ctx.get_config("base_url", DEFAULT_URL).rstrip("/")
            _loopback(base_url)
            budget = float(ctx.get_config("budget_seconds", DEFAULT_BUDGET))
            hook = _hook_timeout()
            deadline = started + (min(budget, hook - 15) if hook > 0 else budget)
            user = users.get(session_id, "")
            model_8b = ctx.get_config("model_path_8b", "")
            result = None
            if model_8b and needs_8b(response_text):  # opt-in: technical answers to the 8B when it is configured
                url_8b = ctx.get_config("base_url_8b", DEFAULT_URL_8B).rstrip("/")
                try:
                    _loopback(url_8b)
                    server_8b.ensure(url_8b, model_8b, deadline)
                    result = translate_answer(lambda text, kw: _translate(url_8b, text, kw, deadline),
                                              response_text, user)
                except Exception as exc:
                    LOG.warning("8B translation failed (%s); trying the 2B", type(exc).__name__)
            if result is None:
                server.ensure(base_url, ctx.get_config("model_path", DEFAULT_MODEL), deadline)
                result = translate_answer(lambda text, kw: _translate(base_url, text, kw, deadline),
                                          response_text, user)
            LOG.info("PLaMo translation completed in %.1fs", time.monotonic() - started)
            return result
        except Exception as exc:
            # Fail open with the original reply. Never log reply bodies: they can hold source or credentials.
            LOG.warning("PLaMo translation failed (%s); returning original", type(exc).__name__)
            return response_text

    ctx.register_hook("pre_llm_call", remember)
    ctx.register_hook("transform_llm_output", translate_reply, hold_stream=True)
