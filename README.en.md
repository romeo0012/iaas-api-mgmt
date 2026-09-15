# IaaS API Mgmt (English)

Node.js + Express + Socket.IO web UI that **visualizes a VM topology**, **computes monthly costs** (Business Cloud IaaS "Resource Pool" + an informational PaaS cloudlet comparison) and can **deploy the whole topology to T-Cloud (CloudSigma) IaaS**.

There is no fixed SLB / Kubernetes / PostgreSQL model — every VM (OPNsense firewall, application servers, database servers, and other VMs like W-01/NFS/Cache/NoSQL) is a plain VM where you click to set **CPU / RAM / Disk** (+ disk tier).

## Requirements

- Node.js (tested on v26)
- Python 3 + FastAPI/uvicorn (only for the optional LLM fallback — see below)

## Installation & run

```bash
npm ci && npm start
```

The app serves on `http://localhost:3000`. Override the port with the `PORT` env var.

Behind a reverse proxy with a base path (e.g. `/iaasapimgmt`):

```bash
BASE_PATH=/iaasapimgmt npm start
```

The app is then available at `http://localhost:3000/iaasapimgmt/`. Works with Socket.IO (the path auto-configures to `BASE_PATH + /socket.io`) and the `/docs/` proxy.

### PM2 / Forever

Optional process-manager configs exist (`ecosystem.config.js`, `forever.json`). Set `PORT`/`BASE_PATH` in `.env`.

### Notes

- A `Procfile` (if present) is stale — the real entrypoint is `server.js`.
- No tests, linter, typecheck, or build step.
- `.gitignore` excludes `node_modules/` and `package-lock.json`.

## Configuration (`.env`)

Copy from the template: `cp .env.example .env`

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | server port | `3003` |
| `BASE_PATH` | base path prefix behind a reverse proxy | — |
| `IaaS_COMMITMENT_MONTHS` | commitment length (0=no commitment / 12 / 24 / 36) — switchable at runtime in the UI | `12` |
| `IaaS_CPU_RATE_CZK_GHZ` | price per CPU GHz/month (default commitment) | `108.73` (12m) |
| `IaaS_RAM_RATE_CZK_GB` | price per RAM GB/month (default commitment) | `47.30` (12m) |
| `IaaS_DISK_RATE_CZK_GB` | price per disk GB/month, Super Fast tier (default commitment) | `3.15` (12m) |
| `IaaS_PAAS_UTILIZATION` | default utilization for the PaaS section in % (UI slider 10–100; determines the number of dynamic cloudlets) | `40` |
| `IaaS_NETWORK_FW_RATE_CZK` | flat monthly "Networking and FW" fee (all commitments) | `108` |
| `TCLOUD_BASE_URL` | T-Cloud API base | `https://prg1.t-cloud.eu/api/2.0` |
| `TCLOUD_REFERER` | Referer header | `https://prg1.t-cloud.eu` |
| `TCLOUD_USERNAME` / `TCLOUD_PASSWORD` / `TCLOUD_OTP_SECRET` | deployment credentials (fallback) | empty |
| `TCLOUD_VLAN_UUID` | optional single VLAN attached to a NIC | — |
| `OPENAI_API_KEY` / `OPENAI_MODEL` / `LLM_ENDPOINT` / `LLM_MODEL` / `FALLBACK_URL` | optional LLM fallback — see below | — |

> `.env` rate overrides (`IaaS_CPU_RATE_CZK_GHZ`, `IaaS_RAM_RATE_CZK_GB`, `IaaS_DISK_RATE_CZK_GB`) apply **only to the default commitment**; switching to another commitment in the UI always uses the table rates from the official T-Business calculator. The same logic applies to PaaS (see the PaaS section below).

### Full rate table (T-Business calculator, CZK/month)

Unit rates come from the official calculator https://t-business.cz/cs/kalkulator-ceny/ (`/api/calculator/groups`); "no commitment" (0) was verified via `/api/calculator/calculate` with `commitment_months=0`.

| Component | 0m (none) | 12m | 24m | 36m |
|---|---|---|---|---|
| CPU (GHz) | 157.06 | 108.73 | 102.69 | 96.65 |
| RAM (GB) | 68.33 | 47.30 | 44.68 | 42.05 |
| Disk Super Fast 10000 (GB) | 4.55 | 3.15 | 2.98 | 2.80 |
| Disk Fast 5000 (GB) | 2.60 | 1.80 | 1.70 | 1.60 |
| Disk Standard 3000 (GB) | 1.95 | 1.35 | 1.28 | 1.20 |
| Disk Basic 600 (GB) | 1.30 | 0.90 | 0.85 | 0.80 |
| Networking and FW (flat/monthly) | 108 | 108 | 108 | 108 |

## Costing — Calculation logic

### 1. IaaS (Business Cloud "Resource Pool")

Business Cloud IaaS is billed as a **Resource Pool** across the whole architecture — the price is computed from the **sum** of all VMs' resources, not per VM:

```
total (IaaS) = ceil(Σ CPU GHz) × cpuRate
             + Σ RAM GB × ramRate
             + Σ disk GB × rate (per each VM's tier)
             + "Networking and FW"                 (flat, 108 CZK, all commitments)
```

Calculation steps (server `lib/pricing.js`, mirrored client-side in `public/main.js`):

1. **Per-VM lines** (`nodeCost`):
   - `cpuCost = cpuGHz × cpuRate(cm)` (exact, not rounded)
   - `ramCost = ramGB × ramRate(cm)`
   - `diskCost = diskGB × (tierRate + basicRate)` — the BC calculator always adds a base **"Basic" volume of the same size** on top of a VM's disk at its performance tier
   - `total = cpuCost + ramCost + diskCost`
2. **Pooled sums** (`summarize`):
   - CPU is billed on the **total GHz rounded up to a whole number** (like the calculator: 36.8 GHz → 37 × rate). Per-node lines stay **exact**; only the pooled CPU is rounded. The difference between the per-node sum and the pooled CPU price comes from this rounding.
   - RAM and disk are summed exactly.
   - `diskCostCZK (total) = Σ per-node diskCost` (= Σ performance tiers + total disk at the Basic rate).
3. **Disk by tier** (`diskByTier`): for the Super Fast / Fast / Standard tiers, the GB of all VMs of that tier are summed × tier rate; a line **`Basic (basis)`** = **total disk of all VMs** × Basic rate is always added.
4. **Price by group**: sum of per-node `totalCZK` + VM count in each group.
5. Formatting: `formatCZK` rounds to whole CZK and separates thousands with spaces (`1 158 Kč`).

### 2. PaaS (cloudlets — informational comparison)

An informational section in the UI — **does not affect the IaaS price**. It models Virtuozzo cloudlets including the official price list (volume bands, CZK/cloudlet/month = hourly rate × 730 h):

- **Cloudlet** = 128 MiB RAM (0.125 GiB) + 400 MHz CPU (0.4 GHz) — **both adjustable** in the UI (PaaS parameters, "Cloudlet RAM" / "Cloudlet CPU" fields).
- **Cloudlets per VM** = `ceil(max(cpuGHz / (clCpuMHz/1000), ramGB / (clRamMiB/1024)))` (independent of disk), where `clCpuMHz` and `clRamMiB` are the cloudlet parameters (default 400 / 128).
- **What changing the RAM/CPU ratio in a cloudlet does**: the cloudlet size only "sees" CPU and RAM, so changing the cloudlet parameters changes **the number of cloudlets of every VM** (and thus the total `N`):
  - increasing a cloudlet's RAM or CPU → the cloudlet covers more of the VM's resources → fewer cloudlets (and vice versa);
  - the new `N` is used to recompute the **volume price** (bands below), the effective average rate and the dynamic share price; **price per cloudlet in CZK does not change** — the parameter only changes *how many* cloudlets are counted;
  - example: VM 7.2 GHz / 2.25 GiB → default (400 MHz + 128 MiB): `ceil(max(7.2/0.4, 2.25/0.125))` = `ceil(max(18, 18))` = **18 cloudlets**; reducing the cloudlet CPU to 200 MHz → `ceil(max(36, 18))` = **36 cloudlets** (double).
- **Total `N`** = sum across all VMs (= the **reserved** cloudlets, always paid).
- **Virtuozzo cloudlet price list (volume bands on total count):**
  | Band | 1–16 | 17–32 | 33–64 | 65–128 | 129+ |
  |---|---|---|---|---|---|
  | **Reserved** CZK/cl/month | 98.84 | 93.88 | 88.91 | 84.02 | 79.06 |
  | **Dynamic** CZK/cl/month | 148.26 | 144.54 | 140.82 | 137.09 | 133.44 |
  (Hourly rates × 730 h: 0.1354/0.1286/0.1218/0.1151/0.1083 → 98.84/93.88/88.91/84.02/79.06 and 0.2031/0.1980/0.1929/0.1878/0.1828 → 148.26/144.54/140.82/137.09/133.44. Discounts: reserved 33–47 %, dynamic 0–10 %.)
- **Price calculation**:
  - **Reserved cloudlets R** = always-paid minimum = `ceil(N × 15 %)` (e.g. 82 → 13);
  - **Dynamic cloudlets D** = actually used above the reservation = `ceil(N × utilization) − R` (e.g. 82 @40 % → `33 − 13 = 20`; @100 % → `82 − 13 = 69`);
  - **Cloudlet price** = `band(R, reserved rates) + band(D, dynamic rates)`, where `band(n, rates)` distributes `n` across the volume bands;
  - example @40 %: R=13 → 13×98.84 = **1 284.92 CZK**; D=20 → 16×148.26 + 4×144.54 = **2 950.32 CZK**; total **4 235.24 CZK**;
  - example @100 %: R=13 → **1 284.92 CZK**; D=69 → 16×148.26 + 16×144.54 + 32×140.82 + 5×137.09 = **9 876.49 CZK**; total **11 161.41 CZK** (average ~136 CZK/cl, not 2× as in the previous model).
- **Utilization**: `paasUtil` (default 40 %, env `IaaS_PAAS_UTILIZATION`, UI slider 10–100 %) determines the number of **dynamic** cloudlets `ceil(N × utilization)`; the reserved ones are always paid unchanged. The CPU/RAM figures shown in the section reflect utilization (actually used capacity).
- **Other Virtuozzo line items** (added to the PaaS total, not affected by utilization):
  - **PaaS disk** = Σ diskGB of all VMs × **2.40 CZK/GB/month** (0.003286 CZK/h × 730);
  - **Public IP** = **120.01 CZK/IP/month** (0.1644 CZK/h × 730), only when the topology contains a firewall (`opnsense` group);
  - **external traffic** is not calculated (no input in the topology).
- **"Total PaaS price"** = cloudlet price (R + D) + PaaS disk + Public IP.
- **Commitment ratio (PaaS)**: `paasCommitRatio(cm) = cpuRate(cm) / cpuRate(12m)`; it multiplies the cloudlet price (same logic as IaaS — an env override applies only to the default commitment). The PaaS commitment is chosen independently (`paasCommitSel`).
- **Effective average rate**: `effRate = cloudletCost(N) / N` — per-VM rows use it so the per-row sum matches the total price; per-VM "PaaS price" = `cl × effRate`.
- **PaaS commitment — server vs UI**: the server reports the raw volume price in `/api/*` (`cloudletCostCZK`, without the commitment ratio); the UI applies the commitment ratio and utilization locally.

### 3. Excel export (.xlsx)

Clicking "Export Excel" mirrors the web content exactly (`exportExcel` in `public/main.js`): both costings (IaaS + PaaS with utilization), disk by tier, price by group, rates, and the VM table (columns `VM, Group, CPU GHz, RAM GiB, Disk GB, Tier, CPU, RAM, Disk, Price IaaS, Cloudlets, Price PaaS`). The PaaS summary rows follow the same order as the web (CPU → RAM → Reserved cloudlets → Dynamic cloudlets → Cloudlet price → Price / cloudlet → PaaS disk → Public IP → Total PaaS price). A **topology screenshot** (html2canvas + JSZip) is embedded at the top when available; rows are shifted so the image does not cover the text. The VM table's "Cloudlets" column shows cloudlets **per utilization** (`round(cl × utilization)`), not the maximum.

### 4. Topology

- **Built-in default topology**: `Sec-01` (OPNsense, Standard, 4+4+20) + `App-01` (Standard, 7.2+2.25+50) + `DB-01` (Fast, 4+4+120). If `default.topo.json` exists (same format as the UI's `.topo.json` export), it is loaded **at server startup** instead.
  - Shipped `default.topo.json`: `envName = dev-kube.prg1paas.t-cloud.eu`, group labels `Aplikace` / `Databáze` / `Bezpečnost` (Application / Database / Security), `Sec-01` label `Firewall/LoadBalancing`. The firewall node's group is **`security`** in the JSON — `compute()` in `lib/architecture.js` **aliases it to `opnsense`**, so the node stays in the topology (rendered as a firewall with a public IP on its NIC). The alias also applies to manually uploaded `.topo.json` files.
- **Groups** (`lib/architecture.js` `defaultGroups()`): `app` (Application servers, APP, standard), `db` (Database servers, DATA, fast), `opnsense` (Security, WAN, standard; may appear as the `security` alias in topologies), `other` (Other servers, LAN, superfast). The group's default disk tier is used when a VM has none of its own.
- **Per-group VLANs** (`defaultVlans()`): every group has `{ name, uuid }`; the UI draws connector lines between the groups and OPNsense — **clicking a connector opens the VLAN editor** (name + UUID). The server merges the topology's VLANs over the defaults in `compute()`.
- **Persistence is purely client-side** (`localStorage` key `iaas_topology` + a JSON `.topo.json` file): the **"Save topology" / "Load topology"** and **"Download topology" / "Upload topology"** buttons. It stores `state` (nodes, groups incl. renamed display names, vlans, commitment, envName) and restores it via the socket `recalc`. There is no server-side storage.

### 5. PaaS import → IaaS

**"Import PaaS → IaaS"** (or `POST /api/import-paas`) converts a Jelastic/Virtuozzo export into an IaaS topology (`fromPaaSExport` in `lib/architecture.js`):

- sized from `cloudlets` (1 cloudlet = 0.4 GHz + 0.125 GiB): `cpuGHz = cloudlets × 0.4` (rounded to 1 decimal), `ramGB = cloudlets × 0.125` (rounded to 2 decimals); disk from `diskLimit` ("200G"→200, "1024M"→2, "1T"→1024).
- `count > 1` expands into `Base-01…NN`; single nodes use `displayName` (or `nodeGroup`).
- `nodeType` → group and tier: `postgresql/mysql/mariadb/...` → `db` (fast); `haproxy/nginx/kubernetes/docker/...` → `app` (standard); `storage/nfs/cache/...` → `other` (superfast); `opnsense/firewall/vpn` → `opnsense`. Unknown → `other` (superfast).
- An **OPNsense firewall** singleton (default 4/4/20) is always kept, even if the export has none. `envName` comes from `description.text` (fallback `envName`).

### 6. PaaS export ← from IaaS

**"Export PaaS"** (or `POST /api/export-paas`) converts the current IaaS topology back into a Jelastic export (`toPaaSExport`): **every VM becomes an `almalinux-vps` node** with:

- `cloudlets = max(1, ceil(max(cpuGHz/0.4, ramGB/0.125)))`;
- `diskLimit` from `diskGB` ("50G"; ≥1024 → "1T");
- `nodeType: "almalinux-vps"`, `nodeGroup` = sanitized lowercase unique token (`^[a-z0-9._\-+]+$`), `scalingMode: "STATEFUL"`, `isSLBAccessEnabled: true`, `tag: "9.7"`, `docker: {cmd:"/bin/bash", env:{DOCKER_EXPOSED_PORT:"22", PATH:...}}`.
- Replicas `Base-01…NN` (split by the importer) collapse back into one node with `count`.
- Top-level `{type:"install", name:<timestamp>, engine:"", categories:["export"], description:{text: envName}, nodes, version:"8.14.3"}`. The result panel allows copy/download.

## T-Cloud deployment (instructions)

> **Warning:** deployment creates **real cloud resources** in T-Cloud. Do not run it without clear intent.

### Credentials

Credentials are entered **in the UI** (deploy panel: username / password / OTP secret) and passed per-login to `lib/tcloud.login(opts)`. Anything left blank falls back to the environment defaults (`.env`): `TCLOUD_USERNAME` / `TCLOUD_PASSWORD` / `TCLOUD_OTP_SECRET`.

### Deployment flow

The **"Deploy to IaaS"** button (Socket.IO `deploy` / `POST /api/deploy`) — `lib/deploy.js`:

1. **Login** (`tcloud.login`): `POST /accounts/action/?do=login` → `POST /accounts/action/?do=verify_otp` (TOTP RFC 6238, base32 secret, HMAC-SHA1, 30 s window) — no external dependencies (`fetch` + `crypto`). If no `otpSecret` is given, 2FA is skipped.
2. **VLAN auto-match**: if any group has an empty UUID, VLANs are fetched via `GET /vlans/detail/?limit=0` and matched by **name** (e.g. APP, DATA, LAN — case-insensitive). An explicitly entered UUID in the topology **always wins**.
3. **For each VM** (sequentially, progress streamed via Socket.IO `deploy-progress`):
   - a **blank data drive** is created (`media: disk`, size = diskGB),
   - then a **server** (NOT auto-started): `cpu = cpuGHz×1000` MHz, `mem = ramGB×1024×1024` B, one virtio drive (`boot_order:1, dev_channel:0:0`), `vnc_password:""`.
   - **NIC**:
     - normal VM → **one NIC on its group's VLAN** (UUID from topology / auto-match by name / `TCLOUD_VLAN_UUID` env); without a VLAN → **DHCP** (`ip_v4_conf:{conf:"dhcp"}`).
     - **OPNsense firewall** → **one NIC with a public IP** (`ip_v4_conf:{conf:"dhcp"}, vlan:null`), not a VLAN.
4. After every server creation, the firewall's public IP is attempted (`wan-ip` event).

### Start a server with VNC

Every created VM is listed in the UI with a **Start** button (Socket.IO `start-server`):

1. login, `POST /servers/{uuid}/action/?do=start`,
2. wait for status `running` (`waitServerRunning`, timeout 90 s, poll 2 s),
3. `getServer` → `vnc_password`, `POST /servers/{uuid}/action/?do=open_vnc` → `vnc_url` (fresh on every open),
4. for OPNsense additionally `getServerPublicIp` → public IPv4 (after the first DHCP handshake; may be empty).

The UI shows the **VNC URL and password** with a copy button.

### Notes / limitations

- Rapid repeated logins to the same account may hit a transient 401 on `verify_otp` — wait and retry.
- `getServerPublicIp`: the address may be a UUID resolved via `GET /ips/{uuid}/`; a NIC without a VLAN gets DHCP.
- More advanced provisioning (attaching the disk as the boot disk, etc.) is outside the scope of this client.

## LLM fallback (optional)

When RAG has no answer, the Node app calls `fallback/fastapi_app.py`, which queries **GPT-5.5** through the OpenAI API.

```bash
# Start the FastAPI fallback
cd /home/jelastic/ai-chat && python3 -m uvicorn fallback.fastapi_app:app --host 0.0.0.0 --port 8001

# Or persistently via screen:
screen -dmS fastapi bash -c 'cd /home/jelastic/ai-chat && python3 -m uvicorn fallback.fastapi_app:app --host 0.0.0.0 --port 8001'
```

Configuration in `.env`: `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-5.5`), `FALLBACK_URL` (default `http://localhost:8001`), `LLM_ENDPOINT` / `LLM_MODEL` (vLLM/TGI OpenAI-compatible endpoint for RAG), `LLM_CONTEXT_TOKENS` (default 8192 — the server sizes the RAG context to that budget; on HTTP 400 = context-length rejection from vLLM, raise it).

> Note: the server auto-rewrites `virtuozzo.com/application-management-docs/` URLs in AI responses to the local `/docs/` proxy (the site blocks bots — the proxy fetches with a browser User-Agent).

## Features (UI overview)

- **Topology editor** — add/remove groups and VMs, edit CPU/RAM/Disk/tier in a modal, rename groups (✎), per-group VLANs (click a connector), tweak PaaS parameters (cloudlet size, tier prices, utilization, commitment).
- **Costing / month** — pooled Resource Pool calculation with a commitment-length switch (IaaS and PaaS independently).
- **Import PaaS → IaaS** / **Export PaaS** — see sections 5 and 6.
- **Save / Load topology** — `localStorage`; **Download / Upload topology** — `.topo.json`.
- **Export Excel** — binary `.xlsx` (SheetJS) with an embedded topology screenshot.
- **Deploy to IaaS** + **Start** (VNC) — see the deployment section.

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/architecture` | GET | default architecture + computed nodes + costing |
| `/api/cost` | POST | computes nodes + price from a submitted architecture (`{}` → default) |
| `/api/import-paas` | POST | converts a PaaS export into an IaaS topology + costing |
| `/api/export-paas` | POST | converts the IaaS topology back into a Jelastic export |
| `/api/pricing` | GET | CPU/RAM/disk rates + commitment options |
| `/api/deploy` | POST | deploys all nodes to T-Cloud |
| Socket.IO `recalc` | — | client sends an architecture → serialized computed + costing |
| Socket.IO `deploy` | — | client sends an architecture → streams `deploy-progress` → summary |
| Socket.IO `start-server` | — | login + start a server → `vnc_url` + `vnc_password` (+ `wan-ip`) |
| Socket.IO `stop-server` | — | login + stop a server |

## Structure

```
server.js               Entrypoint — Express + Socket.IO, REST endpoints, default.topo.json
lib/architecture.js     VM topology model + default architecture + PaaS import/export
lib/pricing.js          Resource Pool rates + cost calculation (IaaS and cloudlets)
lib/tcloud.js           T-Cloud/CloudSigma client (login 2FA/TOTP, drive/server, VNC, VLANs)
lib/deploy.js           Deploy runner (login once, VM by VM, progress reporting)
public/                 Static UI (index.html, main.js, style.css)
default.topo.json       Optional startup topology (loaded at startup instead of the default)
codenow/config/         Env variable templates for CodeNow
```

## License

MIT