'use strict'
const { fail } = require('../lib/runtime')
const { lookupEvent, DEVICE_STATUS } = require('iodd-parser')

module.exports = function (RED) {
  /**
   * Watch port status and diagnosis.
   *
   * Masters differ in whether they can push events, so this polls port status
   * and emits a message only when something changes: a device appearing or
   * disappearing, a port going into or out of operate, a wire break or a short
   * circuit. Emitting every poll would drown the flow in identical messages.
   */
  function IolinkEventNode (config) {
    RED.nodes.createNode(this, config)
    const node = this
    const master = RED.nodes.getNode(config.master)
    if (!master) {
      node.status({ fill: 'red', shape: 'ring', text: 'no master configured' })
      return
    }

    const ports = parsePorts(config.ports)
    const interval = Math.max(250, Number(config.interval) || 2000)
    const previous = new Map()
    let timer = null
    let inFlight = false
    let started = false

    async function poll (send, done) {
      try {
        const states = await master.adapter.scanPorts(ports)
        const messages = []

        for (const state of states) {
          const before = previous.get(state.port)
          previous.set(state.port, state)
          const changes = diff(before, state)
          // The first poll establishes the baseline. Reporting every port as a
          // change on startup would fire alarms for a healthy plant.
          if (!started || !changes.length) continue
          messages.push({
            topic: `iolink/port${state.port}/status`,
            payload: {
              port: state.port,
              connected: state.connected,
              status: state.status,
              statusText: state.statusText,
              mode: state.mode,
              modeText: state.modeText,
              deviceStatus: state.deviceStatus,
              deviceStatusText: DEVICE_STATUS[state.deviceStatus],
              vendorId: state.vendorId,
              deviceId: state.deviceId,
              productName: state.productName
            },
            changes,
            event: classify(before, state),
            timestamp: new Date().toISOString()
          })
        }

        started = true
        const connected = states.filter(s => s.connected).length
        node.status({ fill: connected ? 'green' : 'yellow', shape: 'dot',
          text: `${connected}/${states.length} ports connected` })
        if (messages.length) send([messages])
        if (done) done()
      } catch (e) {
        fail(node, {}, e, done)
      }
    }

    node.on('input', (msg, send, done) => poll(send, done))

    timer = setInterval(() => {
      if (inFlight) return
      inFlight = true
      poll(m => node.send(m), err => {
        inFlight = false
        if (err) node.error(err.message)
      })
    }, interval)

    node.on('close', function (done) {
      if (timer) clearInterval(timer)
      previous.clear()
      started = false
      done()
    })
  }

  const WATCHED = ['connected', 'status', 'mode', 'vendorId', 'deviceId', 'deviceStatus']

  function diff (before, after) {
    if (!before) return WATCHED.filter(k => after[k] !== undefined).map(k => ({ field: k, to: after[k] }))
    return WATCHED
      .filter(k => before[k] !== after[k])
      .map(k => ({ field: k, from: before[k], to: after[k] }))
  }

  /** Describe the transition in the terms the specification uses. */
  function classify (before, after) {
    if (before && !before.connected && after.connected) {
      return { ...lookupEvent(0xff21, 'port'), direction: 'appeared' }
    }
    if (before && before.connected && !after.connected) {
      return { ...lookupEvent(0xff22, 'port'), direction: 'disappeared' }
    }
    if (before && before.deviceId !== after.deviceId && after.deviceId !== undefined) {
      return { ...lookupEvent(0x1803, 'port'), direction: 'device changed' }
    }
    return { ...lookupEvent(0xff26, 'port'), direction: 'status changed' }
  }

  const parsePorts = raw => {
    if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite)
    if (typeof raw === 'string' && raw.trim()) {
      return raw.split(',').map(s => Number(s.trim())).filter(Number.isFinite)
    }
    return undefined
  }

  RED.nodes.registerType('iolink-event', IolinkEventNode)
}
