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
