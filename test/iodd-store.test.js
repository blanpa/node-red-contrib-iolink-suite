'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { IoddStore } = require('../lib/iodd-store')

const FIXTURES = path.join(__dirname, 'fixtures')
const DEMO = path.join(FIXTURES, 'demo-sensor.iodd.xml')

const store = (opts = {}) => new IoddStore({ localDir: FIXTURES, offline: true, ...opts })

test('a local IODD is found by its content, not its filename', async () => {
  const { device, source } = await store().device(999, 4242)
  assert.equal(source, 'file')
  assert.equal(device.identity.vendorName, 'Test Instruments GmbH')
})

test('the identity may arrive as a string, as masters report it', async () => {
  const { device } = await store().device('999', '4242')
  assert.equal(device.identity.deviceId, 4242)
})

test('a second look-up is served from memory, not re-parsed', async () => {
  const s = store()
  const first = await s.device(999, 4242)
  const second = await s.device(999, 4242)
  assert.equal(second.source, 'memory')
  assert.equal(second.device, first.device, 'the same parsed device should be handed out')
})

test('options that change the result get their own cache entry', async () => {
  const s = store()
  const en = await s.device(999, 4242, { language: 'en' })
  const de = await s.device(999, 4242, { language: 'de' })
  assert.notEqual(de.device, en.device)
  assert.equal(en.device.identity.deviceName, 'Demo Temperature Sensor')
  assert.equal(de.device.identity.deviceName, 'Demo-Temperatursensor')
})

test('clearing the store forces a re-read, e.g. after a new IODD is dropped in', async () => {
  const s = store()
  await s.device(999, 4242)
  s.clear()
  assert.equal((await s.device(999, 4242)).source, 'file')
})

test('an unknown device is not silently answered with the wrong IODD', async () => {
  // Offline, with no matching file: the look-up must fail rather than hand
  // back the one IODD that happens to be in the folder.
  const e = await store().device(1, 2).catch(e => e)
  assert.ok(e instanceof Error)
  assert.notEqual(e.message, '')
})

test('a folder full of junk does not stop the search', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iodd-store-'))
  try {
    fs.writeFileSync(path.join(dir, 'broken.xml'), '<not-an-iodd/>')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me')
    fs.copyFileSync(DEMO, path.join(dir, 'zzz-real.xml'))
    const { device, source } = await store({ localDir: dir }).device(999, 4242)
    assert.equal(source, 'file')
    assert.equal(device.identity.deviceId, 4242)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing local folder is not an error, just no local hit', async () => {
  const s = new IoddStore({ localDir: '/nonexistent/iodd/folder', offline: true })
  const e = await s.device(999, 4242).catch(e => e)
  // It falls through to the finder, which is offline and has nothing cached.
  assert.ok(e instanceof Error)
})

test('fromFile parses an IODD directly, bypassing the registry', async () => {
  const device = await store().fromFile(DEMO)
  assert.equal(device.identity.vendorId, 999)
  assert.equal(device.layout('in').octetLength, 4)
})

/**
 * What follows is about a plant that runs for weeks, not about correctness of
 * a single call: the store is asked for an IODD on every read of every port, so
 * what it does on a miss decides how much traffic a flow generates.
 */

test('a lookup already running is shared rather than repeated', async () => {
  // Four read nodes deploying at once all poll immediately. Without this they
  // each download the same IODD from IODDfinder separately.
  const s = store({ localDir: null })
  let downloads = 0
  s.finder.load = async () => {
    downloads++
    await new Promise(resolve => setTimeout(resolve, 20))
    return { device: { identity: { vendorId: 1, deviceId: 2 } }, source: 'network' }
  }

  const results = await Promise.all([1, 2, 3, 4].map(() => s.device(1, 2)))
  assert.equal(downloads, 1, 'one device, one download')
  for (const r of results) {
    assert.equal(r.device, results[0].device)
    assert.equal(r.source, 'network', 'sharing a download still reports where it came from')
  }
  assert.equal((await s.device(1, 2)).source, 'memory')
})

test('a device with no findable IODD is not looked for again straight away', async () => {
  // The case that matters: one unpublished device on a rack polled every
  // second used to mean one request to IODDfinder every second, for ever.
  const s = store({ localDir: null, retryAfter: 60000 })
  let attempts = 0
  s.finder.load = async () => {
    attempts++
    throw Object.assign(new Error('no IODD for this device'), { code: 'IODD_NOT_FOUND' })
  }

  for (let i = 0; i < 5; i++) {
    await assert.rejects(s.device(7, 8), /no IODD for this device/)
  }
  assert.equal(attempts, 1, 'the failure should be remembered, not repeated')
})

test('the memory of a failure runs out, so a device is picked up eventually', async () => {
  const s = store({ localDir: null, retryAfter: 0 })
  let attempts = 0
  s.finder.load = async () => {
    attempts++
    throw new Error('not yet')
  }
  await assert.rejects(s.device(7, 8))
  await assert.rejects(s.device(7, 8))
  assert.equal(attempts, 2)
})

test('clearing the store forgets failures too', async () => {
  // The way back for someone who has just dropped the missing IODD into the
  // folder: redeploy, which closes the master node, which clears the store.
  const s = store({ localDir: null, retryAfter: 60000 })
  let attempts = 0
  s.finder.load = async () => { attempts++; throw new Error('not there') }

  await assert.rejects(s.device(7, 8))
  await assert.rejects(s.device(7, 8))
  assert.equal(attempts, 1)
  s.clear()
  await assert.rejects(s.device(7, 8))
  assert.equal(attempts, 2)
})

test('a folder of IODDs is parsed once, not once per device on the rack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iodd-dir-'))
  try {
    fs.copyFileSync(DEMO, path.join(dir, 'a.xml'))
    fs.copyFileSync(path.join(FIXTURES, 'conditional-sensor.iodd.xml'), path.join(dir, 'b.xml'))

    const s = new IoddStore({ localDir: dir, offline: true, retryAfter: 0 })
    let reads = 0
    const readFile = fs.promises.readFile
    // Only the folder: the finder reads its own cache index either way, and
    // counting that would say nothing about parsing the IODDs.
    fs.promises.readFile = (file, ...rest) => {
      if (String(file).startsWith(dir)) reads++
      return readFile(file, ...rest)
    }
    try {
      // Eight ports of devices that are not in the folder: without an index,
      // every one of them re-parses every file before giving up.
      for (let port = 0; port < 8; port++) {
        await assert.rejects(s.device(100 + port, 1))
      }
    } finally {
      fs.promises.readFile = readFile
    }
    assert.equal(reads, 2, 'each file should be read and parsed once')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an IODD edited in the folder is picked up again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iodd-dir-'))
  try {
    const file = path.join(dir, 'sensor.xml')
    fs.copyFileSync(path.join(FIXTURES, 'conditional-sensor.iodd.xml'), file)
    const s = new IoddStore({ localDir: dir, offline: true, retryAfter: 0 })
    await assert.rejects(s.device(999, 4242), 'not this device yet')

    // Replace it with a different device and give it a newer mtime: the index
    // must not go on believing what the old file said.
    fs.writeFileSync(file, fs.readFileSync(DEMO))
    const later = new Date(Date.now() + 2000)
    fs.utimesSync(file, later, later)

    const { device, source } = await s.device(999, 4242)
    assert.equal(source, 'file')
    assert.equal(device.identity.deviceId, 4242)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
