'use strict'

// VM-based architecture model.
//
// Each VM is a plain virtual machine defined by:
//   cpuGHz  - CPU (GHz)
//   ramGB   - RAM (GiB)
//   diskGB  - disk (GB)
//
// Costing is computed as a pooled "Resource Pool" over the whole
// architecture (see pricing.js) — total CPU (GHz), RAM (GB) and disk (GB)
// across all VMs, each billed at a per-month rate.
//
// Topology groups: opnsense (firewall), app (application servers),
// db (database servers), other (W-01, NFS, Cache, NoSQL, ...).

// Disk tiers (see pricing.js DISK_TIERS): superfast | fast | standard | basic

const DEFAULT_DISK_TIER = 'superfast'

const vm = (group, name, { cpu, ram, disk, label, diskTier }) => {
  return {
    group,
    name,
    label: label || '',
    cpuGHz: cpu,
    ramGB: ram,
    diskGB: disk,
    diskTier: diskTier || undefined,
  }
}

// Default groups: objects keyed by a group id. Each has
//   name      – display name (e.g. "Aplikační servery")
//   label     – short label for a VM in that group (e.g. "Aplikační")
//   vlanName  – name of the group's VLAN (e.g. "APP")
//   diskTier  – default disk tier for VMs in this group (optional)
// `opnsense` is the firewall singleton; every other group is an internal
// VLAN reached through it. Groups are dynamic: the UI can add/remove any
// non-opnsense group (its VMs + VLAN disappear when removed).
function defaultGroups() {
  return {
    app: { name: 'Aplikační servery', label: 'Aplikační', vlanName: 'APP', diskTier: 'standard' },
    db: { name: 'Databázové servery', label: 'Databázový', vlanName: 'DATA', diskTier: 'fast' },
    opnsense: { name: 'OPNsense', label: 'OPNsense', vlanName: 'WAN', diskTier: 'standard' },
  }
}

// Default network per group. Each non-opnsense group is an internal VLAN
// reached through the OPNsense firewall.
function defaultVlans() {
  const vlans = {}
  for (const [key, g] of Object.entries(defaultGroups())) {
    vlans[key] = { name: g.vlanName, uuid: '' }
  }
  return vlans
}

// Default topology per the page example.
function defaultArchitecture() {
  return {
    name: 'dev-kube',
    envName: 'dev-kube.prg1paas.t-cloud.eu',
    groups: defaultGroups(),
    nodes: [
      vm('opnsense', 'OPNsense', { cpu: 4, ram: 4, disk: 20, label: 'Firewall', diskTier: 'standard' }),
      vm('app', 'App-01', { cpu: 7.2, ram: 2.25, disk: 50, diskTier: 'standard' }),
      vm('db', 'DB-01', { cpu: 4, ram: 4, disk: 120, diskTier: 'fast' }),
    ],
  }
}

// Map a PaaS node type to an IaaS topology group + default disk tier.
const PAAS_NODE_TO_GROUP = {
  opnsense: 'opnsense', firewall: 'opnsense', vpn: 'opnsense', vpnserver: 'opnsense',
  postgresql: 'db', mysql: 'db', mariadb: 'db', mongodb: 'db', mongo: 'db', redis: 'db',
  haproxy: 'app', nginx: 'app', apache: 'app', tomcat: 'app', nodejs: 'app', docker:
    'app', kubernetes: 'app', k8s: 'app',
  storage: 'other', nfs: 'other', cache: 'other', nosql: 'other', elasticsearch: 'other', memcached: 'other',
}
const PAAS_NODE_TIER = {
  db: 'fast',
  storage: 'superfast', other: 'superfast',
}

// Convert a PaaS (Jelastic / Virtuozzo) environment export into an IaaS
// architecture. Each PaaS node is sized from its `cloudlets` (1 cloudlet =
// 0.4 GHz CPU + 0.125 GiB RAM) and `diskLimit`; `count` expands into multiple
// VMs. Node types map to IaaS groups (app/db/other/opnsense). Always keeps an
// opnsense firewall singleton even if the export has none.
function fromPaaSExport(data) {
  const nodes = Array.isArray(data.nodes) ? data.nodes : []
  const groups = {}
  const out = []
  const tierFor = (type, group) => {
    const t = PAAS_NODE_TIER[group]
    if (t) return t
    return { standard: 'standard', fast: 'fast', superfast: 'superfast' }[group] || 'standard'
  }
  const groupFor = type => PAAS_NODE_TO_GROUP[String(type || '').toLowerCase()] || 'other'

  for (const node of nodes) {
    const type = node.nodeType || node.nodeGroup || 'other'
    const group = groupFor(node.nodeType || type)
    const cloudlets = Number(node.cloudlets) || 0
    const cpu = Math.round(cloudlets * 0.4 * 10) / 10
    const ram = Math.round(cloudlets * 0.125 * 100) / 100
    const disk = parseDiskLimit(node.diskLimit)
    const baseName = node.displayName || node.nodeGroup || group
    const count = Math.max(1, Number(node.count) || 1)

    if (!groups[group]) groups[group] = groupMeta(group)

    for (let i = 0; i < count; i++) {
      out.push(vm(group, count > 1 ? `${baseName}-${String(i + 1).padStart(2, '0')}` : baseName, {
        cpu: cpu || 0,
        ram: ram || 0,
        disk: disk || 0,
        diskTier: tierFor(type, group),
      }))
    }
  }

  // Always ensure the OPNsense firewall singleton (IaaS entry point).
  if (!groups.opnsense) {
    groups.opnsense = groupMeta('opnsense')
    out.unshift(vm('opnsense', 'OPNsense', { cpu: 4, ram: 4, disk: 20, diskTier: 'standard' }))
  }

  const vlans = {}
  for (const [key, g] of Object.entries(groups)) {
    vlans[key] = { name: g.vlanName, uuid: '' }
  }

  const envName = (data.description && data.description.text)
    || (data.envName) || 'imported-env'
  return {
    name: envName,
    envName,
    groups,
    nodes: out,
    vlans,
  }
}

// Reverse cloudlet sizing: 1 cloudlet = 0.4 GHz CPU + 0.125 GiB RAM, so a VM
// needs enough cloudlets to cover both (take the max, ceil).
function cloudletsOf(cpuGHz, ramGB) {
  return Math.max(1, Math.ceil(Math.max((Number(cpuGHz) || 0) / 0.4, (Number(ramGB) || 0) / 0.125)))
}

// Format GB into a PaaS diskLimit string ("200G", "102.4G", "1T").
function formatDiskLimit(diskGB) {
  const v = Math.round((Number(diskGB) || 0) * 10) / 10
  if (v <= 0) return '1G'
  if (v >= 1024) return `${Math.round(v / 1024 * 10) / 10}T`
  return `${v}G`
}

// Convert an IaaS architecture into a Jelastic PaaS environment export where
// every VM becomes an `almalinux-vps` node (per the user's template). Replica
// VMs that were split by the importer (`Base-01…NN`) are collapsed back into
// a single node with `count`.
function toPaaSExport(arch) {
  const nodes = arch.nodes || []

  // Collapse `Base-NN` replicas (from import expansion) back into one node.
  const collapsed = {}
  const singles = []
  for (const n of nodes) {
    const m = (n.name || '').match(/^(.*)-(\d+)$/)
    if (m && Number(m[2]) >= 1) {
      const key = `${n.group}|${m[1]}`
      if (!collapsed[key]) collapsed[key] = { group: n.group, base: m[1], node: n, count: 0 }
      collapsed[key].count = Math.max(collapsed[key].count, Number(m[2]))
      continue
    }
    singles.push(n)
  }

  const exportNodes = []

  // Jelastic requires nodeGroup to match ^[a-z0-9._\-+]+$ (lowercase).
  const sanitizeGroupName = (name, fallback) => {
    const s = String(name || '').toLowerCase().replace(/[^a-z0-9._\-+]/g, '')
    return s || fallback
  }

  const usedGroups = new Set()
  const uniqueGroup = base => {
    let g = base
    let i = 1
    while (usedGroups.has(g)) { i += 1; g = `${base}-${i}` }
    usedGroups.add(g)
    return g
  }

  const pushNode = (n, count, name) => {
    const cloudlets = cloudletsOf(n.cpuGHz, n.ramGB)
    const label = name || n.name || 'vds'
    const node = {
      docker: {
        cmd: '/bin/bash',
        env: {
          DOCKER_EXPOSED_PORT: '22',
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        },
      },
      tag: '9.7',
      cloudlets,
      diskLimit: formatDiskLimit(n.diskGB),
      scalingMode: 'STATEFUL',
      isSLBAccessEnabled: true,
      nodeType: 'almalinux-vps',
      nodeGroup: uniqueGroup(sanitizeGroupName(label, 'vds')),
    }
    if (count > 1) node.count = count
    exportNodes.push(node)
  }

  for (const c of Object.values(collapsed)) pushNode(c.node, c.count, c.base)
  for (const n of singles) pushNode(n, 1, n.name)

  const envName = arch.envName || arch.name || 'imported-env'
  return {
    type: 'install',
    name: Date.now(),
    engine: '',
    categories: ['export'],
    description: { text: envName },
    nodes: exportNodes,
    version: '8.14.3',
  }
}

function groupMeta(key) {
  const map = {
    app: { name: 'Aplikační servery', label: 'Aplikační', vlanName: 'APP', diskTier: 'standard' },
    db: { name: 'Databázové servery', label: 'Databázový', vlanName: 'DATA', diskTier: 'fast' },
    other: { name: 'Ostatní servery', label: 'Ostatní', vlanName: 'LAN', diskTier: 'superfast' },
    opnsense: { name: 'OPNsense', label: 'OPNsense', vlanName: 'WAN', diskTier: 'standard' },
  }
  return { ...(map[key] || { name: key, label: key, vlanName: key.toUpperCase(), diskTier: 'standard' }) }
}

// Parse a PaaS diskLimit string ("200G", "102.4G", "2048M", "1T") into GB.
function parseDiskLimit(v) {
  if (v == null) return 0
  const m = String(v).trim().match(/^([\d.]+)\s*([GMTP]?)(i?B)?$/i)
  if (!m) return Number(v) || 0
  let val = Number(m[1])
  const unit = (m[2] || 'G').toUpperCase()
  if (unit === 'M') val /= 1024
  if (unit === 'K') val /= 1024 / 1024
  if (unit === 'T') val *= 1024
  if (unit === 'P') val *= 1024 * 1024
  return Math.round(val * 10) / 10
}

function compute(arch) {
  const supplied = arch.groups || {}
  let groups
  if (Object.keys(supplied).length) {
    groups = {}
    for (const [key, g] of Object.entries(supplied)) groups[key] = g
    if (!groups.opnsense) groups.opnsense = { ...defaultGroups().opnsense }
  } else {
    groups = { ...defaultGroups() }
  }

  // Drop VMs whose group no longer exists (removed groups vanish entirely).
  const nodes = (arch.nodes || [])
    .filter(n => groups[n.group || 'other'])
    .map(n => {
      const cpu = Number(n.cpuGHz) || 0
      const ram = Number(n.ramGB) || 0
      const disk = Number(n.diskGB) || 0
      const group = groups[n.group || 'other']
      const tier = ['superfast', 'fast', 'standard', 'basic'].includes(n.diskTier)
        ? n.diskTier
        : (group && group.diskTier) || DEFAULT_DISK_TIER
      return {
        group: n.group || 'other',
        name: n.name || 'VM',
        label: n.label || '',
        cpuGHz: cpu,
        ramGB: ram,
        diskGB: disk,
        diskTier: tier,
        enabled: n.enabled !== false,
      }
    })

  // Derive a VLAN for every group (name kept, uuid preserved if supplied).
  const vlans = {}
  for (const [key, g] of Object.entries(groups)) {
    const v = (arch.vlans && arch.vlans[key]) || {}
    vlans[key] = {
      name: v.name != null && v.name !== '' ? String(v.name) : (g.vlanName || g.name || key),
      uuid: v.uuid != null ? String(v.uuid) : '',
    }
  }

  return { groups, nodes, vlans }
}

module.exports = { defaultArchitecture, compute, defaultVlans, defaultGroups, fromPaaSExport, toPaaSExport }
