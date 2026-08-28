'use strict'

/**
 * Small HTTP helper shared by the master adapters.
 *
 * Node-RED flows fire on timers, so a request that hangs is worse than one that
 * fails: every adapter call is bounded by a timeout and reports the master's
 * own status text when it can.
 */

class MasterError extends Error {
  constructor (message, details = {}) {
    super(message)
    this.name = 'MasterError'
    Object.assign(this, details)
  }
}

async function requestJson (url, { method = 'POST', body, headers = {}, timeout = 5000, auth, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const finalHeaders = { Accept: 'application/json', ...headers }
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json'
  if (auth && auth.user) {
    finalHeaders.Authorization =
      'Basic ' + Buffer.from(`${auth.user}:${auth.password || ''}`).toString('base64')
  }

  let res
  try {
    res = await doFetch(url, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new MasterError(`no reply from ${url} within ${timeout} ms`, { url, timeout })
    }
    throw new MasterError(`cannot reach ${url}: ${e.message}`, { url, cause: e })
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new MasterError(
      `${url} returned ${res.status} with a non-JSON body: ${text.slice(0, 120)}`,
      { url, status: res.status })
  }
  if (!res.ok) {
    throw new MasterError(`${url} returned HTTP ${res.status} ${res.statusText}`,
      { url, status: res.status, body: json })
  }
  return json
}

module.exports = { requestJson, MasterError }
