'use strict'
const path = require('node:path')
const { EventEmitter } = require('node:events')

/**
 * A miniature Node-RED runtime.
 *
 * The nodes only touch a small, well-defined slice of the real runtime, so the
 * unit tests run against a stub of exactly that slice: no editor, no flow file,
 * no HTTP server, and a test suite that starts in milliseconds. Whether the
 * nodes also register and run inside the *real* runtime is answered by the
 * Node-RED integration test, which loads them in the official Docker image.
 */

/**
 * Written as a plain constructor function, not a class: the runtime applies
 * `createNode` to an object the node module already created, and a class
 * constructor cannot be called that way.
 */
function FakeNode (config = {}) {
  EventEmitter.call(this)
  Object.assign(this, config)
  this.id = config.id || `n${Math.random().toString(36).slice(2)}`
  this.type = config.type
  this.statuses = []
  this.errors = []
  this.warnings = []
  this.sent = []
}

FakeNode.prototype = Object.create(EventEmitter.prototype)
FakeNode.prototype.constructor = FakeNode

Object.assign(FakeNode.prototype, {
  status (s) { this.statuses.push(s) },
  error (e, msg) { this.errors.push({ error: e, msg }) },
  warn (w) { this.warnings.push(w) },
  log () {},
  trace () {},
  debug () {},
  send (msg) { this.sent.push(msg) },

  /**
   * Deliver a message the way the runtime does, and resolve once the node
   * calls done() - so a test never has to guess at a timeout.
   */
  receive (msg = {}) {
    return new Promise((resolve, reject) => {
      const sent = []
      const send = m => { if (m !== undefined && m !== null) sent.push(m) }
      const done = err => (err ? reject(err) : resolve(sent))
      const handlers = this.listeners('input')
      if (!handlers.length) return reject(new Error('node has no input handler'))
      handlers[0].call(this, msg, send, done)
    })
  },

  /** Like receive(), but for the error path: resolves with the error. */
  receiveExpectingError (msg = {}) {
    return this.receive(msg).then(
      sent => { throw new Error(`expected a failure, but the node sent ${JSON.stringify(sent)}`) },
      err => err)
  },

  close () {
    return new Promise(resolve => {
      const handlers = this.listeners('close')
      if (!handlers.length) return resolve()
      handlers[0].call(this, resolve)
    })
  }
})

/** Last status the node reported, which is what the editor would show. */
Object.defineProperty(FakeNode.prototype, 'lastStatus', {
  get () { return this.statuses[this.statuses.length - 1] }
})

function makeRED () {
  const types = new Map()
  const instances = new Map()
  const adminRoutes = []

  const RED = {
    nodes: {
      createNode (node, config) {
        FakeNode.call(node, config)
        node.credentials = config.credentials || {}
        instances.set(node.id, node)
      },
      registerType (name, ctor, opts) { types.set(name, { ctor, opts }) },
      getNode (id) { return instances.get(id) || null }
    },
    util: {
      /** Only the property types the nodes actually use. */
      evaluateNodeProperty (value, type, node, msg) {
        switch (type) {
          case 'msg': return value.split('.').reduce((a, k) => (a == null ? a : a[k]), msg)
          case 'num': return Number(value)
          case 'json': return JSON.parse(value)
          case 'flow':
          case 'global': return undefined
          default: return value
        }
      }
    },
    auth: { needsPermission: () => (_req, _res, next) => next && next() },
    httpAdmin: {
      get (route, _permission, handler) { adminRoutes.push({ method: 'GET', route, handler }) },
      post (route, _permission, handler) { adminRoutes.push({ method: 'POST', route, handler }) }
    },
    // test-only handles
    _types: types,
    _instances: instances,
    _routes: adminRoutes
  }

  /** Instantiate a registered node type, the way a deployed flow would. */
  RED.create = (type, config = {}) => {
    const entry = types.get(type)
    if (!entry) throw new Error(`node type "${type}" was never registered`)
    const node = Object.create(FakeNode.prototype)
    entry.ctor.call(node, { id: config.id || `${type}-1`, type, ...config })
    return node
  }

  /** Call an httpAdmin route registered by the master node. */
  RED.callRoute = async (method, route, params = {}, query = {}) => {
    const hit = adminRoutes.find(r => r.method === method && r.route === route)
    if (!hit) throw new Error(`no ${method} route ${route}; have ${adminRoutes.map(r => r.route)}`)
    let status = 200
    let body
    const res = {
      status (code) { status = code; return res },
      json (payload) { body = payload; return res }
    }
    await hit.handler({ params, query }, res)
    return { status, body }
  }

  return RED
}

/** Load a node module against a fresh fake runtime. */
function loadNodes (...files) {
  const RED = makeRED()
  for (const file of files) {
    delete require.cache[require.resolve(path.join('..', 'nodes', file))]
    require(path.join('..', 'nodes', file))(RED)
  }
  return RED
}

const fixture = name => path.join(__dirname, 'fixtures', name)
const DEMO_IODD = fixture('demo-sensor.iodd.xml')

/**
 * Stand-in for a configured iolink-master config node.
 *
 * The runtime nodes want `.adapter`, `.iodd` and `.parseOptions()`; giving them
 * exactly that keeps the tests focused on the node's own logic.
 */
function fakeMasterNode (adapter, store) {
  const { IoddStore } = require('../lib/iodd-store')
  return {
    id: 'master-1',
    type: 'iolink-master',
    adapter,
    iodd: store || new IoddStore({ localDir: path.join(__dirname, 'fixtures'), offline: true }),
    parseOptions: () => ({ language: 'en', keyStyle: 'preserve' })
  }
}

/** Wire a fake master into a runtime so `RED.nodes.getNode('master-1')` finds it. */
function withMaster (RED, adapter, store) {
  const master = fakeMasterNode(adapter, store)
  RED._instances.set(master.id, master)
  return master
}

module.exports = { FakeNode, makeRED, loadNodes, fixture, DEMO_IODD, fakeMasterNode, withMaster }
