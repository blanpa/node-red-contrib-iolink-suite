# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- `iolink event` can read device diagnosis: `DeviceStatus` (ISDU 36) and
  `DetailedDeviceStatus` (ISDU 37), decoded into the EventCodes a device is
  currently signalling with their meaning, type and whether they just appeared.
  Both objects are specified for every IO-Link device, so this needs no vendor
  diagnosis API.
- The fake master grew into a simulator: a plant file describes which IODD sits
  on which port and what its values do (`sine`, `ramp`, `triangle`, `square`,
  `random`), the process data is encoded through that IODD, and a control API
  (`GET /sim`, `POST /sim/port/{n}`) pulls devices, raises events and pins
  values while it runs. `npm run simulator`, or `SIM_PLANT=…` on the
  `fake-master` container.
- `encodeEventQualifier()` and `encodeDetailedDeviceStatus()`, the counterparts
  of the decoders, so the diagnosis objects can be built as well as read.
- Node icons of the suite's own, replacing the borrowed Font Awesome glyphs.
  Each node is dominated by its own shape, so a flow can be read at a glance:
  an arrow out of the device for read and into it for write, sliders for
  parameters, a lens over an M12 connector face for scan, a warning sign for
  events, and octets over named values for `iodd decode`.
- Example flows in Node-RED's **Import → Examples** menu: reading a sensor,
  commissioning a master, watching device health, and decoding bytes that never
  came from a master.
- `npm run lint` (standard), and a GitHub Actions workflow running the unit
  suite on Node 18 and 22 plus the Node-RED integration test.

- Every setting the nodes honour can now be reached in the editor. **Base URL**
  on the master, and **Re-check**, **Vendor ID** and **Device ID** on the read,
  write and parameter nodes, were read at runtime but had no field to set them,
  so pinning a device identity — the documented answer for a master that cannot
  report one — was only possible by editing the flow file by hand. The write
  node also gained the process data **Layout** picker the read node has.
- The editor halves of the nodes are linted (`scripts/lint-editors.js` lifts
  each script block out of the .html and maps the results back), and a test
  checks that every property in a node's `defaults` has somewhere in its edit
  dialog to set it.

### Changed

- The whole suite is one package. The IODD parser moved from its own workspace
  into `lib/iodd` and is no longer published separately as `iodd-parser`;
  `require('node-red-contrib-iolink-suite')` gives the same API.
- A port taken from a message that does not carry it is now an error
  (`IOLINK_BAD_PORT`) instead of silently reading port 1 — which returned
  another device's values with no indication anything was wrong.
- Nodes that poll read once as soon as the flow is deployed, instead of after
  the first interval.
- Unit codes the normative source lists twice (1050, 1380) keep both readings:
  `lookupUnit()` reports the alternatives rather than picking one silently.

- **Test connection** on the master asks the master to identify itself instead
  of scanning all its ports: two requests rather than one per port, and an
  answer even from a master with nothing plugged into it yet.
- `iolink param` reports `device` and `timestamp` on a write, as it already did
  on a read.
- `MasterAdapter.subscribe()` is gone. No profile implemented it and nothing
  called it; an extension point no caller honours is worse than none.

### Fixed

- **Test connection** on a generic HTTP/JSON master reported success without
  sending anything, because that profile's `identify()` answered from its own
  configuration. It now probes a port, so a wrong host fails the test instead
  of showing a green tick. (Introduced with the switch from scanning to
  identifying, above, and never released.)
- The same failure reported more than once no longer collects a copy of its
  error code each time. Remembering a failed IODD lookup means handing the very
  same error to every read inside the retry window, and the reporting helper
  rewrote its message in place: by the third read a Catch node saw
  `IODD_NOT_FOUND: IODD_NOT_FOUND: IODD_NOT_FOUND: no IODD for ...`.
- A device whose IODD is nowhere to be found is remembered as such for a
  configurable time. Every read used to repeat the whole lookup, so one
  unpublished device on a rack sent a request to IODDfinder on every poll —
  once a second on a one-second interval — for as long as the flow ran.
- Several nodes asking for the same IODD at the same moment now share one
  lookup. Since every polling node reads once at deploy, four read nodes on one
  master used to start four downloads of the same file.
- A folder of IODDs is parsed once rather than once per device on the rack: the
  file each device sits in is remembered per file and modification time.
- `iolink scan` reads `msg.ports` the way people send it. A comma-separated
  string asked the master about `port[,]`, and a bare number failed with "list
  is not iterable"; both now work, and a list holding no port number is refused
  with `IOLINK_BAD_PORT` instead of quietly scanning nothing.
- `iodd decode` keeps the last few message-supplied IODDs parsed. Driving one
  node from the flow — the documented way to serve several device types — re-read
  and re-parsed the whole XML for every message, which costs orders of magnitude
  more than the decoding it was there for.
- `iolink event` no longer polls twice at once. An input message arriving while
  the timer was mid-poll produced two runs that each compared the ports against
  what the other had just recorded, so a change could be reported twice or lost.
- A read that was already in flight no longer delivers its message after the
  node has been closed.

## [0.1.0]

First release: `iolink master`, `iolink read`, `iolink write`, `iolink param`,
`iolink scan`, `iolink event` and `iodd decode`, with the ifm IoT Core and
generic HTTP/JSON master profiles.
