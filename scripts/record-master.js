#!/usr/bin/env node
'use strict'

/**
 * Record what a real IO-Link master answers, so a profile can be checked
 * against hardware rather than against its own documentation.
 *
 *   node scripts/record-master.js ifm http://192.168.1.50/ [options]
 *   node scripts/record-master.js jsonapi http://192.168.1.60/ [options]
 *
 * Options:
 *   --ports 1,2,3,4      which ports to ask about (default 1-8)
 *   --user U --password P  basic auth
 *   --master N           JSON API master number (default 1)
 *   --out FILE           where to write the recording (default: recordings/<profile>-<host>-<date>.json)
 *
 * Every request is a read: nothing is written to the master or to a device.
 * The output is the raw exchange - URL, method, body sent, HTTP status, body
 * received - one entry per request, so a difference between the specification
 * and the device can be seen without the adapter's interpretation in the way.
 * Attach the file to an issue, or keep it beside the tests as a fixture.
 */

const fs = require('node:fs')
const path = require('node:path')

function parseArgs (argv) {
  const [profile, base, ...rest] = argv
  const options = { profile, base, ports: [1, 2, 3, 4, 5, 6, 7, 8], master: 1 }
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '')
    const value = rest[i + 1]
    if (key === 'ports') options.ports = value.split(',').map(Number).filter(n => n >= 1)
    else if (key === 'master') options.master = Number(value) || 1
    else options[key] = value
  }
  return options
}

const REQUESTS = {
  /** ifm IoT Core: one POST endpoint, the address in the body. */
  ifm (options) {
    const base = options.base.replace(/\/+$/, '') + '/'
    const post = adr => ({ url: base, method: 'POST', body: { code: 'request', cid: 1, adr } })
    const isdu = (port, index) => ({
      url: base,
      method: 'POST',
      body: { code: 'request', cid: 1, adr: `/iolinkmaster/port[${port}]/iolinkdevice/iolreadacyclic`, data: { index, subindex: 0 } }
    })
    const out = [
      post('/deviceinfo/productcode/getdata'),
      post('/deviceinfo/serialnumber/getdata'),
      post('/gettree')
    ]
    for (const port of options.ports) {
      for (const tail of ['mode/getdata', 'iolinkdevice/status/getdata', 'iolinkdevice/vendorid/getdata',
        'iolinkdevice/deviceid/getdata', 'iolinkdevice/productname/getdata', 'iolinkdevice/serial/getdata',
        'iolinkdevice/pdin/getdata', 'iolinkdevice/pdout/getdata']) {
        out.push(post(`/iolinkmaster/port[${port}]/${tail}`))
      }
      // The standard objects every device has: DeviceStatus, and the ones the
      // identity above comes from.
      for (const index of [16, 18, 36]) out.push(isdu(port, index))
    }
    return out
  },

  /** IO-Link Community JSON API: REST under /iolink/v1. */
  jsonapi (options) {
    let base = options.base.replace(/\/+$/, '')
    if (!/\/iolink\/v\d+$/.test(base)) base += '/iolink/v1'
    const get = p => ({ url: base + p, method: 'GET' })
    const m = options.master
    const out = [
      get('/gateway/identification'),
      get('/gateway/capabilities'),
      get('/masters'),
      get(`/masters/${m}/identification`),
      get(`/masters/${m}/capabilities`),
      get(`/masters/${m}/ports`),
      get('/devices')
    ]
    for (const port of options.ports) {
      out.push(get(`/masters/${m}/ports/${port}/status`))
      out.push(get(`/masters/${m}/ports/${port}/configuration`))
      const alias = `master${m}port${port}`
      out.push(get(`/devices/${alias}/identification`))
      out.push(get(`/devices/${alias}/processdata/getdata/value?format=byteArray`))
      out.push(get(`/devices/${alias}/processdata/setdata/value?format=byteArray`))
      for (const index of [16, 18, 36]) out.push(get(`/devices/${alias}/parameters/${index}/value?format=byteArray`))
    }
    return out
  }
}

async function record (options) {
  const plan = REQUESTS[options.profile]
  if (!plan) {
    throw new Error(`unknown profile "${options.profile}"; one of ${Object.keys(REQUESTS).join(', ')}`)
  }
  const headers = { Accept: 'application/json' }
  if (options.user) {
    headers.Authorization = 'Basic ' + Buffer.from(`${options.user}:${options.password || ''}`).toString('base64')
  }
  const entries = []
  for (const request of plan(options)) {
    const at = new Date().toISOString()
    const entry = { at, ...request }
    try {
      const res = await fetch(request.url, {
        method: request.method,
        headers: request.body ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(5000)
      })
      const text = await res.text()
      entry.status = res.status
      entry.headers = { 'content-type': res.headers.get('content-type') }
      try { entry.reply = JSON.parse(text) } catch { entry.reply = text }
    } catch (e) {
      entry.error = e.message
    }
    entries.push(entry)
    console.error(`${request.method} ${request.url}${request.body ? ' ' + request.body.adr : ''} -> ${entry.status || entry.error}`)
  }
  return entries
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  if (!options.profile || !options.base) {
    console.error('usage: record-master.js <ifm|jsonapi> <base url> [--ports 1,2] [--user U --password P] [--master N] [--out FILE]')
    process.exit(2)
  }
  const entries = await record(options)
  const host = new URL(options.base).host.replace(/[^\w.-]/g, '_')
  const file = options.out ||
    path.join('recordings', `${options.profile}-${host}-${new Date().toISOString().slice(0, 10)}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    profile: options.profile,
    base: options.base,
    recordedAt: new Date().toISOString(),
    requests: entries
  }, null, 2))
  console.error(`${entries.length} exchanges written to ${file}`)
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}

module.exports = { REQUESTS, record, parseArgs }
