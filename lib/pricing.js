'use strict'

require('dotenv').config()

// Business Cloud (T-Business / T-Cloud) IaaS je účtovaný ako "Resource Pool":
// celkové zdroje celej architektúry (súčet cez všetky VM), nie per VM:
//   celková cena = Σ CPU GHz × sadzba + Σ RAM GB × sadzba + Σ disk GB × sadzba
//
// Jednotkové sadzby v Kč/mesiac z oficiálnej kalkulačky T-Business
// (https://t-business.cz/cs/kalkulator-ceny/ - /api/calculator/groups).
// "Bez závazku" = commitment 0 (účtované priamo cez /api/calculator/calculate
// s commitment_months=0, sadzby overené voči API).
//
// Sadzby podľa dĺžky záväzku (Kč/mesiac):
//   komponent              0m(bez)  12m    24m     36m
//   CPU (GHz)              157.06 108.73 102.69   96.65
//   RAM (GB)                68.33  47.30  44.68   42.05
//   Disk:
//     Super Fast 10000       4.55   3.15   2.98    2.80
//     Fast 5000              2.60   1.80   1.70    1.60
//     Standard 3000          1.95   1.35   1.28    1.20
//     Basic 600              1.30   0.90   0.85    0.80

const COMMITMENTS = [0, 12, 24, 36]

// Cloudlet (PaaS/Jelastic-style): 1 cloudlet = 128 MiB RAM (= 0.125 GiB) and
// 400 MHz CPU (= 0.4 GHz). Per-VM cloudlets = max(CPU/0.4, RAM/0.125), rounded
// up; total = sum across all VMs. Disks are ignored for the cloudlet count.
const CLOUDLET_CPU_GHZ = 0.4
const CLOUDLET_RAM_GB = 0.125
// PaaS per-cloudlet monthly price in Kč (T-Business PaaS kalkulačka: 82 cloudlets
// = 10.25 GiB + 32.8 GHz ⇒ 11 361.7 Kč ⇒ 11361.7/82 ≈ 138.56 Kč). Configurable.
const CLOUDLET_RATE_CZK = parseFloat(process.env.IaaS_CLOUDLET_RATE_CZK) || 138.56
// Flat monthly fee for networking + firewall (T-Business kalkulačka:
// "Networking and FW" 108 Kč). Applied to every commitment. Configurable.
const NETWORK_FW_RATE_CZK = parseFloat(process.env.IaaS_NETWORK_FW_RATE_CZK) || 108

const DEFAULT_COMMITMENT = (() => {
  const v = parseInt(process.env.IaaS_COMMITMENT_MONTHS, 10)
  return Number.isFinite(v) && COMMITMENTS.includes(v) ? v : 12
})()

const RATES = {
  cpu: { 0: 157.06, 12: 108.73, 24: 102.69, 36: 96.65 },
  ram: { 0: 68.33, 12: 47.30, 24: 44.68, 36: 42.05 },
}

// Disk tiers: stable keys → display label + per-GB/month rate by commitment.
const DISK_TIERS = {
  superfast: { key: 'superfast', label: 'Super Fast', rates: { 0: 4.55, 12: 3.15, 24: 2.98, 36: 2.80 } },
  fast:      { key: 'fast',      label: 'Fast',      rates: { 0: 2.60, 12: 1.80, 24: 1.70, 36: 1.60 } },
  standard:  { key: 'standard',  label: 'Standard',  rates: { 0: 1.95, 12: 1.35, 24: 1.28, 36: 1.20 } },
  basic:     { key: 'basic',     label: 'Basic',     rates: { 0: 1.30, 12: 0.90, 24: 0.85, 36: 0.80 } },
}

// .env overrides apply to whatever commitment is active.
const ENV = {
  cpu: process.env.IaaS_CPU_RATE_CZK_GHZ,
  ram: process.env.IaaS_RAM_RATE_CZK_GB,
  disk: process.env.IaaS_DISK_RATE_CZK_GB,
}

function commitmentLabel(cm) {
  return cm === 0 ? 'Bez závazku' : cm + ' měs.'
}

function commitmentOptions() {
  return COMMITMENTS.map(cm => ({
    months: cm,
    label: commitmentLabel(cm),
    cpu: rateCpuGHz(cm),
    ram: rateRamGB(cm),
    disk: DISK_TIERS,
  }))
}

// Env overrides apply only to the DEFAULT commitment; switching to another
// commitment in the UI always uses that commitment's table rates.
function rateCpuGHz(cm = DEFAULT_COMMITMENT) {
  const table = RATES.cpu[cm]
  return (ENV.cpu != null && cm === DEFAULT_COMMITMENT) ? parseFloat(ENV.cpu) : table
}
function rateRamGB(cm = DEFAULT_COMMITMENT) {
  const table = RATES.ram[cm]
  return (ENV.ram != null && cm === DEFAULT_COMMITMENT) ? parseFloat(ENV.ram) : table
}
function rateDiskGB(cm = DEFAULT_COMMITMENT) {
  const table = DISK_TIERS.superfast.rates[cm]
  return (ENV.disk != null && cm === DEFAULT_COMMITMENT) ? parseFloat(ENV.disk) : table
}
function commitmentMonths() { return DEFAULT_COMMITMENT }
function defaultCommitment() { return DEFAULT_COMMITMENT }
function diskTiers() { return DISK_TIERS }

// Per-GB/month rate for a disk tier (falls back to the superfast default rate).
function diskRateForTier(tier, cm = DEFAULT_COMMITMENT) {
  const t = DISK_TIERS[tier]
  return (t && t.rates[cm]) || rateDiskGB(cm)
}
function diskTierLabel(tier) {
  const t = DISK_TIERS[tier]
  return t ? t.label : (DISK_TIERS.superfast.label)
}

function formatCZK(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Kč'
}

// Cost breakdown for a single node (VM), using Resource Pool unit prices and
// the node's own disk tier.
function nodeCost(node, cm = DEFAULT_COMMITMENT) {
  const cpuGHz = node.cpuGHz || 0
  const ramGB = node.ramGB || 0
  const diskGB = node.diskGB || 0
  const tier = node.diskTier || 'superfast'
  const diskRate = diskRateForTier(tier, cm)
  const basicRate = DISK_TIERS.basic.rates[cm]
  const cpuCost = cpuGHz * rateCpuGHz(cm)
  const ramCost = ramGB * rateRamGB(cm)
  // BC calculator bills the VM's disk at its performance tier PLUS a base
  // "Basic" volume equal to the disk (see summarize's diskByTier).
  const diskCost = diskGB * (diskRate + basicRate)
  const total = cpuCost + ramCost + diskCost
  return {
    name: node.name,
    group: node.group,
    cpuGHz,
    ramGB,
    diskGB,
    diskTier: tier,
    diskTierLabel: diskTierLabel(tier),
    diskRate: diskRate,
    basicRate: basicRate,
    cloudlets: Math.ceil(Math.max(cpuGHz / CLOUDLET_CPU_GHZ, ramGB / CLOUDLET_RAM_GB)),
    cpuCostCZK: cpuCost,
    ramCostCZK: ramCost,
    diskCostCZK: diskCost,
    totalCZK: total,
    totalFormatted: formatCZK(total),
  }
}

// Full cost summary across all nodes as a pooled "Resource Pool".
function summarize(nodes, cm = DEFAULT_COMMITMENT) {
  const perNode = nodes.map(n => nodeCost(n, cm))
  const pooled = { cpuGHz: 0, ramGB: 0, diskGB: 0 }
  for (const n of perNode) {
    pooled.cpuGHz += n.cpuGHz
    pooled.ramGB += n.ramGB
    pooled.diskGB += n.diskGB
  }
  // The BC calculator bills the *total* CPU GHz rounded up to a whole number
  // (e.g. 36.8 GHz → 37 × rate), so the pooled CPU cost is rounded up too.
  // Per-node lines stay exact; only the pooled CPU is rounded.
  const cpuGHzCharged = Math.ceil(pooled.cpuGHz)
  const totals = {
    cloudlets: perNode.reduce((s, n) => s + n.cloudlets, 0),
    cpuGHz: pooled.cpuGHz,    ramGB: pooled.ramGB,
    diskGB: pooled.diskGB,
    cpuCostCZK: cpuGHzCharged * rateCpuGHz(cm),
    ramCostCZK: pooled.ramGB * rateRamGB(cm),
    diskCostCZK: perNode.reduce((s, n) => s + n.diskCostCZK, 0),
    networkingFwCZK: NETWORK_FW_RATE_CZK,
    totalCZK: 0,
    totalFormatted: '',
  }
  totals.totalCZK = totals.cpuCostCZK + totals.ramCostCZK + totals.diskCostCZK + totals.networkingFwCZK
  totals.totalFormatted = formatCZK(totals.totalCZK)

  // Disk total broken down by tier (BC calculator style): the per-VM
  // performance tier volumes at their tier rates, PLUS a base "Basic"
  // volume equal to the total disk across all VMs.
  const TIER_ORDER = ['superfast', 'fast', 'standard']
  const tierBreakdown = TIER_ORDER.map(key => {
    const t = DISK_TIERS[key]
    const tierNodes = perNode.filter(n => n.diskTier === key)
    const diskGB = tierNodes.reduce((s, n) => s + n.diskGB, 0)
    return {
      key,
      label: t.label,
      rate: t.rates[cm],
      diskGB,
      diskCostCZK: diskGB * t.rates[cm],
    }
  }).filter(x => x.diskGB > 0)

  const basicRate = DISK_TIERS.basic.rates[cm]
  const basicGB = totals.diskGB
  const basicCost = basicGB * basicRate
  const diskByTier = [
    ...tierBreakdown,
    { key: 'basic', label: 'Basic (základ)', rate: basicRate, diskGB: basicGB, diskCostCZK: basicCost },
  ]

  return {
    commitmentMonths: cm,
    commitmentLabel: commitmentLabel(cm),
    rateCpuGHz: rateCpuGHz(cm),
    rateRamGB: rateRamGB(cm),
    rateDiskGB: rateDiskGB(cm),
    cloudletRateCZK: CLOUDLET_RATE_CZK,
    networkFwRateCZK: NETWORK_FW_RATE_CZK,
    networkingFwCZK: NETWORK_FW_RATE_CZK,
    cloudlets: totals.cloudlets,
    cloudletRamGiB: totals.cloudlets * CLOUDLET_RAM_GB,
    cloudletCpuGHz: totals.cloudlets * CLOUDLET_CPU_GHZ,
    cloudletCostCZK: totals.cloudlets * CLOUDLET_RATE_CZK,
    diskTiers: DISK_TIERS,
    diskByTier,
    perNode,
    totals,
  }
}

module.exports = {
  COMMITMENTS,
  defaultCommitment, commitmentOptions,
  rateCpuGHz, rateRamGB, rateDiskGB, commitmentMonths,
  diskTiers, diskRateForTier, diskTierLabel,
  nodeCost, summarize, formatCZK,
}
