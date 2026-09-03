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
let editingId = null
let editingVlan = null
let lastCosting = null

// ---- rendering ----

function renderTopology(nodes, vlans) {
  const fanout = document.getElementById('t-fanout')
  const groupKeys = Object.keys(state.groups || {}).filter(k => k !== 'opnsense')

  fanout.innerHTML = groupKeys.map(key => `
    <div class="t-column">
      <div class="t-conn" data-vlan="${esc(key)}" title="Klikni pro úpravu VLAN">
        <span class="t-vlan-name">${esc((vlans[key] && vlans[key].name) || groupVlanName(key))}</span>
        <span class="t-vlan-uuid">${(vlans[key] && vlans[key].uuid) ? ' · ' + esc(vlans[key].uuid) : ''}</span>
      </div>
      <div class="t-group">
        <div class="t-group-name">${esc(groupHead(key))}
          <span class="grp-actions">
            <button class="grp-edit" data-ed="${esc(key)}" title="Upravit název skupiny">✎</button>
            <button class="grp-del" data-del="${esc(key)}" title="Odebrat skupinu">×</button>
          </span>
        </div>
        <div class="t-group-body">${(nodes || []).filter(n => n.group === key).map(n => vmHtml(n)).join('')}</div>
      </div>
    </div>`).join('')

  const addCol = document.createElement('div')
  addCol.className = 't-column t-addcol'
  addCol.innerHTML = '<button class="btn grp-add" id="addGroupBtn" title="Přidat novou skupinu">+ Skupina</button>'
  fanout.appendChild(addCol)

  const opnsense = (nodes || []).find(n => n.group === 'opnsense')
  const opnsenseBox = document.querySelector('.vm-firewall')
  if (opnsenseBox && opnsense) {
    opnsenseBox.querySelector('.vm-spec').innerHTML =
      `CPU <b>${esc(fmt(opnsense.cpuGHz))}</b> GHz · RAM <b>${esc(fmt(opnsense.ramGB))}</b> GiB · Disk <b>${esc(fmt(opnsense.diskGB))}</b> GB · ${esc(tierLabel(opnsense.diskTier))}`
    opnsenseBox.querySelector('.vm-cost').innerHTML = opnsense._cost
      ? `<div class="vm-cost">${esc(opnsense._cost)}/měs</div>` : ''
  }

  document.querySelectorAll('.vm-click').forEach(el => {
    el.onclick = () => {
      const idx = el.dataset.idx
      const node = idx === 'opnsense' ? (nodes || []).find(n => n.group === 'opnsense') : (nodes || []).find(n => n.idx === idx)
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
  const cost = n._cost ? `<div class="vm-cost">${esc(n._cost)}/měs</div>` : ''
  return `
    <div class="vm vm-click" data-idx="${esc(n.idx)}" title="Klikni pro úpravu">
      <div class="vm-title">${esc(n.name)}</div>
      <div class="vm-sub">${esc(groupLabel(n.group))}</div>
      <div class="vm-spec">CPU <b>${esc(fmt(n.cpuGHz))}</b> GHz · RAM <b>${esc(fmt(n.ramGB))}</b> GiB · Disk <b>${esc(fmt(n.diskGB))}</b> GB · ${esc(tierLabel(n.diskTier))}</div>
      ${cost}
    </div>`
}

function renderCosting(costing) {
  lastCosting = costing
  const t = costing.totals
  const commitSel = $('commitSel')
  if (commitSel) { state.commitment = costing.commitmentMonths; commitSel.value = String(costing.commitmentMonths) }
  $('vmCount').textContent = costing.perNode.length
  $('totCpu').textContent = fmt(t.cpuGHz) + ' GHz'
  $('totRam').textContent = fmt(t.ramGB) + ' GiB'
  $('totDisk').textContent = fmt(t.diskGB) + ' GB'
  $('totCloudlets').textContent = t.cloudlets != null ? fmt(t.cloudlets) : '0'
  $('totCloudRam').textContent = fmt1(costing.cloudletRamGiB != null ? costing.cloudletRamGiB : 0) + ' GiB'
  $('totCloudCpu').textContent = fmt1(costing.cloudletCpuGHz != null ? costing.cloudletCpuGHz : 0) + ' GHz'
  $('totCloudCost').textContent = fmt(costing.cloudletCostCZK != null ? costing.cloudletCostCZK : 0) + ' Kč'

  const baseCloudlets = t.cloudlets != null ? t.cloudlets : 0
  const baseRam = costing.cloudletRamGiB != null ? costing.cloudletRamGiB : 0
  const baseCpu = costing.cloudletCpuGHz != null ? costing.cloudletCpuGHz : 0
  const baseCost = costing.cloudletCostCZK != null ? costing.cloudletCostCZK : 0
  const optimalPct = (typeof window.PAAS_OPTIMAL_PCT === 'number' ? window.PAAS_OPTIMAL_PCT : 60) / 100
  const reservePct = (typeof window.PAAS_RESERVE_PCT === 'number' ? window.PAAS_RESERVE_PCT : 20) / 100
  const optTitle = $('paasOptTitle')
  if (optTitle) optTitle.textContent = `Optimální (${Math.round(optimalPct * 100)} % limitů)`
  const resTitle = $('paasResTitle')
  if (resTitle) resTitle.textContent = `Rezervace (${Math.round(reservePct * 100)} % ceny limitů)`
  const paasLevel = (lvl, pct) => {
    const cl = Math.round(baseCloudlets * pct)
    const el = $('totCloudlets' + lvl)
    if (el) el.textContent = fmt(cl)
    $('totCloudRam' + lvl).textContent = fmt1(baseRam * pct) + ' GiB'
    $('totCloudCpu' + lvl).textContent = fmt1(baseCpu * pct) + ' GHz'
    $('totCloudCost' + lvl).textContent = fmt(baseCost * pct) + ' Kč'
  }
  paasLevel('Opt', optimalPct)
  paasLevel('Res', reservePct)

  $('totCpuCost').textContent = fmt(t.cpuCostCZK) + ' Kč'
  $('totRamCost').textContent = fmt(t.ramCostCZK) + ' Kč'
  $('totDiskCost').textContent = fmt(t.diskCostCZK) + ' Kč'
  $('totNetFw').textContent = fmt(t.networkingFwCZK != null ? t.networkingFwCZK : (costing.networkingFwCZK || 0)) + ' Kč'
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

  $('costTableBody').innerHTML = costing.perNode.map(n => `
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
      <td>${n.totalFormatted}</td>
    </tr>`).join('')
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
  const known = { app: 'App', db: 'DB', other: 'VM', opnsense: 'OPNsense' }[group]
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
    $('mDelete').style.display = node.group === 'opnsense' ? 'none' : ''
  }
  const known = { app: 'App', db: 'DB', other: 'VM', opnsense: 'OPNsense' }[node.group]
  fillGroupSelect(known ? node.group : (node.group || ''))
  // OPNsense je fixní singleton firewall — nelze měnit skupinu.
  $('mGroup').disabled = node.group === 'opnsense'
  $('vmModal').classList.add('open')
}

function fillGroupSelect(current) {
  const sel = $('mGroup')
  const keys = Object.keys(state.groups || {}).filter(k => k !== 'opnsense')
  sel.innerHTML = keys.map(k => `<option value="${esc(k)}">${esc(groupLabel(k))}</option>`).join('')
  if (current && keys.includes(current)) sel.value = current
}

function addVmModal() {
  const first = Object.keys(state.groups || {}).filter(k => k !== 'opnsense')[0] || 'app'
  openModal({ group: first, name: autoName(first), cpuGHz: 7.2, ramGB: 2.25, diskGB: 50 }, true)
  $('mName').focus()
}

function closeModal() {
  $('vmModal').classList.remove('open')
  editingId = null
}

function readForm() {
  const editing = (editingId != null && editingId !== NEW_VM)
    ? state.nodes.find(n => n.idx === editingId) : null
  const group = (editing && editing.group === 'opnsense') ? 'opnsense' : ($('mGroup').value)
  return {
    name: $('mName').value.trim() || 'VM',
    group,
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

function exportExcel() {
  const c = lastCosting
  const nodes = (c && c.perNode) || []
  const t = (c && c.totals) || {}
  const env = (state.nodes[0] && state.nodes[0]._envName) || state.envName || 'topologie'
  const commit = (c && (c.commitmentLabel || (c.commitmentMonths + ' měs.'))) || ''

  const wb = XLSX.utils.book_new()

  // Přehled
  const ov = []
  ov.push([env ? ('Topologie: ' + env) : 'IaaS Architektura'])
  if (commit) ov.push(['Závazek: ' + commit])
  ov.push(['Počet VM: ' + nodes.length])
  ov.push([])
  ov.push(['Celkem (IaaS)'])
  ov.push(['CPU celkem', fmt(t.cpuGHz || 0) + ' GHz'])
  ov.push(['RAM celkem', fmt(t.ramGB || 0) + ' GiB'])
  ov.push(['Disk celkem', fmt(t.diskGB || 0) + ' GB'])
  ov.push(['Cena CPU', fmt(t.cpuCostCZK || 0) + ' Kč'])
  ov.push(['Cena RAM', fmt(t.ramCostCZK || 0) + ' Kč'])
  ov.push(['Cena Disk', fmt(t.diskCostCZK || 0) + ' Kč'])
  ov.push(['Networking a FW', fmt((t.networkingFwCZK != null ? t.networkingFwCZK : 0)) + ' Kč'])
  ov.push(['Celkem (IaaS)', t.totalFormatted || '0 Kč'])
  ov.push([])
  ov.push(['PaaS (informativně)'])
  ov.push(['Cloudlety', (t.cloudlets != null ? fmt(t.cloudlets) : '0')])
  ov.push(['CPU ekv.', fmt1((c && c.cloudletCpuGHz != null ? c.cloudletCpuGHz : 0)) + ' GHz'])
  ov.push(['RAM ekv.', fmt1((c && c.cloudletRamGiB != null ? c.cloudletRamGiB : 0)) + ' GiB'])
  ov.push(['Cena (PaaS)', fmt((c && c.cloudletCostCZK != null ? c.cloudletCostCZK : 0)) + ' Kč'])
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ov), 'Přehled')

  // Virtuální stroje
  const sv = [
    ['VM', 'Skupina', 'CPU GHz', 'RAM GiB', 'Disk GB', 'Tier', 'CPU Kč', 'RAM Kč', 'Disk Kč', 'Celkem Kč']
  ]
  for (const n of nodes) {
    sv.push([n.name, groupLabel(n.group), n.cpuGHz, n.ramGB, n.diskGB, tierLabel(n.diskTier),
      n.cpuCostCZK, n.ramCostCZK, n.diskCostCZK, n.totalFormatted])
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sv), 'Virtuální stroje')

  // Disk podle tieru
  const disc = (c && c.diskByTier) || []
  const sd = [['Tier', 'Disk GB', 'Sazba Kč/GB', 'Cena Kč']]
  for (const x of disc) sd.push([x.label, x.diskGB, x.rate, x.diskCostCZK])
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sd), 'Disk podle tieru')

  // Cena podle skupiny
  const groupMap = {}
  for (const n of nodes) {
    if (!groupMap[n.group]) groupMap[n.group] = { total: 0, count: 0 }
    groupMap[n.group].total += n.totalCZK
    groupMap[n.group].count++
  }
  const sg = [['Skupina', 'Počet VM', 'Cena Kč']]
  for (const g of Object.keys(groupMap)) {
    const d = groupMap[g]
    sg.push([groupHead(g) || g, d.count, d.total])
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sg), 'Cena podle skupiny')

  // Skupiny a VLAN
  const svl = [['Skupina', 'Název', 'Label', 'VLAN', 'UUID', 'Disk tier']]
  for (const k of Object.keys(state.groups || {})) {
    const g = state.groups[k] || {}
    const v = (state.vlans || {})[k] || {}
    svl.push([k, g.name || '', g.label || '', v.name || '', v.uuid || '', tierLabel(g.diskTier)])
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(svl), 'Skupiny a VLAN')

  // Sazby
  const rt = c && c.diskTiers
  const sr = [['Sazby']]
  sr.push(['CPU', fmt(c.rateCpuGHz || 0) + ' Kč/GHz'])
  sr.push(['RAM', fmt(c.rateRamGB || 0) + ' Kč/GB'])
  sr.push(['Závazek', commit])
  sr.push([])
  sr.push(['Disk Kč/GB', c.commitmentMonths + ' měs.'])
  for (const tk of Object.values(rt || {})) {
    const rate = (tk.rates && tk.rates[c.commitmentMonths]) || 0
    sr.push([tk.label, rate])
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sr), 'Sazby')

  XLSX.writeFile(wb, (env || 'topologie') + '.xlsx')
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
    return '🌐 Public IP ' + (msg.name || 'OPNsense') + ': ' + (msg.publicIP || '')
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

fetch(BP + '/api/pricing').then(r => r.json()).then(data => {
  if (commitSel) {
    commitSel.innerHTML = (data.commitments || []).map(c =>
      `<option value="${c.months}">${esc(c.label)}</option>`).join('')
    commitSel.value = String(data.defaultCommitment ?? data.commitmentMonths ?? 12)
    state.commitment = parseInt(commitSel.value, 10)
    if (!Number.isFinite(state.commitment)) state.commitment = 12
  }
}).catch(() => {})

fetch(BP + '/api/architecture').then(r => r.json()).then(loadArch)
