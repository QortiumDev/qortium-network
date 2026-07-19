# Qortium Network

A QDN topology viewer and data-collection pipeline for Qortium Previewnet. The
viewer ships as `qdn://APP/Network/Network`; its current and historical data is
published separately under `DATABASE/Network/Network` and
`SNAPSHOT/Network/Network`.

## Viewer

The React viewer currently provides:

- an interactive chain/QDN-data graph with pan, zoom, reset, and node focus;
- filters for I2P/IP chain and data connections;
- node, link, country, and Core-version summaries with detail modals;
- country flags and version rings, with details for the selected node;
- snapshot-history navigation with a slider, older/newer controls, and
  Left/Right Arrow keyboard shortcuts;
- durable historical-snapshot URLs that participate in Home Back/Forward
  navigation while keeping the latest snapshot at the canonical app URL;
- bundled sample data when published QDN data cannot be loaded.

The app loads `latest.json`, `index.json`, and historical snapshot files from
`DATABASE/Network/Network` through Qortium Home's `qdnRequest` bridge. In a plain
browser it performs the same read-only requests against
`http://127.0.0.1:24891` by default. Set `VITE_QORTIUM_NODE_API_URL` to use a
different development node.

Historical links use `?snapshot=YYYYMMDDTHHMMSSZ`, matching an indexed file at
`snapshots/<snapshotId>.json`. The bounded DATABASE history currently retains
the newest 1,000 snapshots, so a sufficiently old link can eventually fall back
to the latest retained record after its snapshot is pruned.

The viewer supports Classic and Modern QDN UI styles, along with Home theme,
accent, and text-size settings. It does not define a Fun style.

## QAVS

The app is at QAVS `1.4.1`: `1.4` is the minimum Qortium platform level and the
patch number is the app release. `vite.config.ts` reads `package.json`, injects
the visible version badge, and emits `dist/qortium-app.json` with the name
`Network` and the current version during every build.

## Develop and publish the viewer

```sh
npm install
npm run dev
npm test
npm run build
npm run preview
```

Publish a built viewer to the default Previewnet identity:

```sh
npm run qdn:publish
```

The publisher reads `dist/`, uses the local Core at
`http://127.0.0.1:24891`, and defaults to
`~/qortium/git/qortium-core/preview/secrets/initial-minting-accounts.json`.
Overrides use the `QORTIUM_NETWORK_` prefix. The render URL is
`http://127.0.0.1:24891/render/APP/Network/Network`.

## Collect topology data

Generate a current snapshot, SVG, and the QDN payload directories with:

```sh
python3 tools/network-topology-data.py --no-png
```

The collector starts from the configured seed nodes, then breadth-first probes
reachable peers through their public read-only APIs. It deduplicates by host and
node ID, treats missing edges as unknown rather than disconnected, and supports
`--no-discover`, `--max-hops`, `--max-nodes`, `--api-port`,
`--probe-timeout`, and `--probe-workers`.

Collection uses `/admin/info`, `/admin/status`, `/peers`, and `/peers/data`; it
does not inspect private node state. The defaults allow four discovery hops, at
most 250 queried nodes, public API port `24891`, a five-second probe timeout,
and 12 concurrent probe workers. `--max-extra-peers` separately limits how many
non-operator peers are drawn. A reachable node becomes an observer in its own
right, so the resulting topology can include non-seed and multi-hop links rather
than making every connection appear to terminate at a seed.

I2P-only peers cannot be probed over a clearnet API. When Core's
`recordPeerExchange` setting is enabled, the collector also reads recent
`peer-exchange.jsonl` records from each seed and adds approximate gossip-derived
I2P edges. The seed configuration defaults that remote path to
`qortium/preview/peer-exchange.jsonl` relative to the VPS account home; this is
the deployed seed layout, not the local source checkout. Use `--no-gossip`,
`--gossip-window-hours`, or `--gossip-tail-lines` to control this input.

Clearnet IPv4 nodes receive offline country lookups from the vendored
`tools/geoip-ipv4-country.bin.gz`; no peer IP is sent to an external geolocation
service. Rebuild the table with:

```sh
python3 tools/build_geoip_ipv4.py
```

Default outputs are:

- `target/preview-topology/preview-topology.json`
- `target/preview-topology/preview-topology.svg`
- `target/qdn-topology-data/qdn-resources.json`
- `target/qdn-topology-data/DATABASE/Network/Network`
- `target/qdn-topology-data/SNAPSHOT/Network/Network`

The DATABASE payload contains `latest.json`, `index.json`, individual files
under `snapshots/`, and a compact topology record. The tool retains at most
1,000 historical DATABASE records. The SNAPSHOT payload is the point-in-time
resource for the current run. `qdn-resources.json` records both resource
directories for the publishing scripts.

## Publish topology data

After generating payloads, publish both data resources or the viewer and data
together:

```sh
npm run qdn:publish:data
npm run qdn:publish:all
```

`qdn:publish:data` publishes both `DATABASE/Network/Network` and
`SNAPSHOT/Network/Network`. The shared publish helper uses the current local
development default
`~/qortium/git/qortium-core/preview/secrets/initial-minting-accounts.json`.

## Scheduled collection and publishing

```sh
npm run qdn:collect
npm run qdn:auto-publish -- --dry-run
npm run qdn:auto-publish
```

`qdn:collect` adds one snapshot to `target/preview-topology` and prunes archived
files older than 14 days by default. `qdn:auto-publish` considers archived
records after the last selected timestamp, rejects records with collection
errors or seed-height disagreement, selects the strongest eligible record, and
publishes the DATABASE resource only. Its default minimum gap is eight hours.

The production rootless systemd collector/publisher setup is documented in
[`deploy/README.md`](deploy/README.md). The timers publish data only; viewer code
is still published manually with `npm run qdn:publish`.
