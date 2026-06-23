#!/usr/bin/env python3
"""
Collect Previewnet peer topology from the operator nodes and prepare QDN data.

The default map queries the two public seed nodes:

  N Netcup seed
  R Regxa seed

All other nodes (including the operator's own desktop/VM/Mac) appear only as
regular observed peers, the same as any other node on the network.

It writes a JSON snapshot plus an SVG diagram. If ImageMagick is available, it
also exports a PNG unless --no-png is supplied.

It also writes QDN-ready data directories for later publication:

  DATABASE/Network/Network  browsable latest/index data
  SNAPSHOT/Network/Network  complete point-in-time snapshot data
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import shutil
import subprocess
import sys
from dataclasses import dataclass
from html import escape
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT_DIR = REPO_ROOT / "target" / "preview-topology"
DEFAULT_QDN_DATA_DIR = REPO_ROOT / "target" / "qdn-topology-data"

API_PORT = 24891
CHAIN_PORT = 24892
DATA_PORT = 24894
DEFAULT_QDN_NAME = "Network"
DEFAULT_QDN_IDENTIFIER = "Network"
QDN_DATA_SCHEMA = "org.qortium.network.topology.qdn-data.v1"
# Newest-first cap on how many historical snapshots the DATABASE resource keeps.
QDN_MAX_HISTORY = 250

COLORS = {
    "IP_CHAIN": "#16a34a",
    "IP_DATA": "#dc2626",
    "I2P_CHAIN": "#2563eb",
    "I2P_DATA": "#f97316",
    "unknown": "#6b7280",
}

# Outer-ring colors marking how current each node's Core version is, relative to
# the newest version seen on the network during this run. The legend shows the
# three newest version numbers; anything older (or unversioned) is "Older".
VERSION_COLORS = {
    "latest": "#16a34a",   # newest version seen
    "behind1": "#f59e0b",  # one version behind
    "behind2": "#dc2626",  # two versions behind
    "older": "#9ca3af",    # older than the three newest, or no version reported
}


@dataclass(frozen=True)
class NodeConfig:
    key: str
    label: str
    name: str
    role: str
    public_host: str | None = None
    ssh: tuple[str, ...] | None = None
    cwd: Path | None = None


NODE_CONFIGS = [
    NodeConfig(
        "netcup",
        "N",
        "Netcup",
        "seed",
        public_host="185.207.104.78",
        ssh=("ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "qortium-netcup"),
    ),
    NodeConfig(
        "regxa",
        "R",
        "Regxa",
        "seed",
        public_host="146.103.42.59",
        ssh=("ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "qortium-regxa"),
    ),
]


def run_command(args: list[str] | tuple[str, ...], cwd: Path | None, timeout: int) -> str:
    result = subprocess.run(
        list(args),
        cwd=str(cwd) if cwd else None,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
    return result.stdout


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def fetch_endpoint(node: NodeConfig, endpoint: str, timeout: int) -> Any:
    url = f"http://localhost:{API_PORT}{endpoint}"
    if node.ssh:
        command = f"curl -fsS --max-time {timeout} {shell_quote(url)}"
        output = run_command((*node.ssh, command), node.cwd, timeout + 55)
    else:
        output = run_command(["curl", "-fsS", "--max-time", str(timeout), url], None, timeout + 5)
    return json.loads(output)


def host_part(address: str | None) -> str | None:
    if not address:
        return None

    if "://" not in address:
        address = "//" + address
    parsed = urlparse(address)
    if parsed.hostname:
        return parsed.hostname

    if ":" in address:
        return address.rsplit(":", 1)[0]
    return address


def short_version(version: str | None) -> str | None:
    """Reduce a Core version like 'qortium-1.1.1-5e3f95f' to '1.1.1'."""
    if not version:
        return None
    trimmed = version
    if trimmed.startswith("qortium-"):
        trimmed = trimmed[len("qortium-") :]
    # Drop the trailing build/commit hash if present (e.g. '1.1.1-5e3f95f').
    return trimmed.split("-", 1)[0] or version


def representative_version(versions: list[str]) -> str | None:
    """Pick a single version to represent a peer that reported more than one."""
    if not versions:
        return None
    # Sorting groups identical versions; the highest tends to be the newest.
    return sorted(versions)[-1]


def version_tuple(short: str | None) -> tuple[int, ...] | None:
    """Turn a short version like '1.1.3' into a comparable tuple of ints."""
    if not short:
        return None
    parts: list[int] = []
    for chunk in short.split("."):
        if not chunk.isdigit():
            break
        parts.append(int(chunk))
    return tuple(parts) or None


def capability(peer: dict[str, Any], name: str) -> Any:
    for item in peer.get("capabilities") or []:
        if name in item:
            return item[name]
    return None


def edge_kind(layer: str, transport: str | None) -> str:
    normalized = (transport or "IP").upper()
    if layer == "chain":
        return "I2P_CHAIN" if normalized == "I2P" else "IP_CHAIN"
    return "I2P_DATA" if normalized == "I2P" else "IP_DATA"


def collect_nodes(timeout: int) -> dict[str, Any]:
    snapshot: dict[str, Any] = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "nodes": {},
        "errors": {},
    }

    for node in NODE_CONFIGS:
        entry: dict[str, Any] = {
            "label": node.label,
            "name": node.name,
            "role": node.role,
            "publicHost": node.public_host,
        }
        try:
            entry["info"] = fetch_endpoint(node, "/admin/info", timeout)
            entry["status"] = fetch_endpoint(node, "/admin/status", timeout)
            entry["chainPeers"] = fetch_endpoint(node, "/peers", timeout)
            entry["dataPeers"] = fetch_endpoint(node, "/peers/data", timeout)
        except Exception as exc:  # noqa: BLE001 - capture per-node collection failures
            entry["error"] = str(exc)
            snapshot["errors"][node.key] = str(exc)
        snapshot["nodes"][node.key] = entry

    return snapshot


def build_topology(snapshot: dict[str, Any], max_extra_peers: int) -> dict[str, Any]:
    named_by_key = snapshot["nodes"]
    label_by_key = {key: node["label"] for key, node in named_by_key.items()}
    label_by_chain_node_id: dict[str, str] = {}
    label_by_chain_endpoint: dict[str, str] = {}
    public_host_labels: dict[str, set[str]] = {}

    for key, node in named_by_key.items():
        label = node["label"]
        info = node.get("info") or {}
        node_id = info.get("nodeId")
        if node_id:
            label_by_chain_node_id[node_id] = label

        public_host = node.get("publicHost")
        if public_host:
            label_by_chain_endpoint[f"{public_host}:{CHAIN_PORT}"] = label
            label_by_chain_endpoint[f"{public_host}:{DATA_PORT}"] = label
            public_host_labels.setdefault(public_host, set()).add(label)

    # Learn public hosts for named non-seed nodes from seed peer lists.
    for node in named_by_key.values():
        for peer in node.get("chainPeers") or []:
            peer_label = label_by_chain_node_id.get(peer.get("nodeId"))
            host = host_part(peer.get("address"))
            if peer_label and host:
                public_host_labels.setdefault(host, set()).add(peer_label)

    i2p_qdn_to_label: dict[str, str] = {}
    i2p_chain_to_label: dict[str, str] = {}
    for node in named_by_key.values():
        for peer in node.get("chainPeers") or []:
            peer_label = label_by_chain_node_id.get(peer.get("nodeId"))
            if not peer_label:
                continue
            i2p_chain = capability(peer, "I2P")
            i2p_qdn = capability(peer, "I2P_QDN")
            if i2p_chain:
                i2p_chain_to_label[i2p_chain] = peer_label
            if i2p_qdn:
                i2p_qdn_to_label[i2p_qdn] = peer_label

    graph_nodes: dict[str, dict[str, Any]] = {}
    extra_nodes: dict[str, dict[str, Any]] = {}
    edges: dict[tuple[str, str, str], dict[str, Any]] = {}

    for node in named_by_key.values():
        label = node["label"]
        status = node.get("status") or {}
        op_chain = status.get("numberOfConnections", len(node.get("chainPeers") or []))
        op_data = status.get("numberOfDataConnections", len(node.get("dataPeers") or []))
        # Group operators by their own connection mix, same as any other node.
        if op_chain and not op_data:
            op_group = "chain"
        elif op_data and not op_chain:
            op_group = "data"
        else:
            op_group = "both"
        graph_nodes[label] = {
            "id": label,
            "label": label,
            "kind": "operator",
            "group": op_group,
            "role": node.get("role"),
            "name": node.get("name"),
            "host": node.get("publicHost"),
            "chainCount": op_chain,
            "dataCount": op_data,
            "status": status.get("syncPhase"),
            "height": status.get("height"),
            "version": (node.get("info") or {}).get("buildVersion"),
            "observedBy": [],
        }

    def make_extra_id(host: str | None, peer: dict[str, Any]) -> str:
        if host:
            return f"X:{host}"
        node_id = peer.get("nodeId")
        if node_id:
            return f"X:{node_id}"
        return f"X:{peer.get('address', 'unknown')}"

    def add_extra(extra_id: str, host: str | None, peer: dict[str, Any], connected_to: str) -> str:
        if extra_id not in extra_nodes:
            label = f"P{len(extra_nodes) + 1}"
            extra_nodes[extra_id] = {
                "id": extra_id,
                "label": label,
                "kind": "observed",
                "role": "peer",
                "host": host,
                "nodeIds": set(),
                "versions": set(),
                "connectedTo": set(),
                "chainCount": 0,
                "dataCount": 0,
                "observedBy": set(),
            }
        extra = extra_nodes[extra_id]
        if peer.get("nodeId"):
            extra["nodeIds"].add(peer["nodeId"])
        if peer.get("version"):
            extra["versions"].add(peer["version"])
        extra["connectedTo"].add(connected_to)
        extra["observedBy"].add(connected_to)
        return extra_id

    def add_edge(a: str, b: str, kind: str, source_key: str, peer: dict[str, Any], layer: str) -> None:
        if a == b:
            return
        pair = tuple(sorted((a, b)))
        edge_key = (pair[0], pair[1], kind)
        edge = edges.setdefault(
            edge_key,
            {
                "source": pair[0],
                "target": pair[1],
                "kind": kind,
                "samples": [],
                "count": 0,
            },
        )
        edge["count"] += 1
        edge["samples"].append(
            {
                "reportedBy": source_key,
                "direction": peer.get("direction"),
                "address": peer.get("address"),
                "transport": peer.get("transport"),
                "version": peer.get("version"),
                "nodeId": peer.get("nodeId"),
            }
        )
        for node_id in (a, b):
            node = graph_nodes.get(node_id) or extra_nodes.get(node_id)
            if not node or node.get("kind") == "operator":
                continue
            if layer == "chain":
                node["chainCount"] = int(node.get("chainCount") or 0) + 1
            else:
                node["dataCount"] = int(node.get("dataCount") or 0) + 1

    def resolve_chain_target(peer: dict[str, Any], current_label: str) -> str:
        node_id = peer.get("nodeId")
        if node_id in label_by_chain_node_id:
            return label_by_chain_node_id[node_id]

        address = peer.get("address")
        if address in label_by_chain_endpoint:
            return label_by_chain_endpoint[address]

        host = host_part(address)
        if host and host in i2p_chain_to_label:
            return i2p_chain_to_label[host]

        extra_id = make_extra_id(host, peer)
        return add_extra(extra_id, host, peer, current_label)

    def resolve_data_target(peer: dict[str, Any], current_label: str) -> str | None:
        address = peer.get("address")
        host = host_part(address)
        endpoint_label = label_by_chain_endpoint.get(address)
        if endpoint_label:
            return endpoint_label

        if host and host in i2p_qdn_to_label:
            return i2p_qdn_to_label[host]

        # If a seed sees a data connection from a host that uniquely belongs to a
        # named node, map it back to that node. Ambiguous shared public hosts are
        # left as extra peer nodes.
        if host and host in public_host_labels and len(public_host_labels[host]) == 1:
            return next(iter(public_host_labels[host]))

        extra_id = make_extra_id(host, peer)
        return add_extra(extra_id, host, peer, current_label)

    for key, node in named_by_key.items():
        label = node["label"]
        for peer in node.get("chainPeers") or []:
            if peer.get("handshakeStatus") != "COMPLETED":
                continue
            target = resolve_chain_target(peer, label)
            add_edge(label, target, edge_kind("chain", peer.get("transport")), key, peer, "chain")

        for peer in node.get("dataPeers") or []:
            if peer.get("handshakeStatus") != "COMPLETED":
                continue
            target = resolve_data_target(peer, label)
            if target:
                add_edge(label, target, edge_kind("data", peer.get("transport")), key, peer, "data")

    # Keep the diagram readable if the seed nodes are connected to many outside peers.
    if max_extra_peers >= 0 and len(extra_nodes) > max_extra_peers:
        allowed = set(list(extra_nodes)[:max_extra_peers])
        extra_nodes = {key: value for key, value in extra_nodes.items() if key in allowed}
        edges = {
            key: value
            for key, value in edges.items()
            if not (value["source"].startswith("X:") and value["source"] not in allowed)
            and not (value["target"].startswith("X:") and value["target"] not in allowed)
        }

    extras_serializable = {}
    # Label observed peers by the connection types they participate in:
    #   C# chain-only, D# data-only, P# both.
    category_counters = {"C": 0, "D": 0, "P": 0}
    for key, value in extra_nodes.items():
        chain = int(value.get("chainCount") or 0)
        data = int(value.get("dataCount") or 0)
        value["peerCount"] = chain + data
        if chain and not data:
            prefix, group = "C", "chain"
        elif data and not chain:
            prefix, group = "D", "data"
        else:
            prefix, group = "P", "both"
        category_counters[prefix] += 1
        value["label"] = f"{prefix}{category_counters[prefix]}"
        value["group"] = group
        sorted_versions = sorted(value["versions"])
        extras_serializable[key] = {
            **value,
            "nodeIds": sorted(value["nodeIds"]),
            "versions": sorted_versions,
            "version": representative_version(sorted_versions),
            "connectedTo": sorted(value["connectedTo"]),
            "observedBy": sorted(value["observedBy"]),
        }
        graph_nodes[key] = extras_serializable[key]

    for value in graph_nodes.values():
        value["peerCount"] = int(value.get("chainCount") or 0) + int(value.get("dataCount") or 0)

    return {
        "namedLabels": label_by_key,
        "graphNodes": graph_nodes,
        "extraNodes": extras_serializable,
        "edges": list(edges.values()),
    }


def node_radius(node: dict[str, Any], max_peer_count: int) -> float:
    peer_count = max(1, int(node.get("peerCount") or 0))
    max_count = max(1, max_peer_count)
    return 16 + math.sqrt(peer_count / max_count) * 35


def layout_graph(
    graph_nodes: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
    width: int,
    height: int,
    summary_height: int,
) -> dict[str, tuple[float, float]]:
    ids = sorted(
        graph_nodes,
        key=lambda node_id: (-int(graph_nodes[node_id].get("peerCount") or 0), graph_nodes[node_id]["label"]),
    )
    if not ids:
        return {}

    max_peer_count = max(int(node.get("peerCount") or 0) for node in graph_nodes.values())
    radii = {node_id: node_radius(graph_nodes[node_id], max_peer_count) for node_id in ids}
    left, right = 70.0, width - 70.0
    top, bottom = 118.0, height - summary_height - 46.0
    cx, cy = width / 2, (top + bottom) / 2
    # Chain-only peers settle on the left, data-only on the right, both-type
    # peers fan toward the top/bottom from the center, operators in the middle.
    group_of = {node_id: (graph_nodes[node_id].get("group") or "operator") for node_id in ids}
    chain_x = left + (right - left) * 0.15
    data_x = right - (right - left) * 0.15
    top_y = top + (bottom - top) * 0.16
    bottom_y = bottom - (bottom - top) * 0.16
    center_lo_x = cx - (right - left) * 0.18
    center_hi_x = cx + (right - left) * 0.18

    members: dict[str, list[str]] = {"operator": [], "chain": [], "data": [], "both": []}
    for node_id in ids:
        members[group_of[node_id]].append(node_id)

    positions: dict[str, list[float]] = {}

    def seed_line(node_ids: list[str], axis: str, fixed: float, lo: float, hi: float) -> None:
        count = max(1, len(node_ids))
        for i, node_id in enumerate(node_ids):
            value = lo + (hi - lo) * ((i + 0.5) / count)
            positions[node_id] = [fixed, value] if axis == "x" else [value, fixed]

    # Operators cluster centrally; the busiest one sits dead center.
    for i, node_id in enumerate(members["operator"]):
        if i == 0:
            positions[node_id] = [cx, cy]
        else:
            angle = i * math.pi * (3 - math.sqrt(5))
            positions[node_id] = [cx + math.cos(angle) * 90, cy + math.sin(angle) * 90]

    seed_line(members["chain"], "x", chain_x, top + 40, bottom - 40)
    seed_line(members["data"], "x", data_x, top + 40, bottom - 40)

    both = members["both"]
    split = math.ceil(len(both) / 2)
    p_target_y = {node_id: top_y for node_id in both[:split]}
    p_target_y.update({node_id: bottom_y for node_id in both[split:]})
    seed_line(both[:split], "y", top_y, center_lo_x, center_hi_x)
    seed_line(both[split:], "y", bottom_y, center_lo_x, center_hi_x)

    weighted_edges = [
        (edge["source"], edge["target"], max(1, int(edge.get("count") or 1)))
        for edge in edges
        if edge["source"] in positions and edge["target"] in positions
    ]

    centrality = {node_id: float(graph_nodes[node_id].get("peerCount") or 0) for node_id in ids}
    for source, target, weight in weighted_edges:
        centrality[source] += weight
        centrality[target] += weight
    max_centrality = max(centrality.values()) or 1.0

    def clamp(node_id: str) -> None:
        radius = radii[node_id]
        x, y = positions[node_id]
        x = min(max(x, left + radius), right - radius)
        y = min(max(y, top + radius), bottom - radius)

        # Keep nodes clear of the legend box (top-left). Push down rather than
        # right so left-side chain-only nodes stay on their side. Edges can pass
        # behind it.
        if x < 405 and y < 370:
            y = 370 + radius
        positions[node_id] = [x, y]

    for node_id in ids:
        clamp(node_id)

    for _ in range(520):
        forces = {node_id: [0.0, 0.0] for node_id in ids}

        for i, a in enumerate(ids):
            ax, ay = positions[a]
            for b in ids[i + 1 :]:
                bx, by = positions[b]
                dx, dy = bx - ax, by - ay
                distance = max(1.0, math.hypot(dx, dy))
                min_distance = radii[a] + radii[b] + 18
                repel = 7200 / (distance * distance)
                if distance < min_distance:
                    repel += (min_distance - distance) * 0.9
                fx, fy = dx / distance * repel, dy / distance * repel
                forces[a][0] -= fx
                forces[a][1] -= fy
                forces[b][0] += fx
                forces[b][1] += fy

        for source, target, weight in weighted_edges:
            sx, sy = positions[source]
            tx, ty = positions[target]
            dx, dy = tx - sx, ty - sy
            distance = max(1.0, math.hypot(dx, dy))
            desired = 175 + radii[source] + radii[target] - min(weight, 4) * 12
            pull = (distance - desired) * 0.014 * min(weight, 4)
            fx, fy = dx / distance * pull, dy / distance * pull
            forces[source][0] += fx
            forces[source][1] += fy
            forces[target][0] -= fx
            forces[target][1] -= fy

        for node_id in ids:
            x, y = positions[node_id]
            group = group_of[node_id]
            if group == "chain":
                forces[node_id][0] += (chain_x - x) * 0.013
                forces[node_id][1] += (cy - y) * 0.0015
            elif group == "data":
                forces[node_id][0] += (data_x - x) * 0.013
                forces[node_id][1] += (cy - y) * 0.0015
            elif group == "both":
                forces[node_id][0] += (cx - x) * 0.004
                forces[node_id][1] += (p_target_y[node_id] - y) * 0.013
            else:
                central_pull = 0.004 + 0.01 * (centrality[node_id] / max_centrality)
                forces[node_id][0] += (cx - x) * central_pull
                forces[node_id][1] += (cy - y) * central_pull
            positions[node_id][0] += forces[node_id][0]
            positions[node_id][1] += forces[node_id][1]
            clamp(node_id)

    return {node_id: (coords[0], coords[1]) for node_id, coords in positions.items()}


def render_svg(snapshot: dict[str, Any], topology: dict[str, Any]) -> str:
    width = 1400
    graph_nodes = topology["graphNodes"]
    summary_rows = sorted(
        graph_nodes.values(),
        key=lambda node: (-int(node.get("peerCount") or 0), node["label"]),
    )
    summary_columns = 4 if len(summary_rows) > 12 else 3
    rows_per_column = max(1, math.ceil(len(summary_rows) / summary_columns))
    summary_height = 54 + rows_per_column * 20
    height = max(1080, 900 + summary_height)
    positions = layout_graph(graph_nodes, topology["edges"], width, height, summary_height)
    max_peer_count = max((int(node.get("peerCount") or 0) for node in graph_nodes.values()), default=1)

    # Rank the distinct Core versions seen so each node can be colored by how far
    # behind the newest version it is.
    node_versions = {
        node_id: short_version(node.get("version") or representative_version(node.get("versions") or []))
        for node_id, node in graph_nodes.items()
    }
    distinct_versions = sorted({vt for vt in (version_tuple(v) for v in node_versions.values()) if vt})
    version_rank = {vt: index for index, vt in enumerate(distinct_versions)}
    latest_rank = len(distinct_versions) - 1
    top_versions = sorted(distinct_versions, reverse=True)[:3]

    def version_label(vt: tuple[int, ...]) -> str:
        return "v" + ".".join(str(part) for part in vt)

    def version_ring_color(short: str | None) -> str:
        vt = version_tuple(short)
        rank = version_rank.get(vt) if vt is not None else None
        if rank is None:
            return VERSION_COLORS["older"]
        lag = latest_rank - rank
        if lag <= 0:
            return VERSION_COLORS["latest"]
        if lag == 1:
            return VERSION_COLORS["behind1"]
        if lag == 2:
            return VERSION_COLORS["behind2"]
        return VERSION_COLORS["older"]

    named_labels = topology.get("namedLabels") or {}

    def edge_direction(edge: dict[str, Any]) -> tuple[str, str] | None:
        """Resolve a connection's direction from the reporters' OUTBOUND/INBOUND view."""
        votes: dict[tuple[str, str], int] = {}
        for sample in edge["samples"]:
            reporter = named_labels.get(sample.get("reportedBy"))
            heading = (sample.get("direction") or "").upper()
            if reporter is None or reporter not in (edge["source"], edge["target"]):
                continue
            if heading not in ("OUTBOUND", "INBOUND"):
                continue
            other = edge["target"] if reporter == edge["source"] else edge["source"]
            pair = (reporter, other) if heading == "OUTBOUND" else (other, reporter)
            votes[pair] = votes.get(pair, 0) + 1
        if not votes:
            return None
        return max(votes, key=lambda pair: votes[pair])

    def arrow_for_edge(edge: dict[str, Any], color: str, x1: float, y1: float, x2: float, y2: float) -> str:
        direction = edge_direction(edge)
        if not direction:
            return ""
        _, to_id = direction
        if to_id == edge["target"]:
            tail_x, tail_y, tip_x, tip_y = x1, y1, x2, y2
        elif to_id == edge["source"]:
            tail_x, tail_y, tip_x, tip_y = x2, y2, x1, y1
        else:
            return ""
        dx, dy = tip_x - tail_x, tip_y - tail_y
        length = math.hypot(dx, dy) or 1
        ux, uy = dx / length, dy / length
        to_radius = node_radius(graph_nodes[to_id], max_peer_count)
        head_len = 12.0
        half_width = 4.0  # slender head: ~8 wide for 12 long
        if length <= to_radius + head_len + 6:
            return ""
        tip_x = tip_x - ux * (to_radius + 2)
        tip_y = tip_y - uy * (to_radius + 2)
        base_x = tip_x - ux * head_len
        base_y = tip_y - uy * head_len
        px, py = -uy, ux
        left_x, left_y = base_x + px * half_width, base_y + py * half_width
        right_x, right_y = base_x - px * half_width, base_y - py * half_width
        # Partly transparent so overlapping heads blend colors instead of hiding.
        return (
            f'<polygon points="{tip_x:.1f},{tip_y:.1f} {left_x:.1f},{left_y:.1f} '
            f'{right_x:.1f},{right_y:.1f}" fill="{color}" fill-opacity="0.6"/>'
        )

    def line_for_edge(edge: dict[str, Any], offset: float) -> str:
        if edge["source"] not in positions or edge["target"] not in positions:
            return ""
        x1, y1 = positions[edge["source"]]
        x2, y2 = positions[edge["target"]]
        dx, dy = x2 - x1, y2 - y1
        length = math.hypot(dx, dy) or 1
        nx, ny = -dy / length, dx / length
        x1 += nx * offset
        y1 += ny * offset
        x2 += nx * offset
        y2 += ny * offset
        color = COLORS.get(edge["kind"], COLORS["unknown"])
        dash = ' stroke-dasharray="8 7"' if edge["kind"].startswith("I2P") else ""
        width_attr = 2.2 if edge["kind"].endswith("CHAIN") else 2.8
        title = escape(
            f"{edge['kind']} count={edge['count']} "
            + "; ".join(sample.get("address") or "" for sample in edge["samples"][:4])
        )
        line = (
            f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{color}" stroke-width="{width_attr}" stroke-linecap="round" '
            f'opacity="0.82"{dash}><title>{title}</title></line>'
        )
        return line + arrow_for_edge(edge, color, x1, y1, x2, y2)

    pair_kinds: dict[tuple[str, str], list[str]] = {}
    for edge in topology["edges"]:
        pair = tuple(sorted((edge["source"], edge["target"])))
        pair_kinds.setdefault(pair, []).append(edge["kind"])

    edge_svg = []
    order = {"IP_CHAIN": 0, "IP_DATA": 1, "I2P_CHAIN": 2, "I2P_DATA": 3}
    for edge in sorted(topology["edges"], key=lambda e: (e["source"], e["target"], order.get(e["kind"], 9))):
        pair = tuple(sorted((edge["source"], edge["target"])))
        kinds = sorted(pair_kinds[pair], key=lambda k: order.get(k, 9))
        index = kinds.index(edge["kind"])
        offset = (index - (len(kinds) - 1) / 2) * 10
        edge_svg.append(line_for_edge(edge, offset))

    node_svg = []
    for node_id, node in sorted(
        graph_nodes.items(),
        key=lambda item: (int(item[1].get("peerCount") or 0), item[1]["label"]),
    ):
        if node_id not in positions:
            continue
        x, y = positions[node_id]
        radius = node_radius(node, max_peer_count)
        label = node["label"]
        # Uniform neutral base for every node; single-layer peers are tinted by
        # which side they were seen on. For I2P these cannot be merged across
        # chain/data, so a C# and a D# may actually be the same machine.
        fill = "#f8fafc"
        stroke = "#64748b"
        if node.get("group") == "chain":
            fill = "#dbeafe"  # light blue, echoes the I2P chain edges
        elif node.get("group") == "data":
            fill = "#ffedd5"  # light orange, echoes the I2P data edges
        font_size = max(10, min(30, radius * (0.72 if len(label) <= 2 else 0.5)))
        short = node_versions.get(node_id)
        ring_color = version_ring_color(short)
        ring_radius = radius + 4.5
        title_parts = [
            str(node.get("name") or node.get("host") or label),
            f"label={label}",
            f"chain={node.get('chainCount', 0)}",
            f"data={node.get('dataCount', 0)}",
            f"total={node.get('peerCount', 0)}",
        ]
        if node.get("version"):
            title_parts.append(str(node["version"]))
        if node.get("versions"):
            title_parts.extend(str(version) for version in node["versions"])
        node_svg.append(
            f'''
            <g class="node">
              <circle cx="{x:.1f}" cy="{y:.1f}" r="{ring_radius:.1f}" fill="none" stroke="{ring_color}" stroke-width="4"/>
              <circle cx="{x:.1f}" cy="{y:.1f}" r="{radius:.1f}" fill="{fill}" stroke="{stroke}" stroke-width="2.8"/>
              <text x="{x:.1f}" y="{y + font_size * 0.34:.1f}" class="node-label" font-size="{font_size:.1f}px">{escape(label)}</text>
              <title>{escape(' | '.join(title_parts))}</title>
            </g>
            '''
        )

    generated = snapshot.get("generatedAt", "")
    summary_cells = []
    for index, node in enumerate(summary_rows):
        column = index // rows_per_column
        row = index % rows_per_column
        x = 28 + column * 335
        y = height - summary_height + 37 + row * 20
        version = short_version(node.get("version") or representative_version(node.get("versions") or []))
        version_suffix = f", v{version}" if version else ""
        text = (
            f"{node['label']}: total {node.get('peerCount', 0)}, "
            f"chain {node.get('chainCount', 0)}, data {node.get('dataCount', 0)}"
            f"{version_suffix}"
        )
        summary_cells.append(f'<text x="{x}" y="{y}" class="summary">{escape(text)}</text>')

    version_palette = [VERSION_COLORS["latest"], VERSION_COLORS["behind1"], VERSION_COLORS["behind2"]]
    version_legend_items = [(version_palette[i], version_label(vt)) for i, vt in enumerate(top_versions)]
    has_older = any(version_ring_color(short) == VERSION_COLORS["older"] for short in node_versions.values())
    if has_older:
        version_legend_items.append((VERSION_COLORS["older"], "Older"))
    version_legend_svg = []
    for index, (color, text) in enumerate(version_legend_items):
        col, row = index % 2, index // 2
        cx_dot, tx = 28 + col * 162, 44 + col * 162
        cy_dot = 212 + row * 26
        version_legend_svg.append(
            f'<circle cx="{cx_dot}" cy="{cy_dot}" r="7" fill="none" stroke="{color}" stroke-width="3.5"/>'
            f'<text x="{tx}" y="{cy_dot + 4}" class="legend-text">{escape(text)}</text>'
        )
    version_legend_rows = "\n        ".join(version_legend_svg)

    # Fill-tint key for single-layer (chain-only / data-only) peers.
    fill_y = 212 + math.ceil(len(version_legend_items) / 2) * 26 + 8
    fill_legend = (
        f'<text x="18" y="{fill_y - 2}" class="legend-title">Node fill</text>'
        f'<circle cx="28" cy="{fill_y + 22}" r="7" fill="#dbeafe" stroke="#64748b" stroke-width="1.5"/>'
        f'<text x="44" y="{fill_y + 26}" class="legend-text">chain-only</text>'
        f'<circle cx="190" cy="{fill_y + 22}" r="7" fill="#ffedd5" stroke="#64748b" stroke-width="1.5"/>'
        f'<text x="206" y="{fill_y + 26}" class="legend-text">data-only</text>'
        f'<text x="18" y="{fill_y + 48}" class="legend-small">I2P peers appear once per layer (cannot be merged).</text>'
    )
    legend_box_h = fill_y + 58

    legend = f'''
      <g class="legend" transform="translate(28 34)">
        <rect x="0" y="0" width="340" height="{legend_box_h}" rx="8" fill="#ffffff" stroke="#cbd5e1"/>
        <text x="18" y="28" class="legend-title">Previewnet topology</text>
        <line x1="20" y1="52" x2="82" y2="52" stroke="{COLORS['IP_CHAIN']}" stroke-width="3"/>
        <text x="96" y="57" class="legend-text">IP chain connection</text>
        <line x1="20" y1="78" x2="82" y2="78" stroke="{COLORS['IP_DATA']}" stroke-width="3"/>
        <text x="96" y="83" class="legend-text">IP QDN/data connection</text>
        <line x1="20" y1="104" x2="82" y2="104" stroke="{COLORS['I2P_CHAIN']}" stroke-width="3" stroke-dasharray="8 7"/>
        <text x="96" y="109" class="legend-text">I2P chain connection</text>
        <line x1="20" y1="130" x2="82" y2="130" stroke="{COLORS['I2P_DATA']}" stroke-width="3" stroke-dasharray="8 7"/>
        <text x="96" y="135" class="legend-text">I2P QDN/data connection</text>
        <text x="18" y="154" class="legend-small">Circle size follows chain + data peer count.</text>
        <line x1="18" y1="170" x2="322" y2="170" stroke="#e2e8f0" stroke-width="1"/>
        <text x="18" y="190" class="legend-title">Core version</text>
        {version_legend_rows}
        {fill_legend}
      </g>
    '''

    summary_text = "\n".join(summary_cells)

    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <style>
    .title {{ font: 700 26px system-ui, -apple-system, Segoe UI, sans-serif; fill: #0f172a; }}
    .subtitle {{ font: 13px system-ui, -apple-system, Segoe UI, sans-serif; fill: #475569; }}
    .node-label {{ font-family: system-ui, -apple-system, Segoe UI, sans-serif; font-weight: 800; text-anchor: middle; fill: #0f172a; }}
    .legend-title {{ font: 700 16px system-ui, -apple-system, Segoe UI, sans-serif; fill: #0f172a; }}
    .legend-text {{ font: 13px system-ui, -apple-system, Segoe UI, sans-serif; fill: #334155; }}
    .legend-small {{ font: 11px system-ui, -apple-system, Segoe UI, sans-serif; fill: #64748b; }}
    .summary {{ font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #334155; }}
  </style>
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <g class="edges">
    {''.join(edge_svg)}
  </g>
  <g class="nodes">
    {''.join(node_svg)}
  </g>
  <rect x="405" y="14" width="590" height="64" rx="8" fill="#f8fafc" opacity="0.94"/>
  <text x="700" y="42" class="title" text-anchor="middle">Qortium Previewnet live topology</text>
  <text x="700" y="66" class="subtitle" text-anchor="middle">Generated {escape(generated)} from /admin/status, /peers, and /peers/data</text>
  {legend}
  <g class="summary-panel">
    <rect x="18" y="{height - summary_height - 12}" width="{width - 36}" height="{summary_height}" rx="8" fill="#ffffff" stroke="#cbd5e1"/>
    <text x="28" y="{height - summary_height + 12}" class="legend-title">Counts: chain + data peers</text>
    {summary_text}
  </g>
</svg>
'''


def export_png(svg_path: Path, png_path: Path) -> None:
    converter = shutil.which("magick") or shutil.which("convert")
    if not converter:
        raise RuntimeError("ImageMagick convert/magick not found")

    if Path(converter).name == "magick":
        command = [converter, str(svg_path), str(png_path)]
    else:
        command = [converter, str(svg_path), str(png_path)]
    run_command(command, None, 60)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def snapshot_slug(snapshot: dict[str, Any]) -> str:
    generated_at = snapshot.get("generatedAt")
    if isinstance(generated_at, str):
        try:
            parsed = dt.datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
            return parsed.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        except ValueError:
            pass

    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def summarize_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    nodes = snapshot.get("nodes") or {}
    topology = snapshot.get("topology") or {}
    graph_nodes = topology.get("graphNodes") or {}
    edges = topology.get("edges") or []
    errors = snapshot.get("errors") or {}

    operator_nodes = []
    for key, node in sorted(nodes.items()):
        status = node.get("status") or {}
        info = node.get("info") or {}
        operator_nodes.append(
            {
                "key": key,
                "label": node.get("label"),
                "name": node.get("name"),
                "role": node.get("role"),
                "publicHost": node.get("publicHost"),
                "buildVersion": info.get("buildVersion"),
                "nodeId": info.get("nodeId"),
                "height": status.get("height"),
                "syncPhase": status.get("syncPhase"),
                "chainCount": status.get("numberOfConnections", len(node.get("chainPeers") or [])),
                "dataCount": status.get("numberOfDataConnections", len(node.get("dataPeers") or [])),
                "error": node.get("error"),
            }
        )

    edge_counts_by_kind: dict[str, int] = {}
    for edge in edges:
        kind = str(edge.get("kind") or "unknown")
        edge_counts_by_kind[kind] = edge_counts_by_kind.get(kind, 0) + 1

    # Distinct peers seen across all operators, with their reported Core version.
    peer_versions: dict[Any, str | None] = {}
    for node in nodes.values():
        for layer in ("chainPeers", "dataPeers"):
            for peer in node.get(layer) or []:
                peer_id = peer.get("nodeId") or peer.get("address")
                if not peer_id:
                    continue
                version = peer.get("version")
                if version or peer_id not in peer_versions:
                    peer_versions[peer_id] = version

    version_counts: dict[str, int] = {}
    for version in peer_versions.values():
        key = short_version(version) or "unknown"
        version_counts[key] = version_counts.get(key, 0) + 1

    return {
        "schema": f"{QDN_DATA_SCHEMA}.summary",
        "generatedAt": snapshot.get("generatedAt"),
        "operatorCount": len(nodes),
        "observedPeerCount": len(topology.get("extraNodes") or {}),
        "graphNodeCount": len(graph_nodes),
        "edgeCount": len(edges),
        "edgeCountsByKind": edge_counts_by_kind,
        "peerVersionCounts": dict(sorted(version_counts.items())),
        "hasErrors": bool(errors),
        "errors": errors,
        "operators": operator_nodes,
    }


def build_qdn_manifest(
    snapshot: dict[str, Any],
    *,
    qdn_name: str,
    qdn_identifier: str,
    slug: str,
    resource_kind: str,
    files: list[str],
) -> dict[str, Any]:
    service = resource_kind.upper()

    return {
        "schema": QDN_DATA_SCHEMA,
        "generatedAt": snapshot.get("generatedAt"),
        "snapshotId": slug,
        "resource": {
            "service": service,
            "name": qdn_name,
            "identifier": qdn_identifier,
            "title": "Network",
        },
        "relatedResources": {
            "app": {
                "service": "APP",
                "name": qdn_name,
                "identifier": qdn_identifier,
                "title": "Network",
            },
            "database": {
                "service": "DATABASE",
                "name": qdn_name,
                "identifier": qdn_identifier,
                "title": "Network",
            },
            "snapshot": {
                "service": "SNAPSHOT",
                "name": qdn_name,
                "identifier": qdn_identifier,
                "title": "Network",
            },
        },
        "files": files,
    }


def snapshot_index_entry(slug: str, snap: dict[str, Any]) -> dict[str, Any]:
    """Compact metadata for one record, used by the app's record browser."""
    topology = snap.get("topology") or {}
    return {
        "snapshotId": slug,
        "generatedAt": snap.get("generatedAt"),
        "graphNodeCount": len(topology.get("graphNodes") or {}),
        "edgeCount": len(topology.get("edges") or []),
        "observedPeerCount": len(topology.get("extraNodes") or {}),
        "operatorCount": len(snap.get("nodes") or {}),
        "hasErrors": bool(snap.get("errors")),
    }


def write_qdn_payload(
    root: Path,
    snapshot: dict[str, Any],
    *,
    qdn_name: str,
    qdn_identifier: str,
) -> dict[str, Any]:
    slug = snapshot_slug(snapshot)
    summary = summarize_snapshot(snapshot)
    topology = snapshot.get("topology") or {}
    nodes = snapshot.get("nodes") or {}
    errors = snapshot.get("errors") or {}
    database_dir = root / "DATABASE" / qdn_name / qdn_identifier
    snapshot_dir = root / "SNAPSHOT" / qdn_name / qdn_identifier

    # Preserve previously published snapshots so the database keeps history.
    prior_snapshots: dict[str, dict[str, Any]] = {}
    existing_snapshots_dir = database_dir / "snapshots"
    if existing_snapshots_dir.exists():
        for path in existing_snapshots_dir.glob("*.json"):
            try:
                prior_snapshots[path.stem] = json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                continue

    if root.exists():
        shutil.rmtree(root)

    history = dict(prior_snapshots)
    history[slug] = snapshot
    # Newest first, bounded so the resource does not grow without limit.
    ordered_slugs = sorted(history, key=lambda item: (history[item].get("generatedAt") or item), reverse=True)
    ordered_slugs = ordered_slugs[:QDN_MAX_HISTORY]
    if slug not in ordered_slugs:
        ordered_slugs.append(slug)
    index_records = [snapshot_index_entry(item, history[item]) for item in ordered_slugs]

    database_files = [
        "manifest.json",
        "latest.json",
        "index.json",
        "records/summary.json",
        "records/topology.json",
        "records/errors.json",
    ]
    database_files.extend(f"snapshots/{item}.json" for item in ordered_slugs)
    snapshot_files = [
        "manifest.json",
        "snapshot.json",
        "summary.json",
        "topology.json",
        "errors.json",
    ]

    for key in sorted(nodes):
        database_files.append(f"records/nodes/{key}.json")
        snapshot_files.append(f"nodes/{key}.json")

    write_json(
        database_dir / "manifest.json",
        build_qdn_manifest(
            snapshot,
            qdn_name=qdn_name,
            qdn_identifier=qdn_identifier,
            slug=slug,
            resource_kind="DATABASE",
            files=database_files,
        ),
    )
    write_json(database_dir / "latest.json", snapshot)
    write_json(
        database_dir / "index.json",
        {
            "schema": f"{QDN_DATA_SCHEMA}.index",
            "generatedAt": snapshot.get("generatedAt"),
            "latest": ordered_slugs[0] if ordered_slugs else slug,
            "count": len(index_records),
            "records": index_records,
        },
    )
    write_json(database_dir / "records" / "summary.json", summary)
    write_json(database_dir / "records" / "topology.json", topology)
    write_json(database_dir / "records" / "errors.json", errors)
    for item in ordered_slugs:
        write_json(database_dir / "snapshots" / f"{item}.json", history[item])

    for key, node in sorted(nodes.items()):
        write_json(database_dir / "records" / "nodes" / f"{key}.json", node)

    write_json(
        snapshot_dir / "manifest.json",
        build_qdn_manifest(
            snapshot,
            qdn_name=qdn_name,
            qdn_identifier=qdn_identifier,
            slug=slug,
            resource_kind="SNAPSHOT",
            files=snapshot_files,
        ),
    )
    write_json(snapshot_dir / "snapshot.json", snapshot)
    write_json(snapshot_dir / "summary.json", summary)
    write_json(snapshot_dir / "topology.json", topology)
    write_json(snapshot_dir / "errors.json", errors)

    for key, node in sorted(nodes.items()):
        write_json(snapshot_dir / "nodes" / f"{key}.json", node)

    resource_index = {
        "schema": QDN_DATA_SCHEMA,
        "generatedAt": snapshot.get("generatedAt"),
        "snapshotId": slug,
        "resources": {
            "app": {
                "service": "APP",
                "name": qdn_name,
                "identifier": qdn_identifier,
                "publishPath": None,
            },
            "database": {
                "service": "DATABASE",
                "name": qdn_name,
                "identifier": qdn_identifier,
                "publishPath": str(database_dir),
            },
            "snapshot": {
                "service": "SNAPSHOT",
                "name": qdn_name,
                "identifier": qdn_identifier,
                "publishPath": str(snapshot_dir),
            },
        },
    }
    write_json(root / "qdn-resources.json", resource_index)

    return resource_index


def main() -> int:
    parser = argparse.ArgumentParser(description="Map Qortium Previewnet chain/data topology.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--qdn-data-dir", type=Path, default=DEFAULT_QDN_DATA_DIR)
    parser.add_argument("--qdn-name", default=DEFAULT_QDN_NAME)
    parser.add_argument("--qdn-identifier", default=DEFAULT_QDN_IDENTIFIER)
    parser.add_argument("--no-qdn-data", action="store_true", help="Do not write QDN-ready data directories")
    parser.add_argument("--svg", type=Path, default=None, help="SVG output path")
    parser.add_argument("--snapshot", type=Path, default=None, help="JSON snapshot output path")
    parser.add_argument("--png", type=Path, default=None, help="PNG output path")
    parser.add_argument("--no-png", action="store_true", help="Do not attempt PNG export")
    parser.add_argument(
        "--timestamp",
        action="store_true",
        help="Append a UTC timestamp to default output filenames so runs are not overwritten",
    )
    parser.add_argument("--timeout", type=int, default=8, help="Per-endpoint curl timeout in seconds")
    parser.add_argument(
        "--max-extra-peers",
        type=int,
        default=40,
        help="Maximum number of non-operator peers to draw; use -1 for unlimited",
    )
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    stem = "preview-topology"
    if args.timestamp:
        stem += "-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    svg_path = args.svg or (args.output_dir / f"{stem}.svg")
    snapshot_path = args.snapshot or (args.output_dir / f"{stem}.json")
    png_path = args.png or (args.output_dir / f"{stem}.png")

    snapshot = collect_nodes(args.timeout)
    topology = build_topology(snapshot, args.max_extra_peers)
    snapshot["topology"] = topology

    snapshot_path.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    svg_path.write_text(render_svg(snapshot, topology), encoding="utf-8")

    print(f"Wrote snapshot: {snapshot_path}")
    print(f"Wrote SVG: {svg_path}")

    if not args.no_qdn_data:
        qdn_resources = write_qdn_payload(
            args.qdn_data_dir,
            snapshot,
            qdn_name=args.qdn_name,
            qdn_identifier=args.qdn_identifier,
        )
        print(f"Wrote QDN resource index: {args.qdn_data_dir / 'qdn-resources.json'}")
        print(f"DATABASE publish path: {qdn_resources['resources']['database']['publishPath']}")
        print(f"SNAPSHOT publish path: {qdn_resources['resources']['snapshot']['publishPath']}")

    if not args.no_png:
        try:
            export_png(svg_path, png_path)
            print(f"Wrote PNG: {png_path}")
        except Exception as exc:  # noqa: BLE001 - PNG is a convenience export
            print(f"PNG export skipped: {exc}", file=sys.stderr)

    if snapshot.get("errors"):
        print("Collection completed with node errors:", file=sys.stderr)
        for node, error in snapshot["errors"].items():
            print(f"  {node}: {error}", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
