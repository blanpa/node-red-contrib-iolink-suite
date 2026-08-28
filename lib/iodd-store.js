'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { parseIodd } = require('./iodd')
const { IoddFinder } = require('./iodd/finder')

/**
 * Holds the IODDs a master's ports need.
 *
 * A flow reading four ports every second must not re-parse four XML files every
 * second, so parsed devices are kept in memory keyed by vendorId/deviceId plus
 * the options that affect the result. Files on disk win over IODDfinder: a plant
 * that has pinned a specific IODD should keep using it.
 */
class IoddStore {
  constructor (options = {}) {
    this.finder = new IoddFinder({
      cacheDir: options.cacheDir,
      offline: options.offline,
      timeout: options.timeout
    })
    this.localDir = options.localDir || null
    this.cache = new Map()
  }

  _key (vendorId, deviceId, opts) {
    return [vendorId, deviceId, opts.language || 'en', opts.keyStyle || 'preserve',
      JSON.stringify(opts.conditions || {})].join('|')
  }

  /** Forget everything, e.g. after the user drops in a new IODD. */
  clear () { this.cache.clear() }

  /** Load an IODD straight from a file, bypassing the registry. */
  async fromFile (file, parseOptions = {}) {
    const xml = await fs.promises.readFile(file, 'utf8')
    return parseIodd(xml, parseOptions)
  }

  /**
   * Look in `localDir` for an IODD matching the device.
   * Matching is by content, not by filename, since vendors name files freely.
   */
  async _fromLocalDir (vendorId, deviceId, parseOptions) {
    if (!this.localDir) return null
    let entries
    try {
      entries = await fs.promises.readdir(this.localDir)
    } catch {
      return null
    }
    for (const name of entries.filter(n => n.toLowerCase().endsWith('.xml'))) {
      try {
        const device = parseIodd(
          await fs.promises.readFile(path.join(this.localDir, name), 'utf8'), parseOptions)
        if (device.identity.vendorId === Number(vendorId) &&
            device.identity.deviceId === Number(deviceId)) {
          return device
        }
      } catch {
        // A stray or broken XML in the folder must not stop the search.
      }
    }
    return null
  }

  /**
   * Get the parsed IODD for a device.
   * @returns {{device: object, source: 'memory'|'file'|'cache'|'network'}}
   */
  async device (vendorId, deviceId, parseOptions = {}) {
    const key = this._key(vendorId, deviceId, parseOptions)
    const hit = this.cache.get(key)
    if (hit) return { device: hit, source: 'memory' }

    const local = await this._fromLocalDir(vendorId, deviceId, parseOptions)
    if (local) {
      this.cache.set(key, local)
      return { device: local, source: 'file' }
    }

    const { device, source } = await this.finder.load(
      { vendorId, deviceId }, { parse: parseOptions })
    this.cache.set(key, device)
    return { device, source }
  }
}

module.exports = { IoddStore }
