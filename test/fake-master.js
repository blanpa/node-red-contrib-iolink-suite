'use strict'
const http = require('node:http')

/**
 * A stand-in for an ifm IoT Core master.
 *
 * The adapters are the part of this package that can only be proven against a
 * real master, which no CI runner has. This server speaks the same request and
 * reply envelope as the real thing - one POST endpoint, a `code` in the body
 * that is not the HTTP status - so the adapter, the nodes and a whole Node-RED
 * flow can be exercised end to end. It is deliberately literal about the
 * device's quirks: uppercase hex, codes 800/801 for a port with nothing on it.
 *
 * Port 1 carries the demo sensor from the test fixtures (vendorId 999,
 * deviceId 4242), and answers the standard diagnosis objects at index 36 and
 * 37. Port 2 is empty. Port 3 is a digital input, not IO-Link.
 */

const hex = text => Buffer.from(text, 'utf8').toString('hex').toUpperCase()

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const DEFAULT_STATE = () => ({
  product: 'AL1350',
  serial: '000123456789',
  ports: {
    1: {
      status: 2,
      mode: 1,
      vendorId: 999,
      deviceId: 4242,
      productName: 'DEMO-100',
      serial: 'TI-0001',
      pdin: '092B0929',
      pdout: '0B',
      isdu: {
        // index/subindex -> hex, as the master reports it
        '100/0': '092B', //   2347 -> 23.47 degC through the IODD's gradient
        '101/0': '01', //     enum: normally closed
        '102/0': hex('Line A'), //  a String parameter, shorter than its declared length
        '16/0': hex('Test Instruments GmbH'),
        // The two objects every device must have: DeviceStatus says
        // "maintenance required", DetailedDeviceStatus says why - qualifier E4
        // (appears, warning, from the device) and EventCode 8C40, "cleaning".
        // The second slot is empty, as a device with room to spare reports it.
        '36/0': '01',
        '37/0': 'E48C40000000'
      }
    },
    2: { status: 0, mode: 1 },
    3: { status: 0, mode: 2 }
  }
})

class FakeMaster {
  constructor (state) {
    this.state = state || DEFAULT_STATE()
    this.requests = []
    this.server = http.createServer((req, res) => this._handle(req, res))
  }

  async listen (port = 0, host = '127.0.0.1') {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, resolve)
    })
    this.port = this.server.address().port
    this.url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${this.port}/`
    return this
  }

  async close () {
    await new Promise(resolve => this.server.close(resolve))
  }

  _handle (req, res) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let request
      try {
        request = JSON.parse(body || '{}')
      } catch {
        return send(res, 200, { code: 400, data: { message: 'malformed request' } })
      }
      this.requests.push(request)
      const reply = this.dispatch(request)
      // The IoT Core answers HTTP 200 even when it rejects the request; the
      // failure is in `code`. Anything else would hide masked errors.
      send(res, 200, { cid: request.cid, ...reply })
    })
  }

  dispatch ({ adr = '', data }) {
    const value = v => ({ code: 200, data: { value: v } })
    const ok = () => ({ code: 200 })
    const fail = (code, message) => ({ code, data: { message } })

    if (adr === '/deviceinfo/productcode/getdata') return value(this.state.product)
    if (adr === '/deviceinfo/serialnumber/getdata') return value(this.state.serial)

    const match = adr.match(/^\/iolinkmaster\/port\[(\d+)\]\/(.+)$/)
    if (!match) return fail(400, `unknown address ${adr}`)
    const port = this.state.ports[match[1]]
    const tail = match[2]
    if (!port) return fail(400, `port ${match[1]} does not exist on this master`)

    if (tail === 'mode/getdata') return value(String(port.mode))
    if (tail === 'iolinkdevice/status/getdata') return value(String(port.status))

    // Everything below needs a device in IO-Link mode.
    const connected = port.status === 1 || port.status === 2
    if (!connected) return fail(800, 'no device connected to this port')

    switch (tail) {
      case 'iolinkdevice/vendorid/getdata': return value(String(port.vendorId))
      case 'iolinkdevice/deviceid/getdata': return value(String(port.deviceId))
      case 'iolinkdevice/productname/getdata': return value(port.productName)
      case 'iolinkdevice/serial/getdata': return value(port.serial)
      case 'iolinkdevice/pdin/getdata': return value(port.pdin)
      case 'iolinkdevice/pdout/getdata': return value(port.pdout)
      case 'iolinkdevice/pdout/setdata':
        if (!data || typeof data.newvalue !== 'string') return fail(400, 'newvalue missing')
        if (data.newvalue.length % 2) return fail(400, 'odd-length hex')
        port.pdout = data.newvalue.toUpperCase()
        return ok()
      case 'iolinkdevice/iolreadacyclic': {
        const key = `${Number(data && data.index)}/${Number((data && data.subindex) || 0)}`
        const hit = (port.isdu || {})[key]
        if (hit === undefined) return fail(801, `index ${key} is not supported by the device`)
        return value(hit)
      }
      case 'iolinkdevice/iolwriteacyclic': {
        const key = `${Number(data && data.index)}/${Number((data && data.subindex) || 0)}`
        if (typeof data.value !== 'string') return fail(400, 'value missing')
        port.isdu = port.isdu || {}
        port.isdu[key] = data.value.toUpperCase()
        return ok()
      }
      default:
        return fail(400, `unknown address ${adr}`)
    }
  }
}

module.exports = { FakeMaster, DEFAULT_STATE }

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080
  new FakeMaster().listen(port, '0.0.0.0').then(m => {
    console.log(`fake ifm IoT Core master listening on :${m.port}`)
  })
}
