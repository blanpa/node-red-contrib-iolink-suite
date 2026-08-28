'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { requestJson, MasterError } = require('../lib/http')

/** Spin up a one-off server that answers however the test wants. */
async function serve (handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  return { url, close: () => new Promise(r => server.close(r)) }
}

test('sends JSON and returns the parsed reply', async () => {
  let seen = null
  const s = await serve((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      seen = { method: req.method, contentType: req.headers['content-type'], body: JSON.parse(body) }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 200, data: { value: '00FF' } }))
    })
  })
  try {
    const reply = await requestJson(s.url, { body: { code: 'request', cid: 1 } })
    assert.deepEqual(reply, { code: 200, data: { value: '00FF' } })
    assert.equal(seen.method, 'POST')
    assert.equal(seen.contentType, 'application/json')
    assert.equal(seen.body.cid, 1)
  } finally { await s.close() }
})

test('a GET carries no body and no Content-Type', async () => {
  let contentType = 'unset'
  const s = await serve((req, res) => {
    contentType = req.headers['content-type']
    res.end('{"value":"01"}')
  })
  try {
    await requestJson(s.url, { method: 'GET' })
    assert.equal(contentType, undefined)
  } finally { await s.close() }
})

test('an empty body is an empty object, not a parse error', async () => {
  const s = await serve((_req, res) => res.end(''))
  try {
    assert.deepEqual(await requestJson(s.url), {})
  } finally { await s.close() }
})

test('a slow master aborts at the timeout instead of hanging the flow', async () => {
  // No response is ever written: without the timeout this test would never end.
  const s = await serve(() => {})
  try {
    const e = await requestJson(s.url, { timeout: 120 }).catch(e => e)
    assert.ok(e instanceof MasterError)
    assert.match(e.message, /no reply from .* within 120 ms/)
    assert.equal(e.timeout, 120)
  } finally { await s.close() }
})

test('an HTML error page is reported as such, not as a JSON crash', async () => {
  const s = await serve((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/html' })
    res.end('<html><body>Internal Server Error</body></html>')
  })
  try {
    const e = await requestJson(s.url).catch(e => e)
    assert.ok(e instanceof MasterError)
    assert.match(e.message, /non-JSON body/)
    assert.equal(e.status, 500)
  } finally { await s.close() }
})

test('an HTTP error status with a JSON body is reported with the status', async () => {
  const s = await serve((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end('{"error":"unauthorized"}')
  })
  try {
    const e = await requestJson(s.url).catch(e => e)
    assert.match(e.message, /HTTP 401/)
    assert.deepEqual(e.body, { error: 'unauthorized' })
  } finally { await s.close() }
})

test('a refused connection names the URL it could not reach', async () => {
  // Port 1 on loopback: nothing listens there, and binding it needs root.
  const e = await requestJson('http://127.0.0.1:1/', { timeout: 2000 }).catch(e => e)
  assert.ok(e instanceof MasterError)
  assert.match(e.message, /cannot reach http:\/\/127\.0\.0\.1:1\//)
})

test('basic auth is sent when credentials are configured', async () => {
  let auth = null
  const s = await serve((req, res) => { auth = req.headers.authorization; res.end('{}') })
  try {
    await requestJson(s.url, { auth: { user: 'admin', password: 's3cret' } })
    assert.equal(auth, 'Basic ' + Buffer.from('admin:s3cret').toString('base64'))
  } finally { await s.close() }
})

test('a user without a password still produces a valid header', async () => {
  let auth = null
  const s = await serve((req, res) => { auth = req.headers.authorization; res.end('{}') })
  try {
    await requestJson(s.url, { auth: { user: 'admin' } })
    assert.equal(auth, 'Basic ' + Buffer.from('admin:').toString('base64'))
  } finally { await s.close() }
})
