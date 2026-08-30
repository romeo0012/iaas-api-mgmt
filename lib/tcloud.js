'use strict'

// Thin client for the T-Cloud (CloudSigma) API at prg1.t-cloud.eu.
//
// Implements the same flow as the bash scripts:
//
//   1. login                 POST /accounts/action/?do=login      {username,password}
//   2. verify 2FA (TOTP)     POST /accounts/action/?do=verify_otp OTP header
//   3. create drive          POST /drives/
//   4. create server         POST /servers/
//   5. start server          POST /servers/{uuid}/action/?do=start
//
// Uses Node's built-in fetch + crypto (no extra dependencies).
//
// Credentials are per-login: login(opts) accepts {username, password,
// otpSecret, vlanUUID, baseUrl, referer}; anything missing falls back to
// the defaults from the environment (see CONFIG below). This lets the UI
// pass user-supplied credentials instead of hardcoding them.

const crypto = require('crypto')

const CONFIG = {
  baseUrl: process.env.TCLOUD_BASE_URL || 'https://prg1.t-cloud.eu/api/2.0',
  referer: process.env.TCLOUD_REFERER || 'https://prg1.t-cloud.eu',
  username: process.env.TCLOUD_USERNAME || '',
  password: process.env.TCLOUD_PASSWORD || '',
  otpSecret: process.env.TCLOUD_OTP_SECRET || '',
  vlanUUID: process.env.TCLOUD_VLAN_UUID || '',
}

// ------------------------- TOTP (RFC 6238) -------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(str) {
  const clean = str.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase()
  const bits = []
  for (const c of clean) {
    const idx = B32.indexOf(c)
    if (idx < 0) continue
    for (let i = 4; i >= 0; i--) bits.push((idx >> i) & 1)
  }
  const out = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    out.push(byte)
  }
  return Buffer.from(out)
}

function base32Canonical(secret) {
  return secret.replace(/\s+/g, '').replace(/-/g, '').toUpperCase()
}

function totp(secret) {
  const key = base32Decode(base32Canonical(secret))
  const counter = Math.floor(Date.now() / 1000 / 30)
  const msg = Buffer.alloc(8)
  msg.writeUInt32BE(0, 0)
  msg.writeUInt32BE(counter, 4) // 64-bit big-endian
  const hmac = crypto.createHmac('sha1', key).update(msg).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000
  return bin.toString().padStart(6, '0')
}

// ------------------------- Session -------------------------

class Session {
  constructor(cfg) {
    this.cookies = {}
    this.cfg = cfg
  }

  jarFrom(res) {
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []
    for (const sc of setCookies) {
      const [pair] = sc.split(';')
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '' || value.toLowerCase() === 'deleted') delete this.cookies[name]
      else this.cookies[name] = value
    }
  }

  cookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }

  get csrfToken() {
    return this.cookies.csrftoken || ''
  }
}

// ------------------------- HTTP helpers -------------------------

class TCloudError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request(session, method, path, { json, headers = {} } = {}) {
  const res = await fetch(session.cfg.baseUrl + path, {
    method,
    headers: {
      Accept: 'application/json',
      Referer: session.cfg.referer + '/',
      ...(session.cookieHeader() ? { Cookie: session.cookieHeader() } : {}),
      ...(session.csrfToken ? { 'X-CSRFToken': session.csrfToken } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(json ? { body: JSON.stringify(json) } : {}),
  })
  session.jarFrom(res)

  const text = await res.text()
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (!res.ok) {
    const detail = typeof data === 'object' ? JSON.stringify(data).slice(0, 500) : String(data).slice(0, 500)
    throw new TCloudError(`T-Cloud API ${res.status} on ${method} ${path}: ${detail}`, res.status, data)
  }
  return { status: res.status, data }
}

function firstUuid(data) {
  if (!data) return null
  if (Array.isArray(data.objects) && data.objects.length) {
    return data.objects[0].uuid || data.objects[0].id || null
  }
  return data.uuid || data.id || null
}

// ------------------------- Public API -------------------------

async function login(opts = {}) {
  const cfg = {
    ...CONFIG,
    baseUrl: opts.baseUrl || CONFIG.baseUrl,
    referer: opts.referer || CONFIG.referer,
    username: opts.username || CONFIG.username,
    password: opts.password || CONFIG.password,
    otpSecret: opts.otpSecret || CONFIG.otpSecret,
    vlanUUID: opts.vlanUUID || CONFIG.vlanUUID,
  }

  if (!cfg.username || !cfg.password) {
    throw new TCloudError('T-Cloud credentials not provided. Enter username/password/OTP secret in the deploy panel or set TCLOUD_USERNAME / TCLOUD_PASSWORD / TCLOUD_OTP_SECRET in .env.', 0)
  }

  const session = new Session(cfg)

  await request(session, 'POST', '/accounts/action/?do=login', {
    json: { username: cfg.username, password: cfg.password },
  })

  if (!session.csrfToken) throw new TCloudError('Login failed: csrftoken not set', 0)

  if (cfg.otpSecret) {
    const otp = totp(cfg.otpSecret)
    const verify = await request(session, 'POST', '/accounts/action/?do=verify_otp', {
      json: {},
      headers: { OTP: otp },
    })
    if (verify.status !== 200) throw new TCloudError('2FA verification failed', verify.status)
  }

  return session
}

// Create a blank data drive (media: disk).
async function createDrive(session, name, sizeGB) {
  const { data } = await request(session, 'POST', '/drives/', {
    json: { objects: [{ name, size: sizeGB * 1024 * 1024 * 1024, media: 'disk' }] },
  })
  return firstUuid(data)
}

// Create a server with one blank system/virtio drive + one or more nics.
// A nic is either a private VLAN (`vlanUUID`/`vlanUUIDs`) or a public IP
// (`publicIP`), never both. `publicIP` gives a DHCP public-IP nic (e.g. the
// firewall). If nothing is given, fall back to the session's config VLAN,
// else a public DHCP nic.
async function createServer(session, { name, cpuMHz, memMB, diskGB, vlanUUID, vlanUUIDs, publicIP, bootOrder = 1 }) {
  const driveUUID = await createDrive(session, name + '-disk', diskGB)

  const drives = [{
    boot_order: bootOrder,
    dev_channel: '0:0',
    device: 'virtio',
    drive: { uuid: driveUUID },
  }]

  const list = (vlanUUIDs && vlanUUIDs.length) ? vlanUUIDs : (vlanUUID ? [vlanUUID] : [])
  const makeVlan = u => ({ model: 'virtio', vlan: { uuid: u }, ip_v4_conf: null })
  let nics
  if (publicIP) {
    nics = [{ model: 'virtio', ip_v4_conf: { conf: 'dhcp' }, vlan: null }]
  } else if (list.length) {
    nics = list.map(makeVlan)
  } else if (session.cfg.vlanUUID) {
    nics = [makeVlan(session.cfg.vlanUUID)]
  } else {
    nics = [{ model: 'virtio', ip_v4_conf: { conf: 'dhcp' }, vlan: null }]
  }

  const { data } = await request(session, 'POST', '/servers/', {
    json: {
      name,
      cpu: cpuMHz,
      mem: memMB * 1024 * 1024,
      vnc_password: '',
      drives,
      nics,
    },
  })

  const serverUUID = firstUuid(data)
  return { serverUUID, driveUUID }
}

async function startServer(session, serverUUID) {
  await request(session, 'POST', `/servers/${serverUUID}/action/?do=start`, { json: {} })
}

async function stopServer(session, serverUUID) {
  await request(session, 'POST', `/servers/${serverUUID}/action/?do=stop`, { json: {} })
}

// List existing private VLANs; used to auto-match VM groups by VLAN name.
// Matches the reference bash script: GET /vlans/detail/?limit=0 and the
// VLAN display name lives in .meta.name (falling back to .meta.name_tag).
async function listVlans(session) {
  const { data } = await request(session, 'GET', '/vlans/detail/?limit=0')
  const objs = (data && data.objects) || []
  return objs.map(v => {
    const meta = v.meta || {}
    const name = meta.name || meta.name_tag || v.name || ''
    return { uuid: v.uuid, name: String(name), tag: v.bottom_vlan_tag }
  }).filter(v => v.uuid)
}

// Fetch a server object (includes vnc_password, status, nics, ...).
async function getServer(session, serverUUID) {
  const { data } = await request(session, 'GET', `/servers/${serverUUID}/`)
  return data && data.objects ? data.objects[0] : data
}

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

// Extract the public IPv4 of a server. Looks for a NIC without a VLAN (the
// DHCP public-IP NIC, e.g. the OPNsense firewall's WAN). The assigned address
// may be a UUID that must be resolved via GET /ips/{uuid}/ (only populated
// after the server actually runs a DHCP handshake). Returns null if no public
// IP is (yet) available.
async function getServerPublicIp(session, serverUUID) {
  const server = await getServer(session, serverUUID)
  const nics = (server && server.nics) || []
  for (const nic of nics) {
    if (nic.vlan && nic.vlan.uuid) continue // skip private VLAN nics
    const rt = nic.runtime || {}
    const ipV4 = rt.ip_v4 || nic.ip_v4
    if (!ipV4) continue
    const value = typeof ipV4 === 'object' ? (ipV4.uuid || ipV4.address || ipV4.value) : ipV4
    if (!value) continue
    if (isUuid(value)) {
      try {
        const { data } = await request(session, 'GET', `/ips/${value}/`)
        const obj = (data && data.objects && data.objects[0]) || data
        if (obj && (obj.ip_v4 || obj.address)) {
          return { publicIP: obj.ip_v4 || obj.address, serverUUID }
        }
      } catch (e) { /* leave unresolved */ }
    } else {
      return { publicIP: String(value), serverUUID }
    }
  }
  return null
}

// Poll until the server reports status "running" (VNC is only openable on a
// running server). Returns the server object, or null on timeout.
async function waitServerRunning(session, serverUUID, { timeoutMs = 90000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const server = await getServer(session, serverUUID)
    if (server && server.status === 'running') return server
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return null
}

// Open a VNC tunnel; returns the vnc:// URL (different on every open).
async function openVnc(session, serverUUID) {
  const { data } = await request(session, 'POST', `/servers/${serverUUID}/action/?do=open_vnc`, { json: {} })
  let url = data && data.vnc_url
  if (!url && data && Array.isArray(data.objects) && data.objects[0]) url = data.objects[0].vnc_url
  return url || ''
}

module.exports = { login, createDrive, createServer, startServer, stopServer, getServer, getServerPublicIp, waitServerRunning, openVnc, listVlans, totp, CONFIG }
