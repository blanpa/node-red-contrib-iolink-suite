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
- Example flows in Node-RED's **Import → Examples** menu: reading a sensor,
  commissioning a master, watching device health, and decoding bytes that never
  came from a master.
- `npm run lint` (standard), and a GitHub Actions workflow running the unit
  suite on Node 18 and 22 plus the Node-RED integration test.

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

### Fixed

- A read that was already in flight no longer delivers its message after the
  node has been closed.

## [0.1.0]

First release: `iolink master`, `iolink read`, `iolink write`, `iolink param`,
`iolink scan`, `iolink event` and `iodd decode`, with the ifm IoT Core and
generic HTTP/JSON master profiles.
