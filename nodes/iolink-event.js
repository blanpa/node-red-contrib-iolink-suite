'use strict'
const { fail, readDeviceStatus, startPolling, asTick, parsePorts, serialiser, shorten } =
  require('../lib/runtime')
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

    let ports
    try {
      ports = parsePorts(config.ports)
    } catch (e) {
      // Watching every port instead would be a plausible-looking answer to a
      // question the node cannot read. Say so and watch nothing.
      node.status({ fill: 'red', shape: 'ring', text: shorten(e.message) })
      node.error(e.message)
      return
    }
    const interval = Math.max(250, Number(config.interval) || 2000)
    const wantsDeviceStatus = Boolean(config.deviceStatus)
    const previous = new Map()
    let stopPolling = null
    let started = false

    // The timer and an incoming message both poll; one at a time, or the two
    // runs would diff against each other's result rather than against the last
    // reported state, and a change would be dropped or reported twice.
    const oneAtATime = serialiser()

    function poll (msg, send, done) {
      oneAtATime(() => pollOnce(send)).then(
        () => { if (done) done() },
        e => fail(node, msg || {}, e, done))
    }

    async function pollOnce (send) {
      const scanned = await master.adapter.scanPorts(ports)
      const messages = []
      const states = []

      for (const answer of scanned) {
        const before = previous.get(answer.port)
        // A port the master could not be asked about has not changed; the
        // master has gone quiet. The last known state is carried forward under
        // an "unreachable" flag, so an outage is reported as an outage rather
        // than as every device on the rack disappearing, and the master
        // coming back is not every device appearing again.
        const state = answer.error
          ? { ...(before || { port: answer.port }), unreachable: true, error: answer.error }
          : { ...answer, unreachable: false, error: undefined }
        states.push(state)

        if (wantsDeviceStatus && state.connected && !state.unreachable) {
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
        if (!state.unreachable) {
          state.deviceEventCodes = (state.deviceEvents || [])
            .map(e => e.hex).sort().join(',') || undefined
        }

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
            productName: state.productName,
            unreachable: state.unreachable,
            error: state.error
          },
          changes,
          event: classify(before, state),
          timestamp: new Date().toISOString()
        })
      }

      started = true
      node.status(statusFor(states))
      if (messages.length) send([messages])
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

  /** What the node shows under itself after a poll. */
  function statusFor (states) {
    const unreachable = states.filter(s => s.unreachable).length
    if (unreachable) {
      return {
        fill: 'red',
        shape: 'ring',
        text: unreachable === states.length
          ? 'master unreachable'
          : `master unreachable on ${unreachable}/${states.length} ports`
      }
    }
    const unwell = states.find(s => s.deviceStatus > 0)
    if (unwell) {
      return {
        fill: 'yellow',
        shape: 'dot',
        text: `port ${unwell.port}: ${DEVICE_STATUS[unwell.deviceStatus]}`
      }
    }
    const connected = states.filter(s => s.connected).length
    return {
      fill: connected ? 'green' : 'yellow',
      shape: 'dot',
      text: `${connected}/${states.length} ports connected`
    }
  }

  const WATCHED = ['connected', 'status', 'mode', 'vendorId', 'deviceId',
    'deviceStatus', 'deviceEventCodes', 'unreachable']

  function diff (before, after) {
    if (!before) return WATCHED.filter(k => after[k] !== undefined).map(k => ({ field: k, to: after[k] }))
    return WATCHED
      .filter(k => before[k] !== after[k])
      .map(k => ({ field: k, from: before[k], to: after[k] }))
  }

  /**
   * Describe the transition in the terms the specification uses.
   *
   * The master going quiet and coming back has no event code of its own in
   * the specification, which only knows the port; it is reported under the
   * master's name so a flow can tell a rack outage from a device event.
   */
  function classify (before, after) {
    if (after.unreachable) {
      return { scope: 'master', name: 'Master unreachable', type: 'error', direction: 'unreachable' }
    }
    if (before && !before.connected && after.connected) {
      return { ...lookupEvent(0xff21, 'port'), direction: 'appeared' }
    }
    if (before && before.connected && !after.connected) {
      return { ...lookupEvent(0xff22, 'port'), direction: 'disappeared' }
    }
    if (before && before.deviceId !== after.deviceId && after.deviceId !== undefined) {
      return { ...lookupEvent(0x1803, 'port'), direction: 'device changed' }
    }
    if (before && before.unreachable) {
      return { scope: 'master', name: 'Master reachable again', type: 'notification', direction: 'reachable' }
    }
    return { ...lookupEvent(0xff26, 'port'), direction: 'status changed' }
  }

  RED.nodes.registerType('iolink-event', IolinkEventNode)
}
