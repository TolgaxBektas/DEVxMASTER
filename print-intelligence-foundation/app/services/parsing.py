import ast
import json
import re
from typing import Any


def _balanced(text: str) -> list[str]:
    out = []
    for start, opening in enumerate(text):
        if opening not in "[{":
            continue
        depth, quote, escaped = 0, None, False
        for i in range(start, len(text)):
            c = text[i]
            if quote:
                if escaped:
                    escaped = False
                elif c == "\\":
                    escaped = True
                elif c == quote:
                    quote = None
                continue
            if c in "'\"":
                quote = c
            elif c in "[{":
                depth += 1
            elif c in "]}":
                depth -= 1
                if depth == 0:
                    out.append(text[start : i + 1])
                    break
    return out


def parse_qwen_response(response: Any) -> Any:
    if isinstance(response, dict):
        candidates = [
            response.get("message", {}).get("content"),
            response.get("message", {}).get("thinking"),
            response.get("content"),
            response.get("thinking"),
            response.get("response"),
        ]
    else:
        candidates = [str(response)]
    texts = [x for x in candidates if x]
    for text in texts:
        text = re.sub(r"```(?:json)?", "", str(text), flags=re.I).replace("```", "")
        # An unterminated top-level array cannot be returned by the balanced
        # extractor; salvage all complete member objects instead.
        if "[" in text and text.rfind("[") > text.rfind("]"):
            objects = []
            for candidate in re.findall(r"\{[^{}]*\}", text, re.S):
                try:
                    objects.append(json.loads(candidate))
                except json.JSONDecodeError:
                    try:
                        objects.append(ast.literal_eval(candidate))
                    except (ValueError, SyntaxError):
                        pass
            if objects:
                return objects
        for candidate in _balanced(text):
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                try:
                    return ast.literal_eval(candidate)
                except (ValueError, SyntaxError):
                    pass
        # truncated arrays: parse each complete object and wrap as a list
        objects = []
        for candidate in re.findall(r"\{[^{}]*\}", text, re.S):
            try:
                objects.append(json.loads(candidate))
            except json.JSONDecodeError:
                try:
                    objects.append(ast.literal_eval(candidate))
                except (ValueError, SyntaxError):
                    pass
        if objects:
            return objects
        if re.search(
            r"\b(no|none|keine|keinen)\s+ads?\b|\bkeine\s+anzeigen\b", text, re.I
        ):
            return []
    return []
