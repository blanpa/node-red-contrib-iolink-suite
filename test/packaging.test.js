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
