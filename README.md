# IaaS API Mgmt

Node.js + Express + Socket.IO web UI, který **vizualizuje topologii VM architektury**, **počítá měsíční náklady** (Business Cloud IaaS „Resource Pool") a umí **nasadit celou topologii do T-Cloud (CloudSigma) IaaS**.

Neexistuje pevný model SLB / Kubernetes / PostgreSQL — každý VM (firewall OPNsense, aplikační servery, databázové servery i ostatní VM jako W-01/NFS/Cache/NoSQL) je obyčejný VM, kde kliknutím nastavíš **CPU / RAM / Disk** (+ disk tier).

## Požadavky

- Node.js (testováno na v26)
- Python 3 + FastAPI/uvicorn (pouze pro volitelný fallback na LLM — viz níže)

## Instalace a spuštění

```bash
npm ci && npm start
```

Aplikace běží na `http://localhost:3000`. Přepíšeš přes `PORT` env.

Za reverzní proxy s base path (např. `/iaasapimgmt`):

```bash
BASE_PATH=/iaasapimgmt npm start
```

Poté je app na `http://localhost:3000/iaasapimgmt/`. Funguje se Socket.IO (auto-konfigurace path) i `/docs/` proxy.

## Konfigurace (`.env`)

Kopíruj ze šablony: `cp .env.example .env`

| Proměnná | Význam | Default |
|---|---|---|
| `PORT` | port serveru | `3003` |
| `BASE_PATH` | prefix base path za reverzní proxy | — |
| `IaaS_COMMITMENT_MONTHS` | délka závazku (0=bez závazku / 12 / 24 / 36) — v UI jde přepínat za běhu | `12` |
| `IaaS_CPU_RATE_CZK_GHZ` | cena za CPU GHz/měsíc (defaultní závazek) | `108.73` (12m) |
| `IaaS_RAM_RATE_CZK_GB` | cena za RAM GB/měsíc (defaultní závazek) | `47.30` (12m) |
| `IaaS_DISK_RATE_CZK_GB` | cena za disk GB/měsíc, Super Fast tier (defaultní závazek) | `3.15` (12m) |
| `IaaS_CLOUDLET_RATE_CZK` | PaaS cena za 1 cloudlet/měsíc (jen informativně) | `138.56` |
| `IaaS_NETWORK_FW_RATE_CZK` | fixní měsíční poplatek „Networking a FW" (všechny závazky) | `108` |
| `TCLOUD_BASE_URL` | T-Cloud API base | `https://prg1.t-cloud.eu/api/2.0` |
| `TCLOUD_REFERER` | Referer hlavička | `https://prg1.t-cloud.eu` |
| `TCLOUD_USERNAME` / `TCLOUD_PASSWORD` / `TCLOUD_OTP_SECRET` | přihlašovací údaje pro nasazení (fallback) | prázdné |
| `TCLOUD_VLAN_UUID` | volitelný single VLAN na NIC | — |

> `.env` rate overrides platí **jen pro defaultní závazek**; ostatní závazky vždy používají tabulkové ceny z oficiální kalkulačky T-Business.

## Costing (Resource Pool)

Business Cloud IaaS je účtovaný jako **Resource Pool** přes celou architekturu:

```
celkem = Σ CPU GHz × sazba + Σ RAM GB × sazba + Σ disk GB × sazba (dle tieru)
        + "Networking a FW" (108 Kč / měsíc)
```

- **CPU** se účtuje na celkovém počtu GHz **zaokrouhleném nahoru** na celé číslo (jako kalkulačka, např. 36.8 GHz → 37). Per-node řádky zůstávají exaktní.
- **Každý VM má vlastní disk tier** (Super Fast / Fast / Standard / Basic), volitelný v modálu VM.
- Kalkulačka přidává **„Basic (základ)"** svazek = celkový disk (všechny VM dohromady) na Basic sazbě navíc k výkonnostním tierům.
- Panel zobrazuje i **„Cena podle skupiny"** (součet + počet VM) a informativní **„Cloudlety celkem (PaaS)"** (1 cloudlet = 128 MiB RAM + 400 MHz CPU).

Jednotkové sazby pocházejí z oficiální kalkulačky T-Business (https://t-business.cz/cs/kalkulator-ceny/).

## Funkce

- **Editor topologie** — přidávání/odebírání skupin i VM, úprava CPU/RAM/Disk/tier, přejmenování skupin, per-skupinové VLANy (název + UUID).
- **Costing / měsíc** — pooled Resource Pool kalkulace s přepínačem délky závazku.
- **Import PaaS → IaaS** — konverze exportu Jelastic/Virtuozzo na topologii IaaS (velikost z cloudlets + diskLimit).
- **Export PaaS** — zpětná konverze topologie IaaS na Jelastic export (každý VM jako `almalinux-vps`).
- **Uložit / Načíst topologii** — perzistence do `localStorage`.
- **Stáhnout / Nahrát topologii** — export/import konfigurace do JSON souboru (`.topo.json`).
- **Deploy do IaaS** — přihlášení do T-Cloud (login + TOTP 2FA) a vytvoření VM (CPU/RAM/Disk) pro každý uzel; Start serveru s VNC URL a heslem.

## API

- `GET /api/architecture` — defaultní architektura + spočítané uzly + costing
- `POST /api/cost` — spočítá uzly + cenu ze zadané architektury (`{}` → default)
- `POST /api/import-paas` — převede PaaS export na topologii IaaS + costing
- `POST /api/export-paas` — převede topologii IaaS zpět na Jelastic export
- `GET /api/pricing` — CPU/RAM/disk sazby + závazek
- `POST /api/deploy` — nasadí všechny uzly do T-Cloud
- Socket.IO `recalc`, `deploy`, `start-server`

## Struktura

```
server.js               Entrypoint — Express + Socket.IO
lib/architecture.js     Model topologie VM + default architektura + PaaS import/export
lib/pricing.js          Resource Pool sazby + kalkulace nákladů
lib/tcloud.js           T-Cloud/CloudSigma klient (login 2FA/TOTP, drive/server, VNC)
lib/deploy.js           Deploy runner
public/                 Statické UI (index.html, main.js, style.css)
```

## Licence

MIT
