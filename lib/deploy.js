'use strict'

const tcloud = require('./tcloud')

// Deploy an array of VM definitions ({ name, cpuGHz, ramGB, diskGB, group })
// to T-Cloud. Logs in once, then for every VM creates a blank disk + a
// server (NOT auto-started). Progress is reported through `onProgress`.
//
// Returns an array of per-VM results:
//   { name, ok:true, serverUUID, driveUUID, started }
//   { name, ok:false, error }

async function deploy(nodes, opts = {}, onProgress = () => {}) {
  const report = (msg) => { try { onProgress(msg) } catch {} }

  const creds = {}
  for (const k of ['username', 'password', 'otpSecret', 'baseUrl', 'referer']) {
    if (opts[k]) creds[k] = opts[k]
  }
  const vlans = opts.vlans || {}

  report({ type: 'status', message: 'Přihlašuji se k T-Cloud…' })
  const session = await tcloud.login(creds)
  report({ type: 'status', message: 'Přihlášeno k T-Cloud' })

  // Auto-match missing VLAN UUIDs by listing T-Cloud VLANs once and looking
  // them up by the group's VLAN name (e.g. APP, DATA, LAN). An explicitly set
  // UUID in the topology always wins.
  let vlansByName = {}
  const hasMissing = Object.keys(vlans)
    .filter(g => g !== 'opnsense')
    .some(g => vlans[g] && !vlans[g].uuid)
  if (hasMissing) {
    try {
      const list = await tcloud.listVlans(session)
      vlansByName = {}
      for (const v of list) if (v.name) vlansByName[String(v.name).toLowerCase()] = v.uuid
      report({ type: 'status', message: 'Načteno ' + list.length + ' VLAN z T-Cloudu' })
    } catch (e) {
      report({ type: 'status', message: 'Nepodařilo se načíst VLANy: ' + e.message })
    }
  }

  // The firewall gets a single public-IP nic; each other group uses its own
  // VLAN (auto-matched by name, or an explicitly entered UUID, else DHCP).
  const vlanFor = (group) => {
    if (group === 'opnsense') {
      return { publicIP: true }
    }
    const v = vlans[group] || {}
    if (v.uuid) return { vlanUUID: v.uuid }
    const byName = vlansByName[(v.name || group).toLowerCase()]
    if (byName) return { vlanUUID: byName }
    return {}
  }

  const results = []
  for (const n of nodes) {
    const name = n.name || 'VM'
    const cpuMHz = Math.round((Number(n.cpuGHz) || 0) * 1000)
    const memMB = Math.round((Number(n.ramGB) || 0) * 1024)
    const diskGB = Number(n.diskGB) || 0

    report({ type: 'vm-start', name })
    try {
      const net = vlanFor(n.group)
      const { serverUUID, driveUUID } = await tcloud.createServer(session, {
        name,
        cpuMHz,
        memMB,
        diskGB,
        ...net,
      })
      report({ type: 'vm-created', name, serverUUID, driveUUID })
      const entry = { name, ok: true, serverUUID, driveUUID, started: false }
      // The OPNsense firewall uses a public-IP NIC; report its WAN address
      // (may be null until the server first runs a DHCP handshake).
      if (net.publicIP) {
        try {
          const ip = await tcloud.getServerPublicIp(session, serverUUID)
          if (ip && ip.publicIP) {
            entry.publicIP = ip.publicIP
            report({ type: 'wan-ip', name, publicIP: ip.publicIP })
          }
        } catch (e) { /* public IP optional */ }
      }
      results.push(entry)
    } catch (e) {
      report({ type: 'vm-err', name, error: e.message })
      results.push({ name, ok: false, error: e.message })
    }
  }

  report({ type: 'status', message: 'Hotovo' })
  return results
}

module.exports = { deploy }
