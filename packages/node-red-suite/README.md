# node-red-contrib-iolink-suite

Node-RED nodes for IO-Link. Read a sensor's process data as **named, scaled,
engineering values** instead of raw bytes, write actuator outputs by name, and
read or write ISDU parameters by their label in the device's IODD.

```
[ inject ]--->[ iolink read: port 1 ]--->[ debug ]

  msg.payload = {
    "Temperature": 23.47,
    "Counter": 586,
    "SwitchingSignal1": true,
    "SwitchingSignal2": false
  }
```

The decoding is done by [`iodd-parser`](../iodd-parser), which has no Node-RED
dependency — so the same IODD handling is reusable outside Node-RED, and the
`iodd-decode` node works for process data that never touched an IO-Link master
(PROFINET, EtherNet/IP, Modbus, OPC UA, MQTT, a PLC).

## Install

From the Node-RED palette manager, or:

```bash
cd ~/.node-red
npm install node-red-contrib-iolink-suite
```

Requires Node.js ≥ 18 and Node-RED ≥ 3.0.

## The nodes

| Node | What it does |
| --- | --- |
| `iolink master` | Config node: one per physical master. Holds the connection and one shared IODD cache. |
| `iolink read` | Reads a port's process data input and decodes it. On a message or on an interval. |
| `iolink write` | Writes process data output by name, merging into the device's current output. |
| `iolink param` | Reads and writes ISDU parameters by name, scaled and with enumerations resolved. |
| `iolink scan` | Reports which ports are occupied, by which device, and whether an IODD was found. |
| `iolink event` | Polls port status and emits a message only when something changes. |
| `iodd decode` | Decodes or encodes raw IO-Link bytes against an IODD, with no master involved. |

## Configuring a master

Pick a **profile** in the `iolink master` config node:

- **ifm IoT Core** — AL13xx / AL19xx / AL2xxx. Verified against the real API.
- **Generic HTTP/JSON** — for Balluff, Turck and others: the request paths are
  configuration, not code, so a new master is a settings entry. Templates take
  `{port}`, `{index}`, `{subindex}` and `{value}`, and `valuePath` says where
  the value sits in the reply (e.g. `data.value`).

Where the IODD comes from, in order:

1. **IODD folder** (`ioddDir`) — files are matched by their content, not their
   filename, so vendor naming does not matter. A pinned IODD always wins.
2. **IODDfinder**, cached on disk (`ioddCacheDir`). Tick **offline** on an
   air-gapped plant to switch this off.

## Reading process data

Point the node at a master and a port, then tick the values you want. The
editor asks the master what is on the port and lists the values by name, with
units — you never type a bit offset.

- **Output: single** — one message, `msg.payload` an object of every value.
- **Output: split** — one message per value, with `msg.topic` set to
  `<prefix>/<value>`, which maps straight onto MQTT topics.

Alongside `payload`, each message carries `meta` (unit, range, type, bit offset
per value), `device` (vendor, product, serial, port) and `iolink` (the raw hex,
the layout id, the octet count).

Set an **interval** to poll. A tick is skipped while the previous read is still
in flight, so a slow master cannot build a backlog.

## Writing process data

Send `msg.payload = { "Valve": true }`. By default the node reads the device's
current output first and merges into it, so setting one field leaves the others
alone — without that, writing one valve on a manifold would close every other
one. Turn **merge** off if the master cannot read its output back, and then
supply every value.

Values are range-checked against the IODD before anything is written.

## Reading and writing parameters

`iolink param` addresses an ISDU by its name (or index), and applies the IODD's
scaling and enumerations in both directions:

```
msg = { action: "write", payload: 30 }   →  Switch point, index 100, hex 0BB8
msg = { action: "read" }                 →  msg.payload = 23.47, msg.meta.unit = "°C"
```

Read-only and write-only parameters are refused with a clear message rather
than by the device, and a record can be addressed per `msg.subindex`.

## Errors

Every node reports failures the same way: the node goes red with a short
status, and the error reaching a Catch node is prefixed with a code you can
branch on.

| Code | Meaning |
| --- | --- |
| `IOLINK_NO_DEVICE` | The port reports no IO-Link device. |
| `IOLINK_NO_DATA` | The master returned no value. |
| `IOLINK_BAD_PAYLOAD` | The payload was not the shape the node needs. |
| `IOLINK_OUT_OF_RANGE` | The value is outside the range the IODD declares. |
| `IOLINK_READ_ONLY` / `IOLINK_WRITE_ONLY` | The parameter does not allow it. |
| `IOLINK_UNKNOWN_PARAMETER` / `IOLINK_UNKNOWN_SUBINDEX` | No such parameter in the IODD. |
| `IOLINK_MERGE_UNAVAILABLE` | The master cannot read its output back to merge into. |
| `IODD_*` | Raised by the parser: a bad IODD, an ambiguous variant, wrong data length. |

## Testing

```bash
npm test                     # unit tests, no hardware and no network
npm run test:docker          # the same suite in a clean container
npm run test:integration     # the nodes loaded into real Node-RED, in Docker
```

The suite runs against a fake ifm IoT Core master (`test/fake-master.js`) that
speaks the real request and reply envelope, so the adapters, the nodes and a
whole flow are exercised end to end without a master on the desk. The Docker
integration test deploys a flow into the official `nodered/node-red` image and
checks the decoded values that come out the other end.

## Adding a master profile

One file in `lib/adapters/`, one entry in `lib/adapters/index.js`. Adapters
deal in **raw hex only** — decoding stays in `iodd-parser` — so a new vendor
never touches the decoding path. Profiles verified against real hardware are
marked as such in the registry; please say which you tested against.

## Licence

Apache-2.0
