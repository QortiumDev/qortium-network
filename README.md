# Qortium Network

Utilities for preparing Qortium network topology data for a future QDN viewer.

## App

The QDN app is a static Vite/React viewer for `DATABASE/Network/Network` topology data.

Run it locally:

```bash
npm install
npm run dev
```

Build and test it:

```bash
npm test
npm run build
```

The app loads `DATABASE/Network/Network/latest.json` through the QDN bridge when available. In local browser development it falls back to the local Core API at `http://127.0.0.1:24891`, and if the QDN data is not available it shows bundled sample data.

Publish the app after building:

```bash
npm run build
npm run qdn:publish
```

Publish freshly generated topology data:

```bash
python3 tools/network-topology-data.py --no-png
npm run qdn:publish:data
```

The publish helpers use the same local Previewnet account pattern as the other Qortium apps. Environment overrides use the `QORTIUM_NETWORK_` prefix.

## Topology Data

`tools/network-topology-data.py` is copied from the existing Previewnet topology map script and extended to emit QDN-ready data directories.

### Peer discovery

Collection seeds from the two VPS seed nodes (Netcup, Regxa) over SSH, then
breadth-first probes every reachable peer's **public HTTP API** outward from
there, deduping by host and by `nodeId` as it expands. Every node that answers
becomes a first-class observer, so the map shows real non-seed links — including
I2P↔I2P connections that touch a reachable node, and nodes several hops out —
instead of every peer collapsing onto the two seeds.

Only the voluntary, opt-out API is read (`/admin/info`, `/admin/status`,
`/peers`, `/peers/data`, read-only). An **I2P-only node has no IP in any peer
list**, so there is nothing to dial: it stays an observed-only leaf and remains
private by construction. A missing edge therefore means *unreachable/unknown*,
not *not connected*. The involuntary P2P gossip surface is never used.

Relevant flags: `--no-discover` (seeds only), `--max-hops` (default 4),
`--max-nodes` (default 250), `--api-port` (default 24891), `--probe-timeout`,
`--probe-workers`.

Default QDN identities:

- `APP/Network/Network`
- `DATABASE/Network/Network`
- `SNAPSHOT/Network/Network`

Generate the current snapshot, SVG, and QDN payload directories:

```bash
python3 tools/network-topology-data.py --no-png
```

Default output paths:

- `target/preview-topology/preview-topology.json`
- `target/preview-topology/preview-topology.svg`
- `target/qdn-topology-data/qdn-resources.json`
- `target/qdn-topology-data/DATABASE/Network/Network`
- `target/qdn-topology-data/SNAPSHOT/Network/Network`

Publishing those payload directories to QDN is intentionally left for a later pass.

## Auto-logging

Two helpers drive scheduled, curated logging (intended for the netcup VPS):

```bash
npm run qdn:collect       # capture one snapshot into the local archive (no publish)
npm run qdn:auto-publish  # pick the best recent record and publish DATABASE only
```

`qdn:auto-publish` selects an error-free, in-consensus record with the most
peers (then edges, version adoption, recency) from the eligible window, keeping
published records at least `QORTIUM_NETWORK_MIN_GAP_HOURS` apart. Run it with
`--dry-run` to preview the choice. See [`deploy/README.md`](deploy/README.md)
for the systemd timer setup and configuration.
