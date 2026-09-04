# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- A profile for the IO-Link Community's **JSON Integration for IO-Link**
  (spec 10.222, V1.0.0), the REST interface Balluff, Pepperl+Fuchs and others
  share: `/iolink/v1`, byte arrays, device aliases, the specification's error
  objects. Aliases are looked up from the master and re-looked-up when one is
  refused, so a port renamed in the master's configuration keeps working. A
  gateway with several masters is addressed by **Master no.** in the dialog.
  Built from the specification's OpenAPI document and tested against a stand-in
  that speaks it (`test/fake-jsonapi-master.js`).
- `npm run record` (`scripts/record-master.js`) sends every read a profile
  relies on to a real master and stores the raw exchanges under `recordings/`,
  so a profile can be checked against hardware and a difference reported with
  the evidence attached. Nothing is written to the master or a device.
- `iolink read` reads several ports at once: **Port** takes a list (`1,3` as a
  string, or an array from a message), and one message comes back keyed by
  port — `msg.payload[1].Temperature` where the single-port form says
  `msg.payload.Temperature`, with `meta`, `device` and `iolink` keyed to match.
  One port produces exactly the message it always did, so no flow changes shape
  because this became possible. The ports are read one after another rather
  than at once, and a port that does not answer is named under `msg.errors`
  instead of costing the others their reading. In split mode the port joins the
  topic, because two devices of one type carry the same value names.
- `iolink param` reads and writes several parameters at once, given as a list
  or an array. The message is keyed by the name the IODD gives each parameter,
  so asking by index and asking by name produce the same message. Writing
  several takes a payload keyed by parameter; a payload that is not an object
  is refused rather than written to the first and guessed at for the rest.
  Clicking the loaded parameter list now adds and removes instead of replacing.

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
- An icon of the suite's own, replacing the borrowed Font Awesome glyphs: the
  letters IO, drawn as shapes rather than set in a font. Every node in the
  suite wears it, so the suite reads as one group in a flow rather than as
  six unrelated nodes.
- Example flows in Node-RED's **Import → Examples** menu: reading a sensor,
  commissioning a master, watching device health, and decoding bytes that never
  came from a master.
- `npm run lint` (standard), and a GitHub Actions workflow running the unit
  suite on Node 18 and 22 plus the Node-RED integration test.
- A release workflow: pushing a version tag (`v0.2.0`) checks that it matches
  `package.json`, runs lint, the unit suite and the Node-RED integration test
  on the tagged commit, publishes to npm with provenance, and cuts a GitHub
  release whose notes are this file's section for that version.

- The generic HTTP/JSON profile can find out which device is on a port:
  `readVendorId`, `readDeviceId`, `readProductName` and `readSerial` join the
  configurable paths, and a scan fills them in for occupied ports. Without
  them the profile could report that a port was in use but never which device
  was in it, so an IODD could not be looked up and `iolink read`, `write` and
  `param` failed on every generic master with `IOLINK_NO_DEVICE` - a message
  that blamed the wiring for a gap in the profile. That case is now
  `IOLINK_NO_IDENTITY` and says what to do about it. An identity path the
  master refuses is dropped after the first try rather than repeated on every
  poll.
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

- The README and the master dialog no longer call the ifm profile "verified
  against the real API". It was built from ifm's documentation and tested
  against the stand-in in `test/`, like every other profile, and nothing in
  the repository had been run against a master. The dialog now says, next to
  the profile, what each one rests on; the generic profile's default paths
  are named as the placeholders they are rather than as Balluff's or Turck's.
- An ifm master that answers a port request with a rejection (a port that
  does not exist, say) is reported as that port's state, not as the master
  being unreachable.
- The port identity cache belongs to the master node rather than to each read,
  write and parameter node: three nodes on one port ask it once instead of
  three times, and each node's **Re-check** says how old an answer it will
  take, so the node with the shortest one refreshes the entry for the others.
- The `device` block on every message names the product the master reports,
  and falls back to the IODD's first variant only when the master does not
  say. A family IODD covers several products, and the first listed was not
  necessarily the one on the port. `iolink write` and `iolink param` now
  carry the same `device` block as `iolink read` (vendor and device id, serial)
  through one shared `describeDevice()`.
- `iolink read` warns once when a selected value is not in the device's
  process data (after a firmware update, a changed key style, or a different
  device on the port), naming the value and what the device does carry.
  Before, the value was silently left out, which looked like a sensor that
  had stopped reporting.
- `iolink param` refuses a subindex that is not a whole number from 0 to 255
  (`IOLINK_BAD_SUBINDEX`) before asking the device, and refuses a value the
  master returns, or a record to be written, that is not proper hex
  (`IOLINK_BAD_HEX`) rather than letting `Buffer.from` cut it short. The
  editor's parameter picker says so when the port field holds a message
  property rather than a number, instead of asking the master about port
  NaN; the picker endpoints answer 400 to such a port.

- The long edit dialogs are divided into named sections rather than separated
  by bare rules: **Connection**, **IODD** and **Generic profile** on the master,
  **Device identity** on read, write and param. The two checkbox rows that put
  their label inside the tick now match the other five, so every dialog keeps
  one column of labels.
- Every node in the palette carries the same colour. `iodd decode` used to be
  green because it is the one node that needs no master, which made it look
  like it came from a different package.
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

- A master that could not be reached was reported by `iolink read`, `write`
  and `param` as `IOLINK_NO_DEVICE`, "port 1 reports no IO-Link device": the
  adapters answer an outage with an entry carrying `error`, and the identity
  lookup read the missing ids as an empty port. Worse, that answer went into
  the identity cache, so the outage lived on for a full re-check after the
  master was back. It is now `IOLINK_MASTER_UNREACHABLE`, names the cause,
  and is never cached.
- `iolink event` reported a master going quiet as every device on the rack
  disappearing, and the master returning as every device appearing again,
  because an unanswered port looked exactly like an empty one. The last known
  state is now carried through the outage under `payload.unreachable`, with
  `event.direction` `unreachable` and `reachable`; a device that really did
  leave while the master was down is still reported as gone when it returns.
- Opening `iolink read`, changing nothing but the name and pressing Done
  emptied the value selection. The dialog shows the saved selection as a
  ticked list until a scan replaces it, and "everything ticked" was taken as
  "no filter" whether the list came from the device or not. It now means that
  only after a scan.
- `msg.parameter` on `iolink param` was documented as overriding the dialog
  but only did so when the dialog was empty or set to take it from the message;
  a name typed into the dialog was evaluated first and the message ignored.
  The message now wins, as the help says.
- `iolink read` in split mode dropped `msg.errors`: the ports that did not
  answer were counted in the status line but named nowhere. They are now
  named on every split message.
- The HTTP timeout was lifted as soon as a master's headers arrived, so a
  master that sent headers and then stalled on the body hung the flow. The
  body is now read under the same timeout.

- The edit dialogs of `iolink read` and `iolink param` left a `form-row`
  unclosed, so the browser nested the rule, the identity fields and the tips
  that followed inside the **Poll** (respectively **Subindex**) row: one field
  387 pixels tall where every other is 34. Both dialogs also carried two
  paragraphs of help text at the bottom, which belongs in the help pane and is
  where `iolink write` already had it.
- The palette section was headed **IO**. The category was `IO-Link`, and the
  editor takes everything before the first `-` as the section it files a node
  under (`category.split("-")[0]`), so the rest of the name was silently
  dropped. It is now `IO Link Suite`, which the editor shows in full.
- The node icons were never displayed. Node-RED's registry looks for icons at
  `<module>/<the directory the node's .js is in>/icons`, and they were shipped
  in an `icons/` at the root of the package, so the registry listed the suite
  with no icons at all and every node quietly wore Node-RED's fallback arrow.
  Nothing said so: an unknown icon URL answers 200 with the fallback, which is
  why the integration test asking for the icons passed throughout. They now
  live in `nodes/icons`, and the test checks the registry's listing rather
  than the status code. (Introduced with the icons, above, and never released.)
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
