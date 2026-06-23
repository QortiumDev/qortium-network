# Auto-logging deployment (netcup)

Two systemd timers run the topology logger on the netcup VPS:

- **collector** — every ~10 min, captures one snapshot into a local archive
  (`scripts/auto-collect.mjs`). Cheap; no on-chain activity.
- **publisher** — ~2×/day, picks the best recent record and publishes
  `DATABASE/Network/Network` only (`scripts/auto-publish.mjs`). `SNAPSHOT` is
  intentionally skipped.

"Best" = error-free **and** in consensus (operators at one height), then the
most peers → most edges → highest version adoption → most recent. Records are
spaced at least `MIN_GAP_HOURS` (8h) apart, measured from the last *selected*
record, so daily posts never cluster across the midnight boundary.

The DATABASE resource keeps the newest 1000 records (`QDN_MAX_HISTORY`), which
the in-app record browser pages through.

## What netcup needs

No `npm install` and no build are required for the timers — the scripts use only
Node and Python standard libraries plus `curl`/`ssh`. Install:

- `node` (v18+), `python3`, `curl`, `ssh`
- a synced Qortium Core node on `127.0.0.1:24891` (netcup already runs one)
- this repo checked out, e.g. at `/opt/qortium-network`

## 1. SSH from netcup to regxa

The collector queries netcup over localhost (`--local-node netcup`) and **regxa
over SSH**. Add an SSH alias on netcup so this resolves non-interactively:

```
# ~/.ssh/config on netcup
Host qortium-regxa
    HostName 146.103.42.59
    User <regxa-user>
    IdentityFile ~/.ssh/<key>
    BatchMode yes
```

Verify: `ssh qortium-regxa 'curl -fsS --max-time 8 http://localhost:24891/admin/info'`

If regxa is ever unreachable, the snapshot is kept but marked with an error and
is automatically disqualified from publishing.

## 2. Signing account + API key

Publishing signs an ARBITRARY transaction from the account that owns the QDN
name **Network** (`QaLdnApWW3hps1qXM8cpsL1pVgw7RtyJmN`). Copy *only* that
account entry to netcup and lock it down:

```
install -d -m 700 /opt/qortium-network/secrets
# copy the accounts JSON containing the role that owns "Network"
install -m 600 initial-minting-accounts.json /opt/qortium-network/secrets/
```

Point `QORTIUM_NETWORK_NODE_API_KEY_PATH` at netcup's Core `apikey.txt`.

> Secret handling: never commit these files. `secrets/` and `target/` are
> outside version control.

## 3. Configure

```
cp deploy/qortium-network.env.example /etc/qortium-network.env
# edit paths/role to match the host
```

## 4. (Optional) seed existing history

A fresh netcup payload starts empty, so the first publish would replace the live
DATABASE with a single record. To preserve the records already on QDN, copy the
current payload dir to netcup before enabling the timers:

```
rsync -a target/qdn-topology-data/ netcup:/opt/qortium-network/target/qdn-topology-data/
```

(The publisher accumulates new records on top of whatever is already there.)

## 5. Install and enable the timers

Edit `User=` and `WorkingDirectory=` in both `.service` files (and the `node`
path if needed), then:

```
sudo cp deploy/qortium-network-*.service deploy/qortium-network-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qortium-network-collect.timer
sudo systemctl enable --now qortium-network-publish.timer
```

## 6. Verify

```
# one collection by hand
sudo systemctl start qortium-network-collect.service
journalctl -u qortium-network-collect.service -n 30 --no-pager

# see what the publisher WOULD post, without publishing
sudo -u <service-user> QORTIUM_NETWORK_... node scripts/auto-publish.mjs --dry-run
#   (easiest: `set -a; . /etc/qortium-network.env; set +a` first)

# timer schedule
systemctl list-timers 'qortium-network-*'
```

## Tuning

| Setting | Env | Default |
|---------|-----|---------|
| Sample interval | (collector timer `OnUnitActiveSec`) | 10 min |
| Publish cadence | (publisher timer `OnCalendar`) | 06:05 / 18:05 |
| Min gap between posts | `QORTIUM_NETWORK_MIN_GAP_HOURS` | 8 |
| Local archive retention | `QORTIUM_NETWORK_RETENTION_DAYS` | 14 days |
| History kept on QDN | `QDN_MAX_HISTORY` in the Python tool | 1000 |

The app (`APP/Network/Network`) is **not** auto-published; republish it manually
with `npm run qdn:publish` only when the viewer code changes.
