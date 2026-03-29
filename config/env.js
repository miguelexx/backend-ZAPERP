'use strict'

const path = require('path')
const dotenv = require('dotenv')

let loaded = false

function loadEnv() {
  if (loaded) return
  dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true })
  loaded = true
}

function isProduction() {
  return String(process.env.NODE_ENV || '').trim() === 'production'
}

function getBooleanEnv(name, defaultValue = false) {
  const raw = process.env[name]
  if (raw == null || raw === '') return defaultValue
  const norm = String(raw).trim().toLowerCase()
  return norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on'
}

module.exports = {
  loadEnv,
  isProduction,
  getBooleanEnv,
}
