'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseIodd, ERROR_CODES } = require('../../lib/iodd')
const fs = require('node:fs')
const path = require('node:path')
const { demo, conditional, fixture, corpusDir } = require('./helpers')

/** A named IODD from the corpus, or a reason to skip when it was not fetched. */
const corpus = name => path.join(corpusDir, name)
const needsCorpus = name => !fs.existsSync(corpus(name)) && `needs ${name}: run \`npm run corpus\``

test('reads device identity', () => {
  const d = demo()
  assert.equal(d.identity.vendorId, 999)
  assert.equal(d.identity.deviceId, 4242)
  assert.equal(d.identity.vendorName, 'Test Instruments GmbH')
  assert.equal(d.identity.deviceName, 'Demo Temperature Sensor')
  assert.equal(d.identity.variants[0].productId, 'DEMO-100')
})

test('reads the communication profile, which sits outside ProfileBody', () => {
  const c = demo().communication
  assert.equal(c.ioLinkRevision, 'V1.1')
  assert.equal(c.bitrate, 'COM2')
  assert.equal(c.minCycleTimeUs, 2300)
  assert.equal(c.sioSupported, true)
})

test('resolves names through the external text collection', () => {
  assert.equal(demo({ language: 'de' }).identity.deviceName, 'Demo-Temperatursensor')
  assert.equal(demo({ language: 'en' }).identity.deviceName, 'Demo Temperature Sensor')
})

test('falls back per string when a translation is incomplete', () => {
  const d = demo({ language: 'de' })
  const keys = d.layout('in').items.map(i => i.key)
  assert.ok(keys.includes('Temperatur'), 'translated name is used')
  assert.ok(keys.includes('Counter'), 'untranslated name falls back to the primary language')
  assert.equal(d.language.resolved, 'de')
})

test('a region tag finds the base language table', () => {
  assert.equal(demo({ language: 'de-DE' }).identity.deviceName, 'Demo-Temperatursensor')
})

test('process data layout carries offsets, widths and types', () => {
  const layout = demo().layout('in')
  assert.equal(layout.bitLength, 32)
  assert.equal(layout.octetLength, 4)
  const byKey = Object.fromEntries(layout.items.map(i => [i.key, i]))
  assert.deepEqual(
    { o: byKey.Temperature.bitOffset, l: byKey.Temperature.bitLength, t: byKey.Temperature.type },
    { o: 16, l: 16, t: 'Integer' })
  assert.deepEqual(
    { o: byKey.Counter.bitOffset, l: byKey.Counter.bitLength, t: byKey.Counter.type },
    { o: 2, l: 14, t: 'UInteger' })
  assert.equal(byKey.SwitchingSignal1.bitLength, 1)
})

test('scaling and units come from the user interface, not the datatype', () => {
  const t = demo().layout('in').items.find(i => i.key === 'Temperature')
  assert.equal(t.gradient, 0.01)
  assert.equal(t.unitCode, 1001)
  assert.equal(t.unit, '°C')
  assert.equal(t.decimals, 2)
  // The declared range is in raw counts and must be reported scaled.
  assert.equal(t.min, -50)
  assert.equal(t.max, 150)
})

test('enum members are resolved to text', () => {
  const s = demo().layout('in').items.find(i => i.key === 'SwitchingSignal1')
  assert.deepEqual(s.values.map(v => [v.value, v.name]), [['true', 'Closed'], ['false', 'Open']])
  const de = demo({ language: 'de' }).layout('in').items.find(i => i.key === 'Schaltsignal1')
  assert.deepEqual(de.values.map(v => v.name), ['Schließer', 'Öffner'])
})

test('ISDU parameters include vendor and standard objects', () => {
  const d = demo()
  const setpoint = d.variable('V_Setpoint')
  assert.equal(setpoint.index, 100)
  assert.equal(setpoint.access, 'rw')
  assert.equal(setpoint.unit, '°C')
  assert.equal(setpoint.gradient, 0.01)

  const serial = d.variable('V_SerialNumber')
  assert.equal(serial.index, 21)
  assert.equal(serial.type, 'String')
  assert.equal(serial.access, 'ro')
  assert.equal(serial.standard, true)
})

test('parameters can be looked up by index or by name', () => {
  const d = demo()
  assert.equal(d.variable(100).id, 'V_Setpoint')
  assert.equal(d.variable('Switch point').id, 'V_Setpoint')
})

test('DatatypeRef is resolved against the datatype collection', () => {
  const polarity = demo().variable('V_Polarity')
  assert.equal(polarity.type, 'UInteger')
  assert.deepEqual(polarity.values.map(v => v.name), ['Normally open', 'Normally closed'])
})

test('events merge the specified table with vendor definitions', () => {
  const d = demo()
  const short = d.event(0x7710)
  assert.equal(short.name, 'Short circuit - Check installation')
  assert.equal(short.type, 'Error')
  assert.equal(short.standard, true)

  const vendor = d.event(0x18ff)
  assert.equal(vendor.name, 'Sensor element drift')
  assert.equal(vendor.type, 'Warning')
  assert.equal(vendor.vendorSpecific, true)
})

test('conditional process data layouts are all reported', () => {
  const d = conditional()
  assert.equal(d.variants.length, 2)
  assert.equal(d.variants[0].condition.variableId, 'V_Layout')
  assert.equal(d.variants[0].condition.index, 200)
})

test('an unselected layout is an error, not a guess', () => {
  const d = conditional()
  assert.throws(() => d.layout('in'), e => {
    assert.equal(e.code, ERROR_CODES.AMBIGUOUS_VARIANT)
    assert.match(e.message, /PD_Compact \(when V_Layout/)
    return true
  })
})

test('a layout can be selected by id or by parameter value', () => {
  assert.equal(conditional().layout('in', { variant: 'PD_Extended' }).octetLength, 4)
  assert.equal(conditional({ conditions: { V_Layout: 0 } }).layout('in').octetLength, 2)
  assert.equal(conditional().layout('in', { conditions: { V_Layout: 1 } }).octetLength, 4)
})

test('conflicting scalings are reported instead of being picked at random', () => {
  const d = conditional({ conditions: { V_Layout: 0 } })
  const t = d.layout('in').items[0]
  assert.equal(t.gradient, undefined, 'no scaling applied while the unit is unknown')
  assert.equal(t.scalingAmbiguous.length, 2)
  assert.deepEqual(t.scalingAmbiguous.map(a => a.unit), ['°C', '°F'])
  assert.match(d.warnings.join(' '), /conflicting scalings/)
})

test('supplying the deciding parameter resolves the scaling', () => {
  const c = conditional({ conditions: { V_Layout: 0, V_Unit: 0 } }).layout('in').items[0]
  assert.equal(c.unit, '°C')
  assert.equal(c.gradient, 0.1)
  const f = conditional({ conditions: { V_Layout: 0, V_Unit: 1 } }).layout('in').items[0]
  assert.equal(f.unit, '°F')
  assert.equal(f.offset, 32)
})

test('rejects input that is not an IODD', () => {
  assert.throws(() => parseIodd('<html><body/></html>'), e => e.code === ERROR_CODES.PARSE)
  assert.throws(() => parseIodd('not xml at all <<<'), e => e.code === ERROR_CODES.PARSE)
  assert.throws(() => parseIodd(42), e => e.code === ERROR_CODES.PARSE)
})

test('tolerates a UTF-8 byte order mark', () => {
  const d = parseIodd('﻿' + fixture('demo-sensor.iodd.xml'))
  assert.equal(d.identity.deviceId, 4242)
})

test('key style can be adapted for topic-friendly output', () => {
  const snake = demo({ keyStyle: 'snake' }).layout('in').items.map(i => i.key)
  assert.ok(snake.includes('switching_signal1'), snake.join(','))
  const camel = demo({ keyStyle: 'camel' }).layout('in').items.map(i => i.key)
  assert.ok(camel.includes('temperature'), camel.join(','))
})

test('scaled ranges carry no floating point noise', () => {
  const xml = fixture('demo-sensor.iodd.xml')
    .replace('gradient="0.01" offset="0" unitCode="1001" displayFormat="Dec.2"/>',
      'gradient="0.00001" offset="0" unitCode="1001"/>')
  const layout = parseIodd(xml).layout('in')
  const item = layout.items.find(i => i.key === 'Temperature')
  // The raw range -5000..15000 scaled by 0.00001 is -0.05..0.15 exactly.
  assert.equal(item.min, -0.05)
  assert.equal(item.max, 0.15)
})

test('numeric character references are decoded, markup ones stay escaped', () => {
  const xml = fixture('demo-sensor.iodd.xml')
    .replace('<Text id="TI_PD_Temperature" value="Temperature"/>',
      '<Text id="TI_PD_Temperature" value="Temperatur &#252;ber 85&#176;C &#60;max&#62; &amp; &#x41;"/>')
  const item = parseIodd(xml).layout('in').items.find(i => i.bitOffset === 16 || i.key.startsWith('Temperatur'))
  assert.equal(item.name, 'Temperatur über 85°C <max> & A')
})

test('external text documents supply translations the IODD itself lacks', () => {
  const fr = '<ExternalTextDocument xmlns="http://www.io-link.com/IODD/2010/10">' +
    '<Language xml:lang="fr"><Text id="TI_DeviceName" value="Capteur de démonstration"/></Language>' +
    '</ExternalTextDocument>'
  const d = parseIodd(fixture('demo-sensor.iodd.xml'), { language: 'fr', externalTexts: [fr] })
  assert.equal(d.identity.deviceName, 'Capteur de démonstration')
  assert.ok(d.language.available.includes('fr'))
  // Untranslated strings still fall back to the primary language.
  assert.equal(d.identity.variants[0].productId, 'DEMO-100')
})

test('an empty <Text value=""> is no description, not the textId', () => {
  const xml = fixture('demo-sensor.iodd.xml')
    .replace('<Text id="TI_PD_Temperature_Descr" value="Current process temperature"/>',
      '<Text id="TI_PD_Temperature_Descr" value=""/>')
  const item = parseIodd(xml).layout('in').items.find(i => i.key === 'Temperature')
  assert.equal(item.description, undefined)
})

test('DirectParameterOverlay is exposed as the index-1 record it describes', { skip: needsCorpus('87-5747-131XX004.xml') }, () => {
  const d = parseIodd(fs.readFileSync(corpus('87-5747-131XX004.xml'), 'utf8'))
  const v = d.variable('V_DirectParameters')
  assert.equal(v.index, 1)
  assert.equal(v.directParameterOverlay, true)
  assert.equal(v.type, 'Record')
  assert.ok(v.items.length > 0)
})

test('a scalar parameter with ambiguous scaling says so', { skip: needsCorpus('17-3344-FTW23.xml') }, () => {
  const d = parseIodd(fs.readFileSync(corpus('17-3344-FTW23.xml'), 'utf8'))
  const v = d.variable('V_uCTmp')
  assert.equal(v.scalingAmbiguous.length, 3)
  assert.equal(v.gradient, undefined)
  assert.ok(d.warnings.some(w => w.includes('µC-Temperature') && w.includes('conflicting')))
})
