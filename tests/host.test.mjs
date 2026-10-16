// Host-half behaviour: storage round-trips, archive/restore, and the one-shot
// enrichment call — driven through fakes so no DSH process is needed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { createTodoCore, normalizeNode, storagePaths, LIMITS } from '../src/host.js'
import { SECTIONS } from '../src/prompt.js'

/**
 * A KV backend backed by plain Maps, mirroring the JSON backend's contract —
 * including "a unit has exactly one live handle" per unit name, which is what
 * makes a leaked handle observable. It serves both the notes unit and the
 * separate settings unit the plugin opens.
 */
function createFakeStorage(initial = {}, initialGlobals = {}) {
  const records = new Map(Object.entries(initial))
  const globals = new Map(Object.entries(initialGlobals))
  const opens = []
  const live = new Set()
  const closedUnits = new Set()
  const makeUnit = (name) => {
    const isNotes = name === 'todonote'
    return {
      async loadAll() {
        return {
          tables: isNotes ? { nodes: Object.fromEntries(records) } : { settings: {} },
          global: globals.has(name) ? globals.get(name) : null,
        }
      },
      async putRecord(table, key, value) {
        assert.equal(table, 'nodes')
        records.set(key, JSON.parse(JSON.stringify(value)))
      },
      async deleteRecord(table, key) {
        assert.equal(table, 'nodes')
        records.delete(key)
      },
      async setGlobal(value) {
        globals.set(name, JSON.parse(JSON.stringify(value)))
      },
      async close() {
        live.delete(name)
        closedUnits.add(name)
      },
    }
  }
  const backend = {
    name: 'json',
    kv: {
      async open(descriptor) {
        if (live.has(descriptor.name)) {
          throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
        }
        opens.push(descriptor)
        live.add(descriptor.name)
        return makeUnit(descriptor.name)
      },
    },
  }
  return {
    records,
    globals,
    opens,
    opensFor: (name) => opens.filter((descriptor) => descriptor.name === name).length,
    isClosed: () => closedUnits.has('todonote'),
    isLive: () => live.size > 0,
    storage: {
      backend: {
        names: () => ['json'],
        get: (name) => {
          if (name !== 'json') throw new Error(`unknown backend ${name}`)
          return backend
        },
      },
    },
  }
}

/** A streaming LLM stub that records every request it is asked to make. */
function createFakeLlm({ chunks, providers = [{ id: 'test', name: 'Test' }], models = [{ id: 'test-model' }] } = {}) {
  const calls = []
  return {
    calls,
    listProviders: () => providers,
    listModels: async () => models,
    stream(options) {
      calls.push(options)
      const script = chunks ?? [
        { type: 'text-delta', index: 0, text: SECTIONS.map((section) => `## ${section}\n- 一条要点`).join('\n\n') },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      return (async function* generate() {
        for (const chunk of script) yield chunk
      })()
    },
  }
}

/** Poll until the predicate holds, so a background refinement can settle. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for the core to settle')
}

/** Build a started core over the fakes. */
async function makeCore({ storage = createFakeStorage(), llm = createFakeLlm(), config, defaultModel } = {}) {
  const core = createTodoCore({
    getStorage: () => storage.storage,
    getLlm: () => llm,
    getDefaultModel: () => defaultModel ?? { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    logger: { info() {}, warn() {}, error() {} },
    config,
  })
  await core.start()
  return { core, storage, llm }
}

test('a fresh core opens the unit and reports an empty store', async () => {
  const { core, storage } = await makeCore()
  assert.deepEqual(storage.opens, [
    { name: 'todonote', version: 1, tables: ['nodes'], hasGlobal: false, layout: 'single' },
    { name: 'todonote-settings', version: 1, tables: ['settings'], hasGlobal: true, layout: 'single' },
  ])
  const state = core.snapshot()
  assert.equal(state.nodes.length, 0)
  assert.equal(state.storage.ok, true)
  assert.equal(state.storage.backend, 'json')
  assert.deepEqual(state.sections, SECTIONS)
  assert.deepEqual(state.preferences, { provider: '', model: '', alignPrompt: '' })
  await core.close()
  assert.equal(storage.isClosed(), true)
})

test('creating a note persists the user text and derives a missing title', async () => {
  const { core, storage } = await makeCore()
  const node = await core.create({ body: '# 想做的事\n第二行', workspaceId: 'ws-1', workspaceTitle: 'work', workspacePath: 'D:\\work' })
  assert.equal(node.title, '想做的事')
  assert.equal(node.status, 'active')
  assert.equal(node.refine.status, 'idle')
  assert.equal(storage.records.size, 1)
  assert.equal(storage.records.get(node.id).workspacePath, 'D:\\work')
  await core.close()
})

test('update changes only the user-owned fields', async () => {
  const { core } = await makeCore()
  const node = await core.create({ title: 'a', body: 'b' })
  await core.refine({ id: node.id })
  await waitFor(() => core.snapshot().nodes[0].refine.status === 'done')
  const updated = await core.update({ id: node.id, title: 'c', body: 'd' })
  assert.equal(updated.title, 'c')
  assert.equal(updated.body, 'd')
  assert.equal(updated.refine.status, 'done', 'a plain edit never clears the AI supplement')
  await core.close()
})

test('archiving keeps the note readable and restores it', async () => {
  const { core } = await makeCore()
  const node = await core.create({ title: '归档我', body: 'x' })
  const archived = await core.archive({ id: node.id, archived: true })
  assert.equal(archived.status, 'archived')
  assert.ok(archived.archivedAt)
  assert.equal(core.snapshot().nodes[0].title, '归档我')
  const restored = await core.archive({ id: node.id, archived: false })
  assert.equal(restored.status, 'active')
  assert.equal(restored.archivedAt, '')
  await core.close()
})

test('removing a note drops it from the store and the snapshot', async () => {
  const { core, storage } = await makeCore()
  const node = await core.create({ title: '删我', body: 'x' })
  await core.remove({ id: node.id })
  assert.equal(storage.records.size, 0)
  assert.equal(core.snapshot().nodes.length, 0)
  await core.close()
})

test('an unknown id fails loud instead of writing a new note', async () => {
  const { core } = await makeCore()
  await assert.rejects(() => core.update({ id: 'nope', title: 'x' }), /便签不存在/)
  await assert.rejects(() => core.refine({ id: 'nope' }), /便签不存在/)
  await core.close()
})

test('enrichment asks the model with no tools and stores the answer beside the user text', async () => {
  const llm = createFakeLlm()
  const { core } = await makeCore({ llm })
  const node = await core.create({ title: '接入日志', body: '我写的原文' })
  const started = await core.refine({ id: node.id, hint: '看看成本' })
  assert.equal(started.refine.status, 'running')
  await waitFor(() => core.snapshot().nodes[0].refine.status === 'done')

  assert.equal(llm.calls.length, 1)
  const request = llm.calls[0]
  assert.equal(request.provider, 'test')
  assert.equal(request.model, 'test-model')
  assert.equal(request.tools, undefined, 'a one-shot call exposes no tools, so the model cannot execute anything')
  assert.equal(request.messages.length, 1)
  assert.equal(request.messages[0].role, 'user')
  assert.equal(request.messages[0].content[0].type, 'text')
  assert.match(request.messages[0].content[0].text, /我写的原文/)
  assert.match(request.messages[0].content[0].text, /看看成本/)

  const settled = core.snapshot().nodes[0]
  assert.equal(settled.body, '我写的原文', 'the user text is untouched')
  assert.equal(settled.refine.status, 'done')
  assert.match(settled.refine.content, /## 背景/)
  assert.equal(settled.refine.warning, '')
  assert.equal(settled.refine.model, 'test-model')
  await core.close()
})

test('an answer missing sections is stored with a warning', async () => {
  const llm = createFakeLlm({ chunks: [
    { type: 'text-delta', index: 0, text: '## 背景\n- 只有背景' },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  const { core } = await makeCore({ llm })
  const node = await core.create({ title: 'x', body: 'y' })
  await core.refine({ id: node.id })
  await waitFor(() => core.snapshot().nodes[0].refine.status !== 'running')
  assert.match(core.snapshot().nodes[0].refine.warning, /边界/)
  await core.close()
})

test('a terminal error finish settles the note as failed', async () => {
  const llm = createFakeLlm({ chunks: [
    { type: 'text-delta', index: 0, text: '## 背景' },
    { type: 'finish', reason: { kind: 'error', failure: { message: '额度用完了' } } },
  ] })
  const { core } = await makeCore({ llm })
  const node = await core.create({ title: 'x', body: 'y' })
  await core.refine({ id: node.id })
  await waitFor(() => core.snapshot().nodes[0].refine.status !== 'running')
  const refine = core.snapshot().nodes[0].refine
  assert.equal(refine.status, 'error')
  assert.match(refine.error, /额度用完了/)
  await core.close()
})

test('a second refinement keeps the previous answer in history', async () => {
  const llm = createFakeLlm()
  const { core } = await makeCore({ llm })
  const node = await core.create({ title: 'x', body: 'y' })
  await core.refine({ id: node.id })
  await waitFor(() => core.snapshot().nodes[0].refine.status === 'done')
  const first = core.snapshot().nodes[0].refine.content
  await core.refine({ id: node.id })
  await waitFor(() => core.snapshot().nodes[0].refine.status === 'done')
  const refine = core.snapshot().nodes[0].refine
  assert.equal(refine.history.length, 1)
  assert.equal(refine.history[0].content, first)
  await core.close()
})

test('a refinement is refused while the note is already running', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const llm = {
    calls: [],
    listProviders: () => [{ id: 'test' }],
    listModels: async () => [{ id: 'm' }],
    stream() {
      return (async function* generate() {
        await gate
        yield { type: 'text-delta', index: 0, text: '## 背景' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const { core } = await makeCore({ llm })
  const node = await core.create({ title: 'x', body: 'y' })
  await core.refine({ id: node.id })
  await assert.rejects(() => core.refine({ id: node.id }), /正在完善中/)
  release()
  await waitFor(() => core.snapshot().nodes[0].refine.status !== 'running')
  await core.close()
})

test('nodes left running by a restart are settled on open', async () => {
  const stored = normalizeNode({
    id: 'kept',
    title: '上次没跑完',
    body: 'x',
    refine: { status: 'running', content: '旧的补充' },
  }, 'kept')
  const { core } = await makeCore({ storage: createFakeStorage({ kept: stored }) })
  const node = core.snapshot().nodes[0]
  assert.equal(node.refine.status, 'error')
  assert.match(node.refine.error, /重启/)
  assert.equal(node.refine.content, '旧的补充')
  await core.close()
})

test('storage that cannot be opened is reported instead of throwing', async () => {
  const core = createTodoCore({
    getStorage: () => ({ backend: { names: () => ['memory'], get: () => ({}) } }),
    getLlm: () => undefined,
    logger: { info() {}, warn() {} },
    config: { backend: 'json' },
  })
  await core.start()
  const state = core.snapshot()
  assert.equal(state.storage.ok, false)
  assert.match(state.storage.error, /没有可用的 KV 存储后端/)
  await core.close()
})

test('a missing model provider is reported to the note, not thrown at the caller', async () => {
  const llm = { calls: [], listProviders: () => [], listModels: async () => [], stream() { throw new Error('never reached') } }
  const { core } = await makeCore({ llm, defaultModel: { currentSelection: () => undefined } })
  const node = await core.create({ title: 'x', body: 'y' })
  await core.refine({ id: node.id })
  await waitFor(() => core.snapshot().nodes[0].refine.status !== 'running')
  assert.match(core.snapshot().nodes[0].refine.error, /没有可用的模型提供方/)
  await core.close()
})

test('wire values are bounded before they reach storage', async () => {
  const { core } = await makeCore()
  const node = await core.create({ title: 'x'.repeat(500), body: 'y'.repeat(LIMITS.body + 500) })
  assert.equal(node.title.length, LIMITS.title)
  assert.equal(node.body.length, LIMITS.body)
  await core.close()
})

test('a replacement generation adopts the live unit instead of reopening it', async () => {
  const storage = createFakeStorage()
  const first = await makeCore({ storage })
  const second = createTodoCore({
    getStorage: () => storage.storage,
    getLlm: () => undefined,
    logger: { info() {}, warn() {} },
    config: {},
  })
  await second.start()
  assert.equal(storage.opensFor('todonote'), 1, 'the same backend serves one live handle to both generations')
  assert.equal(storage.opensFor('todonote-settings'), 1, 'the settings unit is adopted too')
  assert.equal(second.snapshot().storage.ok, true)

  await first.core.close()
  assert.equal(storage.isLive(), true, 'the unit stays open while another generation holds a reference')
  await second.close()
  assert.equal(storage.isLive(), false, 'the last release closes the unit')
})

test('a core disposed while opening does not leak the unit', async () => {
  const storage = createFakeStorage()
  const makeCoreOver = () => createTodoCore({
    getStorage: () => storage.storage,
    getLlm: () => undefined,
    logger: { info() {}, warn() {} },
    config: {},
  })

  const disposed = makeCoreOver()
  const starting = disposed.start()
  await disposed.close()
  await starting
  assert.equal(storage.isLive(), false, 'the in-flight open is handed back, not leaked')

  const replacement = makeCoreOver()
  await replacement.start()
  assert.equal(replacement.snapshot().storage.ok, true, 'a later generation can still open the unit')
  await replacement.close()
})

test('the console can pin the enrichment model, and the choice outlives the process', async () => {
  const llm = createFakeLlm({ providers: [{ id: 'a' }, { id: 'b' }], models: [{ id: 'm1' }, { id: 'm2' }] })
  const storage = createFakeStorage()
  const first = await makeCore({
    storage,
    llm,
    config: { provider: 'a', model: 'm1' },
    defaultModel: { currentSelection: () => ({ provider: 'a', model: 'm1' }) },
  })
  assert.deepEqual(
    await first.core.saveSettings({ provider: 'b', model: 'm2', alignPrompt: '先和我对齐' }),
    { provider: 'b', model: 'm2', alignPrompt: '先和我对齐' },
  )
  assert.deepEqual(first.core.snapshot().preferences, { provider: 'b', model: 'm2', alignPrompt: '先和我对齐' })

  const node = await first.core.create({ title: 'x', body: 'y' })
  await first.core.refine({ id: node.id })
  await waitFor(() => first.core.snapshot().nodes[0].refine.status !== 'running')
  assert.equal(llm.calls[0].provider, 'b', 'the console choice beats the row config and the default')
  assert.equal(llm.calls[0].model, 'm2')
  await first.core.close()

  const second = createTodoCore({
    getStorage: () => storage.storage,
    getLlm: () => llm,
    getDefaultModel: () => ({ currentSelection: () => ({ provider: 'a', model: 'm1' }) }),
    logger: { info() {}, warn() {} },
    config: {},
  })
  await second.start()
  assert.deepEqual(
    second.snapshot().preferences,
    { provider: 'b', model: 'm2', alignPrompt: '先和我对齐' },
    'the choice is read back from storage',
  )
  await second.close()
})

test('the model catalog lists providers, their models and the live default', async () => {
  const llm = createFakeLlm({ providers: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }], models: [{ id: 'm1', name: 'One' }] })
  const { core } = await makeCore({ llm, defaultModel: { currentSelection: () => ({ provider: 'a', model: 'm1' }) } })
  const catalog = await core.catalog()
  assert.equal(catalog.providers.length, 2)
  assert.deepEqual(catalog.providers[1], { id: 'b', name: 'Beta', models: [{ id: 'm1', name: 'One' }] })
  assert.deepEqual(catalog.fallback, { provider: 'a', model: 'm1' })
  assert.deepEqual(catalog.selected, { provider: '', model: '', alignPrompt: '' })
  await core.close()
})

test('an invalid or half-given model choice is refused', async () => {
  const { core } = await makeCore()
  await assert.rejects(() => core.saveSettings({ provider: 'test', model: '' }), /要么都选/)
  await assert.rejects(() => core.saveSettings({ provider: '', model: 'm' }), /要么都选/)
  await assert.rejects(() => core.saveSettings({ provider: 'ghost', model: 'm' }), /不可用/)
  assert.deepEqual(await core.saveSettings({ provider: '', model: '' }), { provider: '', model: '', alignPrompt: '' })
  await core.close()
})

test('stored records are normalized on read, and unusable ones are dropped', async () => {
  assert.equal(normalizeNode(null, ''), undefined)
  const node = normalizeNode({ title: 'x' }, 'key-1')
  assert.equal(node.id, 'key-1')
  assert.equal(node.status, 'active')
  assert.deepEqual(node.refine.history, [])
})

test('the reported storage path follows DSH_HOME, falling back to ~/.dsh', () => {
  assert.equal(storagePaths({ DSH_HOME: 'D:/custom' }, '/home/me').dir, join('D:/custom', 'storages'))
  assert.equal(storagePaths({}, '/home/me').dir, join('/home/me', '.dsh', 'storages'))
  assert.equal(storagePaths({ DSH_HOME: '   ' }, '/home/me').dir, join('/home/me', '.dsh', 'storages'))
  assert.equal(storagePaths({ DSH_HOME: '~/elsewhere' }, '/home/me').dir, join('/home/me', 'elsewhere', 'storages'))
  const paths = storagePaths({}, '/home/me')
  assert.equal(paths.nodes, join(paths.dir, 'todonote.json'))
  assert.equal(paths.settings, join(paths.dir, 'todonote-settings.json'))
  assert.equal(typeof paths.nodesExists, 'boolean')
})
