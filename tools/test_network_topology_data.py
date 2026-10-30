"""Offline collector regression tests: python3 -m unittest discover -s tools."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "network_topology_data", Path(__file__).with_name("network-topology-data.py")
)
collector = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = collector
spec.loader.exec_module(collector)


def endpoint(node, path, timeout):
    if path == "/admin/info":
        return {"nodeId": "netcup-node", "buildVersion": "qortium-1.8.0-test"}
    if path == "/admin/status":
        return {"height": 185500, "syncPercent": 100, "syncPhase": "SYNCED"}
    if path == "/peers":
        return [{"address": "146.103.42.59:24892"}, {"address": "80.241.221.139:24892"}]
    return []


class CollectorRetirementTests(unittest.TestCase):
    def collect(self, **overrides):
        options = dict(discover=True, max_hops=4, max_nodes=250,
                       probe_timeout=1, probe_workers=1, api_port=24891)
        options.update(overrides)
        return collector.collect_topology(1, None, **options)

    def test_live_collection_keeps_discovery_and_gossip_without_retired_operator(self):
        public = {"ok": True, "info": {"nodeId": "public-node"},
                  "status": {"height": 185499},
                  "chainPeers": [{"address": "146.103.42.59:24892"}], "dataPeers": []}
        with patch.object(collector, "fetch_endpoint", side_effect=endpoint) as management, \
                patch.object(collector, "fetch_peer_exchange_lines", return_value=[]) as gossip, \
                patch.object(collector, "probe_hosts_concurrent", return_value=[("80.241.221.139", public)]) as probes:
            snap = self.collect()
        self.assertEqual(set(snap["nodes"]), {"netcup", "public-node"})
        self.assertEqual(snap["errors"], {})
        self.assertEqual(snap["collection"]["operatorKeys"], ["netcup"])
        self.assertEqual(snap["collection"]["retiredOperatorKeys"], ["regxa"])
        self.assertEqual({call.args[0].key for call in management.call_args_list}, {"netcup"})
        self.assertEqual({call.args[0].key for call in gossip.call_args_list}, {"netcup"})
        self.assertEqual(probes.call_args.args[0], ["80.241.221.139"])
        self.assertEqual(snap["nodes"]["public-node"]["role"], "peer")
        self.assertEqual(snap["discovery"]["queriedNodeCount"], 2)

    def test_remaining_operator_failure_is_still_an_error(self):
        with patch.object(collector, "fetch_endpoint", side_effect=RuntimeError("Netcup unavailable")), \
                patch.object(collector, "fetch_peer_exchange_lines", return_value=[]):
            snap = self.collect(discover=False)
        self.assertEqual(snap["errors"], {"netcup": "Netcup unavailable"})
        self.assertIn("error", snap["nodes"]["netcup"])

    def test_retired_address_is_excluded_but_other_public_peers_are_probeable(self):
        self.assertFalse(collector.is_probeable_host("146.103.42.59"))
        self.assertTrue(collector.is_probeable_host("80.241.221.139"))
        self.assertFalse(collector.is_probeable_host("example.b32.i2p"))
        self.assertFalse(collector.is_probeable_host("127.0.0.1"))

    def test_new_payload_retains_historical_regxa_observations(self):
        old = {"generatedAt": "2026-10-26T04:32:03Z", "errors": {},
               "nodes": {"regxa": {"label": "R", "role": "seed"}},
               "topology": {"graphNodes": {"R": {"label": "R"}}, "edges": []}}
        new = {"generatedAt": "2026-10-29T16:00:00Z", "errors": {},
               "nodes": {"netcup": {"label": "N", "role": "seed"}},
               "topology": {"graphNodes": {"N": {"label": "N"}}, "edges": []}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "payload"
            collector.write_qdn_payload(root, old, qdn_name="Network", qdn_identifier="Network")
            database = root / "DATABASE/Network/Network"
            old_file = database / "snapshots/20261026T043203Z.json"
            before = old_file.read_bytes()
            collector.write_qdn_payload(root, new, qdn_name="Network", qdn_identifier="Network")
            self.assertEqual(old_file.read_bytes(), before)
            self.assertEqual(json.loads((database / "index.json").read_text())["count"], 2)
            self.assertEqual(json.loads((database / "latest.json").read_text())["nodes"], new["nodes"])


if __name__ == "__main__":
    unittest.main()
