# SPDX-License-Identifier: Apache-2.0
import io
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import cenacle_bot as cb


def call(wsgi, path, payload, secret):
    raw = json.dumps(payload).encode()
    environ = {
        "REQUEST_METHOD": "POST", "PATH_INFO": path, "CONTENT_LENGTH": str(len(raw)),
        "wsgi.input": io.BytesIO(raw), "HTTP_X_CENACLE_SIGNATURE": cb.sign(secret, raw),
    }
    status = []
    body = b"".join(wsgi(environ, lambda s, h: status.append(s)))
    return status[0], json.loads(body) if body else None


class SigningTest(unittest.TestCase):
    def test_matches_the_server(self):
        # The server's signing (internal/integrations/signing) gives this value.
        self.assertEqual(
            cb.sign("cns_vector", b'{"type":"action"}', at=1761300000),
            "t=1761300000,v1=ec934ea08f890ec4f071002edaba61efc173b8e392057d8f219b92fc6f9f94bc",
        )

    def test_verify(self):
        h = cb.sign("cns_x", b"{}")
        self.assertTrue(cb.verify("cns_x", h, b"{}"))
        self.assertFalse(cb.verify("cns_y", h, b"{}"))
        self.assertFalse(cb.verify("cns_x", h, b"[]"))
        self.assertFalse(cb.verify("cns_x", h, b"{}", now=time.time() + 600))
        self.assertFalse(cb.verify("cns_x", "garbage", b"{}"))


class AppTest(unittest.TestCase):
    def test_routes(self):
        seen = []

        def interaction(req):
            if req["type"] == "dialog_submission" and not req["values"].get("reason"):
                return {"errors": {"reason": "Say why."}}
            return {"text": "pressed " + req["action_id"]}

        wsgi = cb.app("cns_s", on_interaction=interaction, on_event=seen.append,
                      on_command=lambda c: {"response_type": "in_channel", "text": c["text"]})
        self.assertEqual(call(wsgi, "/interaction", {"type": "action", "action_id": "go"}, "cns_s"),
                         ("200 OK", {"text": "pressed go"}))
        self.assertEqual(call(wsgi, "/interaction", {"type": "dialog_submission", "values": {}}, "cns_s")[1],
                         {"errors": {"reason": "Say why."}})
        self.assertEqual(call(wsgi, "/command", {"text": "api"}, "cns_s")[1]["text"], "api")
        self.assertEqual(call(wsgi, "/event", {"type": "message.created"}, "cns_s")[0], "204 No Content")
        self.assertEqual(seen, [{"type": "message.created"}])
        self.assertEqual(call(wsgi, "/interaction", {}, "cns_forged")[0], "401 Unauthorized")


class ClientTest(unittest.TestCase):
    def test_post_and_errors(self):
        got = {}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _answer(self):
                got["auth"] = self.headers.get("Authorization")
                got["body"] = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"null")
                if self.path == "/api/channels/c1/messages":
                    body = b'{"id":"m1","channel_id":"c1"}'
                    self.send_response(201)
                else:
                    body = b'{"status":403,"code":"forbidden","detail":"no"}'
                    self.send_response(403)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_POST = do_PUT = _answer

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            client = cb.Client(f"http://127.0.0.1:{server.server_port}/", "cnb_t")
            self.assertEqual(client.post_message("c1", "hi")["id"], "m1")
            self.assertEqual(got["auth"], "Bearer cnb_t")
            self.assertTrue(got["body"]["nonce"].startswith("sdk-"))
            with self.assertRaises(cb.CenacleError) as err:
                client.react("c1", "m1", "+1")
            self.assertEqual((err.exception.status, err.exception.code), (403, "forbidden"))
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()
