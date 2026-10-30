# Auto-logging deployment (netcup, rootless)

Two **user** systemd timers run the topology logger as the `qortium` user — no
root required (the host already has `Linger=yes`, matching `wright-bot.service`).

- **collector** — every ~10 min, captures one snapshot into a local archive
  (`scripts/auto-collect.mjs`). Cheap; no on-chain activity.
- **publisher** — ~2×/day, picks the best recent record and publishes
  `DATABASE/Network/Network` only (`scripts/auto-publish.mjs`). `SNAPSHOT` is
  intentionally skipped.

"Best" = error-free **and** in consensus (operators at one height), then the
most peers → most edges → highest version adoption → most recent. Records are
spaced at least `MIN_GAP_HOURS` (8h) apart, measured from the last *selected*
record, so daily posts never cluster across the midnight boundary. The DATABASE
resource keeps the newest 1000 records, which the in-app browser pages through.

## Prerequisites (already true on netcup)

- synced Qortium Core on `127.0.0.1:24891`
- `python3`, `curl`, `git`, `ssh`; user lingering enabled
- the signing account that owns `Network` present in the accounts JSON
- local management API and peer-exchange log access on Netcup

The timers use only Node + Python standard libraries, so **no `npm install` and
no build** are needed.

## 1. Userland Node

```
mkdir -p ~/.local && cd ~/.local
VER=$(curl -fsS https://nodejs.org/dist/index.json | python3 -c "import json,sys;print([x for x in json.load(sys.stdin) if x['lts']][0]['version'])")
curl -fsSLO https://nodejs.org/dist/$VER/node-$VER-linux-x64.tar.xz
tar xf node-$VER-linux-x64.tar.xz && rm -rf node && mv node-$VER-linux-x64 node
~/.local/node/bin/node --version
```

## 2. Repo

```
git clone -b record-browser https://github.com/QortiumDev/qortium-network.git ~/qortium-network
```

Update later with `git -C ~/qortium-network pull` (or switch to `main` after merge).

## 3. Managed observer access

The collector queries Netcup over IPv4 loopback when
`QORTIUM_NETWORK_LOCAL_NODE=netcup`. It reads Netcup's peer-exchange log and
continues public-peer API discovery. Regxa was retired in October 2026;
no Regxa SSH alias, account or API is needed, and its former IP is excluded
from discovery probes. Existing historical Regxa records are retained.

Verify locally: `curl -fsS --max-time 8 http://127.0.0.1:24891/admin/info`.
Check `collection.operatorKeys` and `errors` in the new snapshot to distinguish
the configured managed observation from discovered public peers. One configured
operator means the publisher's operator-height gate has no independent second
operator to compare; it still rejects records containing collection errors.

## 4. Configure

```
cp ~/qortium-network/deploy/qortium-network.env.example ~/qortium-network/deploy/qortium-network.env
# edit: confirm apikey + accounts paths and that LOCAL_NODE=netcup
chmod 600 ~/qortium-network/deploy/qortium-network.env
```

## 5. (Optional) seed existing history

A fresh payload starts empty, so the first publish would replace the live
DATABASE with a single record. To preserve records already on QDN, copy the
current payload before enabling the publisher (run from the dev checkout):

```
rsync -a target/qdn-topology-data/ qortium-netcup:~/qortium-network/target/qdn-topology-data/
```

## 6. Install and enable the user timers

```
mkdir -p ~/.config/systemd/user
cp ~/qortium-network/deploy/qortium-network-*.service ~/qortium-network/deploy/qortium-network-*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now qortium-network-collect.timer
systemctl --user enable --now qortium-network-publish.timer
```

## 7. Verify

```
# one collection by hand
systemctl --user start qortium-network-collect.service
journalctl --user -u qortium-network-collect.service -n 30 --no-pager

# preview the publisher's choice without publishing
set -a; . ~/qortium-network/deploy/qortium-network.env; set +a
~/.local/node/bin/node ~/qortium-network/scripts/auto-publish.mjs --dry-run

systemctl --user list-timers 'qortium-network-*'
```

## Tuning

| Setting | Where | Default |
|---------|-------|---------|
| Sample interval | collector timer `OnUnitActiveSec` | 10 min |
| Publish cadence | publisher timer `OnCalendar` | 06:05 / 18:05 UTC |
| Min gap between posts | `QORTIUM_NETWORK_MIN_GAP_HOURS` | 8 |
| Local archive retention | `QORTIUM_NETWORK_RETENTION_DAYS` | 14 days |
| History kept on QDN | `QDN_MAX_HISTORY` in the Python tool | 1000 |

The app (`APP/Network/Network`) is **not** auto-published; republish it manually
with `npm run qdn:publish` only when the viewer code changes.
