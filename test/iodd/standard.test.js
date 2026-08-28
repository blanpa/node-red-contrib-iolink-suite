'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  lookupEvent, decodeEventQualifier, decodeDetailedDeviceStatus,
  encodeEventQualifier, encodeDetailedDeviceStatus, DEVICE_STATUS
} = require('../../lib/iodd')

/**
 * The device diagnosis objects. These are the same for every IO-Link device by
 * specification, which is exactly what makes them worth decoding here: a master
 * that can read an ISDU can report device health without a vendor API.
 */

test('an event qualifier splits into mode, type, source and instance', () => {
  // 0xE4 = 11 10 0 100: appears, warning, from the device, application instance.
  assert.deepEqual(decodeEventQualifier(0xE4), {
    qualifier: 0xE4,
    mode: 'appears',
    type: 'Warning',
    source: 'device',
    instance: 'application'
  })
  // 0x74 = 01 11 0 100: single shot, error.
  const single = decodeEventQualifier(0x74)
  assert.equal(single.mode, 'single shot')
  assert.equal(single.type, 'Error')
  // The raw octet is always reported, so an unconventional device is still
  // readable even where the resolved fields come out empty.
  assert.equal(decodeEventQualifier(0x00).qualifier, 0)
  assert.equal(decodeEventQualifier(0x00).mode, undefined)
})

test('DetailedDeviceStatus decodes to resolved events', () => {
  const events = decodeDetailedDeviceStatus('E48C40' + 'D45111')
  assert.equal(events.length, 2)
  assert.deepEqual(
    { hex: events[0].hex, name: events[0].name, type: events[0].type, mode: events[0].mode },
    {
      hex: '0x8C40',
      name: 'Maintenance required - Cleaning',
      type: 'Warning',
      mode: 'appears'
    })
  // 0xD4 = 11 01 0 100: appears, notification.
  assert.equal(events[1].hex, '0x5111')
  assert.equal(events[1].name, 'Primary supply voltage underrun - Check tolerance')
})

test('empty slots are dropped, not reported as event 0', () => {
  // A device declares a fixed number of slots and fills as many as it needs.
  assert.deepEqual(decodeDetailedDeviceStatus('E48C40' + '000000' + '000000'),
    decodeDetailedDeviceStatus('E48C40'))
  assert.deepEqual(decodeDetailedDeviceStatus('000000000000'), [])
  assert.deepEqual(decodeDetailedDeviceStatus(''), [])
})

test('a trailing partial entry is ignored rather than guessed at', () => {
  const events = decodeDetailedDeviceStatus('E48C40' + 'D4')
  assert.equal(events.length, 1)
})

test('buffers and byte arrays are accepted like hex', () => {
  const hex = decodeDetailedDeviceStatus('E48C40')
  assert.deepEqual(decodeDetailedDeviceStatus(Buffer.from([0xE4, 0x8C, 0x40])), hex)
  assert.deepEqual(decodeDetailedDeviceStatus([0xE4, 0x8C, 0x40]), hex)
})

test('a vendor specific event code is marked, not invented', () => {
  const [event] = decodeDetailedDeviceStatus('E4' + '1850')
  assert.equal(event.vendorSpecific, true)
  assert.equal(event.name, undefined)
  assert.equal(event.hex, '0x1850')
})

test('DeviceStatus values carry the specified wording', () => {
  assert.equal(DEVICE_STATUS[0], 'Device is OK')
  assert.equal(DEVICE_STATUS[4], 'Failure')
  assert.equal(lookupEvent(0x8C40).deviceStatus, 1) // "maintenance required"
})

// ------------------------------------------------- building the same objects

test('an event qualifier survives a round trip', () => {
  const qualifier = { mode: 'appears', type: 'Warning', source: 'device', instance: 'application' }
  const raw = encodeEventQualifier(qualifier)
  assert.equal(raw, 0xE4)
  const { qualifier: _raw, ...back } = decodeEventQualifier(raw)
  assert.deepEqual(back, qualifier)
})

test('an event takes the type the specification gives its code', () => {
  // 0x8C40 is a warning in Table D.1; nobody should have to restate that.
  const [event] = decodeDetailedDeviceStatus(encodeDetailedDeviceStatus(['0x8C40']))
  assert.equal(event.type, 'Warning')
  assert.equal(event.mode, 'appears')
  assert.equal(event.hex, '0x8C40')
})

test('a device status object is built the way a device would report it', () => {
  const raw = encodeDetailedDeviceStatus(
    [0x8C40, { code: '0x5111', mode: 'disappears' }, '0x5101'], { slots: 5 })
  assert.equal(raw.length, 15, 'five three-octet slots, two of them empty')
  const events = decodeDetailedDeviceStatus(raw)
  assert.equal(events.length, 3, 'the empty slots come back dropped')
  assert.equal(events[1].mode, 'disappears')
  // Each code keeps the type Table D.1 gives it: a supply voltage underrun is
  // a warning, a blown fuse is an error.
  assert.equal(events[1].type, 'Warning')
  assert.equal(events[2].type, 'Error')
})

test('something that is not an EventCode is refused, not rounded', () => {
  assert.throws(() => encodeDetailedDeviceStatus(['nope']), /not an EventCode/)
  assert.throws(() => encodeDetailedDeviceStatus([0x10000]), /not an EventCode/)
})
