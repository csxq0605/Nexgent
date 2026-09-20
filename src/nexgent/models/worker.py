"""One trusted, isolated Provider request; credentials arrive only over stdin."""

import json
import sys
from urllib.parse import urlsplit


def request_params(base_url, model, messages, max_tokens):
    if type(max_tokens) is not int or not 1 <= max_tokens <= 12000:
        raise ValueError("Completion limit must be an integer in 1..12000")
    result = {"model": model, "messages": messages, "response_format": {"type": "json_object"},
              "max_completion_tokens": max_tokens}
    if (urlsplit(base_url).hostname in {"api.xiaomimimo.com", "token-plan-cn.xiaomimimo.com"}
            and model.lower().startswith("mimo-v2.5")):
        # MiMo counts default thinking against this bound. Structured program
        # generation uses the budget for its JSON/source output instead.
        result["extra_body"] = {"thinking": {"type": "disabled"}}
    return result


def usage_snapshot(usage):
    def get(value, key):
        return value.get(key) if isinstance(value, dict) else getattr(value, key, None)

    result = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = get(usage, key)
        if type(value) is int and value >= 0:
            result[key] = value
    for group, keys in (
        ("completion_tokens_details", ("reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens")),
        ("prompt_tokens_details", ("cached_tokens", "audio_tokens", "image_tokens", "video_tokens")),
    ):
        details = get(usage, group)
        counters = {key: get(details, key) for key in keys
                    if type(get(details, key)) is int and get(details, key) >= 0}
        if counters:
            result[group] = counters
    return result


def response_payload(response):
    choice = response.choices[0] if response.choices else None
    content = getattr(getattr(choice, "message", None), "content", None)
    reason, identity = getattr(choice, "finish_reason", None), getattr(response, "id", None)
    observed_model = getattr(response, "model", None)
    system_fingerprint = getattr(response, "system_fingerprint", None)
    return {"content": content[:240001] if isinstance(content, str) else None,
            "finish_reason": reason[:100] if isinstance(reason, str) else None,
            "response_id": identity[:500] if isinstance(identity, str) else None,
            "observed_model": observed_model[:500] if isinstance(observed_model, str) else None,
            "system_fingerprint": (system_fingerprint[:500]
                                   if isinstance(system_fingerprint, str) else None),
            "usage": usage_snapshot(getattr(response, "usage", None))}


def error_payload(exc, stage):
    """Describe transport failures without serializing messages, URLs or headers."""
    causes, seen, current = [], set(), exc
    status_code = None
    error_number = None
    while current is not None and id(current) not in seen and len(causes) < 8:
        seen.add(id(current))
        name = type(current).__name__
        causes.append(name[:80] if name.isidentifier() else "Exception")
        value = getattr(current, "status_code", None)
        if type(value) is int and 100 <= value <= 599:
            status_code = value
        value = getattr(current, "errno", None)
        if type(value) is int and -100000 <= value <= 100000:
            error_number = value
        current = current.__cause__ or current.__context__
    phase = "unknown"
    phases = (({"gaierror"}, "dns_resolution"),
              ({"SSLError", "SSLCertVerificationError"}, "tls_handshake"),
              ({"ProxyError"}, "proxy_connection"),
              ({"ConnectTimeout", "ConnectError", "ConnectionRefusedError"}, "connect"),
              ({"ReadTimeout", "ReadError", "RemoteProtocolError"}, "response_read"),
              ({"WriteTimeout", "WriteError"}, "request_write"),
              ({"PoolTimeout"}, "connection_pool"))
    for types, candidate in phases:
        if types.intersection(causes):
            phase = candidate
            break
    if phase == "unknown" and status_code is not None:
        phase = "http_response"
    return {"error_type": causes[0], "diagnostics": {
        "cause_types": causes, "stage": stage, "connection_phase": phase,
        "http_status": status_code, "errno": error_number,
        "message_policy": "Exception messages, URLs, request bodies and headers omitted"}}


def main():
    client = None
    stage = "request_validation"
    try:
        request = json.loads(sys.stdin.read(1_000_001))
        if set(request) != {"api_key", "base_url", "timeout", "request_params"}:
            raise ValueError("Invalid worker request")
        if type(request["timeout"]) not in (int, float) or not 0 < request["timeout"] <= 180:
            raise ValueError("Invalid timeout")
        params = request["request_params"]
        if params != request_params(request["base_url"], params.get("model"), params.get("messages"),
                                    params.get("max_completion_tokens")):
            raise ValueError("Invalid bounded request parameters")
        stage = "client_setup"
        from openai import OpenAI
        client = OpenAI(api_key=request["api_key"], base_url=request["base_url"],
                        timeout=request["timeout"], max_retries=0)
        stage = "request"
        response = client.chat.completions.create(**params)
        stage = "response_decode"
        result = response_payload(response)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
        return 0
    except Exception as exc:
        print(json.dumps(error_payload(exc, stage)), flush=True)
        return 1
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
