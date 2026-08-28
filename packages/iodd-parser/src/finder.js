'use strict'
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { extractIodd } = require('./zip')
const { parseIodd } = require('./index')
const { err, CODES } = require('./errors')

/**
 * Client for IODDfinder (ioddfinder.io-link.com), the IO-Link community's
 * IODD registry, plus a local cache.
 *
 * Every IO-Link device reports a vendorId and a deviceId over the wire, which
 * is enough to look its IODD up automatically. On a shop floor the internet is
 * often unavailable, so the cache is authoritative once populated and a failed
 * request falls back to it rather than to an error. IODD ZIPs can also be
 * imported by hand for devices that were never published.
 */

const BASE_URL = 'https://ioddfinder.io-link.com/api'
const DEFAULT_TIMEOUT = 15000

const defaultCacheDir = () =>
  process.env.IODD_CACHE_DIR || path.join(os.homedir(), '.cache', 'iodd-parser')

class IoddFinder {
  /**
   * @param {object} [options]
   * @param {string} [options.cacheDir]  where downloaded IODDs are kept
   * @param {string} [options.baseUrl]
   * @param {number} [options.timeout=15000] request timeout in ms
   * @param {boolean} [options.offline=false] never hit the network
   */
  constructor (options = {}) {
    this.cacheDir = options.cacheDir || defaultCacheDir()
    this.baseUrl = (options.baseUrl || BASE_URL).replace(/\/+$/, '')
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT
    this.offline = Boolean(options.offline)
    this._fetch = options.fetch || globalThis.fetch
  }

  // ---------------------------------------------------------------- network

  async _request (url, { binary = false } = {}) {
    if (this.offline) {
      throw err(CODES.PARSE, 'finder is in offline mode', { offline: true })
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    try {
      const res = await this._fetch(url, {
        signal: controller.signal,
        headers: { Accept: binary ? '*/*' : 'application/json' }
      })
      if (!res.ok) {
        throw err(CODES.PARSE, `IODDfinder returned ${res.status} ${res.statusText} for ${url}`,
          { status: res.status, url })
      }
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.json()
    } catch (e) {
      if (e.name === 'AbortError') {
        throw err(CODES.PARSE, `IODDfinder request timed out after ${this.timeout} ms`, { url })
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Search the registry.
   * Pass `{ vendorId, deviceId }` for the automatic lookup after reading a
   * device's identity, or `vendorName`/`productName` to search by hand.
   */
  async search (query = {}) {
    const params = new URLSearchParams()
    for (const key of ['vendorId', 'deviceId', 'vendorName', 'productName', 'productVariantId']) {
      if (query[key] !== undefined && query[key] !== null && query[key] !== '') {
        params.set(key, String(query[key]))
      }
    }
    params.set('page', String(query.page ?? 0))
    params.set('size', String(query.size ?? 20))
    const body = await this._request(`${this.baseUrl}/drivers?${params}`)
    return {
      total: body.totalElements,
      page: body.number,
      results: (body.content || []).map(normaliseEntry)
    }
  }

  /** Download one IODD package as a ZIP buffer. */
  async downloadZip (vendorId, ioddId) {
    return this._request(
      `${this.baseUrl}/vendors/${vendorId}/iodds/${ioddId}/files/zip/rated`,
      { binary: true })
  }

  // ------------------------------------------------------------------ cache

  _cachePath (file) { return path.join(this.cacheDir, file) }

  async _readIndex () {
    try {
      return JSON.parse(await fsp.readFile(this._cachePath('index.json'), 'utf8'))
    } catch {
      return []
    }
  }

  async _writeIndex (entries) {
    await fsp.mkdir(this.cacheDir, { recursive: true })
    await fsp.writeFile(this._cachePath('index.json'), JSON.stringify(entries, null, 1))
  }

  /** Everything currently cached. */
  async list () {
    return this._readIndex()
  }

  /** Find a cached IODD for a device. */
  async findCached (vendorId, deviceId) {
    const index = await this._readIndex()
    const hits = index.filter(e =>
      Number(e.vendorId) === Number(vendorId) && Number(e.deviceId) === Number(deviceId))
    return pickBest(hits)
  }

  /** Store an IODD XML in the cache. */
  async store (xml, meta) {
    await fsp.mkdir(this.cacheDir, { recursive: true })
    const file = `${meta.vendorId}-${meta.deviceId}-${meta.ioddId ?? 'local'}.xml`
    await fsp.writeFile(this._cachePath(file), xml, 'utf8')
    const index = await this._readIndex()
    const entry = { ...meta, file, cachedAt: new Date().toISOString() }
    const next = index.filter(e => e.file !== file).concat(entry)
    await this._writeIndex(next)
    return entry
  }

  /** Read a cached IODD's XML. */
  async readCached (entry) {
    return fsp.readFile(this._cachePath(entry.file), 'utf8')
  }

  /**
   * Import an IODD ZIP the user supplied by hand - the shop-floor path for
   * devices IODDfinder does not carry, and the offline path in general.
   * `input` is a ZIP buffer, a path to a .zip, or raw IODD XML.
   */
  async importPackage (input, extra = {}) {
    let xml
    if (typeof input === 'string' && !input.trimStart().startsWith('<')) {
      input = await fsp.readFile(input)
    }
    if (Buffer.isBuffer(input) && input.length > 1 && input[0] === 0x50 && input[1] === 0x4b) {
      xml = extractIodd(input).xml
    } else {
      xml = Buffer.isBuffer(input) ? input.toString('utf8') : String(input)
    }
    const device = parseIodd(xml)
    const entry = await this.store(xml, {
      vendorId: device.identity.vendorId,
      deviceId: device.identity.deviceId,
      vendorName: device.identity.vendorName,
      productName: (device.identity.variants[0] || {}).productId || device.identity.deviceName,
      ioddId: extra.ioddId,
      source: extra.source || 'import'
    })
    return { entry, device }
  }

  // ------------------------------------------------------------------ combined

  /**
   * Get the IODD for a device, cache first.
   *
   * @param {object} id `{ vendorId, deviceId }` as reported by the device
   * @param {object} [options]
   * @param {boolean} [options.refresh=false] ignore the cache and re-download
   * @param {object}  [options.parse] options forwarded to `parseIodd`
   * @returns {{device: IoddDevice, entry: object, source: 'cache'|'network'}}
   */
  async load (id, options = {}) {
    const { vendorId, deviceId } = id
    if (vendorId === undefined || deviceId === undefined) {
      throw err(CODES.BROKEN_REF, 'need both vendorId and deviceId to look up an IODD')
    }

    if (!options.refresh) {
      const cached = await this.findCached(vendorId, deviceId)
      if (cached) {
        const xml = await this.readCached(cached)
        return { device: parseIodd(xml, options.parse), entry: cached, source: 'cache' }
      }
    }

    let networkError
    try {
      const { results } = await this.search({ vendorId, deviceId, size: 20 })
      const best = pickBest(results)
      if (!best) {
        throw err(CODES.BROKEN_REF,
          `IODDfinder has no IODD for vendorId ${vendorId}, deviceId ${deviceId}. ` +
          'Import the vendor\'s IODD ZIP instead.',
          { vendorId, deviceId })
      }
      const zip = await this.downloadZip(best.vendorId, best.ioddId)
      const { xml } = extractIodd(zip)
      const device = parseIodd(xml, options.parse)
      const entry = await this.store(xml, { ...best, source: 'ioddfinder' })
      return { device, entry, source: 'network' }
    } catch (e) {
      networkError = e
    }

    // The shop floor is offline more often than not; a stale cache entry beats
    // no reading at all, so fall back even when refresh was requested.
    const cached = await this.findCached(vendorId, deviceId)
    if (cached) {
      const xml = await this.readCached(cached)
      return {
        device: parseIodd(xml, options.parse),
        entry: cached,
        source: 'cache',
        staleReason: networkError.message
      }
    }
    throw networkError
  }
}

/** Prefer approved entries, then the most recently uploaded. */
function pickBest (entries) {
  if (!entries || !entries.length) return null
  const score = e => (e.status === 'APPROVED' ? 1 : 0)
  return [...entries].sort((a, b) =>
    score(b) - score(a) ||
    (b.uploadDate ?? 0) - (a.uploadDate ?? 0) ||
    (b.ioddId ?? 0) - (a.ioddId ?? 0))[0]
}

function normaliseEntry (c) {
  return {
    vendorId: c.vendorId,
    deviceId: c.deviceId,
    ioddId: c.ioddId,
    vendorName: c.vendorName,
    productName: c.productName,
    productId: c.productId,
    version: c.versionString,
    ioLinkRevision: c.ioLinkRev,
    status: c.ioddStatus,
    uploadDate: c.uploadDate,
    driverName: c.driverName,
    hasMoreVersions: c.hasMoreVersions
  }
}

module.exports = { IoddFinder, defaultCacheDir }
