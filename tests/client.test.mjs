// Browser-half wiring and render behaviour, checked without a browser: the
// built lib/client.js is loaded exactly as the DSH module system loads it, its
// factory is run against a stub React and a fake client context, and the
// registered components are called with framework-shaped props.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Minimal React stand-in: hooks are positional cells, state survives a re-render. */
function createReactStub() {
  let cursor = 0
  const cells = []
  const pendingEffects = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next }]
    },
    useMemo(compute) {
      cursor++
      return compute()
    },
    /** Effects are collected and run right after the component returns. */
    useEffect(effect) {
      cursor++
      pendingEffects.push(effect)
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = { current: initial }
      return cells[index]
    },
  }
  /** Run the pending effects, as React does after paint. */
  const flush = () => {
    const queued = pendingEffects.splice(0, pendingEffects.length)
    for (const effect of queued) effect()
  }
  return {
    React,
    render(Component, props) {
      cursor = 0
      const tree = Component(props)
      flush()
      return tree
    },
    /** Re-render from the top, keeping hook state, as React would after a setState. */
    rerender(Component, props) {
      cursor = 0
      const tree = Component(props)
      flush()
      return tree
    },
    /** Forget every hook cell, so one test cannot inherit another's state. */
    resetHooks() {
      cursor = 0
      cells.length = 0
      pendingEffects.length = 0
    },
  }
}

/** Whether an element type is a test-provided primitive, which is never expanded. */
function isPrimitiveType(type) {
  return Object.values(primitives).includes(type)
}

/** Inline a function component's output, the way React would before painting it. */
function expand(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  if (typeof node.type === 'function' && !isPrimitiveType(node.type)) return expand(node.type(node.props))
  return node
}

/** Depth-first search over the element tree, expanding feature components. */
function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, found)
    return found
  }
  const rendered = expand(node)
  if (Array.isArray(rendered)) {
    for (const item of rendered) findAll(item, predicate, found)
    return found
  }
  if (rendered === null || typeof rendered !== 'object') return found
  if (rendered.type !== undefined && predicate(rendered)) found.push(rendered)
  for (const child of rendered.children ?? []) findAll(child, predicate, found)
  return found
}

/** Collect every text leaf, for copy assertions. */
function textOf(node, parts = []) {
  if (Array.isArray(node)) {
    for (const item of node) textOf(item, parts)
    return parts
  }
  if (typeof node === 'string' || typeof node === 'number') {
    parts.push(String(node))
    return parts
  }
  const rendered = expand(node)
  if (Array.isArray(rendered)) {
    for (const item of rendered) textOf(item, parts)
    return parts
  }
  if (rendered === null || typeof rendered !== 'object') return parts
  for (const child of rendered.children ?? []) textOf(child, parts)
  return parts
}

/** Install the page globals the browser half touches. */
function installDom() {
  const styles = []
  const storage = new Map()
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
    },
  }
  globalThis.document = {
    getElementById: (id) => styles.find((style) => style.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (style) => { styles.push(style) } },
  }
  return styles
}

const react = createReactStub()
const clipboard = { writes: [] }
const primitives = {
  Button: function Button() {},
  Input: function Input() {},
  Modal: function Modal() {},
  SegmentedTabs: function SegmentedTabs() {},
  MarkdownText: function MarkdownText() {},
  IconChecklistOutlineRegular: function IconChecklistOutlineRegular() {},
  IconPlusOutlineRegular: function IconPlusOutlineRegular() {},
  IconArchiveOutlineRegular: function IconArchiveOutlineRegular() {},
  writeClipboard: async (text) => { clipboard.writes.push(text); return true },
}

const styles = installDom()
const registration = { current: null }
globalThis.window.__ModuleLoader__ = { load: (value) => { registration.current = value } }
await import(pathToFileURL(path.join(ROOT, 'lib/client.js')).href)

const plugin = registration.current.factory((specifier) => {
  if (specifier === 'react') return react.React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
})

/** A client context that records slot registrations, RPC traffic and jumps. */
function createClientContext(handlers = {}, services = null) {
  const registrations = []
  const injections = []
  const calls = []
  const panels = []
  const jumps = []
  const available = services ?? {
    uiWorkspace: {
      startSession(workspaceId, options) {
        jumps.push({ workspaceId, ...options })
      },
    },
  }
  const ctx = {
    connection: {
      rpc: {
        async call(channel, endpoint, payload) {
          calls.push({ channel, endpoint, payload })
          const handler = handlers[endpoint]
          if (handler === undefined) return { ok: true, value: { nodes: [] } }
          const result = handler(payload)
          if (result instanceof Error) return { ok: false, error: { code: 'todonote/failed', message: result.message, details: {} } }
          return { ok: true, value: result }
        },
      },
    },
    layout: { selectPanel: (id) => { panels.push(id) } },
    get: (name) => available[name],
    effect(fn) {
      const dispose = fn()
      return dispose
    },
    slots: {
      inject(key, callback) {
        injections.push({ key, callback })
        return () => {}
      },
      register(options, Component) {
        const entry = { options, Component }
        registrations.push(entry)
        return () => {}
      },
    },
  }
  return { ctx, registrations, injections, calls, panels, jumps }
}

/** Run apply() and resolve every slot injection, as the renderer would. */
function boot(handlers, services) {
  react.resetHooks()
  const harness = createClientContext(handlers, services)
  plugin.apply(harness.ctx)
  for (const injection of harness.injections) injection.callback()
  return harness
}

/** Standard seats for a root-scoped registration. */
function seats(face, { workspaces = [], sessions = {} } = {}) {
  return {
    useTodo: (selector) => selector(face.hooks.todo.getSnapshot()),
    useWorkspaces: (selector) => selector({ items: workspaces }),
    useSessions: (selector) => selector({ byId: sessions }),
    usePanelInfo: (selector) => selector({ activePanelId: null }),
  }
}

const NODE = {
  id: 'n1',
  title: '接入审计日志',
  body: '我自己的原文',
  workspaceId: 'ws-1',
  workspaceTitle: 'work',
  workspacePath: 'D:\\work',
  status: 'active',
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
  archivedAt: '',
  refine: {
    status: 'done',
    content: '## 背景\n- 补充',
    provider: 'test',
    model: 'test-model',
    at: '2026-10-16T01:00:00.000Z',
    error: '',
    warning: '',
    startedAt: '',
    history: [],
  },
}

test('the built client bundle registers the package id and a factory', () => {
  assert.equal(registration.current.id, 'dsh-todonote')
  assert.equal(typeof registration.current.factory, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'connection', 'layout'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the console panel, the sidebar glyph and the overlay', () => {
  const harness = boot()
  const byName = (name) => harness.registrations.filter((entry) => entry.options.name === name)
  assert.equal(byName('main').length, 1)
  assert.equal(byName('main')[0].options.key, 'todonote')
  assert.equal(byName('sidebar.panellist').length, 1)
  assert.equal(byName('sidebar.panellist')[0].options.id, 'todonote', 'the sidebar id must be the main key')
  assert.equal(byName('shell.overlay').length, 1)
  assert.equal(byName('shell.overlay')[0].options.id, 'todonote.ball')
  const types = harness.registrations.map((entry) => entry.Component).every((component) => typeof component === 'function')
  assert.equal(types, true)
  assert.equal(styles.length, 1, 'the stylesheet is injected once')
})

test('the injected face exposes the shared observable and the action table', () => {
  const harness = boot()
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  assert.equal(typeof face.hooks.todo.getSnapshot, 'function')
  assert.equal(typeof face.hooks.todo.subscribe, 'function')
  for (const action of ['refresh', 'select', 'setView', 'openCreate', 'openEdit', 'patchEditor', 'bindWorkspace', 'closeEditor', 'save', 'setArchived', 'remove', 'refine', 'copy', 'dismissNotice', 'openConsole']) {
    assert.equal(typeof face.todo[action], 'function', `action ${action} exists`)
  }
})

test('the overlay face and the panel face share one store', () => {
  const harness = boot()
  const main = harness.registrations.find((entry) => entry.options.name === 'main').options.inject()
  const overlay = harness.registrations.find((entry) => entry.options.name === 'shell.overlay').options.inject()
  assert.equal(main.hooks.todo, overlay.hooks.todo)
  assert.equal(main.todo, overlay.todo)
})

test('refresh pulls the notes over the plugin channel', async () => {
  const harness = boot({ state: () => ({ nodes: [NODE], total: 1, truncated: false, storage: { ok: true, backend: 'json', error: '' } }) })
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  await face.todo.refresh()
  assert.deepEqual(harness.calls[0], { channel: '/todonote', endpoint: 'state', payload: {} })
  assert.equal(face.hooks.todo.getSnapshot().nodes.length, 1)
  assert.equal(face.hooks.todo.getSnapshot().phase, 'ready')
})

test('a failing host call surfaces as a notice instead of an exception', async () => {
  const harness = boot({ refine: () => new Error('这条便签正在完善中') })
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  await face.todo.refine('n1', '')
  assert.equal(face.hooks.todo.getSnapshot().notice, '这条便签正在完善中')
})

test('the console renders the note, never merges the AI text into it, and copies both', async () => {
  const harness = boot({ state: () => ({ nodes: [NODE], total: 1, truncated: false, storage: { ok: true, backend: 'json', error: '' } }) })
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  await face.todo.refresh()

  const props = { ...seats(face), ...face }
  const tree = react.render(main.Component, props)
  const text = textOf(tree).join('|')
  assert.match(text, /接入审计日志/)
  assert.match(text, /我自己的原文/)
  assert.match(text, /AI 完善/)
  assert.match(text, /计划便签/)

  const copyButton = findAll(tree, (node) => node.type === primitives.Button && textOf(node).join('') === '复制')[0]
  assert.ok(copyButton, 'the copy action is rendered')
  await copyButton.props.onClick()
  assert.equal(clipboard.writes.length, 1)
  assert.match(clipboard.writes[0], /## 我的内容/)
  assert.match(clipboard.writes[0], /我自己的原文/)
  assert.match(clipboard.writes[0], /## AI 完善/)
  assert.match(clipboard.writes[0], /## 背景/)
})

test('the refine button asks the host to enrich exactly one note', async () => {
  const harness = boot({ state: () => ({ nodes: [NODE], total: 1, truncated: false, storage: { ok: true, backend: 'json', error: '' } }) })
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  await face.todo.refresh()
  const tree = react.render(main.Component, { ...seats(face), ...face })
  const refine = findAll(tree, (node) => node.type === primitives.Button && textOf(node).join('') === '重新完善')[0]
  assert.ok(refine, 'a refined note offers a re-run')
  await refine.props.onClick()
  const call = harness.calls.find((entry) => entry.endpoint === 'refine')
  assert.deepEqual(call.payload, { id: 'n1', hint: '' })
})

test('archived notes stay reachable behind the archived tab', async () => {
  const archived = { ...NODE, id: 'n2', title: '旧计划', status: 'archived', archivedAt: '2026-10-16T02:00:00.000Z' }
  const harness = boot({ state: () => ({ nodes: [NODE, archived], total: 2, truncated: false, storage: { ok: true, backend: 'json', error: '' } }) })
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  await face.todo.refresh()
  const activeProps = { ...seats(face), ...face }
  const activeTree = react.render(main.Component, activeProps)
  assert.equal(textOf(activeTree).join('|').includes('旧计划'), false, 'archived notes are not in the active list')

  face.todo.setView('archived')
  const archivedTree = react.rerender(main.Component, { ...seats(face), ...face })
  const text = textOf(archivedTree).join('|')
  assert.match(text, /旧计划/)
  assert.match(text, /取消归档/)
})

test('creating a note from the console sends the draft to the host', async () => {
  const harness = boot({ state: () => ({ nodes: [], total: 0, truncated: false, storage: { ok: true, backend: 'json', error: '' } }), create: () => NODE })
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  await face.todo.refresh()
  face.todo.openCreate({ workspaceId: 'ws-1', workspaceTitle: 'work', workspacePath: 'D:\\work' })
  face.todo.patchEditor({ title: '新计划', body: '正文' })
  await face.todo.save()
  const call = harness.calls.find((entry) => entry.endpoint === 'create')
  assert.equal(call.payload.title, '新计划')
  assert.equal(call.payload.body, '正文')
  assert.equal(call.payload.workspaceId, 'ws-1')
  assert.equal(face.hooks.todo.getSnapshot().editor, null, 'the editor closes after a save')
})

test('the floating ball hides without a session and appears with one', () => {
  const harness = boot()
  const overlay = harness.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const face = overlay.options.inject()

  const empty = react.render(overlay.Component, { ...seats(face), ...face })
  assert.equal(findAll(empty, (node) => node.props.className === 'tn-ball').length, 0, 'no session means no ball')

  const sessionId = 's1'
  const withSession = {
    ...seats(face, {
      workspaces: [{ workspaceId: 'ws-1', title: 'work', path: 'D:\\work', sessionIds: [sessionId] }],
      sessions: { [sessionId]: { id: sessionId, retainedBy: { mainView: 1 }, displayTitle: '会话' } },
    }),
    ...face,
  }
  const tree = react.render(overlay.Component, withSession)
  const ball = findAll(tree, (node) => node.props.className === 'tn-ball')[0]
  assert.ok(ball, 'a workspace session shows the ball')
  assert.equal(ball.props['aria-label'], '计划便签：记一条')

  const event = { clientX: 1200, clientY: 760, pointerId: 1, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} } }
  ball.props.onPointerDown(event)
  ball.props.onPointerUp({ ...event, clientX: 1200, clientY: 760 })
  const opened = react.rerender(overlay.Component, withSession)
  assert.ok(findAll(opened, (node) => node.props.className === 'tn-quick')[0], 'a tap opens the quick create card')
})

test('the floating ball saves a note bound to the open workspace', async () => {
  const harness = boot({ state: () => ({ nodes: [], total: 0, truncated: false, storage: { ok: true, backend: 'json', error: '' } }), create: () => NODE })
  const overlay = harness.registrations.find((entry) => entry.options.name === 'shell.overlay')
  const face = overlay.options.inject()
  const sessionId = 's1'
  const props = {
    ...seats(face, {
      workspaces: [{ workspaceId: 'ws-1', title: 'work', path: 'D:\\work', sessionIds: [sessionId] }],
      sessions: { [sessionId]: { id: sessionId, retainedBy: { mainView: 1 } } },
    }),
    ...face,
  }

  const tree = react.render(overlay.Component, props)
  const ball = findAll(tree, (node) => node.props.className === 'tn-ball')[0]
  const event = { clientX: 1200, clientY: 760, pointerId: 1, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} } }
  ball.props.onPointerDown(event)
  ball.props.onPointerUp(event)

  // Each edit re-renders, exactly as React would, so the save handler sees the
  // draft the user just typed.
  let opened = react.rerender(overlay.Component, props)
  findAll(opened, (node) => node.type === primitives.Input)[0].props.onChange({ target: { value: '碎屑想法' } })
  opened = react.rerender(overlay.Component, props)
  findAll(opened, (node) => node.type === 'textarea')[0].props.onChange({ target: { value: '写点东西' } })
  opened = react.rerender(overlay.Component, props)

  const save = findAll(opened, (node) => node.type === primitives.Button && textOf(node).join('') === '保存')[0]
  assert.ok(save, 'the quick card offers 保存')
  await save.props.onClick()

  const call = harness.calls.find((entry) => entry.endpoint === 'create')
  assert.ok(call, 'saving from the ball creates a note')
  assert.equal(call.payload.title, '碎屑想法')
  assert.equal(call.payload.body, '写点东西')
  assert.equal(call.payload.workspaceId, 'ws-1')
  assert.equal(call.payload.workspacePath, 'D:\\work')
})

test('the sidebar glyph renders the icon bare', () => {
  const harness = boot()
  const entry = harness.registrations.find((item) => item.options.name === 'sidebar.panellist')
  const glyph = entry.Component({ size: 18, active: false })
  assert.equal(glyph.type, primitives.IconChecklistOutlineRegular)
  assert.equal(glyph.props.size, 18)
})

test('the settings dialog picks the enrichment model and saves it to the host', async () => {
  const harness = boot({
    state: () => ({
      nodes: [],
      total: 0,
      truncated: false,
      storage: { ok: true, backend: 'json', error: '' },
      preferences: { provider: '', model: '', alignPrompt: '' },
    }),
    models: () => ({
      providers: [{ id: 'a', name: 'Alpha', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }],
      fallback: { provider: 'a', model: 'm1' },
      selected: { provider: '', model: '', alignPrompt: '' },
    }),
    'settings/set': (payload) => ({ provider: payload.provider, model: payload.model, alignPrompt: payload.alignPrompt }),
  })
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  await face.todo.refresh()

  face.todo.openSettings()
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  const opened = face.hooks.todo.getSnapshot()
  assert.equal(opened.settingsOpen, true)
  assert.equal(opened.catalog.providers.length, 1)
  assert.deepEqual(harness.calls.find((entry) => entry.endpoint === 'models').payload, {})

  const tree = react.render(main.Component, { ...seats(face), ...face })
  const modal = findAll(tree, (node) => node.type === primitives.Modal)[0]
  assert.ok(modal, 'the settings dialog renders')
  assert.equal(modal.props.title, '设置')
  const providerSelect = findAll(modal, (node) => node.type === 'select')[0]
  assert.equal(providerSelect.props.value, '', 'it opens on "follow the default"')
  providerSelect.props.onChange({ target: { value: 'a' } })
  assert.deepEqual(
    face.hooks.todo.getSnapshot().settingsDraft,
    { provider: 'a', model: 'm1', alignPrompt: '' },
    'choosing a provider preselects its first model',
  )

  await face.todo.saveSettings()
  assert.deepEqual(
    harness.calls.find((entry) => entry.endpoint === 'settings/set').payload,
    { provider: 'a', model: 'm1', alignPrompt: '' },
  )
  const saved = face.hooks.todo.getSnapshot()
  assert.deepEqual(saved.preferences, { provider: 'a', model: 'm1', alignPrompt: '' })
  assert.equal(saved.settingsOpen, false, 'saving closes the dialog')

  const pinned = react.rerender(main.Component, { ...seats(face), ...face })
  assert.match(textOf(pinned).join('|'), /完善模型：a \/ m1/, 'the header shows the pinned model')
})

test('a rejected model choice surfaces as a notice and keeps the dialog open', async () => {
  const harness = boot({
    state: () => ({
      nodes: [],
      total: 0,
      truncated: false,
      storage: { ok: true, backend: 'json', error: '' },
      preferences: { provider: '', model: '', alignPrompt: '' },
    }),
    models: () => ({ providers: [{ id: 'a', name: 'Alpha', models: [] }], fallback: null, selected: { provider: '', model: '', alignPrompt: '' } }),
    'settings/set': () => new Error('提供方 ghost 当前不可用'),
  })
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  face.todo.openSettings()
  face.todo.patchSettings({ provider: 'ghost', model: 'x' })
  await face.todo.saveSettings()
  const state = face.hooks.todo.getSnapshot()
  assert.equal(state.notice, '提供方 ghost 当前不可用')
  assert.equal(state.settingsOpen, true)
})

/** Render the console over one note and return the face for assertions. */
async function consoleOver(harness, node) {
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  await face.todo.refresh()
  const props = { ...seats(face), ...face }
  const tree = react.render(main.Component, props)
  return { face, tree, node: node ?? NODE }
}

test('the detail view hands the note to its workspace session, preset line first', async () => {
  const harness = boot({
    state: () => ({
      nodes: [NODE],
      total: 1,
      truncated: false,
      storage: { ok: true, backend: 'json', error: '' },
      preferences: { provider: '', model: '', alignPrompt: '先和我对齐再动手' },
    }),
  })
  const { face, tree } = await consoleOver(harness)
  const align = findAll(tree, (node) => node.type === primitives.Button && textOf(node).join('') === '去工作区对齐')[0]
  assert.ok(align, 'the align action is rendered')
  assert.equal(align.props.disabled, false)
  align.props.onClick()

  assert.equal(harness.jumps.length, 1)
  const jump = harness.jumps[0]
  assert.equal(jump.workspaceId, 'ws-1')
  const queued = face.hooks.todo.getSnapshot().pendingPrompt
  assert.ok(queued.startsWith('先和我对齐再动手\n\n'), 'the configured preset leads')
  assert.match(queued, /# 接入审计日志/)
  assert.match(queued, /我自己的原文/)
  assert.match(queued, /## 背景/, 'the AI supplement travels with it')
})

test('the session-scoped entry drops the queued plan into the composer', async () => {
  const harness = boot()
  const dock = harness.registrations.find((entry) => entry.options.name === 'conversation.input.dock')
  assert.ok(dock, 'the composer dock entry is registered')
  const face = dock.options.inject()
  face.todo.queueDraft('和我对齐下面的计划\n\n# 一条便签')
  const written = []
  const props = {
    ...face,
    useTodo: (selector) => selector(face.hooks.todo.getSnapshot()),
    inputActions: { setDraft: (text) => { written.push(text) } },
  }
  react.render(dock.Component, props)
  await new Promise((resolve) => { setTimeout(resolve, 150) })
  assert.deepEqual(written, ['和我对齐下面的计划\n\n# 一条便签'])
  const state = face.hooks.todo.getSnapshot()
  assert.equal(state.pendingPrompt, '', 'the queue is cleared after it lands')
  assert.equal(state.notice, '计划已填进输入框（不会自动发送）')
})

test('a client without inputActions says so instead of silently losing the plan', async () => {
  const harness = boot()
  const dock = harness.registrations.find((entry) => entry.options.name === 'conversation.input.dock')
  const face = dock.options.inject()
  face.todo.queueDraft('some plan')
  react.render(dock.Component, {
    ...face,
    useTodo: (selector) => selector(face.hooks.todo.getSnapshot()),
    inputActions: undefined,
  })
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  const state = face.hooks.todo.getSnapshot()
  assert.equal(state.pendingPrompt, '')
  assert.match(state.notice, /没有提供输入框填充能力/)
})

test('aligning is refused without a bound workspace, and without the client service', async () => {
  const unbound = { ...NODE, workspaceId: '', workspaceTitle: '', workspacePath: '' }
  const harness = boot({ state: () => ({ nodes: [unbound], total: 1, truncated: false, storage: { ok: true, backend: 'json', error: '' }, preferences: { provider: '', model: '', alignPrompt: '' } }) })
  const { face, tree } = await consoleOver(harness, unbound)
  const align = findAll(tree, (node) => node.type === primitives.Button && textOf(node).join('') === '去工作区对齐')[0]
  assert.equal(align.props.disabled, true, 'the button is disabled without a workspace')
  align.props.onClick()
  assert.equal(harness.jumps.length, 0)
  assert.equal(face.hooks.todo.getSnapshot().notice, '这条便签没有绑定工作区，先在标题下面绑一个。')

  const bare = boot(
    { state: () => ({ nodes: [NODE], total: 1, truncated: false, storage: { ok: true, backend: 'json', error: '' }, preferences: { provider: '', model: '', alignPrompt: '' } }) },
    {},
  )
  const second = await consoleOver(bare)
  const button = findAll(second.tree, (node) => node.type === primitives.Button && textOf(node).join('') === '去工作区对齐')[0]
  button.props.onClick()
  assert.equal(second.face.hooks.todo.getSnapshot().notice, '当前客户端没有工作区导航能力，无法跳转。')
})

const OTHER = {
  ...NODE,
  id: 'n2',
  title: '压测脚本改成可配置',
  body: '并发数写死了',
  workspaceId: 'ws-2',
  workspaceTitle: 'Study',
  workspacePath: 'D:\\Study',
}

test('the console filters notes by workspace, including the unbound ones', async () => {
  const unbound = { ...NODE, id: 'n3', title: '还没想好放哪', workspaceId: '', workspaceTitle: '', workspacePath: '' }
  const harness = boot({
    state: () => ({ nodes: [NODE, OTHER, unbound], total: 3, truncated: false, storage: { ok: true, backend: 'json', error: '' }, preferences: { provider: '', model: '', alignPrompt: '' } }),
  })
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  await face.todo.refresh()
  const workspaces = [
    { workspaceId: 'ws-1', title: 'DSHarness', path: 'D:\\DSHarness', sessionIds: [] },
    { workspaceId: 'ws-2', title: 'Study', path: 'D:\\Study', sessionIds: [] },
  ]
  const props = { ...seats(face, { workspaces }), ...face }

  const all = react.render(main.Component, props)
  const filterSelect = findAll(all, (node) => node.props.className === 'tn-filter-select')[0]
  assert.ok(filterSelect, 'the workspace filter is rendered')
  assert.deepEqual(
    filterSelect.children.map((option) => option.props.value),
    ['all', 'none', 'ws-1', 'ws-2'],
    'every workspace plus the two fixed choices are offered',
  )
  assert.match(textOf(all).join('|'), /压测脚本改成可配置/)

  face.todo.setWorkspaceFilter('ws-2')
  const onlyStudy = react.rerender(main.Component, props)
  const studyText = textOf(onlyStudy).join('|')
  assert.match(studyText, /压测脚本改成可配置/)
  assert.doesNotMatch(studyText, /接入审计日志/)

  face.todo.setWorkspaceFilter('none')
  const onlyUnbound = react.rerender(main.Component, props)
  const unboundText = textOf(onlyUnbound).join('|')
  assert.match(unboundText, /还没想好放哪/)
  assert.doesNotMatch(unboundText, /接入审计日志/)
})

test('the detail header rebinds a note to a workspace without opening the editor', async () => {  const harness = boot({
    state: () => ({ nodes: [NODE], total: 1, truncated: false, storage: { ok: true, backend: 'json', error: '' }, preferences: { provider: '', model: '', alignPrompt: '' } }),
    update: (payload) => ({ ...NODE, ...payload }),
  })
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  await face.todo.refresh()
  const workspaces = [
    { workspaceId: 'ws-1', title: 'DSHarness', path: 'D:\\DSHarness', sessionIds: [] },
    { workspaceId: 'ws-2', title: 'Study', path: 'D:\\Study', sessionIds: [] },
  ]
  const props = { ...seats(face, { workspaces }), ...face }
  const tree = react.render(main.Component, props)
  const picker = findAll(tree, (node) => node.props.className === 'tn-select-sm')[0]
  assert.ok(picker, 'the header carries a workspace picker')
  assert.equal(picker.props.value, 'ws-1')
  picker.props.onChange({ target: { value: 'ws-2' } })
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  assert.deepEqual(
    harness.calls.find((entry) => entry.endpoint === 'update').payload,
    { id: 'n1', workspaceId: 'ws-2', workspaceTitle: 'Study', workspacePath: 'D:\\Study' },
  )

  const reopened = react.rerender(main.Component, props)
  findAll(reopened, (node) => node.props.className === 'tn-select-sm')[0].props.onChange({ target: { value: '' } })
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  const unbind = harness.calls.filter((entry) => entry.endpoint === 'update').at(-1)
  assert.deepEqual(unbind.payload, { id: 'n1', workspaceId: '', workspaceTitle: '', workspacePath: '' })
  assert.equal(face.hooks.todo.getSnapshot().notice, '已取消工作区绑定')
})

test('the storage button reveals the folder through the shipped route', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init })
    if (String(input).includes('open-in-app/apps')) {
      return { ok: true, json: async () => ({ apps: ['vscode', 'explorer'] }) }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    const harness = boot({
      state: () => ({ nodes: [NODE], total: 1, truncated: false, storage: { ok: true, backend: 'json', error: '' }, preferences: { provider: '', model: '', alignPrompt: '' } }),
      'storage/path': () => ({ dir: 'C:\\Users\\me\\.dsh\\storages', nodes: 'C:\\Users\\me\\.dsh\\storages\\todonote.json' }),
    })
    const main = harness.registrations.find((entry) => entry.options.name === 'main')
    const face = main.options.inject()
    await face.todo.refresh()
    const tree = react.render(main.Component, { ...seats(face), ...face })
    const button = findAll(tree, (node) => node.type === primitives.Button && textOf(node).join('') === '打开存储位置')[0]
    assert.ok(button, 'the footer carries the storage button')

    await face.todo.openStorage()
    assert.deepEqual(harness.calls.find((entry) => entry.endpoint === 'storage/path').payload, {})
    assert.equal(requests.length, 2, 'apps first, then the open call')
    assert.match(requests[1].input, /open-in-app\/open/)
    assert.deepEqual(JSON.parse(requests[1].init.body), { app: 'explorer', path: 'C:\\Users\\me\\.dsh\\storages' })
    assert.match(face.hooks.todo.getSnapshot().notice, /已在文件管理器打开/)

    const reopened = react.rerender(main.Component, { ...seats(face), ...face })
    assert.match(textOf(reopened).join('|'), /C:\\Users\\me\\\.dsh\\storages/, 'the path is shown under the list')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('without a file manager the storage path lands on the clipboard', async () => {
  const harness = boot({
    state: () => ({ nodes: [], total: 0, truncated: false, storage: { ok: true, backend: 'json', error: '' }, preferences: { provider: '', model: '', alignPrompt: '' } }),
    'storage/path': () => ({ dir: '/tmp/todonote-storages', nodes: '/tmp/todonote-storages/todonote.json' }),
  })
  const main = harness.registrations.find((entry) => entry.options.name === 'main')
  const face = main.options.inject()
  clipboard.writes.length = 0
  await face.todo.openStorage()
  assert.deepEqual(clipboard.writes.at(-1), '/tmp/todonote-storages')
  assert.match(face.hooks.todo.getSnapshot().notice, /已复制存储目录/)
})

test('去工作区完善 opens a session carrying the write-back instruction', async () => {
  const harness = boot({
    state: () => ({ nodes: [NODE], total: 1, truncated: false, storage: { ok: true, backend: 'json', error: '' }, preferences: { provider: '', model: '', alignPrompt: '先和我对齐' } }),
  })
  const { face, tree } = await consoleOver(harness)
  const button = findAll(tree, (node) => node.type === primitives.Button && textOf(node).join('') === '去工作区完善')[0]
  assert.ok(button, 'the session refine action is rendered')
  assert.equal(button.props.disabled, false)
  button.props.onClick()

  assert.equal(harness.jumps.length, 1)
  assert.equal(harness.jumps[0].workspaceId, 'ws-1')
  const queued = face.hooks.todo.getSnapshot().pendingPrompt
  assert.ok(queued.startsWith('先和我对齐'), 'the configured preset leads')
  assert.match(queued, /todonote_write_refinement/)
  assert.match(queued, /便签 id：n1/)
  assert.match(queued, /我自己的原文/)
  assert.match(face.hooks.todo.getSnapshot().notice, /按回车发送/)
})

test('去工作区完善 is refused without a bound workspace', async () => {
  const unbound = { ...NODE, workspaceId: '', workspaceTitle: '', workspacePath: '' }
  const harness = boot({
    state: () => ({ nodes: [unbound], total: 1, truncated: false, storage: { ok: true, backend: 'json', error: '' }, preferences: { provider: '', model: '', alignPrompt: '' } }),
  })
  const { face, tree } = await consoleOver(harness, unbound)
  const button = findAll(tree, (node) => node.type === primitives.Button && textOf(node).join('') === '去工作区完善')[0]
  assert.equal(button.props.disabled, true)
  button.props.onClick()
  assert.equal(harness.jumps.length, 0)
  assert.match(face.hooks.todo.getSnapshot().notice, /先给这条便签绑定工作区/)
})
