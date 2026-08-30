require('dotenv').config()
const express = require('express')
const app = express()
const http = require('http').Server(app)
const fs = require('fs')
const path = require('path')
const BASE_PATH = process.env.BASE_PATH || ''
const port = process.env.PORT || 3003

const io = require('socket.io')(http, {
  path: BASE_PATH + '/socket.io',
})

const architecture = require('./lib/architecture')
const pricing = require('./lib/pricing')
const deployLib = require('./lib/deploy')
const tcloud = require('./lib/tcloud')

app.use(express.json({ limit: '10mb' }))

app.use(BASE_PATH, (req, res, next) => {
  const htmlPath = req.path === '/' || req.path === '' ? '/index.html'
    : req.path.endsWith('.html') ? req.path : null
  if (!htmlPath) return next()
  const filePath = path.join(__dirname, 'public', htmlPath)
  fs.readFile(filePath, 'utf-8', (err, html) => {
    if (err) return next()
    const baseTag = BASE_PATH ? `<base href="${BASE_PATH}/">` : ''
    const script = `<script>window.BASE_PATH=${JSON.stringify(BASE_PATH)};</script>`
    res.send(html.replace('</head>', baseTag + script + '</head>'))
  })
})

app.use(BASE_PATH, express.static(__dirname + '/public'))

function p(route) { return BASE_PATH + route }

function costOf(arch, commitmentMonths) {
  const computed = architecture.compute(arch)
  const cm = pricing.COMMITMENTS.includes(commitmentMonths) ? commitmentMonths : pricing.defaultCommitment()
  return { arch, computed, costing: pricing.summarize(computed.nodes, cm) }
}

app.get(p('/api/architecture'), (_req, res) => {
  res.json(costOf(architecture.defaultArchitecture()))
})

app.post(p('/api/cost'), (req, res) => {
  const body = req.body || {}
  const arch = Array.isArray(body.nodes) ? body : architecture.defaultArchitecture()
  const cm = (body && body.commitmentMonths != null) ? body.commitmentMonths : pricing.defaultCommitment()
  res.json(costOf(arch, cm))
})

// Import a PaaS (Jelastic / Virtuozzo) environment export and convert it into
// an IaaS topology. Accepts the export object directly or under `data`.
app.post(p('/api/import-paas'), (req, res) => {
  const body = req.body || {}
  const data = body.data || body
  try {
    if (!data || typeof data !== 'object' || !Array.isArray(data.nodes)) {
      return res.status(400).json({ error: 'Není to platný export PaaS prostředí (chybí nodes).' })
    }
    const arch = architecture.fromPaaSExport(data)
    res.json(costOf(arch))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Convert the current IaaS architecture into a Jelastic PaaS export. Accepts an
// architecture ({nodes, groups, ...}) or `{}` for the default topology.
app.post(p('/api/export-paas'), (req, res) => {
  const body = req.body || {}
  const arch = Array.isArray(body.nodes) ? body : architecture.defaultArchitecture()
  res.json(architecture.toPaaSExport(arch))
})

app.get(p('/api/pricing'), (_req, res) => {
  res.json({
    commitments: pricing.commitmentOptions(),
    defaultCommitment: pricing.defaultCommitment(),
    commitmentMonths: pricing.commitmentMonths(),
    rateCpuGHz: pricing.rateCpuGHz(),
    rateRamGB: pricing.rateRamGB(),
    rateDiskGB: pricing.rateDiskGB(),
  })
})

app.post(p('/api/deploy'), async (req, res) => {
  const body = req.body || {}
  const arch = Array.isArray(body.nodes) ? body : architecture.defaultArchitecture()
  const computed = architecture.compute(arch)
  const nodes = computed.nodes.filter(n => n.enabled !== false)
  const creds = body.creds || {}
  try {
    const results = await deployLib.deploy(nodes, { ...creds, vlans: computed.vlans })
    const ok = results.filter(r => r.ok).length
    res.json({ results, summary: { total: results.length, ok, failed: results.length - ok } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

io.on('connection', (socket) => {
  socket.on('recalc', (arch, callback) => {
    const full = Array.isArray(arch && arch.nodes) ? arch : architecture.defaultArchitecture()
    callback(costOf(full, arch && arch.commitmentMonths))
  })

  socket.on('deploy', async (arg, callback) => {
    const full = Array.isArray(arg && arg.nodes) ? arg : { nodes: [] }
    const computed = architecture.compute(full)
    const nodes = computed.nodes.filter(n => n.enabled !== false)
    const creds = (arg && arg.creds) || {}
    socket.emit('deploy-progress', { type: 'status', message: 'Spouštím deployment…' })
    try {
      const results = await deployLib.deploy(nodes, { ...creds, vlans: computed.vlans }, msg => socket.emit('deploy-progress', msg))
      callback({ ok: true, results, summary: { total: results.length, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length } })
    } catch (e) {
      socket.emit('deploy-progress', { type: 'status', message: 'Chyba: ' + e.message })
      callback({ ok: false, error: e.message })
    }
  })

  socket.on('start-server', async (arg, callback) => {
    const serverUUID = arg && arg.serverUUID
    const creds = (arg && arg.creds) || {}
    if (!serverUUID) return callback({ ok: false, error: 'serverUUID chybí' })
    socket.emit('deploy-progress', { type: 'status', message: 'Start serveru ' + String(serverUUID).slice(0, 8) + '…' })
    try {
      const session = await tcloud.login(creds)
      await tcloud.startServer(session, serverUUID)
      const server = await tcloud.waitServerRunning(session, serverUUID)
      if (!server) {
        socket.emit('deploy-progress', { type: 'status', message: 'Server ' + String(serverUUID).slice(0, 8) + ' se nepodařilo nastartovat (timeout čekání na running)' })
        return callback({ ok: false, error: 'server nenaběhl do running' })
      }
      const vncPassword = (server && server.vnc_password) || ''
      let vncUrl = ''
      try { vncUrl = await tcloud.openVnc(session, serverUUID) } catch (e) { /* VNC optional */ }

      // The OPNsense firewall has a public-IP NIC; once it's running, grab the
      // assigned public IPv4 and push it to the topology connector.
      let wanIp = ''
      try {
        const ip = await tcloud.getServerPublicIp(session, serverUUID)
        if (ip && ip.publicIP) wanIp = ip.publicIP
      } catch (e) { /* public IP optional */ }
      if (wanIp) socket.emit('deploy-progress', { type: 'wan-ip', publicIP: wanIp })

      socket.emit('deploy-progress', { type: 'vm-started', name: '(server)', serverUUID, vncUrl, vncPassword })
      callback({ ok: true, serverUUID, vncUrl, vncPassword, publicIP: wanIp })
    } catch (e) {
      socket.emit('deploy-progress', { type: 'status', message: 'Chyba startu: ' + e.message })
      callback({ ok: false, error: e.message })
    }
  })

  socket.on('stop-server', async (arg, callback) => {
    const serverUUID = arg && arg.serverUUID
    const creds = (arg && arg.creds) || {}
    if (!serverUUID) return callback({ ok: false, error: 'serverUUID chybí' })
    socket.emit('deploy-progress', { type: 'status', message: 'Zastavuji server ' + String(serverUUID).slice(0, 8) + '…' })
    try {
      const session = await tcloud.login(creds)
      await tcloud.stopServer(session, serverUUID)
      socket.emit('deploy-progress', { type: 'vm-stopped', name: '(server)', serverUUID })
      callback({ ok: true, serverUUID })
    } catch (e) {
      socket.emit('deploy-progress', { type: 'status', message: 'Chyba zastavení: ' + e.message })
      callback({ ok: false, error: e.message })
    }
  })
})

http.listen(port, () => console.log('IaaS API Mgmt running on port ' + port + ' base=' + (BASE_PATH || '/')))
