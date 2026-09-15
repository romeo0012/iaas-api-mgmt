# IaaS API Mgmt

Node.js + Express + Socket.IO web UI, který **vizualizuje topologii VM architektury**, **počítá měsíční náklady** (Business Cloud IaaS „Resource Pool" + informativní PaaS cloudlety) a umí **nasadit celou topologii do T-Cloud (CloudSigma) IaaS**.

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

Poté je app na `http://localhost:3000/iaasapimgmt/`. Funguje se Socket.IO (path se auto-konfiguruje na `BASE_PATH + /socket.io`) i `/docs/` proxy.

### PM2 / Forever

Volitelně existují konfigurace procesního managera (`ecosystem.config.js`, `forever.json`). V `.env` se nastaví `PORT`/`BASE_PATH`.

### Poznámky

- `Procfile` (pokud existuje) je zastaralý — opravdový entrypoint je `server.js`.
- Žádné testy, linter, typecheck ani build step.
- `.gitignore` vylučuje `node_modules/` a `package-lock.json`.

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
| `IaaS_PAAS_UTILIZATION` | default využití pro PaaS sekci v % (UI slider 10–100; určuje počet dynamických cloudletů) | `40` |
| `IaaS_NETWORK_FW_RATE_CZK` | fixní měsíční poplatek „Networking a FW" (všechny závazky) | `108` |
| `TCLOUD_BASE_URL` | T-Cloud API base | `https://prg1.t-cloud.eu/api/2.0` |
| `TCLOUD_REFERER` | Referer hlavička | `https://prg1.t-cloud.eu` |
| `TCLOUD_USERNAME` / `TCLOUD_PASSWORD` / `TCLOUD_OTP_SECRET` | přihlašovací údaje pro nasazení (fallback) | prázdné |
| `TCLOUD_VLAN_UUID` | volitelný single VLAN na NIC | — |
| `OPENAI_API_KEY` / `OPENAI_MODEL` / `LLM_ENDPOINT` / `LLM_MODEL` / `FALLBACK_URL` | volitelný LLM fallback — viz níže | — |

> `.env` rate overrides (`IaaS_CPU_RATE_CZK_GHZ`, `IaaS_RAM_RATE_CZK_GB`, `IaaS_DISK_RATE_CZK_GB`) platí **jen pro defaultní závazek**; přepnutí na jiný závazek v UI vždy používá tabulkové ceny z oficiální kalkulačky T-Business. Stejná logika platí pro PaaS (viz PaaS section níže).

### Přehled všech sazeb (T-Business kalkulačka, Kč/měsíc)

Jednotkové sazby pocházejí z oficiální kalkulačky https://t-business.cz/cs/kalkulator-ceny/ (`/api/calculator/groups`); „bez závazku" (0) ověřeno přes `/api/calculator/calculate` s `commitment_months=0`.

| Komponenta | 0m (bez) | 12m | 24m | 36m |
|---|---|---|---|---|
| CPU (GHz) | 157.06 | 108.73 | 102.69 | 96.65 |
| RAM (GB) | 68.33 | 47.30 | 44.68 | 42.05 |
| Disk Super Fast 10000 (GB) | 4.55 | 3.15 | 2.98 | 2.80 |
| Disk Fast 5000 (GB) | 2.60 | 1.80 | 1.70 | 1.60 |
| Disk Standard 3000 (GB) | 1.95 | 1.35 | 1.28 | 1.20 |
| Disk Basic 600 (GB) | 1.30 | 0.90 | 0.85 | 0.80 |
| Networking a FW (fix měsíčně) | 108 | 108 | 108 | 108 |

## Costing — Logika výpočtu

### 1. IaaS (Business Cloud „Resource Pool")

Business Cloud IaaS je účtovaný jako **Resource Pool** přes celou architekturu — cena se počítá ze **součtu** zdrojů všech VM, ne per VM:

```
celkem (IaaS) = ceil(Σ CPU GHz) × sazbaCPU
              + Σ RAM GB × sazbaRAM
              + Σ disk GB × sazba (dle tieru každého VM)
              + "Networking a FW"                  (fixní, 108 Kč, všechny závazky)
```

Postup výpočtu (server `lib/pricing.js`, klientsky zrcadleno v `public/main.js`):

1. **Per-VM řádky** (`nodeCost`):
   - `cpuCost = cpuGHz × sazbaCPU(cm)` (exaktní, nezaokrouhleno)
   - `ramCost = ramGB × sazbaRAM(cm)`
   - `diskCost = diskGB × (sazbaTieru + sazbaBasic)` — BC kalkulačka si k VM disku v výkonnostním tieru vždy přičte ještě **základní „Basic" svazek stejné velikosti**
   - `total = cpuCost + ramCost + diskCost`
2. **Poolované součty** (`summarize`):
   - počítač se **zaokrouhluje nahoru na celé GHz** (jako kalkulačka: 36.8 GHz → 37 × sazba). Per-node řádky zůstávají **exaktní**; zaokrouhlí se jen pooled CPU. Rozdíl per-node součtu a pooled CPU ceny je tímto zaokrouhlením.
   - RAM i disk se sčítají přesně.
   - `diskCostCZK (celkem) = Σ per-node diskCost` (= Σ výkonnostní tiery + celkový disk na Basic sazbě).
3. **Disk podle tieru** (`diskByTier`): pro tierdeklarace Super Fast / Fast / Standard se sečtou GB všech VM daného tieru × sazba tieru; navíc vždy přibude řádek **`Basic (základ)`** = **celkový disk všech VM** × sazba Basic.
4. **Cena podle skupiny**: součet per-node `totalCZK` + počet VM v každé skupině.
5. Formátování: `formatCZK` zaokrouhlí na celé Kč a oddělí mezery po tisících (`1 158 Kč`).

### 2. PaaS (cloudlety — informativní srovnání)

Čistě informativní sekce v UI — **neovlivňuje cenu IaaS**. Modeluje Virtuozzo cloudlety vč. oficiálního ceníku (objemová pásma, Kč/cloudlet/měsíc = hodinová sazba × 730 h):

- **Cloudlet** = 128 MiB RAM (0.125 GiB) + 400 MHz CPU (0.4 GHz) — **obojí nastavitelné** v UI (PaaS parametry, pole „RAM cloudletu" / „CPU cloudletu").
- **Cloudlety per VM** = `ceil(max(cpuGHz / (clCpuMHz/1000), ramGB / (clRamMiB/1024)))` (nezávislé na disku), kde `clCpuMHz` a `clRamMiB` jsou parametry cloudletu (default 400 / 128).
- **Co dělá změna poměru RAM/CPU v cloudletu**: velikost cloudletu „vidí" jen CPU a RAM, proto změna parametru cloudletu mění **počet cloudletů každého VM** (a tím i celkový počet `N`):
  - zvětšíš-li RAM nebo CPU cloudletu → cloudlet pokryje víc zdrojů VM → klesne počet cloudletů (a naopak);
  - z nového `N` se přepočítá **objemová cena** (pásma níže), efektivní průměrná sazba i cena dynamické části; **ceny za cloudlet v Kč se nemění** — parametr mění jen *kolik* cloudletů se spočte;
  - příklad: VM 7.2 GHz / 2.25 GiB → default (400 MHz + 128 MiB): `ceil(max(7.2/0.4, 2.25/0.125))` = `ceil(max(18, 18))` = **18 cloudletů**; zmenšíš-li CPU cloudletu na 200 MHz → `ceil(max(36, 18))` = **36 cloudletů** (dvojnásobek).
- **Celkem `N`** = součet přes všechny VM (= **rezervované** cloudlety, platí se vždy).
- **Virtuozzo ceník cloudletů (objemová pásma na celkový počet):**
  | Pásmo | 1–16 | 17–32 | 33–64 | 65–128 | 129+ |
  |---|---|---|---|---|---|
  | **Rezervované** Kč/cl/měs | 98.84 | 93.88 | 88.91 | 84.02 | 79.06 |
  | **Dynamické** Kč/cl/měs | 148.26 | 144.54 | 140.82 | 137.09 | 133.44 |
  (Hodinové sazby × 730 h: 0.1354/0.1286/0.1218/0.1151/0.1083 → 98.84/93.88/88.91/84.02/79.06 a 0.2031/0.1980/0.1929/0.1878/0.1828 → 148.26/144.54/140.82/137.09/133.44. Sleva: rezervované 33–47 %, dynamické 0–10 %.)
- **Výpočet ceny**:
  - **Rezervované cloudlety R** = vždy placené minimum = `ceil(N × 15 %)` (např. 82 → 13);
  - **Dynamické cloudlety D** = skutečně využité nad rezervací = `ceil(N × utilizace) − R` (např. 82 @40 % → `33 − 13 = 20`; @100 % → `82 − 13 = 69`);
  - **Cena cloudletů** = `band(R, rezervované sazby) + band(D, dynamické sazby)`, kde `band(n, sazby)` rozpočítá `n` do pásem;
  - příklad @40 %: R=13 → 13×98,84 = **1 284,92 Kč**; D=20 → 16×148,26 + 4×144,54 = **2 950,32 Kč**; celkem **4 235,24 Kč**;
  - příklad @100 %: R=13 → **1 284,92 Kč**; D=69 → 16×148,26 + 16×144,54 + 32×140,82 + 5×137,09 = **9 876,49 Kč**; celkem **11 161,41 Kč** (průměr ~136 Kč/cl, nikoli 2× jako předchozí model).
- **Využití (utilizace)**: `paasUtil` (default 40 %, env `IaaS_PAAS_UTILIZATION`, UI slider 10–100 %) určuje počet **dynamických** cloudletů `ceil(N × utilization)`; rezervované se platí vždy beze změny. CPU/RAM v sekci se zobrazují na utilizaci (využité kapacity).
- **Další položky Virtuozzo** (přičítají se k PaaS celkem, neovlivněné utilizací):
  - **Disk PaaS** = Σ diskGB všech VM × **2.40 Kč/GB/měs** (0.003286 Kč/h × 730);
  - **Public IP** = **120.01 Kč/IP/měs** (0.1644 Kč/h × 730), jen pokud je v topologii firewall (skupina `opnsense`);
  - **External traffic** se nekalkuluje (nemá v topologii vstup).
- **Úhrn „Cena PaaS celkem"** = cena cloudletů (R + D) + Disk PaaS + Public IP.
- **Poměr závazku (PaaS)**: `paasCommitRatio(cm) = sazbaCPU(cm) / sazbaCPU(12m)`; násobí cenu cloudletů (stejná logika jako u IaaS: env override jen pro defaultní závazek). PaaS závazek se volí nezávisle (`paasCommitSel`).
- **Efektivní průměrná sazba**: `effRate = cenaCloudletů(N) / N` — per-VM řádky ji používají, aby součet seděl na celkovou cenu; per-VM „Cena PaaS" = `cl × effRate`.
- **PaaS závazek — server vs UI**: server hlásí v `/api/*` objemovou cenu (`cloudletCostCZK`, bez poměru závazku); UI aplikuje poměr závazku a utilizaci lokálně.

### 3. Export Excel (.xlsx)

Kliknutí „Export Excel" zrcadlí přesně web obsah (`exportExcel` v `public/main.js`): oba costingy (IaaS + PaaS s utilizací), disk podle tieru, cenu podle skupiny, sazby, tabulku VM (sloupce `VM, Skupina, CPU GHz, RAM GiB, Disk GB, Tier, CPU, RAM, Disk, Cena IaaS, Cloudlety, Cena PaaS`). PaaS souhrn má řádky ve stejném pořadí jako web (CPU → RAM → Cloudlety rezervované → Cloudlety dynamické → Cena cloudletů → Cena / cloudlet → Disk PaaS → Public IP → Cena PaaS celkem). Nahoře se vloží **obrázek topologie** (html2canvas + JSZip), pokud je k dispozici; řádky se posunou tak, aby obrázek nepřekrýval text. Sloupec „Cloudlety" v tabulce VM zobrazuje počet cloudletů **dle utilizace** (`round(cl × utilization)`), nikoli maximální.

### 4. Topologie

- **Defaultní topologie** (build-in): `Sec-01` (OPNsense, Standard, 4+4+20) + `App-01` (Standard, 7.2+2.25+50) + `DB-01` (Fast, 4+4+120). Pokud existuje `default.topo.json` (formát stejný jako `.topo.json` export UI), načte se **při startu serveru** místo ní.
  - Dodávané `default.topo.json`: `envName = dev-kube.prg1paas.t-cloud.eu`, skupinové labely `Aplikace` / `Databáze` / `Bezpečnost`, `Sec-01` label `Firewall/LoadBalancing`. Skupina firewallu je v JSON **`security`** — `compute()` v `lib/architecture.js` ji **aliasuje na `opnsense`**, takže uzel zůstává v topologii (renderuje se jako firewall s veřejnou IP na NIC). Alias platí i pro ručně nahrané `.topo.json`.
- **Skupiny** (`lib/architecture.js` `defaultGroups()`): `app` (Aplikační servery, APP, standard), `db` (Databázové servery, DATA, fast), `opnsense` (Bezpečnost, WAN, standard; v topologii se může objevit i jako alias `security`), `other` (Ostatní servery, LAN, superfast). Defaultní disk tier skupiny se použije, když VM nemá vlastní.
- **Per-skupinové VLANy** (`defaultVlans()`): každá skupina má `{ name, uuid }`; UI zobrazí spojnice mezi skupinami a OPNsense — **klik na spojnici otevře editor VLAN** (název + UUID). Server v `compute()` sloučí VLANy z topologie přes defaulty.
- **Perzistence je čistě klientská** (`localStorage` klíč `iaas_topology` + JSON `.topo.json` soubor): tlačítka **„Uložit topologii" / „Načíst topologii"** a **„Stáhnout topologii" / „Nahrát topologii"**. Ukládá se `state` (nodes, groups vč. přejmenovaných názvů, vlans, commitment, envName) a obnovuje se přes socket `recalc`. Není žádný serverový úložiště.

### 5. PaaS import → IaaS

**„Import PaaS → IaaS"** (nebo `POST /api/import-paas`) převede Jelastic/Virtuozzo export na IaaS topologii (`fromPaaSExport` v `lib/architecture.js`):

- velikost z `cloudlets` (1 cloudlet = 0.4 GHz + 0.125 GiB): `cpuGHz = cloudlets × 0.4` (zaokr. 1 des.), `ramGB = cloudlets × 0.125` (zaokr. 2 des.); disk z `diskLimit` („200G"→200, „1024M"→2, „1T"→1024).
- `count > 1` expanduje do `Base-01…NN`; jednotlivé uzly používají `displayName` (nebo `nodeGroup`).
- `nodeType` → skupina a tier: `postgresql/mysql/mariadb/...` → `db` (fast); `haproxy/nginx/kubernetes/docker/...` → `app` (standard); `storage/nfs/cache/...` → `other` (superfast); `opnsense/firewall/vpn` → `opnsense`. Neznámý → `other` (superfast).
- Vždy se zachová singleton **OPNsense firewall** (default 4/4/20), i když export žádný nemá. `envName` z `description.text` (fallback `envName`).

### 6. PaaS export ← z IaaS

**„Export PaaS"** (nebo `POST /api/export-paas`) převede aktuální IaaS topologii zpět na Jelastic export (`toPaaSExport`): **každý VM = `almalinux-vps`** uzel s:

- `cloudlets = max(1, ceil(max(cpuGHz/0.4, ramGB/0.125)))`;
- `diskLimit` z `diskGB` („50G"; ≥1024 → „1T");
- `nodeType: "almalinux-vps"`, `nodeGroup` = sanitizovaný lowercase unikátní token (`^[a-z0-9._\-+]+$`), `scalingMode: "STATEFUL"`, `isSLBAccessEnabled: true`, `tag: "9.7"`, `docker: {cmd:"/bin/bash", env:{DOCKER_EXPOSED_PORT:"22", PATH:...}}`.
- Repliky `Base-01…NN` (rozdělené importerem) se sbalí zpět do jednoho uzlu s `count`.
- Top-level `{type:"install", name:<timestamp>, engine:"", categories:["export"], description:{text: envName}, nodes, version:"8.14.3"}`. Panel s výsledkem umožní kopírovat/stáhnout.

## T-Cloud deployment (instrukce pro nasazení)

> **Pozor:** deployment vytváří **reálné cloudové zdroje** v T-Cloudu. Nespouštěj ho bez jasného záměru.

### Přihlašovací údaje

Údaje se zadávají **v UI** (deploy panel: username / password / OTP secret) a předávají se per-login do `lib/tcloud.login(opts)`. Cokoli necháš prázdné fallbackuje na env defaulty (`.env`): `TCLOUD_USERNAME` / `TCLOUD_PASSWORD` / `TCLOUD_OTP_SECRET`.

### Průběh deploymentu

Tlačítko **„Deploy do IaaS"** (Socket.IO `deploy` / `POST /api/deploy`) — `lib/deploy.js`:

1. **Login** (`tcloud.login`): `POST /accounts/action/?do=login` → `POST /accounts/action/?do=verify_otp` (TOTP RFC 6238, base32 secret, HMAC-SHA1, 30 s okno) — bez externích závislostí (`fetch` + `crypto`). Když `otpSecret` není zadaný, 2FA se přeskočí.
2. **Auto-match VLAN**: pokud mají skupiny prázdné UUID, načtou se VLANy přes `GET /vlans/detail/?limit=0` a spárují podle **názvu** (např. APP, DATA, LAN — case-insensitive). Explicitně zadané UUID v topologii má **vždy přednost**.
3. **Pro každý VM** (sekvenčně, progress po Socket.IO `deploy-progress`):
   - vytvoří se **prázdný datový disk** (`media: disk`, velikost = diskGB),
   - pak **server** (NOT auto-started): `cpu = cpuGHz×1000` MHz, `mem = ramGB×1024×1024` B, jeden virtio disk (`boot_order:1, dev_channel:0:0`), `vnc_password:""`.
   - **NIC**:
     - normální VM → **jeden NIC na VLAN své skupiny** (UUID z topologie / auto-match podle názvu / `TCLOUD_VLAN_UUID` z env); bez VLAN → **DHCP** (`ip_v4_conf:{conf:"dhcp"}`).
     - **OPNsense firewall** → **jeden NIC s veřejnou IP** (`ip_v4_conf:{conf:"dhcp"}, vlan:null`), nikoli VLAN.
4. Po vytvoření každého serveru se zkusí získat veřejná IP firewallu (`wan-ip` event).

### Start serveru s VNC

Každý vytvořený VM je v UI seznamu s tlačítkem **Start** (Socket.IO `start-server`):

1. login, `POST /servers/{uuid}/action/?do=start`,
2. čekání na status `running` (`waitServerRunning`, timeout 90 s, poll 2 s),
3. `getServer` → `vnc_password`, `POST /servers/{uuid}/action/?do=open_vnc` → `vnc_url` (nová na každé otevření),
4. pro OPNsense navíc `getServerPublicIp` → veřejná IPv4 (po prvním DHCP handshake; může být prázdné).

UI zobrazí **VNC URL a heslo** s tlačítkem copy.

### Poznámky / omezení

- Rychlé opakované loginy na stejný účet mohou narazit na přechodnou 401 na `verify_otp` — počkej a zkus znovu.
- `getServerPublicIp`: adresa může být UUID, které se řeší přes `GET /ips/{uuid}/`; bez VLAN NIC dostane DHCP.
- Sofistikovanější nasazení (přiřazení disku jako boot disk apod.) je mimo scope klienta.

## LLM fallback (volitelné)

Když RAG nemá odpověď, volá Node `fallback/fastapi_app.py`, který se ptá **GPT-5.5** přes OpenAI API.

```bash
# Spuštění FastAPI fallbacku
cd /home/jelastic/ai-chat && python3 -m uvicorn fallback.fastapi_app:app --host 0.0.0.0 --port 8001

# Nebo persistentně přes screen:
screen -dmS fastapi bash -c 'cd /home/jelastic/ai-chat && python3 -m uvicorn fallback.fastapi_app:app --host 0.0.0.0 --port 8001'
```

Konfigurace v `.env`: `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-5.5`), `FALLBACK_URL` (default `http://localhost:8001`), `LLM_ENDPOINT` / `LLM_MODEL` (vLLM/TGI OpenAI-kompatibilní endpoint pro RAG), `LLM_CONTEXT_TOKENS` (default 8192 — server dimenzuje RAG kontext na tento budget; při 400 = context-length z vLLM ho zvyš).

> Pozn.: server auto-přepisuje `virtuozzo.com/application-management-docs/` URL v AI odpovědích na lokální `/docs/` proxy (web blokuje boty — proxy fetuje s browser User-Agentem).

## Funkce (přehled UI)

- **Editor topologie** — přidávání/odebírání skupin i VM, úprava CPU/RAM/Disk/tier v modálu, přejmenování skupin (✎), per-skupinové VLANy (klik na spojnici), interní úprava PaaS parametrů (velikost cloudletu, ceny pásem, využití, závazek).
- **Costing / měsíc** — pooled Resource Pool kalkulace s přepínačem délky závazku (IaaS i PaaS nezávisle).
- **Import PaaS → IaaS** / **Export PaaS** — viz sekce 5 a 6.
- **Uložit / Načíst topologii** — `localStorage`; **Stáhnout / Nahrát topologii** — `.topo.json`.
- **Export Excel** — binární `.xlsx` (SheetJS) se screenshotem topologie.
- **Deploy do IaaS** + **Start** (VNC) — viz deployment sekce.

## API

| Endpoint | Metoda | Popis |
|---|---|---|
| `/api/architecture` | GET | defaultní architektura + spočítané uzly + costing |
| `/api/cost` | POST | počítá uzly + cenu ze zadané architektury (`{}` → default) |
| `/api/import-paas` | POST | převede PaaS export na topologii IaaS + costing |
| `/api/export-paas` | POST | převede topologii IaaS zpět na Jelastic export |
| `/api/pricing` | GET | CPU/RAM/disk sazby + commitment options |
| `/api/deploy` | POST | nasadí všechny uzly do T-Cloud |
| Socket.IO `recalc` | — | klient pošle architekturu → serializovaná computed + costing |
| Socket.IO `deploy` | — | klient pošle architekturu → proud `deploy-progress` → summary |
| Socket.IO `start-server` | — | login + start serveru → `vnc_url` + `vnc_password` (+ `wan-ip`) |
| Socket.IO `stop-server` | — | login + zastavení serveru |

## Struktura

```
server.js               Entrypoint — Express + Socket.IO, REST endpointy, default.topo.json
lib/architecture.js     Model topologie VM + default architektura + PaaS import/export
lib/pricing.js          Resource Pool sazby + kalkulace nákladů (IaaS i cloudlety)
lib/tcloud.js           T-Cloud/CloudSigma klient (login 2FA/TOTP, drive/server, VNC, VLANy)
lib/deploy.js           Deploy runner (login jednou, VM po VM, report progress)
public/                 Statické UI (index.html, main.js, style.css)
default.topo.json       Volitelná startovní topologie (načte se při startu místo defaultu)
codenow/config/         Šablony env proměnných pro CodeNow
```

## Licence

MIT