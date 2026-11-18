"""Client response-order regressions using synthetic fetches, never live services."""
from __future__ import annotations

import json
from types import SimpleNamespace
import unittest

from PyQt6.QtCore import QCoreApplication, QEventLoop, QTimer

from backend_client import BackendClient


_TOKEN = "0123456789abcdef0123456789abcdef"
_BOOT_PAGE = f'<script>window.__EASYAG_TOKEN__="{_TOKEN}";</script>'.encode()


class SyntheticClient(BackendClient):
    """Exercise the real dispatch/auth lifecycle with controlled async replies."""

    def __init__(self):
        super().__init__("http://127.0.0.1:19823")
        self.fetches = []

    def _fetch(self, route, method, payload, timeout_ms, callback, authenticated=True):
        self.fetches.append(SimpleNamespace(
            route=route, method=method, payload=payload, timeout=timeout_ms,
            callback=callback, authenticated=authenticated, taken=False,
        ))

    def take(self, route):
        for request in self.fetches:
            if request.route == route and not request.taken:
                request.taken = True
                return request
        raise AssertionError(f"No outstanding synthetic request for {route}")

    def count(self, route):
        return sum(request.route == route for request in self.fetches)


class BackendClientOrderingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QCoreApplication.instance() or QCoreApplication([])

    def setUp(self):
        self.client = SyntheticClient()
        self.statuses = []
        self.finished = []
        self.errors = []
        self.client.status_received.connect(self.statuses.append)
        self.client.operation_finished.connect(lambda action, data: self.finished.append((action, data)))
        self.client.error.connect(lambda action, message: self.errors.append((action, message)))
        self.client.start()
        self.complete(self.client.take("/"), raw=_BOOT_PAGE)
        self.complete(self.client.take("/api/status"), {"config": {"nativeProxy": False}})
        self.complete(self.client.take("/api/logs?limit=120"), [])
        self.statuses.clear()
        self.finished.clear()

    def tearDown(self):
        self.client.stop()
        self.flush()

    @staticmethod
    def flush():
        loop = QEventLoop()
        QTimer.singleShot(0, loop.quit)
        loop.exec()

    def complete(self, request, data=None, *, status=200, raw=None, failure=""):
        payload = json.dumps(data).encode() if raw is None else raw
        QTimer.singleShot(0, lambda: request.callback(status, payload, failure))
        self.flush()

    def post(self, action, body):
        self.assertTrue(self.client.request(action, "/api/config", body))
        return self.client.take("/api/config")

    def test_old_status_is_replaced_after_success_even_when_refresh_was_blocked(self):
        self.client.refresh()
        old_status = self.client.take("/api/status")
        mutation = self.post("network", {"nativeProxy": True})
        self.client.operation_finished.connect(
            lambda action, _data: self.client.refresh() if action == "network" else None
        )
        saved = {"ok": True, "settings": {"nativeProxy": True}}
        self.complete(mutation, saved)
        self.assertEqual(self.finished, [("network", saved)])
        self.assertEqual(self.client.count("/api/status"), 2)

        self.complete(old_status, {"config": {"nativeProxy": False}})
        self.assertEqual(self.statuses, [])
        self.assertEqual(self.finished, [("network", saved)])
        self.assertEqual(self.client.count("/api/status"), 3)
        self.assertIn("status", self.client._pending)

        latest = {"config": {"nativeProxy": True}}
        self.complete(self.client.take("/api/status"), latest)
        self.flush()
        self.assertEqual(self.statuses, [latest])
        self.assertEqual(self.finished, [("network", saved), ("status", latest)])
        self.assertNotIn("status", self.client._pending)
        self.assertEqual(self.client.count("/api/status"), 3)
        self.assertEqual(self.errors, [])

    def test_different_mutations_keep_both_success_callbacks_and_invalidate_each_poll(self):
        self.client.refresh()
        old_status = self.client.take("/api/status")
        network = self.post("network", {"nativeProxy": True})
        enhance = self.post("enhance", {"enhanceMode": True})
        newer_settings = {"ok": True, "settings": {"nativeProxy": True, "enhanceMode": True}}
        older_settings = {"ok": True, "settings": {"nativeProxy": True, "enhanceMode": False}}

        # Full settings responses may complete out of order. Each owning UI
        # operation still needs its own response; unrelated fields are not a patch.
        self.complete(enhance, newer_settings)
        self.complete(old_status, {"config": {"nativeProxy": False, "enhanceMode": False}})
        replacement = self.client.take("/api/status")
        self.complete(network, older_settings)
        self.complete(replacement, {"config": older_settings["settings"]})
        self.assertEqual(self.statuses, [])
        self.assertEqual(self.finished, [("enhance", newer_settings), ("network", older_settings)])
        self.assertEqual(self.client._mutation_epoch, 2)

        latest = {"config": newer_settings["settings"]}
        self.complete(self.client.take("/api/status"), latest)
        self.assertEqual(self.statuses, [latest])
        self.assertEqual(self.client.count("/api/status"), 4)
        self.assertEqual(self.errors, [])

    def test_obsolete_status_error_is_replaced_without_auth_or_error_side_effects(self):
        self.client.refresh()
        old_status = self.client.take("/api/status")
        self.complete(self.post("network", {"nativeProxy": True}), {"ok": True})
        handshake_count = self.client.count("/")
        self.complete(old_status, status=401, raw=b"obsolete invalid JSON")
        self.assertEqual(self.client.count("/"), handshake_count)
        self.assertEqual(self.statuses, [])
        self.assertEqual(self.errors, [])
        self.assertEqual(self.client.count("/api/status"), 3)
        self.complete(self.client.take("/api/status"), {"config": {"nativeProxy": True}})
        self.assertEqual(len(self.statuses), 1)

    def test_online_signal_reentrancy_cannot_publish_a_newly_obsolete_status(self):
        self.client._set_online(False)
        self.client.refresh()
        status_request = self.client.take("/api/status")
        mutation = self.post("network", {"nativeProxy": True})

        def complete_mutation(online):
            if online:
                mutation.callback(200, b'{"ok":true}', "")

        self.client.connection_changed.connect(complete_mutation)
        self.complete(status_request, {"config": {"nativeProxy": False}})
        self.assertEqual(self.statuses, [])
        self.assertEqual(self.finished, [("network", {"ok": True})])
        self.assertEqual(self.client.count("/api/status"), 3)
        latest = {"config": {"nativeProxy": True}}
        self.complete(self.client.take("/api/status"), latest)
        self.assertEqual(self.statuses, [latest])
        self.assertEqual(self.errors, [])

    def test_tunnel_token_reflected_by_error_is_redacted_before_notice(self):
        token = "fixture-tunnel-token-not-real"
        self.assertTrue(self.client.request("mobile-config", "/api/mobile/config", {"tunnelToken": token}))
        request = self.client.take("/api/mobile/config")
        self.complete(request, {"ok": False, "error": "Rejected credential " + token}, status=500)
        self.assertEqual(len(self.errors), 1)
        self.assertNotIn(token, self.errors[0][1])
        self.assertIn("敏感内容已隐藏", self.errors[0][1])
        self.assertNotIn("mobile-config", self.client._pending)

    def test_failed_mutation_does_not_invalidate_existing_status(self):
        self.client.refresh()
        old_status = self.client.take("/api/status")
        self.complete(self.post("network", {"nativeProxy": True}),
                      {"ok": False, "error": "Synthetic save failure"}, status=500)
        snapshot = {"config": {"nativeProxy": False}}
        self.complete(old_status, snapshot)
        self.assertEqual(self.statuses, [snapshot])
        self.assertEqual(self.client._mutation_epoch, 0)
        self.assertEqual(self.client.count("/api/status"), 2)
        self.assertEqual(self.errors, [("network", "Synthetic save failure")])

    def test_status_retries_capture_the_epoch_at_actual_redispatch(self):
        self.client.refresh()
        old_status = self.client.take("/api/status")
        mutation = self.post("network", {"nativeProxy": True})
        self.complete(old_status, {"error": "Expired synthetic token"}, status=401)
        handshake = self.client.take("/")
        self.complete(mutation, {"ok": True})
        self.complete(handshake, raw=_BOOT_PAGE)
        retried = self.client.take("/api/status")
        snapshot = {"config": {"nativeProxy": True}}
        self.complete(retried, snapshot)
        self.assertEqual(self.statuses, [snapshot])
        self.assertEqual(self.client.count("/api/status"), 3)
        self.assertEqual(self.errors, [])

    def test_mutation_auth_retry_remains_once_and_success_is_delivered(self):
        mutation = self.post("network", {"nativeProxy": True})
        self.complete(mutation, {"error": "Expired synthetic token"}, status=401)
        self.complete(self.client.take("/"), raw=_BOOT_PAGE)
        retried = self.client.take("/api/config")
        self.assertEqual(retried.payload, mutation.payload)
        saved = {"ok": True, "settings": {"nativeProxy": True}}
        self.complete(retried, saved)
        self.assertEqual(self.finished, [("network", saved)])
        self.assertEqual(self.client._mutation_epoch, 1)
        self.assertEqual(self.client.count("/api/config"), 2)
        self.assertEqual(self.errors, [])

    def test_second_auth_failure_is_final_without_mutation_epoch_change(self):
        mutation = self.post("network", {"nativeProxy": True})
        self.complete(mutation, {"error": "Expired synthetic token"}, status=401)
        self.complete(self.client.take("/"), raw=_BOOT_PAGE)
        self.complete(self.client.take("/api/config"), {"error": "Still unauthorized"}, status=401)
        self.assertEqual(self.finished, [])
        self.assertEqual(self.errors, [("network", "Still unauthorized")])
        self.assertEqual(self.client.count("/api/config"), 2)
        self.assertEqual(self.client.count("/"), 2)
        self.assertEqual(self.client._mutation_epoch, 0)
        self.assertNotIn("network", self.client._pending)

    def test_stop_and_restart_ignore_previous_generation_completions(self):
        self.client.refresh()
        old_status = self.client.take("/api/status")
        old_mutation = self.post("network", {"nativeProxy": True})
        self.client.stop()
        self.client.start()
        self.complete(self.client.take("/"), raw=_BOOT_PAGE)
        current_status = self.client.take("/api/status")
        current_operation = self.client._pending["status"]
        request_count = len(self.client.fetches)
        self.complete(old_mutation, {"ok": True})
        self.complete(old_status, {"config": {"nativeProxy": False}})
        self.assertEqual(self.statuses, [])
        self.assertEqual(self.finished, [])
        self.assertEqual(self.errors, [])
        self.assertEqual(self.client._mutation_epoch, 0)
        self.assertIs(self.client._pending["status"], current_operation)
        self.assertEqual(len(self.client.fetches), request_count)
        latest = {"config": {"nativeProxy": True}}
        self.complete(current_status, latest)
        self.assertEqual(self.statuses, [latest])

    def test_stop_from_success_callback_does_not_schedule_more_requests(self):
        self.client.operation_finished.connect(
            lambda action, _data: self.client.stop() if action == "network" else None
        )
        mutation = self.post("network", {"nativeProxy": True})
        self.client.refresh()
        old_status = self.client.take("/api/status")
        request_count = len(self.client.fetches)
        self.complete(mutation, {"ok": True})
        self.complete(old_status, {"config": {"nativeProxy": False}})
        self.assertEqual(self.finished, [("network", {"ok": True})])
        self.assertEqual(self.statuses, [])
        self.assertEqual(len(self.client.fetches), request_count)
        self.assertEqual(self.client._pending, {})


if __name__ == "__main__":
    unittest.main()
