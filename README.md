# IO-Link suite

IO-Link for Node.js and Node-RED: parse a device's IODD, then read and write
its process data and parameters as **named, scaled engineering values** instead
of raw bytes.

```js
{ "Temperature": 23.47, "Counter": 586, "SwitchingSignal1": true }
```

## Packages

| Package | What it is |
| --- | --- |
| [`iodd-parser`](packages/iodd-parser) | Parses IODD files and decodes/encodes IO-Link process data and ISDU parameters. Plain Node.js, no Node-RED. |
| [`node-red-contrib-iolink-suite`](packages/node-red-suite) | Node-RED nodes for IO-Link masters, built on the parser. |

The split is deliberate. Decoding lives entirely in the parser, so it is usable
from any Node.js program — and from Node-RED flows whose process data arrives
over PROFINET, EtherNet/IP, Modbus, OPC UA or MQTT rather than from an IO-Link
master's web API.

## Tests

```bash
npm install
npm test                  # everything, locally: no hardware, no network
npm run test:docker       # the same suite in a clean container
npm run test:integration  # the nodes loaded into real Node-RED, in Docker
npm run test:all          # both of the above
```

Neither suite needs an IO-Link master. The Node-RED tests run against a fake
ifm IoT Core master that speaks the real request and reply envelope, and the
integration test installs the packed tarballs into the official
`nodered/node-red` image — so anything left out of `package.json` fails here
and not on a user's machine.

Real vendor IODDs are copyrighted and are never committed. `npm run corpus`
fetches a set from IODDfinder; the parser's corpus tests skip without it.

## Licence

Apache-2.0
