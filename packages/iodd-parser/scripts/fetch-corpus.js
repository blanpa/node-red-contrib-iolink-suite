#!/usr/bin/env node
'use strict'
/**
 * Populate test/corpus/ with real vendor IODDs from IODDfinder.
 *
 *   node scripts/fetch-corpus.js [devices-per-vendor]
 *
 * The corpus is what turns the test suite from "matches my idea of an IODD"
 * into "survives what vendors actually ship". It is deliberately NOT committed:
 * IODD files are the vendors' copyrighted material, and IODDfinder's terms
 * cover downloading them for your own use, not redistribution.
 */
const fs = require('node:fs')
const path = require('node:path')
const { IoddFinder } = require('../src/finder')
const { extractIodd } = require('../src/zip')

const VENDORS = [
  'ifm electronic gmbh', 'Balluff GmbH', 'Hans TURCK GmbH & Co. KG', 'SICK AG', 'Baumer',
  'Pepperl+Fuchs', 'Festo', 'Banner Engineering Corporation', 'Leuze electronic GmbH + Co. KG',
  'wenglor sensoric GmbH', 'OMRON Corporation', 'SensoPart Industriesensorik GmbH',
  'Murrelektronik', 'Bosch Rexroth AG', 'SIEMENS AG', 'Phoenix Contact GmbH & Co. KG',
  'SMC Corporation', 'VEGA Grieshaber KG', 'WIKA Alexander Wiegand SE & Co. KG',
  'Endress+Hauser', 'MICRO-EPSILON MESSTECHNIK GmbH & Co. KG', 'autosen gmbh',
  'di-soric GmbH & Co. KG', 'Contrinex AG Industrial Electronics', 'KROHNE Messtechnik GmbH',
  'microsonic GmbH', 'Weidmüller Interface GmbH & Co. KG', 'Norgren', 'TR-Electronic GmbH',
  'Beckhoff Automation GmbH & Co. KG'
]

const outDir = path.join(__dirname, '..', 'test', 'corpus')
const perVendor = Number(process.argv[2] || 3)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main () {
  fs.mkdirSync(outDir, { recursive: true })
  const finder = new IoddFinder({ timeout: 60000 })
  const index = []
  let skipped = 0

  for (const vendorName of VENDORS) {
    let results
    try {
      ({ results } = await finder.search({ vendorName, size: 40 }))
    } catch (e) {
      console.error(`  ! search failed for ${vendorName}: ${e.message}`)
      continue
    }
    // Spread across the vendor's catalogue rather than taking the first few,
    // so the corpus covers different product families and IODD generations.
    const step = Math.max(1, Math.floor(results.length / perVendor))
    const picks = []
    for (let i = 0; i < results.length && picks.length < perVendor; i += step) picks.push(results[i])

    for (const entry of picks) {
      const file = `${entry.vendorId}-${entry.ioddId}-${sanitise(entry.productName || entry.deviceId)}.xml`
      const target = path.join(outDir, file)
      if (fs.existsSync(target)) { skipped++; index.push({ ...entry, file }); continue }
      try {
        const zip = await finder.downloadZip(entry.vendorId, entry.ioddId)
        fs.writeFileSync(target, extractIodd(zip).xml, 'utf8')
        index.push({ ...entry, file })
        console.log(`  + ${file}`)
      } catch (e) {
        console.error(`  ! ${file}: ${e.message}`)
      }
      // IODDfinder rate limits; a short pause keeps the run from being throttled.
      await sleep(1200)
    }
  }

  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1))
  console.log(`\n${index.length} IODDs in ${outDir} (${skipped} already present)`)
}

const sanitise = s => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60)

main().catch(e => { console.error(e); process.exit(1) })
