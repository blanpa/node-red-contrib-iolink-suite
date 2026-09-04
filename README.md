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

The decoding is done by the IODD parser in [`lib/iodd`](IODD-PARSER.md), which
has no Node-RED dependency — so the `iodd decode` node works for process data
that never touched an IO-Link master (PROFINET, EtherNet/IP, Modbus, OPC UA,
MQTT, a PLC), and the same decoder is usable from plain Node.js.

## Install

From the Node-RED palette manager, or:

```bash
cd ~/.node-red
npm install node-red-contrib-iolink-suite
```

Requires Node.js ≥ 18 and Node-RED ≥ 3.0. Node-RED's
**Import → Examples → iolink-suite** menu has ready-made flows for the common
cases.

## The nodes

| Node | What it does |
| --- | --- |
| `iolink master` | Config node: one per physical master. Holds the connection and one shared IODD cache. |
| `iolink read` | Reads process data in from one port or several, and decodes it. On a message or on an interval. |
| `iolink write` | Writes process data output by name, merging into the device's current output. |
| `iolink param` | Reads and writes ISDU parameters by name, one or several, scaled and with enumerations resolved. |
| `iolink scan` | Reports which ports are occupied, by which device, and whether an IODD was found. |
| `iolink event` | Watches port status and device diagnosis, and emits a message only when something changes. |
| `iodd decode` | Decodes or encodes raw IO-Link bytes against an IODD, with no master involved. |

## Configuring a master

Pick a **profile** in the `iolink master` config node. Every profile was built
from its interface's documentation and is tested against a stand-in that
speaks it; **none has yet been checked against a master on a bench**. The
dialog says so next to the choice, and `npm run record` (below) is how that
changes.

- **ifm IoT Core** — AL13xx / AL19xx / AL2xxx, after ifm's IoT Core
  documentation: one POST endpoint, the address in the body.
- **IO-Link JSON API** — the IO-Link Community's *JSON Integration for
  IO-Link* (spec 10.222, V1.0.0), the one REST interface several vendors
  share: Balluff and Pepperl+Fuchs ship it on their newer masters, others are
  following. Everything sits under `/iolink/v1`; a gateway holding several
  masters numbers them, so the dialog asks which. A port renamed in the
  master's configuration is found by its alias. Values are exchanged as byte
  arrays and decoded here, through the IODD, like for every other profile.
- **Generic HTTP/JSON** — for a master with a REST API of its own shape (Turck's
  TBEN web API, for one): the request paths are configuration, not code, so a
  new master is a settings entry. Templates take `{port}`, `{index}`,
  `{subindex}` and `{value}`, and `valuePath` says where the value sits in the
  reply (e.g. `data.value`). The defaults are placeholders, not any vendor's
  paths.

  `readVendorId` and `readDeviceId` are the two that decide whether IODDs can
  be found at all: without them the master can say a device is there but not
  which, and `read`, `write` and `param` have nothing to decode against. They
  then need the ids pinned on the node itself, and say so
  (`IOLINK_NO_IDENTITY`) rather than claiming the port is empty. A path the
  master refuses is dropped after the first try, so a wrong guess is not
  repeated on every poll.

Masters that speak only a fieldbus — PROFINET, EtherCAT, EtherNet/IP, Modbus
TCP — have no profile and need none: bring the raw process data in through the
Node-RED node for that fieldbus and hand it to `iodd decode`.

Give it a **host**, optionally an HTTP port and HTTPS. A master behind a path or
a proxy takes a full **base URL** instead, which overrides both.

### Checking a profile against a real master

```bash
npm run record -- ifm http://192.168.1.50/ --ports 1,2
npm run record -- jsonapi http://192.168.1.60/ --user admin --password secret
```

sends every read the profile relies on — nothing is written — and stores the
raw exchanges, request and reply, under `recordings/`. A reply that differs
from what the stand-in in `test/` answers is a difference between the
documentation and the device, and the file is what an issue or a fixture
needs.

Where the IODD comes from, in order:

1. **IODD folder** (`ioddDir`) — files are matched by their content, not their
   filename, so vendor naming does not matter. A pinned IODD always wins.
2. **IODDfinder**, cached on disk (`ioddCacheDir`). Tick **offline** on an
   air-gapped plant to switch this off.

A device whose IODD is nowhere to be found is remembered as such for **retry
after** (60 s by default), so one unpublished device on a rack does not send a
request to IODDfinder on every poll for as long as the flow runs. Dropping the
missing IODD into the folder and redeploying clears that at once. Several nodes
asking for the same IODD at the same moment share one lookup rather than each
starting their own.

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

**Port** takes one port, or a list of them — `1,3` typed as a string, or an
array from a message. Several ports come back as one message keyed by port,
with every part of the single-port message keeping its name underneath:

```
msg.payload[1].Temperature      several ports
msg.payload.Temperature         one port, unchanged
```

`meta`, `device` and `iolink` are keyed the same way. The ports are read one
after another, not at once — a master is a small device on the end of a wire.
A port that does not answer is left out and named under `msg.errors`; only when
no port at all answers does the read fail. In split mode the port joins the
topic (`<prefix>/port3/<value>`), because two devices of one type carry the
same value names.

Set an **interval** to poll: the node reads once as soon as the flow is
deployed and then on every tick. A tick is skipped while the previous read is
still in flight, so a slow master cannot build a backlog.

### Which device is on the port

`read`, `write` and `param` ask the port who is on it and cache the answer for
**re-check** (30 s by default) — asking before every read would triple the
traffic to the master, and pinning it for ever would survive a device being
swapped. Shorten it where devices are changed while the flow runs. The cache
belongs to the master, not to the node: three nodes on one port ask it once,
and the node with the shortest re-check refreshes it for the others. A master
that does not answer is not cached, so an outage ends when the master returns
rather than one re-check later.

The `device` block on every message names the product the master reports,
falling back to the IODD's first variant only when the master does not say — a
family IODD covers several products, and the first listed is not necessarily
the one on the port.

Filling in **vendor ID** and **device ID** pins the device instead: the node
loads that IODD and stops asking. That is the answer for a master whose API
cannot report an identity, and a way to hold a port to the device type it is
meant to carry.

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

## Diagnosis

`iolink event` polls the ports and emits a message only when something changes:
a device appearing or disappearing, a port leaving operate, a wire break.

Tick **device status** and it additionally reads the two objects every IO-Link
device must provide — `DeviceStatus` (ISDU 36) and `DetailedDeviceStatus`
(ISDU 37) — so the message also carries whether the device says it is OK,
needs maintenance, is out of specification or has failed, together with the
EventCodes standing behind that, resolved to their meaning:

```json
{ "deviceStatus": 1, "deviceStatusText": "Maintenance required",
  "deviceEvents": [ { "hex": "0x8C40", "name": "Maintenance required - Cleaning",
                      "type": "Warning", "mode": "appears" } ] }
```

Those two objects are specified for every device, not vendor extensions, so
this works on any master that can read an ISDU.

## Errors

Every node reports failures the same way: the node goes red with a short
status, and the error reaching a Catch node is prefixed with a code you can
branch on.

| Code | Meaning |
| --- | --- |
| `IOLINK_MASTER_UNREACHABLE` | The master did not answer at all, so nothing is known about the port. Not cached: the first read after the master returns succeeds. |
| `IOLINK_NO_DEVICE` | The master answered, and the port reports no IO-Link device. |
| `IOLINK_NO_IDENTITY` | A device is there, but the master will not say which — pin the ids, or configure the identity paths. |
| `IOLINK_NO_DATA` | The master returned no value. |
| `IOLINK_BAD_PORT` | The port number could not be resolved from the message. |
| `IOLINK_BAD_SUBINDEX` | The subindex is not a whole number from 0 to 255. |
| `IOLINK_BAD_HEX` | A value the master returned, or a record to be written, is not proper hex. |
| `IOLINK_BAD_PAYLOAD` | The payload was not the shape the node needs. |
| `IOLINK_OUT_OF_RANGE` | The value is outside the range the IODD declares. |
| `IOLINK_READ_ONLY` / `IOLINK_WRITE_ONLY` | The parameter does not allow it. |
| `IOLINK_UNKNOWN_PARAMETER` / `IOLINK_UNKNOWN_SUBINDEX` | No such parameter in the IODD. |
| `IOLINK_NO_PARAMETER` | No parameter was selected, in the node or on the message. |
| `IOLINK_UNSUPPORTED_PARAMETER` | The IODD describes the parameter in a way this decoder cannot handle. |
| `IOLINK_MERGE_UNAVAILABLE` | The master cannot read its output back to merge into. |
| `IODD_*` | Raised by the decoder: a bad IODD, an ambiguous variant, wrong data length. |

## Layout

Everything lives in one package, in one place:

```
nodes/        the seven nodes, runtime .js beside editor .html
nodes/icons/  the palette icon, black on transparent, 2:3 as Node-RED wants
              (the registry only finds icons beside the node files)
lib/          adapters/  one file per master profile, raw hex only
              iodd/      the IODD parser and the process data codec
test/         unit tests; test/iodd/ covers the decoder
scripts/      the editor linter, the IODD corpus fetcher, the unit generator
docker/       the containers the test suites run in
examples/     flows offered in Node-RED's Import → Examples menu
```

## Releasing

A version tag is a release. Move the changelog's **Unreleased** section under
the new version, then:

```bash
npm version minor          # bumps package.json, commits, tags v0.2.0
git push --follow-tags
```

The `publish` workflow checks that the tag matches `package.json`, runs lint,
the unit suite and the Node-RED integration test on the tagged commit,
publishes to npm with provenance, and creates a GitHub release with that
version's changelog section as its notes. It needs an npm automation token
in the repository secret `NPM_TOKEN`.

## The simulator

`test/fake-master.js` is a stand-in for an ifm IoT Core master: the same request
and reply envelope, the same quirks (uppercase hex, a `code` in the body that is
not the HTTP status). The test suite runs against it, and so can you, for
building a flow or demonstrating one without a master on the desk.

```bash
npm run simulator            # a plant on :8080, values that move
node test/fake-master.js     # the fixed rack the tests use
node test/fake-jsonapi-master.js  # the same rack behind the JSON API, on :8081

# Node-RED with the suite installed, wired to the simulator, editor on :1880
SIM_PLANT=test/fixtures/simulator-plant.json \
  docker compose -f docker-compose.test.yml up node-red
```

A **plant file** describes the rack: which IODD sits on which port, and what its
values are doing. The process data is *encoded through that IODD*, so the bytes
on the wire are the bytes the device description says they should be, scaling
included — not a hex string somebody typed.

```json
"1": {
  "iodd": "demo-sensor.iodd.xml",
  "values": {
    "Temperature":      { "wave": "sine", "min": 18.5, "max": 24.5, "periodMs": 60000 },
    "Counter":          { "wave": "ramp", "min": 0, "max": 16000, "periodMs": 120000 },
    "SwitchingSignal1": { "wave": "square", "periodMs": 8000 }
  },
  "deviceStatus": 1,
  "events": ["0x8C40"]
}
```

Waves: `sine`, `ramp`, `triangle`, `square`, `random`, `constant` — all
functions of the clock alone, so a run can be replayed exactly. A bare number,
string or boolean is a fixed value.

While it runs, the rack can be changed from outside — which is what makes an
alarm flow demonstrable:

```bash
curl localhost:8080/sim                                    # the whole rack
curl -d '{"connected":false}'        localhost:8080/sim/port/1   # pull a device
curl -d '{"deviceStatus":2,"events":["0x8C10"]}' localhost:8080/sim/port/1
curl -d '{"values":{"Temperature":42.5}}'        localhost:8080/sim/port/1
```

The control API lives beside the master's endpoint, never inside it: no message
a flow sends can reach it *as a flow message*. In the Docker environment the
simulator is not published to the host — the test harness must not fight
whatever else holds a port — but it is reachable inside the compose network at
`http://fake-master:8080/sim`, which an `http request` node can drive: an
inject node that pulls a device out is a fine way to demonstrate an alarm.

## Testing

```bash
npm test                     # unit tests, no hardware and no network
npm run lint                 # including the editor scripts inside the .html
npm run test:docker          # the same suite in a clean container
npm run test:integration     # the nodes loaded into real Node-RED, in Docker
npm run test:all             # both of the above
```

The suite runs against a fake ifm IoT Core master (`test/fake-master.js`) that
speaks the real request and reply envelope, so the adapters, the nodes and a
whole flow are exercised end to end without a master on the desk. The Docker
integration test installs the packed tarball into the official
`nodered/node-red` image — so anything left out of `package.json` fails there
and not on a user's machine — deploys a flow that uses every node, and checks
the decoded values that come out the other end.

The editor halves of the nodes are linted too: `standard` reads `.js` files, so
`scripts/lint-editors.js` lifts each `<script>` block out of the `.html`, lints
it, and maps the line numbers back. A unit test also checks that every property
in a node's `defaults` has somewhere in its edit dialog to set it — a mismatch
there is invisible at runtime and leaves a setting reachable only by editing the
flow file by hand.

Real vendor IODDs are copyrighted and are never committed. `npm run corpus`
fetches a set from IODDfinder; the decoder's corpus tests skip without it.

## Adding a master profile

One file in `lib/adapters/`, one entry in `lib/adapters/index.js`. Adapters
deal in **raw hex only** — decoding stays in `lib/iodd` — so a new vendor never
touches the decoding path. Profiles verified against real hardware are marked
as such in the registry; please say which you tested against.

## Licence

Apache-2.0
