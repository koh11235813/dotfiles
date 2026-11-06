"""Translate completed Hermes replies with a local PLaMo 3 server."""

import json
import logging
import re
import time
import urllib.request
from urllib.parse import urlsplit


LOG = logging.getLogger(__name__)
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
LITERALS = re.compile(
    r"(`+)[^`\n]*?\1|https?://[^\s<>`]+|"
    r"(?<!\w)(?:[~/]|\./|\.\./|[A-Za-z]:\\)[^\s<>`]+|"
    r"<\|plamo:[^>]*>|<\|plamo:|⟦KEEP\d+⟧"
)
JAPANESE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]")
CONTEXT = (
    "An AI coding assistant replying to a software developer. "
    "Keep every ⟦KEEPnumber⟧ placeholder unchanged. Preserve the speaker's tone."
)


def _parts(text):
    pending = []
    fence = None
    for line in text.splitlines(keepends=True):
        match = FENCE.match(line)
        if fence or match or not line.strip() or line.startswith(("    ", "\t")):
            if pending:
                yield True, "".join(pending)
                pending = []
            yield False, line
            if fence:
                if re.fullmatch(r" {0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}\s*", line):
                    fence = None
            elif match:
                fence = match.group(1)
        else:
            pending.append(line)
    if pending:
        yield True, "".join(pending)


def _protect(text):
    literals = []

    def replace(match):
        literal = match.group()
        # Sentence punctuation after a bare URL/path is not part of that identifier.
        suffix = ""
        if not literal.startswith(("`", "<|", "⟦")):
            trimmed = literal.rstrip(".,;:!?)")
            suffix = literal[len(trimmed):]
            literal = trimmed
        marker = f"⟦KEEP{len(literals)}⟧"
        literals.append(literal)
        return marker + suffix

    return LITERALS.sub(replace, text), literals


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("translation endpoint redirected")


def _chunks(text):
    while len(text) > 1600:
        boundaries = list(re.finditer(r"\s+", text[:1600]))
        if not boundaries:
            raise ValueError("unbroken prose exceeds translation limit")
        end = boundaries[-1].end()
        yield text[:end]
        text = text[end:]
    if text:
        yield text


def _translate(text, base_url, deadline, context, form):
    body = text.rstrip("\r\n")
    tail = text[len(body):]
    protected, literals = _protect(body)
    prose = re.sub(r"⟦KEEP\d+⟧", "", protected)
    if not re.search(r"[A-Za-z]", prose) or JAPANESE.search(prose):
        return text
    translated = "".join(
        _request(chunk, base_url, deadline, context, form) for chunk in _chunks(protected)
    )
    for index, literal in enumerate(literals):
        marker = f"⟦KEEP{index}⟧"
        if translated.count(marker) != 1:
            raise ValueError("translation changed a protected literal")
    translated = re.sub(r"⟦KEEP(\d+)⟧", lambda m: literals[int(m[1])], translated)
    return translated + tail


def _request(protected, base_url, deadline, context, form):
    tail = protected[len(protected.rstrip()):]
    payload = {
        "model": "plamo-3-translate",
        "messages": [{"role": "user", "content": protected}],
        "stream": False,
        "temperature": 0,
        "max_tokens": min(4096, len(protected) * 3 + 128),
        "stop": ["<|plamo:tag|>", "<|plamo:bos|>"],
        "cache_prompt": True,
        "chat_template_kwargs": {"source_lang": "en", "target_lang": "ja", "context": context},
    }
    if form:
        payload["chat_template_kwargs"]["form"] = form
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("translation budget exhausted")
    request = urllib.request.Request(
        base_url + "/v1/chat/completions", json.dumps(payload).encode(),
        {"Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    with opener.open(request, timeout=remaining) as response:
        choice = json.load(response)["choices"][0]
    translated = choice["message"]["content"]
    if (choice.get("finish_reason") != "stop" or not isinstance(translated, str)
            or not translated.strip() or not JAPANESE.search(translated)
            or len(translated) > len(protected) * 3 + 200):
        raise ValueError("invalid or truncated translation")
    return translated.strip() + tail


def register(ctx):
    def translate_reply(response_text, **kwargs):
        started = time.monotonic()
        try:
            base_url = ctx.get_config("base_url", "http://127.0.0.1:8000").rstrip("/")
            endpoint = urlsplit(base_url)
            if (endpoint.scheme != "http" or endpoint.hostname not in ("127.0.0.1", "::1")
                    or endpoint.username or endpoint.password or endpoint.path
                    or endpoint.query or endpoint.fragment):
                raise ValueError("base_url must be an HTTP loopback origin")
            context = ctx.get_config("context", CONTEXT)
            form = ctx.get_config("form", "")
            if form not in ("", "plain", "polite"):
                raise ValueError("form must be empty, plain or polite")
            result = "".join(
                _translate(text, base_url, started + 20, context, form) if prose else text
                for prose, text in _parts(response_text)
            )
            LOG.info("PLaMo translation completed in %.3fs", time.monotonic() - started)
            return result
        except Exception as exc:
            # A held hook must return the original explicitly to remain fail-open.
            # Never log response bodies: they can contain source text or credentials.
            LOG.warning("PLaMo translation failed (%s); returning original", type(exc).__name__)
            return response_text

    ctx.register_hook("transform_llm_output", translate_reply, hold_stream=True)
