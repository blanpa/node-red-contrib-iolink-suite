'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const pkg = require('../package.json')

/**
 * Node-RED loads nodes from the `node-red` block in package.json, and the
 * editor half from the .html beside each .js. A mismatch there does not fail
 * any unit test - it fails silently at install time on someone else's machine,
 * with the node simply missing from the palette.
 */
const root = path.join(__dirname, '..')
const declared = Object.entries(pkg['node-red'].nodes)

test('every declared node file exists', () => {
  for (const [name, file] of declared) {
    assert.ok(fs.existsSync(path.join(root, file)), `${name}: missing ${file}`)
    assert.ok(fs.existsSync(path.join(root, file.replace(/\.js$/, '.html'))),
      `${name}: missing editor html for ${file}`)
  }
})

test('every node module exports a registration function', () => {
  for (const [, file] of declared) {
    const mod = require(path.join(root, file))
    assert.equal(typeof mod, 'function', `${file} must export function (RED) {...}`)
  }
})

test('each node registers the type it is declared under', () => {
  for (const [name, file] of declared) {
    const js = fs.readFileSync(path.join(root, file), 'utf8')
    assert.match(js, new RegExp(`registerType\\(\\s*['"]${name}['"]`),
      `${file} should register the type "${name}"`)
    const html = fs.readFileSync(path.join(root, file.replace(/\.js$/, '.html')), 'utf8')
    assert.match(html, new RegExp(`RED\\.nodes\\.registerType\\(\\s*['"]${name}['"]`),
      `the editor half of ${name} should register it too`)
    assert.match(html, new RegExp(`data-template-name=["']${name}["']`),
      `${name} needs an edit template`)
    assert.match(html, new RegExp(`data-help-name=["']${name}["']`),
      `${name} needs help text; it is the only documentation most users read`)
  }
})

/**
 * Node-RED reads an edit dialog by looking for `#node-input-<property>` for
 * every key in `defaults`. A key with no such element is not an error anywhere:
 * the editor leaves the stored value alone and the field simply cannot be
 * reached, so a setting the runtime honours is only reachable by hand-editing
 * the flow file. That is how identityTtl, vendorId, deviceId and url spent a
 * release being documented in code comments and settable by nobody.
 */
test('every configurable property has somewhere in the dialog to set it', () => {
  // The type half of a typedInput is carried by a hidden field the widget
  // drives; it has no label and nothing to click, which is the point.
  const rendered = new Set(['portType', 'parameterType'])

  for (const [name, file] of declared) {
    const html = fs.readFileSync(path.join(root, file.replace(/\.js$/, '.html')), 'utf8')
    const block = html.match(/defaults:\s*\{([\s\S]*?)\n\s{4}\}/)
    assert.ok(block, `${name}: could not find the defaults block`)

    const isConfig = /category:\s*'config'/.test(html)
    const prefix = isConfig ? 'node-config-input' : 'node-input'
    const template = html.match(
      new RegExp(`data-template-name=["']${name}["']>([\\s\\S]*?)</script>`))
    assert.ok(template, `${name}: could not find the edit template`)

    for (const line of block[1].split('\n')) {
      const property = (line.match(/^\s*(\w+)\s*:/) || [])[1]
      if (!property || rendered.has(property)) continue
      // A property naming a config node type is rendered by the runtime.
      if (/type:\s*'[\w-]+'/.test(line)) continue
      // Either a field of its own, or a value oneditsave builds - which is how
      // a list of tickboxes becomes one array property.
      const hasField = template[1].includes(`id="${prefix}-${property}"`)
      const builtOnSave = new RegExp(`this\\.${property}\\s*=`).test(html)
      assert.ok(hasField || builtOnSave,
        `${name}: "${property}" is in defaults and used at runtime, but the ` +
        `edit dialog has no #${prefix}-${property} to set it`)
    }
  }
})

test('the html files declare no node type that the package does not ship', () => {
  const names = new Set(declared.map(([name]) => name))
  for (const file of fs.readdirSync(path.join(root, 'nodes')).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(root, 'nodes', file), 'utf8')
    for (const match of html.matchAll(/RED\.nodes\.registerType\(\s*['"]([\w-]+)['"]/g)) {
      assert.ok(names.has(match[1]), `${file} registers "${match[1]}", which package.json omits`)
    }
  }
})

test('the files list covers everything the nodes need at runtime', () => {
  // Publishing without lib/ would ship a package that cannot even be loaded.
  for (const needed of ['lib/', 'nodes/']) {
    assert.ok(pkg.files.includes(needed), `package.json "files" must include ${needed}`)
  }
  for (const entry of pkg.files) {
    assert.ok(fs.existsSync(path.join(root, entry.replace(/\/$/, ''))),
      `package.json lists "${entry}", which does not exist`)
  }
})

test('the runtime dependencies are exactly what the code needs', () => {
  // The IODD parser lives in lib/iodd, so the only runtime dependency left is
  // the XML reader it is built on.
  assert.deepEqual(Object.keys(pkg.dependencies), ['fast-xml-parser'])
  // Node-RED itself may never be a runtime dependency: the runtime provides it.
  assert.equal(pkg.dependencies['node-red'], undefined)
  assert.ok(pkg['node-red'].version, 'declare the minimum Node-RED version')
})

test('the package is publishable: npm and the Node-RED library need this', () => {
  for (const field of ['name', 'version', 'description', 'license', 'repository']) {
    assert.ok(pkg[field], `package.json needs "${field}"`)
  }
  // flows.nodered.org only lists packages carrying the node-red keyword.
  assert.ok(pkg.keywords.includes('node-red'), 'keywords must include "node-red"')
})

test('the example flows are valid and only use nodes that exist', () => {
  // Examples ship in the palette's Import menu. A broken one is discovered by
  // a user on their first day with the package, which is the worst moment.
  const dir = path.join(root, 'examples')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  assert.ok(files.length, 'the examples folder should not be empty')

  const ours = new Set(Object.keys(pkg['node-red'].nodes))
  // Node-RED core types an example may lean on without adding a dependency.
  const core = new Set(['tab', 'comment', 'inject', 'debug', 'function', 'switch',
    'change', 'link in', 'link out', 'catch', 'status'])

  for (const file of files) {
    const flow = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    assert.ok(Array.isArray(flow), `${file} must be a flow array`)
    const ids = new Set(flow.map(n => n.id))
    assert.equal(ids.size, flow.length, `${file} has duplicate node ids`)
    for (const node of flow) {
      assert.ok(node.id && node.type, `${file} has a node without an id or type`)
      assert.ok(ours.has(node.type) || core.has(node.type),
        `${file} uses "${node.type}", which is neither ours nor a core node`)
      // Every wire and every config reference must point at a node in the file,
      // or the example imports with a broken link.
      for (const target of (node.wires || []).flat()) {
        assert.ok(ids.has(target), `${file}: ${node.id} wires to unknown ${target}`)
      }
      if (node.master) {
        assert.ok(ids.has(node.master), `${file}: ${node.id} refers to a missing master`)
      }
    }
  }
})

test('every node icon exists, and every icon is used', () => {
  // Node-RED silently falls back to a default icon for a missing file, so a
  // typo here shows up as "why does that node look wrong" and nothing else.
  const dir = path.join(root, 'icons')
  const shipped = fs.readdirSync(dir)
  const used = new Set()

  for (const [name, file] of declared) {
    const html = fs.readFileSync(path.join(root, file.replace(/\.js$/, '.html')), 'utf8')
    const match = html.match(/icon:\s*'([^']+)'/)
    if (!match) continue // a config node has no icon on the canvas
    const icon = match[1]
    if (icon.startsWith('font-awesome/')) continue
    assert.ok(shipped.includes(icon), `${name} wants icons/${icon}, which is not there`)
    used.add(icon)
  }
  for (const icon of shipped) {
    assert.ok(used.has(icon), `icons/${icon} is shipped but no node uses it`)
  }
  assert.ok(pkg.files.includes('icons/'), 'package.json "files" must include icons/')
})

test('the icons are what Node-RED asks for: white, transparent, 2:3', () => {
  for (const name of fs.readdirSync(path.join(root, 'icons'))) {
    const svg = fs.readFileSync(path.join(root, 'icons', name), 'utf8')
    const box = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
    assert.ok(box, `${name} needs a viewBox`)
    assert.equal(Number(box[2]) / Number(box[1]), 1.5, `${name} must keep the 2:3 aspect ratio`)
    assert.ok(Number(box[1]) >= 40, `${name} should be at least 40 x 60`)
    // Anything but white would be invisible on some node colours, and the
    // editor does not recolour a custom icon.
    for (const colour of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)) {
      assert.ok(['#fff', 'none'].includes(colour[1]),
        `${name} paints with ${colour[1]}; node icons are white on transparent`)
    }
    assert.doesNotMatch(svg, /<image|<text/, `${name} should be shapes, not bitmaps or fonts`)
  }
})
