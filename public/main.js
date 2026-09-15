const BP = window.BASE_PATH || ''
const socket = io({ path: BP + '/socket.io' })

const $ = id => document.getElementById(id)
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
const fmt = n => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const fmt1 = n => (Math.round(n * 100) / 100).toString().replace('.', ',')

function groupMeta(key) { return (state.groups && state.groups[key]) || {} }
function groupLabel(key) { const g = groupMeta(key); return g.label || g.name || key }
function groupHead(key) { const g = groupMeta(key); return g.name || key }
function groupVlanName(key) { const g = groupMeta(key); return (g.vlanName || g.name || key).toUpperCase() }

const TIER_LABELS = { superfast: 'Super Fast', fast: 'Fast', standard: 'Standard', basic: 'Basic' }
function tierLabel(t) { return TIER_LABELS[t] || 'Super Fast' }

let state = { nodes: [], vlans: {}, groups: {}, wanIp: '', commitment: 12, envName: '' }
let paasUtil = (typeof window.PAAS_UTILIZATION === 'number' && window.PAAS_UTILIZATION >= 10)
  ? Math.min(window.PAAS_UTILIZATION, 100) : 40
let paasCloudRamMiB = 128
let paasCloudCpuMHz = 400
// Virtuozzo (PaaS) ceník — objemová pásma cloudletů (měsíčně = hodinová × 730 h)
const PAAS_RESERVED_RATES = [98.84, 93.88, 88.91, 84.02, 79.06] // 1–16, 17–32, 33–64, 65–128, 129+
const PAAS_DYNAMIC_RATES = [148.26, 144.54, 140.82, 137.09, 133.44] // 1–16, 17–32, 33–64, 65–128, 129+
const PAAS_BANDS = [16, 32, 64, 128, Infinity]
const PAAS_RESERVATION_PCT = 15 // rezervované cloudlety = vždy placené minimum (15 % z celku)
const PAAS_DISK_RATE_CZK = 2.40 // cena / GB / měsíc (0.003286 Kč/h × 730)
const PAAS_PUBLIC_IP_RATE_CZK = 120.01 // cena / IP / měsíc (0.1644 Kč/h × 730)
let paasCommitment = 12
let paasCommitCpuRates = {}
let editingId = null
let editingVlan = null
let lastCosting = null

// ---- rendering ----

function renderTopology(nodes, vlans) {
  const fanout = document.getElementById('t-fanout')
  const keys = Object.keys(state.groups || {})
  const groupKeys = keys.filter(k => k === 'opnsense').concat(keys.filter(k => k !== 'opnsense'))

  // INTERNET + WAN connector + groups all in one horizontal row
  const html = []
  html.push('<div class="t-node t-internet">INTERNET</div>')
  html.push(`<div class="t-conn t-wan" data-vlan="opnsense" title="Klikni pro úpravu VLAN"><span class="t-vlan-name" id="wanIp">${esc(state.wanIp ? 'WAN · ' + state.wanIp : 'WAN')}</span></div>`)

  for (const key of groupKeys) {
    const isSec = key === 'opnsense'
    html.push(`
    <div class="t-column${isSec ? ' t-sec' : ''}">
      ${!isSec ? `<div class="t-conn" data-vlan="${esc(key)}" title="Klikni pro úpravu VLAN">
        <span class="t-vlan-name">${esc((vlans[key] && vlans[key].name) || groupVlanName(key))}</span>
        <span class="t-vlan-uuid">${(vlans[key] && vlans[key].uuid) ? ' · ' + esc(vlans[key].uuid) : ''}</span>
      </div>` : ''}
      <div class="t-group">
        <div class="t-group-name">${esc(groupHead(key))}
          <span class="grp-actions">
            <button class="grp-edit" data-ed="${esc(key)}" title="Upravit název skupiny">✎</button>
            <button class="grp-del" data-del="${esc(key)}" title="Odebrat skupinu">×</button>
          </span>
        </div>
        <div class="t-group-body">${(nodes || []).filter(n => n.group === key).map(n => vmHtml(n)).join('')}</div>
      </div>
    </div>`)
  }

  html.push(`<div class="t-column t-addcol"><button class="btn grp-add" id="addGroupBtn" title="Přidat novou skupinu">+ Skupina</button></div>`)
  fanout.innerHTML = html.join('')

  document.querySelectorAll('.vm-click').forEach(el => {
    el.onclick = () => {
      const node = (nodes || []).find(n => n.idx === el.dataset.idx)
      if (node) openModal(node)
    }
  })
  document.querySelectorAll('.t-conn').forEach(el => { el.onclick = () => openVlanModal(el.dataset.vlan) })
  document.querySelectorAll('.grp-del').forEach(el => { el.onclick = () => removeGroup(el.dataset.del) })
  document.querySelectorAll('.grp-edit').forEach(el => { el.onclick = () => openGroupModal(el.dataset.ed) })
  document.getElementById('addGroupBtn').onclick = addGroup

  const env = (nodes[0] && nodes[0]._envName) || state.envName
  $('envName').textContent = env || 'dev-kube.prg1paas.t-cloud.eu'
}

function renderWan() {
  const el = $('wanIp')
  if (!el) return
  el.textContent = state.wanIp ? ('WAN · ' + state.wanIp) : 'WAN'
}

function setWanIp(ip) {
  if (ip) { state.wanIp = ip; renderWan() }
}

function addGroup() {
  const name = (window.prompt('Název nové skupiny:') || '').trim()
  if (!name) return
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'grp'
  if (!/^[a-z]/.test(base)) base = 'g' + base
  let key = base
  let i = 1
  while ((state.groups || {})[key]) key = base + (i++)
  state.groups[key] = { name, label: name, vlanName: name.toUpperCase() }
  recalc()
}

function removeGroup(key) {
  const g = (state.groups || {})[key]
  if (!window.confirm('Odebrat skupinu „' + (g && g.name || key) + '“ a všechny její VM?')) return
  delete state.groups[key]
  state.nodes = state.nodes.filter(n => n.group !== key)
  recalc()
}

function vmHtml(n) {
  const cls = n.group === 'opnsense' ? 'vm vm-click vm-firewall' : 'vm vm-click'
  return `
    <div class="${esc(cls)}" data-idx="${esc(n.idx)}" title="Klikni pro úpravu">
      <div class="vm-title">${esc(n.name)}</div>
      <div class="vm-sub">${esc(groupLabel(n.group))}</div>
      <div class="vm-spec">CPU <b>${esc(fmt(n.cpuGHz))}</b> GHz · RAM <b>${esc(fmt(n.ramGB))}</b> GiB · Disk <b>${esc(fmt(n.diskGB))}</b> GB · ${esc(tierLabel(n.diskTier))}</div>
    </div>`
}

function paasCloudletsOf(cpuGHz, ramGB) {
  const clCpu = paasCloudCpuMHz / 1000
  const clRam = paasCloudRamMiB / 1024
  return Math.ceil(Math.max(cpuGHz / clCpu, ramGB / clRam))
}

function paasCommitRatio(cm) {
  const r12 = paasCommitCpuRates[12]
  const r = paasCommitCpuRates[cm]
  if (!r12 || !r) return 1
  return r / r12
}

function paasBandedCost(count, rateArr) {
  let prev = 0
  let cost = 0
  for (let i = 0; i < PAAS_BANDS.length; i++) {
    if (count <= prev) break
    const inBand = Math.min(count, PAAS_BANDS[i]) - prev
    if (inBand > 0) cost += inBand * rateArr[i]
    prev = PAAS_BANDS[i]
  }
  return cost
}

function paasSplitCl(totalCl, util) {
  const u = util != null ? util : paasUtil / 100
  const reserved = Math.ceil(totalCl * PAAS_RESERVATION_PCT / 100)
  const dynamic = Math.max(0, Math.ceil(totalCl * u) - reserved)
  return { reserved, dynamic }
}

function paasCloudletsCost(totalCl, cm, util) {
  const ratio = paasCommitRatio(cm)
  const { reserved, dynamic } = paasSplitCl(totalCl, util)
  const cost = paasBandedCost(reserved, PAAS_RESERVED_RATES) + paasBandedCost(dynamic, PAAS_DYNAMIC_RATES)
  return cost * ratio
}

function commitLabel(cm) {
  return cm === 0 ? 'Bez závazku' : cm + ' měs.'
}

function renderCosting(costing) {
  lastCosting = costing
  const t = costing.totals
  const commitSel = $('commitSel')
  if (commitSel) { state.commitment = costing.commitmentMonths; commitSel.value = String(costing.commitmentMonths) }
  $('totCpu').textContent = fmt(t.cpuGHz) + ' GHz'
  $('totRam').textContent = fmt(t.ramGB) + ' GiB'
  $('totDisk').textContent = fmt(t.diskGB) + ' GB'
  const baseCloudlets = costing.perNode.reduce((s, n) => s + paasCloudletsOf(n.cpuGHz, n.ramGB), 0)
  const baseRam = t.ramGB
  const baseCpu = t.cpuGHz
  const utilPct = paasUtil / 100
  const paasSplit = paasSplitCl(baseCloudlets, utilPct)
  const paasReservedCl = paasSplit.reserved
  const paasDynamicCl = paasSplit.dynamic
  const paasCloudletCost = paasCloudletsCost(baseCloudlets, paasCommitment, utilPct)
  const paasEffRate = baseCloudlets > 0 ? paasCloudletCost / baseCloudlets : 0
  const paasDiskCl = Array.isArray(costing.perNode)
    ? costing.perNode.reduce((s, n) => s + (Number(n.diskGB) || 0), 0)
    : 0
  const paasDiskCost = paasDiskCl * PAAS_DISK_RATE_CZK
  const hasOpn = Array.isArray(costing.perNode) && costing.perNode.some(n => n.group === 'opnsense')
  const paasIpCost = hasOpn ? PAAS_PUBLIC_IP_RATE_CZK : 0
  const paasGrandTotal = paasCloudletCost + paasDiskCost + paasIpCost
  const el = $('totCloudletsR')
  if (el) el.textContent = fmt(paasReservedCl)
  const elD = $('totCloudletsD')
  if (elD) elD.textContent = fmt(paasDynamicCl)
  $('totCloudRamUtil').textContent = fmt1(baseRam * utilPct) + ' GiB'
  $('totCloudCpuUtil').textContent = fmt1(baseCpu * utilPct) + ' GHz'
  const perClEl = $('totCloudPerClUtil')
  if (perClEl) perClEl.textContent = fmt1(paasEffRate) + ' Kč'
  $('totCloudCostUtil').textContent = fmt(paasCloudletCost) + ' Kč'
  const diskEl = $('totDiskPaaS')
  if (diskEl) diskEl.textContent = fmt(paasDiskCost) + ' Kč'
  const ipEl = $('totPublicIP')
  if (ipEl) ipEl.textContent = fmt(paasIpCost) + ' Kč'
  const grandEl = $('totPaasGrand')
  if (grandEl) grandEl.textContent = fmt(paasGrandTotal) + ' Kč'
  const paasCommitSel = $('paasCommitSel')
  if (paasCommitSel) paasCommitSel.value = String(paasCommitment)
  const paasMRam = $('paasCloudRamMiB'); if (paasMRam) paasMRam.value = String(paasCloudRamMiB)
  const paasMCpu = $('paasCloudCpuMHz'); if (paasMCpu) paasMCpu.value = String(paasCloudCpuMHz)
  const utilVal = $('paasUtilVal')
  if (utilVal) utilVal.textContent = paasUtil + ' %'
  const utilRange = $('paasUtilRange')
  if (utilRange) utilRange.value = String(paasUtil)

  $('totPrice').textContent = t.totalFormatted

  const disc = costing.diskByTier || []
  $('diskTierDetail').innerHTML = disc.length
    ? '<div class="cost-disc-title">Disk podle tieru</div>' + disc.map(x =>
        `<div class="cost-disc-row">
           <span class="cd-label">${esc(x.label)}</span>
           <span class="cd-gb">${fmt(x.diskGB)} GB × ${fmt(x.rate)} Kč</span>
           <span class="cd-cost">${fmt(x.diskCostCZK)} Kč</span>
         </div>`).join('')
    : ''
  const tiers = costing.diskTiers || {}
  const tierLine = Object.values(tiers)
    .map(t => `${t.label} ${fmt((t.rates && t.rates[costing.commitmentMonths]) || 0)}`)
    .join(' · ')
  $('rateNote').textContent =
    `CPU: ${fmt(costing.rateCpuGHz)} Kč/GHz · RAM: ${fmt(costing.rateRamGB)} Kč/GB · Disk (Kč/GB): ${tierLine} · závazek: ${costing.commitmentLabel || (costing.commitmentMonths + ' měs.')}`
  const exEl = $('iaasExtras')
  if (exEl) {
    const chips = []
    if (costing.networkingFwCZK) chips.push(`Networking + FW: ${fmt(costing.networkingFwCZK)} Kč`)
    if (costing.publicIpCZK) chips.push(`Public IP: ${fmt(costing.publicIpCZK)} Kč`)
    exEl.innerHTML = chips.map(c => `<span>${esc(c)}</span>`).join('')
  }

  const groupMap = {}
  for (const n of costing.perNode) {
    if (!groupMap[n.group]) groupMap[n.group] = { total: 0, count: 0 }
    groupMap[n.group].total += n.totalCZK
    groupMap[n.group].count++
  }
  const order = Object.keys(state.groups || {}).filter(k => groupMap[k]).concat(
    Object.keys(groupMap).filter(k => !(state.groups || {})[k]))
  $('groupCostDetail').innerHTML = order.map(g => {
    const d = groupMap[g]
    return `<div class="cost-group-row">
      <span class="cg-label">${esc(groupHead(g) || g)}</span>
      <span class="cg-count">${d.count} VM</span>
      <span class="cg-cost">${fmt(d.total)} Kč</span>
    </div>`
  }).join('')

  $('costTableBody').innerHTML = costing.perNode.map(n => {
    const cl = paasCloudletsOf(n.cpuGHz, n.ramGB)
    return `
    <tr>
      <td>${esc(n.name)}</td>
      <td>${esc(groupLabel(n.group))}</td>
      <td>${fmt(n.cpuGHz)}</td>
      <td>${fmt(n.ramGB)}</td>
      <td>${n.diskGB}</td>
      <td>${esc(n.diskTierLabel)}</td>
      <td>${fmt(n.cpuCostCZK)} Kč</td>
      <td>${fmt(n.ramCostCZK)} Kč</td>
      <td>${fmt(n.diskCostCZK)} Kč</td>
      <td class="iaas-total">${n.totalFormatted}</td>
      <td>${fmt(Math.round(cl * utilPct))}</td>
      <td>${fmt(Math.round(cl * paasEffRate))} Kč</td>
    </tr>`
  }).join('')
}

function recalc() {
  socket.emit('recalc', { nodes: state.nodes.map(strip), vlans: state.vlans, groups: state.groups, commitmentMonths: state.commitment }, (res) => {
    state.nodes = res.computed.nodes.map((n, i) => {
      const c = (res.costing.perNode && res.costing.perNode[i]) || {}
      return { ...n, idx: String(i), _cost: c.totalFormatted }
    })
    state.vlans = res.computed.vlans || state.vlans
    state.groups = res.computed.groups || state.groups
    renderTopology(state.nodes, state.vlans)
    renderCosting(res.costing)
  })
}

function strip(n) {
  return { group: n.group, name: n.name, label: n.label, cpuGHz: n.cpuGHz, ramGB: n.ramGB, diskGB: n.diskGB, diskTier: n.diskTier }
}

// ---- modal ----

const NEW_VM = '__new__'

function autoName(group) {
  const known = { app: 'App', db: 'DB', other: 'VM', opnsense: 'Sec' }[group]
  const base = known || (groupLabel(group) || 'VM')
  const used = new Set(state.nodes.filter(n => n.group === group).map(n => n.name))
  let i = 1
  let name
  do { name = base + '-' + String(i).padStart(2, '0'); i++ } while (used.has(name))
  return name
}

function openModal(node, isNew) {
  editingId = isNew ? NEW_VM : node.idx
  const groupMeta2 = (state.groups && state.groups[node.group]) || {}
  const defaultTier = groupMeta2.diskTier || 'superfast'
  if (isNew) {
    $('mName').value = node.name
    $('mGroup').value = node.group
    $('mCpu').value = node.cpuGHz
    $('mRam').value = node.ramGB
    $('mDisk').value = node.diskGB
    $('mTier').value = node.diskTier || defaultTier
    $('modalTitle').textContent = 'Přidat VM'
    $('mDelete').style.display = 'none'
  } else {
    $('mName').value = node.name
    $('mGroup').value = node.group
    $('mCpu').value = node.cpuGHz
    $('mRam').value = node.ramGB
    $('mDisk').value = node.diskGB
    $('mTier').value = node.diskTier || defaultTier
    $('modalTitle').textContent = 'Upravit VM — ' + node.name
    $('mDelete').style.display = ''
  }
  const known = { app: 'App', db: 'DB', other: 'VM', opnsense: 'Bezpečnost' }[node.group]
  fillGroupSelect(known ? node.group : (node.group || ''))
  $('mGroup').disabled = false
  $('vmModal').classList.add('open')
}

function fillGroupSelect(current) {
  const sel = $('mGroup')
  const keys = Object.keys(state.groups || {})
  sel.innerHTML = keys.map(k => `<option value="${esc(k)}">${esc(groupLabel(k))}</option>`).join('')
  if (current && keys.includes(current)) sel.value = current
}

function addVmModal() {
  const first = Object.keys(state.groups || {})[0] || 'app'
  openModal({ group: first, name: autoName(first), cpuGHz: 7.2, ramGB: 2.25, diskGB: 50 }, true)
  $('mName').focus()
}

function closeModal() {
  $('vmModal').classList.remove('open')
  editingId = null
}

function readForm() {
  return {
    name: $('mName').value.trim() || 'VM',
    group: $('mGroup').value,
    cpuGHz: parseFloat($('mCpu').value) || 0,
    ramGB: parseFloat($('mRam').value) || 0,
    diskGB: parseFloat($('mDisk').value) || 0,
    diskTier: $('mTier').value || 'superfast',
  }
}

$('mSave').onclick = () => {
  if (editingId == null) return
  if (editingId === NEW_VM) {
    state.nodes.push(readForm())
  } else {
    const node = state.nodes.find(n => n.idx === editingId)
    if (!node) return
    Object.assign(node, readForm())
  }
  closeModal()
  recalc()
}

$('mCancel').onclick = closeModal
$('mDelete').onclick = () => {
  if (editingId == null || editingId === NEW_VM) return
  const idx = editingId
  closeModal()
  state.nodes = state.nodes.filter(n => n.idx !== idx)
  recalc()
}

// ---- vlan modal ----

function openVlanModal(group) {
  editingVlan = group
  const v = state.vlans[group] || {}
  $('vName').value = v.name || ''
  $('vUuid').value = v.uuid || ''
  $('vlanTitle').textContent = 'Upravit VLAN — ' + (groupHead(group) || group)
  $('vlanModal').classList.add('open')
}

function closeVlanModal() {
  $('vlanModal').classList.remove('open')
  editingVlan = null
}

$('vSave').onclick = () => {
  if (!editingVlan) return
  const v = state.vlans[editingVlan] || {}
  v.name = $('vName').value.trim()
  v.uuid = $('vUuid').value.trim()
  state.vlans[editingVlan] = v
  closeVlanModal()
  recalc()
}

$('vCancel').onclick = closeVlanModal

// ---- group rename modal ----

let editingGroup = null

function openGroupModal(group) {
  editingGroup = group
  const g = state.groups[group] || {}
  $('gName').value = g.name || g.label || group
  $('gLabel').value = g.label || ''
  $('groupTitle').textContent = 'Upravit skupinu — ' + (groupHead(group) || group)
  $('groupModal').classList.add('open')
}

function closeGroupModal() {
  $('groupModal').classList.remove('open')
  editingGroup = null
}

$('gSave').onclick = () => {
  if (!editingGroup) return
  const name = $('gName').value.trim()
  const label = $('gLabel').value.trim()
  if (name || label) {
    const g = state.groups[editingGroup] = state.groups[editingGroup] || {}
    if (name) g.name = name
    if (label) g.label = label
    if (!g.name && g.label) g.name = g.label
    if (!g.label) g.label = g.name
  }
  closeGroupModal()
  recalc()
}

$('gCancel').onclick = closeGroupModal

// ---- toolbar ----

$('addVmBtn').onclick = addVmModal
$('recalcBtn').onclick = recalc

// ---- topology save / load (localStorage) ----

let statusTimer = null
function showStatus(msg) {
  const el = $('topoStatus')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => el.classList.remove('show'), 3000)
}

function topologyConfig() {
  return {
    envName: state.envName || '',
    commitment: state.commitment,
    groups: state.groups || {},
    vlans: state.vlans || {},
    nodes: state.nodes.map(strip),
  }
}

function applyTopology(cfg) {
  state.envName = (cfg && cfg.envName) || ''
  state.commitment = (cfg && cfg.commitment != null) ? cfg.commitment : 12
  state.groups = (cfg && cfg.groups) || {}
  state.vlans = (cfg && cfg.vlans) || {}
  state.nodes = ((cfg && cfg.nodes) || []).map((n, i) => ({ ...n, idx: String(i) }))
  recalc()
}

function saveTopology() {
  try {
    localStorage.setItem('iaas_topology', JSON.stringify(topologyConfig()))
    showStatus('Konfigurace topologie uložena ✓')
  } catch (e) {
    showStatus('Chyba uložení: ' + e.message)
  }
}

function loadTopology() {
  try {
    const raw = localStorage.getItem('iaas_topology')
    if (!raw) { showStatus('Žádná uložená konfigurace'); return }
    applyTopology(JSON.parse(raw))
    showStatus('Konfigurace topologie načtena ✓ (' + state.nodes.length + ' VM)')
  } catch (e) {
    showStatus('Chyba načtení: ' + e.message)
  }
}

// ---- topology download / upload (file) ----

function downloadTopology() {
  try {
    const name = (state.envName || 'topologie') + '.topo.json'
    const blob = new Blob([JSON.stringify(topologyConfig(), null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    URL.revokeObjectURL(a.href)
    showStatus('Topologie stažena ✓')
  } catch (e) {
    showStatus('Chyba stažení: ' + e.message)
  }
}

function uploadTopologyFile(file) {
  const reader = new FileReader()
  reader.onload = () => {
    try {
      applyTopology(JSON.parse(reader.result))
      showStatus('Topologie nahrána ✓ (' + state.nodes.length + ' VM)')
    } catch (e) {
      showStatus('Chyba nahrání: ' + e.message)
    }
  }
  reader.onerror = () => showStatus('Chyba čtení souboru')
  reader.readAsText(file)
}

$('saveTopoBtn').onclick = saveTopology
$('loadTopoBtn').onclick = loadTopology
$('dlTopoBtn').onclick = downloadTopology
$('ulTopoBtn').onclick = () => $('ulTopoFile').click()
$('ulTopoFile').onchange = e => {
  const f = e.target.files && e.target.files[0]
  if (f) uploadTopologyFile(f)
  e.target.value = ''
}

// ---- export Excel (SheetJS -> binární .xlsx) ----

// Procento alimentované pro „Optimální“ / „Rezervace“ (stejně jako renderCosting).
function paasPct() {
  return {
    utilization: paasUtil / 100,
  }
}

// ---- Excel styling (opravdová grafika .xlsx přes JSZip) ----
//
// SheetJS community build neumí zapsat styly, tak se soubor po zápisu
// dozpracovává přes JSZip: přepíše se xl/styles.xml (fonty/filly/borders/cellXfs
// kopírující barevné schéma webu) a do xl/worksheets/sheet1.xml se doplní
// atribut `s` na buňky podle mřížky `rowTags` (jedna položka tagu na buňku).
// Tagy: default|title|subtitle|note|secIaaS|secPaaS|lbl|val|total|thead|tcell|tcellBold

const XLSX_TAG_IX = { default: 0, title: 1, subtitle: 2, note: 3, secIaaS: 4, secPaaS: 5, lbl: 6, val: 7, total: 8, thead: 9, tcell: 10, tcellBold: 11 }

function buildExcelStylesXml() {
  const font = (bold, sz, color, italic) =>
    '<font>' + (bold ? '<b/>' : '') + (italic ? '<i/>' : '') +
    `<sz val="${sz}"/><color rgb="FF${color}"/><name val="Calibri"/></font>`
  const fonts = [
    font(false, 11, '000000'),            // 0 default
    font(true, 11, '000000'),             // 1 bold
    font(true, 14, '1F3B57'),             // 2 title
    font(false, 10, '666666', true),      // 3 note (grey italic)
    font(true, 14, '1F6FEB'),             // 4 sec IaaS (blue)
    font(true, 14, '7A5BD6'),             // 5 sec PaaS (purple)
    font(false, 10, '8A79C9'),            // 6 item label (purple-grey)
    font(true, 11, '6B4FC0'),             // 7 item value / PaaS (purple)
    font(false, 10, '556677'),            // 8 subtitle
  ]
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF6F8FA"/><bgColor indexed="64"/></patternFill></fill>',   // 2 table header
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF0F6FF"/><bgColor indexed="64"/></patternFill></fill>',   // 3 blue tint (totals)
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFAF8FF"/><bgColor indexed="64"/></patternFill></fill>',   // 4 purple tint (items)
  ]
  const thin = '<border><left style="thin"><color rgb="FFEEF0F3"/></left><right style="thin"><color rgb="FFEEF0F3"/></right><top style="thin"><color rgb="FFEEF0F3"/></top><bottom style="thin"><color rgb="FFEEF0F3"/></bottom><diagonal/></border>'
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>', thin]
  const xf = (fontId, fillId, borderId, applyFont, applyFill, applyBorder) =>
    `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="${applyFont ? 1 : 0}" applyFill="${applyFill ? 1 : 0}" applyBorder="${applyBorder ? 1 : 0}"/>`
  const cellXfs = [
    xf(0, 0, 0),            // 0 default
    xf(2, 0, 0, 1),         // 1 title
    xf(8, 0, 0, 1),         // 2 subtitle
    xf(3, 0, 0, 1),         // 3 note
    xf(4, 0, 0, 1),         // 4 sec IaaS
    xf(5, 0, 0, 1),         // 5 sec PaaS
    xf(6, 0, 0, 1),         // 6 item label
    xf(7, 0, 0, 1),         // 7 item value
    xf(1, 3, 1, 1, 1, 1),   // 8 total (blue tint, bold)
    xf(1, 2, 1, 1, 1, 1),   // 9 table header (grey fill, bold, borders)
    xf(0, 0, 1, 0, 0, 1),   // 10 table cell (borders)
    xf(1, 0, 1, 1, 0, 1),   // 11 table cell bold (IaaS total / PaaS price)
  ]
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${cellXfs.length}">${cellXfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
}

function colToIdx(letters) {
  let idx = 0
  for (let i = 0; i < letters.length; i++) idx = idx * 26 + (letters.charCodeAt(i) - 64)
  return idx - 1
}

function applyXlsxStyles(sheetXml, rowTags) {
  return sheetXml.replace(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g, (mrow, r, inner) => {
    const ri = +r - 1
    const tags = rowTags[ri]
    const styled = inner.replace(/<c r="([A-Z]+)(\d+)"([^>]*)>/g, (m, col, rr, attrs) => {
      const tag = (tags && tags[colToIdx(col)]) || 'default'
      const si = XLSX_TAG_IX[tag]
      if (si == null || si === 0) return m
      return `<c r="${col}${rr}" s="${si}"${attrs}>`
    })
    return mrow.replace(inner, styled)
  })
}

async function exportExcel() {
  const c = lastCosting
  const nodes = (c && c.perNode) || []
  const t = (c && c.totals) || {}
  const env = (state.nodes[0] && state.nodes[0]._envName) || state.envName || 'topologie'
  const commit = (c && (c.commitmentLabel || (c.commitmentMonths + ' měs.'))) || ''
  const { utilization } = paasPct()

  const fmtKc = n => fmt(n == null ? 0 : n) + ' Kč'
  const aoa = []
  const rowTags = []
  const pushRow = (cells, spec) => {
    aoa.push(cells)
    const tags = new Array(cells.length)
    if (Array.isArray(spec)) {
      for (let i = 0; i < cells.length; i++) tags[i] = spec[i] || 'default'
    } else if (typeof spec === 'string') {
      for (let i = 0; i < cells.length; i++) tags[i] = spec
    } else {
      for (let i = 0; i < cells.length; i++) tags[i] = (spec && spec.base) || 'default'
      if (spec && spec.cells) for (const [i, tag] of Object.entries(spec.cells)) tags[+i] = tag
    }
    rowTags.push(tags)
  }

  pushRow([env ? ('Topologie: ' + env) : 'IaaS Architektura'], 'title')
  if (commit) pushRow(['Závazek: ' + commit], 'subtitle')
  pushRow([], 'blank')

  pushRow(['IaaS Costing / měsíc'], 'secIaaS')
  pushRow(['CPU', fmt(t.cpuGHz || 0) + ' GHz'], ['lbl', 'val'])
  pushRow(['RAM', fmt(t.ramGB || 0) + ' GiB'], ['lbl', 'val'])
  pushRow(['Disk', fmt(t.diskGB || 0) + ' GB'], ['lbl', 'val'])
  if (t.networkingFwCZK) pushRow(['Networking + FW', fmtKc(t.networkingFwCZK)], ['lbl', 'val'])
  if (t.publicIpCZK) pushRow(['Public IP', fmtKc(t.publicIpCZK)], ['lbl', 'val'])
  pushRow(['Cena (IaaS)', t.totalFormatted || '0 Kč'], ['lbl', 'total'])
  pushRow([], 'blank')

  const disc = c && c.diskByTier
  if (disc && disc.length) {
    pushRow(['Disk podle tieru'], 'note')
    for (const x of disc) pushRow([x.label, `${fmt(x.diskGB)} GB × ${fmt(x.rate)} Kč`, fmtKc(x.diskCostCZK)], ['lbl', 'note', 'val'])
    pushRow([], 'blank')
  }

  const groupMap = {}
  for (const n of nodes) {
    if (!groupMap[n.group]) groupMap[n.group] = { total: 0, count: 0 }
    groupMap[n.group].total += n.totalCZK
    groupMap[n.group].count++
  }
  const order = Object.keys(state.groups || {}).filter(k => groupMap[k]).concat(
    Object.keys(groupMap).filter(k => !(state.groups || {})[k]))
  if (order.length) {
    pushRow(['Cena podle skupiny'], 'note')
    for (const g of order) {
      const d = groupMap[g]
      pushRow([groupHead(g) || g, d.count + ' VM', fmtKc(d.total)], ['lbl', 'note', 'val'])
    }
    pushRow([], 'blank')
  }

  const tiers = (c && c.diskTiers) || {}
  const tierLine = Object.values(tiers)
    .map(tk => `${tk.label} ${fmt((tk.rates && tk.rates[c.commitmentMonths]) || 0)}`)
    .join(' · ')
  const rateNote = `CPU: ${fmt(c.rateCpuGHz)} Kč/GHz · RAM: ${fmt(c.rateRamGB)} Kč/GB · Disk (Kč/GB): ${tierLine} · závazek: ${commit || (c.commitmentMonths + ' měs.')}`
  pushRow([rateNote], 'note')
  pushRow([], 'blank')

  pushRow(['PaaS Costing / měsíc'], 'secPaaS')
  pushRow([`Závazek (PaaS): ${commitLabel(paasCommitment)} · Cloudlet: ${paasCloudRamMiB} MiB RAM + ${paasCloudCpuMHz} MHz CPU · Virtuozzo pásma (R: 98.84–79.06 / D: 148.26–133.44 Kč/cl/měs, ×${fmt1(paasCommitRatio(paasCommitment))}) · Rezervace: 15 % cloudletů (vždy placené) `], 'note')
  pushRow([`Utilizace ${Math.round(utilization * 100)} % · Rezervované: 15 % celkových · Dynamické: ceil(celkem × utilizace) − rezervované`], 'note')
  const paasTotalCl = nodes.reduce((s, n) => s + paasCloudletsOf(n.cpuGHz, n.ramGB), 0)
  const paasSplitXl = paasSplitCl(paasTotalCl, utilization)
  const paasResCl = paasSplitXl.reserved
  const paasDynCl = paasSplitXl.dynamic
  const paasCloudCost = paasCloudletsCost(paasTotalCl, paasCommitment, utilization)
  const paasDiskGB = nodes.reduce((s, n) => s + (Number(n.diskGB) || 0), 0)
  const paasDisk = paasDiskGB * PAAS_DISK_RATE_CZK
  const hasOp = nodes.some(n => n.group === 'opnsense')
  const paasIp = hasOp ? PAAS_PUBLIC_IP_RATE_CZK : 0
  pushRow(['CPU', fmt1((t.cpuGHz || 0) * utilization) + ' GHz'], ['lbl', 'val'])
  pushRow(['RAM', fmt1((t.ramGB || 0) * utilization) + ' GiB'], ['lbl', 'val'])
  pushRow(['Cloudlety rezervované (15 %)', fmt(paasResCl)], ['lbl', 'val'])
  pushRow(['Cloudlety dynamické (dle utilizace)', fmt(paasDynCl)], ['lbl', 'val'])
  pushRow(['Cena cloudletů (R + D)', fmtKc(paasCloudCost)], ['lbl', 'val'])
  pushRow(['Cena / cloudlet (průměr)', fmtKc(paasTotalCl > 0 ? paasCloudCost / paasTotalCl : 0)], ['lbl', 'val'])
  pushRow(['Disk PaaS (' + fmt(paasDiskGB) + ' GB × 2,40 Kč)', fmtKc(paasDisk)], ['lbl', 'val'])
  pushRow(['Public IP', fmtKc(paasIp)], ['lbl', 'val'])
  pushRow(['Cena (PaaS) celkem', fmtKc(paasCloudCost + paasDisk + paasIp)], ['lbl', 'total'])
  pushRow([], 'blank')

  const header = ['VM', 'Skupina', 'CPU GHz', 'RAM GiB', 'Disk GB', 'Tier', 'CPU', 'RAM', 'Disk', 'Cena IaaS', 'Cloudlety', 'Cena PaaS']
  pushRow(header, 'thead')
  const expTotalCl = nodes.reduce((s, n) => s + paasCloudletsOf(n.cpuGHz, n.ramGB), 0)
  const expEffRate = expTotalCl > 0 ? paasCloudletsCost(expTotalCl, paasCommitment, utilization) / expTotalCl : 0
  for (const n of nodes) {
    const cl = paasCloudletsOf(n.cpuGHz, n.ramGB)
    pushRow([n.name, groupLabel(n.group), n.cpuGHz, n.ramGB, n.diskGB, n.diskTierLabel,
      fmtKc(n.cpuCostCZK), fmtKc(n.ramCostCZK), fmtKc(n.diskCostCZK), n.totalFormatted,
      fmt(Math.round(cl * utilization)), fmtKc(cl * expEffRate)],
      { base: 'tcell', cells: { 9: 'tcellBold', 11: 'tcellBold' } })
  }

  // --- Topologie jako obrázek vložený do binárního .xlsx ---
  let topoPng = null
  try {
    const topoEl = document.querySelector('.topology')
    if (topoEl && window.html2canvas && window.JSZip) {
      let canvas = await html2canvas(topoEl, { scale: 2, backgroundColor: '#ffffff' })
      const maxW = 1400
      if (canvas.width > maxW) {
        const sc = maxW / canvas.width
        const c2 = document.createElement('canvas')
        c2.width = maxW
        c2.height = Math.round(canvas.height * sc)
        c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height)
        canvas = c2
      }
      topoPng = { b64: canvas.toDataURL('image/png').split(',')[1], w: canvas.width, h: canvas.height }
    }
  } catch (e) { topoPng = null }

  // rezervované prázdné řádky nahoře, aby obrázek nepřekrýval text
  if (topoPng) {
    const resTop = Math.round(topoPng.h / 18) + 2
    for (let i = 0; i < resTop; i++) aoa.unshift([null])
    for (let i = 0; i < resTop; i++) rowTags.unshift([])
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [
    { wch: 24 }, { wch: 16 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 11 },
    { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 13 }, { wch: 10 }, { wch: 12 },
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Costing mesic')
  const raw = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true })

  if (window.JSZip) {
    const zip = await JSZip.loadAsync(raw)
    zip.file('xl/styles.xml', buildExcelStylesXml())
    let sheet = await zip.file('xl/worksheets/sheet1.xml').async('string')
    sheet = applyXlsxStyles(sheet, rowTags)

    if (topoPng) {
      zip.file('xl/media/image1.png', topoPng.b64, { base64: true })
      const cx = Math.round(topoPng.w * 9525)
      const cy = Math.round(topoPng.h * 9525)
      zip.file('xl/drawings/_rels/drawing1.xml.rels',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="/xl/media/image1.png" Id="rId1"/></Relationships>')
      zip.file('xl/drawings/drawing1.xml',
        `<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><oneCellAnchor><from><col>0</col><colOff>0</colOff><row>0</row><rowOff>0</rowOff></from><ext cx="${cx}" cy="${cy}"/><pic><nvPicPr><cNvPr id="1" name="Topologie" descr="Topologie"/><cNvPicPr/></nvPicPr><blipFill><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" cstate="print" r:embed="rId1"/><a:stretch xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:fillRect/></a:stretch></blipFill><spPr><a:prstGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" prst="rect"/></spPr></pic><clientData/></oneCellAnchor></wsDr>`)
      const drawingRef = '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>'
      if (!sheet.includes('<drawing')) sheet = sheet.replace('</worksheet>', drawingRef + '</worksheet>')
      zip.file('xl/worksheets/_rels/sheet1.xml.rels',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="/xl/drawings/drawing1.xml" Id="rId1"/></Relationships>')
      let ct = await zip.file('[Content_Types].xml').async('string')
      if (!ct.includes('image/png')) ct = ct.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>')
      if (!ct.includes('/xl/drawings/drawing1.xml')) ct = ct.replace('</Types>', '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>')
      zip.file('[Content_Types].xml', ct)
    }

    zip.file('xl/worksheets/sheet1.xml', sheet)
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = (env || 'topologie') + '.xlsx'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 3000)
  } else {
    XLSX.writeFile(wb, (env || 'topologie') + '.xlsx', { compression: true })
  }
  showStatus('Excel stažen ✓')
}

$('xlBtn').onclick = exportExcel

// ---- deploy ----

let deployLogLines = []
let deployedServers = []

function readCreds() {
  const creds = {}
  const user = $('credUser').value.trim()
  const pass = $('credPass').value
  const otp = $('credOtp').value.trim()
  if (user) creds.username = user
  if (pass) creds.password = pass
  if (otp) creds.otpSecret = otp
  return creds
}

$('deployBtn').onclick = () => {
  $('deployPanel').hidden = false
  $('deploySummary').hidden = true
  $('deployLog').innerHTML = ''
  deployLogLines = []
  deployedServers = []
  setDeployStatus('Spouštím deployment…')
  $('deployBtn').disabled = true

  socket.emit('deploy', { nodes: state.nodes.map(strip), vlans: state.vlans, groups: state.groups, creds: readCreds() }, (res) => {
    $('deployBtn').disabled = false
    const summary = res && res.summary
    if (!summary) {
      setDeployStatus('Chyba: ' + (res && res.error || 'neznámá'))
      return
    }
    setDeployStatus(`Hotovo — ${summary.ok}/${summary.total} VM nasazeno (žádná nenastartována), ${summary.failed} chyb`)
    deployedServers = (res.results || []).filter(r => r.ok && r.serverUUID).map(r => ({ name: r.name, serverUUID: r.serverUUID, started: false }))
    renderDeployed()
  })
}

function renderDeployed() {
  $('deploySummary').hidden = false
  $('deploySummary').innerHTML = deployedServers.map(s => `
    <div class="deploy-server">
      <span class="ds-name">${esc(s.name)}</span>
      <span class="ds-uuid">${esc(s.serverUUID)}</span>
      ${s.started
        ? `<span class="ds-started">běží</span><button class="btn btn-deploy btn-start" data-stop="${esc(s.serverUUID)}">Zastavit</button>
           ${s.vncUrl ? `
           <div class="ds-vnc">
             <div class="ds-vnc-row"><span class="ds-vnc-label">VNC</span><code class="ds-vnc-url">${esc(s.vncUrl)}</code><button class="btn btn-mini" data-copy="${esc(s.vncUrl)}">kopírovat</button></div>
             <div class="ds-vnc-row"><span class="ds-vnc-label">Heslo</span><code class="ds-vnc-pass">${esc(s.vncPassword || '(nenastaveno)')}</code>${s.vncPassword ? `<button class="btn btn-mini" data-copy="${esc(s.vncPassword)}">kopírovat</button>` : ''}</div>
           </div>` : ''}`
        : `<button class="btn btn-deploy btn-start" data-start="${esc(s.serverUUID)}">Start</button>`}
    </div>`).join('')
  document.querySelectorAll('[data-start]').forEach(btn => {
    btn.onclick = () => {
      const uuid = btn.getAttribute('data-start')
      const entry = deployedServers.find(x => x.serverUUID === uuid)
      startServer(uuid, entry)
    }
  })
  document.querySelectorAll('[data-stop]').forEach(btn => {
    btn.onclick = () => {
      const uuid = btn.getAttribute('data-stop')
      const entry = deployedServers.find(x => x.serverUUID === uuid)
      stopServer(uuid, entry)
    }
  })
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation()
      copyText(btn.getAttribute('data-copy'), () => {
        const prev = btn.textContent
        btn.textContent = '✓'
        setTimeout(() => { btn.textContent = prev }, 1200)
      })
    }
  })
}

function startServer(serverUUID, entry) {
  if (!entry) return
  appendDeployLog({ type: 'status', message: 'Start serveru ' + entry.name + ' …' })
  socket.emit('start-server', { serverUUID, creds: readCreds() }, (res) => {
    if (res && res.ok) {
      if (res.publicIP) setWanIp(res.publicIP)
      entry.started = true
      entry.vncUrl = res.vncUrl || ''
      entry.vncPassword = res.vncPassword || ''
      appendDeployLog({ type: 'vm-started', name: entry.name, serverUUID, vncUrl: entry.vncUrl, vncPassword: entry.vncPassword })
      renderDeployed()
    } else {
      appendDeployLog({ type: 'vm-err', name: entry.name, error: (res && res.error) || 'neznámá chyba' })
    }
  })
}

function stopServer(serverUUID, entry) {
  if (!entry) return
  appendDeployLog({ type: 'status', message: 'Zastavuji server ' + entry.name + ' …' })
  socket.emit('stop-server', { serverUUID, creds: readCreds() }, (res) => {
    if (res && res.ok) {
      entry.started = false
      delete entry.vncUrl
      delete entry.vncPassword
      appendDeployLog({ type: 'vm-stopped', name: entry.name, serverUUID })
      renderDeployed()
    } else {
      appendDeployLog({ type: 'vm-err', name: entry.name, error: (res && res.error) || 'neznámá chyba' })
    }
  })
}

socket.on('deploy-progress', (msg) => {
  if (msg && msg.type === 'wan-ip' && msg.publicIP) setWanIp(msg.publicIP)
  appendDeployLog(msg)
})

function setDeployStatus(text) {
  $('deployStatus').textContent = text
}

function logText(msg) {
  if (msg.type === 'status') return '▸ ' + (msg.message || '')
  if (msg.type === 'vm-start') return '→ Nasazuji ' + msg.name + ' …'
  if (msg.type === 'vm-created')
    return '✓ ' + msg.name + ' vytvořeno' + (msg.serverUUID ? ' · ' + msg.serverUUID : '') + ' (nenastartováno)'
  if (msg.type === 'vm-started')
    return '✓ ' + msg.name + ' nastartováno' + (msg.serverUUID ? ' · ' + msg.serverUUID : '') +
      (msg.vncUrl ? '\n   VNC: ' + msg.vncUrl + '\n   Heslo: ' + ((msg.vncPassword || '(nenastaveno)')) : '')
  if (msg.type === 'vm-stopped')
    return '■ ' + msg.name + ' zastaveno' + (msg.serverUUID ? ' · ' + msg.serverUUID : '')
  if (msg.type === 'vm-ok')
    return '✓ ' + msg.name + ' hotovo' + (msg.started ? ' (běží)' : ' (vytvořeno)') + (msg.serverUUID ? ' · ' + msg.serverUUID : '')
  if (msg.type === 'wan-ip')
    return '🌐 Public IP ' + (msg.name || 'Sec-01') + ': ' + (msg.publicIP || '')
  if (msg.type === 'vm-err') return '✗ ' + msg.name + ' — ' + (msg.error || 'chyba')
  return JSON.stringify(msg)
}

function appendDeployLog(msg) {
  const log = $('deployLog')
  const line = document.createElement('div')
  line.className = 'deploy-line ' + (msg.type === 'vm-ok' || msg.type === 'vm-created' || msg.type === 'vm-started' ? 'ok' : msg.type === 'vm-err' ? 'err' : '')
  line.textContent = logText(msg)
  deployLogLines.push(line.textContent)
  log.appendChild(line)
  log.scrollTop = log.scrollHeight
}

function copyText(text, done) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
  } else {
    fallbackCopy(text, done)
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy') } catch {}
  document.body.removeChild(ta)
  done()
}

$('copyLogBtn').onclick = () => {
  const text = deployLogLines.join('\n')
  if (!text) return
  copyText(text, () => {
    const b = $('copyLogBtn')
    const prev = b.textContent
    b.textContent = 'Zkopírováno ✓'
    setTimeout(() => { b.textContent = prev }, 1500)
  })
}

// ---- import PaaS → IaaS ----

function loadArch(data) {
  if (data.arch && data.arch.envName) state.envName = data.arch.envName
  state.nodes = data.computed.nodes.map((n, i) => {
    const c = (data.costing.perNode && data.costing.perNode[i]) || {}
    return { ...n, idx: String(i), _cost: c.totalFormatted }
  })
  state.vlans = data.computed.vlans || {}
  state.groups = data.computed.groups || {}
  renderTopology(state.nodes, state.vlans)
  renderCosting(data.costing)
  renderWan()
}

const importPanel = $('importPanel')
const importErr = $('importErr')
$('importBtn').onclick = () => {
  importPanel.hidden = !importPanel.hidden
  if (!importPanel.hidden) { importErr.textContent = ''; $('importInput').focus() }
}
$('importCancelBtn').onclick = () => { importPanel.hidden = true }
$('importOkBtn').onclick = () => {
  const raw = $('importInput').value.trim()
  importErr.textContent = ''
  if (!raw) { importErr.textContent = 'Prázdný vstup.'; return }
  let payload
  try { payload = JSON.parse(raw) } catch (e) { importErr.textContent = 'Chyba JSON: ' + e.message; return }
  $('importOkBtn').disabled = true
  fetch(BP + '/api/import-paas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: payload }),
  }).then(r => r.json().then(d => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok) throw new Error(d.error || 'Import selhal')
      loadArch(d)
      $('importErr').textContent = 'Topologie importována ✓ (' + state.nodes.length + ' VM)'
      importPanel.hidden = true
    })
    .catch(e => { importErr.textContent = e.message })
    .finally(() => { $('importOkBtn').disabled = false })
}

// ---- export PaaS (Jelastic) ----

const exportPanel = $('exportPanel')
const exportErr = $('exportErr')
function exportPaaS() {
  exportErr.textContent = ''
  $('exportJson').value = 'Generuji…'
  const envName = state.nodes[0] && state.nodes[0]._envName
  const payload = {
    envName: envName || '',
    groups: state.groups || {},
    nodes: state.nodes.map(n => ({ group: n.group, name: n.name, label: n.label, cpuGHz: n.cpuGHz, ramGB: n.ramGB, diskGB: n.diskGB })),
  }
  fetch(BP + '/api/export-paas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => r.json()).then(d => {
    if (d.error) throw new Error(d.error)
    $('exportJson').value = JSON.stringify(d, null, 2)
    exportPanel.hidden = false
  }).catch(e => { exportErr.textContent = e.message })
}
$('exportBtn').onclick = () => {
  exportPanel.hidden = !exportPanel.hidden
  if (!exportPanel.hidden) exportPaaS()
}
$('exportCancelBtn').onclick = () => { exportPanel.hidden = true }
$('exportCopyBtn').onclick = () => {
  const v = $('exportJson').value
  navigator.clipboard && navigator.clipboard.writeText(v)
  exportErr.textContent = 'Zkopírováno ✓'
}
$('exportDlBtn').onclick = () => {
  const v = $('exportJson').value
  const blob = new Blob([v], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = (state.nodes[0] && state.nodes[0]._envName || 'paas-export') + '.json'
  a.click()
  URL.revokeObjectURL(a.href)
}

// ---- init ----

const commitSel = $('commitSel')
if (commitSel) commitSel.onchange = () => {
  state.commitment = parseInt(commitSel.value, 10)
  if (!Number.isFinite(state.commitment)) state.commitment = 12
  recalc()
}

const paasCommitSel = $('paasCommitSel')
if (paasCommitSel) paasCommitSel.onchange = () => {
  paasCommitment = parseInt(paasCommitSel.value, 10)
  if (!Number.isFinite(paasCommitment)) paasCommitment = 12
  if (lastCosting) renderCosting(lastCosting)
  else recalc()
}

const bindPaasParam = (input, setter, min) => {
  if (!input) return
  const apply = () => {
    let v = parseFloat(String(input.value).replace(',', '.'))
    if (!Number.isFinite(v) || v < min) v = min
    setter(v)
    if (lastCosting) renderCosting(lastCosting)
    else recalc()
  }
  input.oninput = apply
  input.onchange = apply
}
bindPaasParam($('paasCloudRamMiB'), v => { paasCloudRamMiB = v }, 1)
bindPaasParam($('paasCloudCpuMHz'), v => { paasCloudCpuMHz = v }, 1)

const paasRange = $('paasUtilRange')
if (paasRange) {
  paasRange.oninput = () => {
    paasUtil = parseInt(paasRange.value, 10) || 40
    $('paasUtilVal').textContent = paasUtil + ' %'
    if (lastCosting) renderCosting(lastCosting)
  }
}

fetch(BP + '/api/pricing').then(r => r.json()).then(data => {
  const commitOpts = (data.commitments || []).map(c =>
    `<option value="${c.months}">${esc(c.label)}</option>`).join('')
  paasCommitCpuRates = {}
  for (const c of (data.commitments || [])) paasCommitCpuRates[c.months] = c.cpu
  const defCm = Number(data.defaultCommitment ?? data.commitmentMonths ?? 12)
  if (commitSel) {
    commitSel.innerHTML = commitOpts
    commitSel.value = String(defCm)
    state.commitment = parseInt(commitSel.value, 10)
    if (!Number.isFinite(state.commitment)) state.commitment = 12
  }
  if (paasCommitSel) {
    paasCommitSel.innerHTML = commitOpts
    paasCommitSel.value = String(defCm)
    paasCommitment = parseInt(paasCommitSel.value, 10)
    if (!Number.isFinite(paasCommitment)) paasCommitment = 12
  }
}).catch(() => {})

fetch(BP + '/api/architecture').then(r => r.json()).then(loadArch)
