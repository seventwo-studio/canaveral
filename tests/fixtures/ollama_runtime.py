#!/usr/bin/env python3
"""A real child HTTP process for runner tests; never downloads or loads a model."""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


root = Path(os.environ["OLLAMA_MODELS"])
(root / "environment.json").write_text(json.dumps(dict(os.environ)))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        value = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        with (root / "requests.jsonl").open("a") as log:
            log.write(json.dumps({"path": self.path, "value": value}) + "\n")
        mode = (root / "mode").read_text() if (root / "mode").exists() else ""
        if self.path == "/api/version":
            result = {"version": "fixture"}
        elif self.path == "/api/tags":
            result = {"models": [{"name": "fixture:latest", "digest": ("b" if mode == "digest" else "a") * 64}]}
        elif self.path == "/api/show":
            result = {"capabilities": ["completion"]}
            if mode == "remote":
                result["remote_host"] = "https://example.invalid"
        elif self.path == "/api/generate":
            (root / "generating").touch()
            if mode == "wait":
                time.sleep(30)
            result = {"model": "fixture:latest", "done": True, "response": "Hello from the runner.",
                      "prompt_eval_count": 4, "eval_count": 5}
            if mode == "usage":
                result.pop("eval_count")
            if mode == "incomplete":
                result["done"] = False
        else:
            self.send_error(404)
            return
        body = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


HTTPServer(("127.0.0.1", int(os.environ["OLLAMA_HOST"].split(":")[1])), Handler).serve_forever()
