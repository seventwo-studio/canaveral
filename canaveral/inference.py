"""Embedded inference contracts; model installation stays an explicit operator action."""
import json
import re

from .model import Error, identifier, integer, resources, text


TERMINAL = ("succeeded", "failed", "cancelled")
STATES = ("queued", "waitingForResources", "running", "unknown") + TERMINAL


def inference_offer(value):
    if not isinstance(value, dict) or value.get("runtime") != "ollama":
        raise Error("Inference requires the ollama runtime.", 400)
    models = value.get("models")
    if not isinstance(models, list) or not 1 <= len(models) <= 100:
        raise Error("Offer between 1 and 100 installed inference models.", 400)
    result = []
    for model in models:
        if not isinstance(model, dict):
            raise Error("Invalid inference model.", 400)
        name = text(model.get("id"), "model ID", 200)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*", name) or "cloud" in name.lower():
            raise Error("Use an exact installed local model tag.", 400)
        revision = model.get("digest")
        if not isinstance(revision, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", revision):
            raise Error("Models require a pinned sha256 digest.", 400)
        result.append({"id": name, "digest": revision, "capability": "generation",
                       "resources": resources(model.get("resources"))})
        if model.get("capability", "generation") != "generation":
            raise Error("The initial embedded runtime supports generation only.", 400)
    if len({model["id"] for model in result}) != len(result):
        raise Error("Model IDs must be unique within a host offer.", 400)
    return {"runtime": "ollama", "models": result}


def job_request(value):
    if set(value) - {"id", "model", "digest", "prompt", "maxTokens", "hostId"}:
        raise Error("Unknown inference request fields.", 400)
    prompt = value.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode("utf-8")) > 65536:
        raise Error("Supply a nonempty prompt of at most 64 KiB.", 400)
    if len(json.dumps(prompt).encode()) > 65536:
        raise Error("The JSON-encoded prompt must fit 64 KiB.", 400)
    result = {"id": identifier(value.get("id")), "model": text(value.get("model"), "model ID", 200),
              "prompt": prompt, "maxTokens": integer(value.get("maxTokens", 600), "maxTokens", 4096)}
    if "digest" in value:
        if not isinstance(value["digest"], str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", value["digest"]):
            raise Error("Invalid model digest.", 400)
        result["digest"] = value["digest"]
    if "hostId" in value:
        result["hostId"] = identifier(value["hostId"])
    return result


def generation_result(value, model):
    if not isinstance(value, dict) or value.get("model") != model or not isinstance(value.get("text"), str):
        raise Error("Invalid inference result or model identity.", 400)
    if len(value["text"].encode("utf-8")) > 131072:
        raise Error("Inference result exceeds 128 KiB.", 400)
    usage = value.get("usage")
    if not isinstance(usage, dict) or set(usage) != {"inputTokens", "outputTokens"}:
        raise Error("Inference results require measured token usage.", 400)
    if any(type(n) is not int or not 0 <= n <= 2 ** 31 for n in usage.values()):
        raise Error("Invalid measured token usage.", 400)
    result = {"model": model, "text": value["text"], "usage": dict(usage)}
    if len(json.dumps(result).encode()) > 262144:
        raise Error("Encoded inference result exceeds 256 KiB.", 400)
    return result
