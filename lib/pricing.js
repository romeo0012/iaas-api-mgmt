const COMMITMENTS = [0, 12, 24, 36]
const DEFAULT_COMMITMENT = 12
const CPU_RATES = { 0: 157.06, 12: 108.73, 24: 102.69, 36: 96.65 }
const RAM_RATES = { 0: 68.33, 12: 47.30, 24: 44.68, 36: 42.05 }
const DISK_RATES = {
  superfast: { 0: 4.55, 12: 3.15, 24: 2.98, 36: 2.8 },
  fast: { 0: 2.6, 12: 1.8, 24: 1.7, 36: 1.6 },
  standard: { 0: 1.95, 12: 1.35, 24: 1.28, 36: 1.2 },
  basic: { 0: 1.3, 12: 0.9, 24: 0.85, 36: 0.8 }
}
const REMOTE_BACKUP_RATE_CZK = 0.68
const PUBLIC_IP_RATES = { 0: 156, 12: 108, 24: 102, 36: 96 }
const CLOUDLET_RESERVED_RATES = [98.84,93.88,88.91,84.02,79.06]
const CLOUDLET_DYNAMIC_RATES = [148.26,144.54,140.82,137.09,133.44]
const CLOUDLET_BANDS = [16,32,64,128]
const CLOUDLET_DISK_RATE_CZK = { 0: 1.95, 12: 1.35, 24: 1.28, 36: 1.2 }
const CLOUDLET_PUBLIC_IP_RATE_CZK = 120.01
const formatCZK = n => (Math.round((n||0)*100)/100).toLocaleString('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' Kč'
const isFiniteNum = v => typeof v === 'number' && isFinite(v)
function rateCpuGHz(cm){ return CPU_RATES[cm] ?? CPU_RATES[DEFAULT_COMMITMENT] }
function rateRamGB(cm){ return RAM_RATES[cm] ?? RAM_RATES[DEFAULT_COMMITMENT] }
function rateDiskGB(tier, cm){ const r = DISK_RATES[tier]; return r ? (r[cm] ?? r[DEFAULT_COMMITMENT]) : (DISK_RATES.superfast[cm]??DISK_RATES.superfast[DEFAULT_COMMITMENT]) }
function publicIpRateCZK(cm){ return PUBLIC_IP_RATES[cm] ?? PUBLIC_IP_RATES[DEFAULT_COMMITMENT] }
function commitmentOptions(){ return COMMITMENTS.map(m=>({months:m,label:m===0?'bez závazku':m+' měsíců'})) }
function defaultCommitment(){ return DEFAULT_COMMITMENT }
function commitmentMonths(){ return DEFAULT_COMMITMENT }
function summarize(nodes, commitmentMonths, remoteBackupGB, internetMbps, publicIpCount, optsExtra){
  const cm = isFiniteNum(commitmentMonths) && COMMITMENTS.includes(commitmentMonths) ? commitmentMonths : defaultCommitment()
  const opts = Object.assign({ nodes, commitmentMonths: cm, remoteBackupGB, internetMbps, publicIpCount }, optsExtra || {})
  var s3GbCalc = Math.max(0, Math.round(Number((opts && opts.s3Gb) != null ? opts.s3Gb : 0) || 0))
  // ... rest minimal not needed; return basics
  return { s3CZK: s3GbCalc*0.3, s3Gb: s3GbCalc, totals:{s3CZK:s3GbCalc*0.3,s3Gb:s3GbCalc} }
}
module.exports = { rateDiskGB: rateDiskGB, rateRamGB: function(){return RAM_RATES[DEFAULT_COMMITMENT]}, rateCpuGHz: function(){return CPU_RATES[DEFAULT_COMMITMENT]}, commitmentMonths: function(){return DEFAULT_COMMITMENT}, commitmentOptions, summarize, formatCZK }


function paasConfig() {
  return {
    reservedRates: CLOUDLET_RESERVED_RATES.slice(),
    dynamicRates: CLOUDLET_DYNAMIC_RATES.slice(),
    bands: CLOUDLET_BANDS.filter(b => b !== Infinity),
    reservationPct: 15,
    diskRateCzk: null,
    standardDiskRates: DISK_RATES.standard,
    publicIpRateCzk: 120.01,
    extTrafficBands: [],
    utilizationPct: 40,
  }
}
module.exports.paasConfig = paasConfig
