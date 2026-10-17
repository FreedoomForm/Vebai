#!/usr/bin/env python3
"""Minimal Z.ai (GLM) client for the vebai agent runner.

Mirrors the site's src/lib/zai.ts: official OpenAI-compatible endpoint,
glm-4.7-flash primary + glm-4.5-flash fallback, retry/backoff on 429/5xx
and the known Zhipu overload codes. Key-free web search (Bing RSS primary,
DuckDuckGo lite fallback) and a page reader are included so the agent can
look things up without burning LLM tokens.
"""
import html as _html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = (os.environ.get("ZAI_BASE_URL") or
            "https://open.bigmodel.cn/api/paas/v4").rstrip("/")
API_KEY = os.environ.get("ZAI_API_KEY") or ""
PRIMARY_MODEL = os.environ.get("ZAI_MODEL") or "glm-4.7-flash"
FALLBACK_MODEL = "glm-4.5-flash"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36")


class ZaiError(Exception):
    pass


def _post_json(url: str, payload: dict, key: str = "", timeout: int = 120) -> dict:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _retryable(status: int, body: str) -> bool:
    if status in (429, 500, 502, 503, 504):
        return True
    if re.search(r'"code"\s*:\s*"?(1302|1303|1305|1113)"?', body):
        return True
    return bool(re.search(r"负载已饱和|调用过高|并发|算力不足|rate.?limit", body, re.I))


def chat(messages, temperature: float = 0.3, max_tokens: int = 4000,
         timeout: int = 180):
    """One chat completion with retries + model fallback -> (text, model)."""
    if not API_KEY:
        raise ZaiError("ZAI_API_KEY не задан (добавь secret ZAI_API_KEY в репозиторий)")
    last = ""
    for model in [PRIMARY_MODEL, FALLBACK_MODEL]:
        for attempt in range(4):
            try:
                d = _post_json(
                    BASE_URL + "/chat/completions",
                    {"model": model, "messages": messages, "stream": False,
                     "temperature": temperature, "max_tokens": max_tokens,
                     "thinking": {"type": "disabled"}},
                    key=API_KEY, timeout=timeout)
                text = ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
                if text.strip():
                    return text.strip(), model
                last = "пустой ответ модели"
            except urllib.error.HTTPError as e:
                try:
                    body = e.read().decode(errors="replace")[:400]
                except Exception:
                    body = ""
                last = f"HTTP {e.code}: {body}"
                if not _retryable(e.code, body):
                    raise ZaiError(last)
            except Exception as e:
                last = f"{type(e).__name__}: {e}"
            time.sleep(min(2 ** attempt * 1.5 + 1.0, 20))
    raise ZaiError("GLM недоступен: " + last[:300])


# ------------------------------------------------------------ free web tools

def _strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s)
    s = _html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def web_search(query: str, num: int = 6) -> str:
    """Bing RSS primary, DuckDuckGo fallback. Returns a compact text list."""
    num = max(1, min(num, 10))
    items = []
    try:
        url = ("https://www.bing.com/search?q=" + urllib.parse.quote(query) +
               f"&format=rss&count={max(num, 10)}&setlang=en&cc=US")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            xml = r.read().decode(errors="replace")
        for m in re.finditer(r"<item>([\s\S]*?)</item>", xml):
            if len(items) >= num:
                break
            b = m.group(1)
            t = re.search(r"<title>([\s\S]*?)</title>", b)
            l = re.search(r"<link>([\s\S]*?)</link>", b)
            d = re.search(r"<description>([\s\S]*?)</description>", b)
            if not (t and l and re.match(r"https?://", l.group(1).strip())):
                continue
            items.append((t.group(1).strip(), l.group(1).strip(),
                          _strip_html(d.group(1))[:300] if d else ""))
    except Exception:
        items = []
    if not items:
        try:
            url = "https://lite.duckduckgo.com/lite/?q=" + urllib.parse.quote(query)
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                page = r.read().decode(errors="replace")
            for m in re.finditer(r'<a[^>]*href="(https?://[^"]+)"[^>]*>([\s\S]*?)</a>', page):
                if len(items) >= num:
                    break
                link, name = m.group(1), _strip_html(m.group(2))
                if "duckduckgo.com" in link or len(name) < 3:
                    continue
                items.append((name, link, ""))
        except Exception:
            pass
    if not items:
        return "поиск не дал результатов"
    return "\n".join(f"{i + 1}. {t}\n   {u}\n   {s}" for i, (t, u, s) in enumerate(items))


def read_page(url: str, cap: int = 4000) -> str:
    """Fetch a page and return stripped text (~cap chars)."""
    if not re.match(r"^https?://", url):
        return "нужен http(s) URL"
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9,ru;q=0.8"})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read(400_000).decode(errors="replace")
        raw = re.sub(r"<script[\s\S]*?</script>", " ", raw, flags=re.I)
        raw = re.sub(r"<style[\s\S]*?</style>", " ", raw, flags=re.I)
        return _strip_html(raw)[:cap]
    except Exception as e:
        return f"страница недоступна: {type(e).__name__}: {e}"
