'use strict'
const { fail, readDeviceStatus, startPolling, asTick } = require('../lib/runtime')
const { lookupEvent, DEVICE_STATUS } = require('../lib/iodd')

module.exports = function (RED) {
  /**
   * Watch port status and diagnosis.
   *
   * Masters differ in whether they can push events, so this polls port status
   * and emits a message only when something changes: a device appearing or
   * disappearing, a port going into or out of operate, a wire break or a short
   * circuit. Emitting every poll would drown the flow in identical messages.
   *
   * With "device status" on it also asks each connected device how it is doing,
   * through the two objects the specification gives every device rather than
   * through a vendor diagnosis API. That costs two more ISDU reads per port and
   * per poll, which is why it is a choice and not the default.
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
    const wantsDeviceStatus = Boolean(config.deviceStatus)
    const previous = new Map()
    let stopPolling = null
    let started = false

    async function poll (_msg, send, done) {
      try {
        const states = await master.adapter.scanPorts(ports)
        const messages = []

        for (const state of states) {
          if (wantsDeviceStatus && state.connected) {
            try {
              Object.assign(state, await readDeviceStatus(master.adapter, state.port))
            } catch (e) {
              // A device or master that will not answer index 36 must not stop
              // the port watch; the refusal is reported as part of the state.
              state.deviceStatusError = e.message
            }
          }
          // Watched as one field: any change in the standing events is a change
          // worth a message, without putting the whole list in the comparison.
          state.deviceEventCodes = (state.deviceEvents || [])
            .map(e => e.hex).sort().join(',') || undefined

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
              deviceEvents: state.deviceEvents,
              deviceStatusError: state.deviceStatusError,
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
        const unwell = states.filter(s => s.deviceStatus > 0)
        node.status(unwell.length
          ? {
              fill: 'yellow',
              shape: 'dot',
              text: `port ${unwell[0].port}: ${DEVICE_STATUS[unwell[0].deviceStatus]}`
            }
          : {
              fill: connected ? 'green' : 'yellow',
              shape: 'dot',
              text: `${connected}/${states.length} ports connected`
            })
        if (messages.length) send([messages])
        if (done) done()
      } catch (e) {
        fail(node, {}, e, done)
      }
    }

    node.on('input', poll)

    stopPolling = startPolling(node, interval, asTick(poll))

    node.on('close', function (done) {
      stopPolling()
      previous.clear()
      started = false
      done()
    })
  }

  const WATCHED = ['connected', 'status', 'mode', 'vendorId', 'deviceId',
    'deviceStatus', 'deviceEventCodes']

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
