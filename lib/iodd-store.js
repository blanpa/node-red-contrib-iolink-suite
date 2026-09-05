'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { parseIodd } = require('./iodd')
const { IoddFinder } = require('./iodd/finder')

/** How long a device with no findable IODD is left alone before trying again. */
const DEFAULT_RETRY_AFTER = 60000

/**
 * Holds the IODDs a master's ports need.
 *
 * A flow reading four ports every second must not re-parse four XML files every
 * second, so parsed devices are kept in memory keyed by vendorId/deviceId plus
 * the options that affect the result. Files on disk win over IODDfinder: a plant
 * that has pinned a specific IODD should keep using it.
 *
 * What is cached is the *lookup*, not just its result, and a failed lookup is
 * remembered too. Both matter on a running plant rather than in a test: without
 * the first, every read node deploying at once downloads the same IODD
 * separately; without the second, one device whose IODD was never published
 * sends a request to IODDfinder on every single poll, for as long as the flow
 * runs.
 */
class IoddStore {
  constructor (options = {}) {
    this.finder = new IoddFinder({
      cacheDir: options.cacheDir,
      offline: options.offline,
      timeout: options.timeout
    })
    this.localDir = options.localDir || null
    this.retryAfter = options.retryAfter ?? DEFAULT_RETRY_AFTER
    this.cache = new Map()
    this.failures = new Map()
    this.localIndex = new Map()
  }

  _key (vendorId, deviceId, opts) {
    return [vendorId, deviceId, opts.language || 'en', opts.keyStyle || 'preserve',
      JSON.stringify(opts.conditions || {})].join('|')
  }

  /**
   * Forget everything, including which devices could not be resolved.
   *
   * This is the way back for someone who has just dropped the missing IODD into
   * the folder: redeploying the flow closes the master node, which clears the
   * store, and the next read looks again straight away.
   */
  clear () {
    this.cache.clear()
    this.failures.clear()
    this.localIndex.clear()
  }

  /** Load an IODD straight from a file, bypassing the registry. */
  async fromFile (file, parseOptions = {}) {
    const xml = await fs.promises.readFile(file, 'utf8')
    return parseIodd(xml, parseOptions)
  }

  /**
   * Look in `localDir` for an IODD matching the device.
   * Matching is by content, not by filename, since vendors name files freely.
   *
   * Which file holds which device is remembered per file and mtime, so a folder
   * of twenty IODDs is parsed once rather than once per device on the rack. A
   * file that is edited or replaced has a new mtime and is read again.
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
      const file = path.join(this.localDir, name)
      try {
        const { mtimeMs } = await fs.promises.stat(file)
        const known = this.localIndex.get(file)
        if (known && known.mtimeMs === mtimeMs) {
          if (known.vendorId !== Number(vendorId) || known.deviceId !== Number(deviceId)) continue
        }
        const device = parseIodd(await fs.promises.readFile(file, 'utf8'), parseOptions)
        this.localIndex.set(file, {
          mtimeMs,
          vendorId: device.identity.vendorId,
          deviceId: device.identity.deviceId
        })
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

  async _load (vendorId, deviceId, parseOptions) {
    const local = await this._fromLocalDir(vendorId, deviceId, parseOptions)
    if (local) return { device: local, source: 'file' }
    return this.finder.load({ vendorId, deviceId }, { parse: parseOptions })
  }

  /**
   * Get the parsed IODD for a device.
   * @returns {{device: object, source: 'memory'|'file'|'cache'|'network'}}
   */
  async device (vendorId, deviceId, parseOptions = {}) {
    const key = this._key(vendorId, deviceId, parseOptions)

    const hit = this.cache.get(key)
    if (hit) {
      // Callers that arrive while the lookup is still running share it and are
      // told where it really came from; later ones are answered from memory.
      const shared = !hit.settled
      return { device: await hit.promise, source: shared ? hit.source : 'memory' }
    }

    const failure = this.failures.get(key)
    if (failure && Date.now() - failure.at < this.retryAfter) throw failure.error

    const entry = { settled: false, source: 'memory' }
    entry.promise = this._load(vendorId, deviceId, parseOptions).then(
      result => {
        entry.source = result.source
        entry.settled = true
        return result.device
      },
      error => {
        // Nothing to remember but the failure itself: keeping the rejected
        // promise in the cache would hand the same error to every later read
        // with no way back once the IODD does turn up.
        this.cache.delete(key)
        this.failures.set(key, { at: Date.now(), error })
        throw error
      })

    this.cache.set(key, entry)
    return { device: await entry.promise, source: entry.source }
  }
}

module.exports = { IoddStore, DEFAULT_RETRY_AFTER }
