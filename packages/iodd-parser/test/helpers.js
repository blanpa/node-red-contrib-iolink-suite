'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { parseIodd } = require('../src')

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const demo = opts => parseIodd(fixture('demo-sensor.iodd.xml'), opts)
const conditional = opts => parseIodd(fixture('conditional-sensor.iodd.xml'), opts)

/** Directory holding real vendor IODDs, populated by `npm run corpus`. */
const corpusDir = path.join(__dirname, 'corpus')
const corpusFiles = () => {
  try {
    return fs.readdirSync(corpusDir).filter(f => f.endsWith('.xml')).map(f => path.join(corpusDir, f))
  } catch {
    return []
  }
}

module.exports = { fixture, demo, conditional, corpusDir, corpusFiles }
