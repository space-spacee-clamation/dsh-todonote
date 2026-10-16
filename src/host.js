/**
 * TodoNote — Host half.
 *
 * Owns durable storage of todo "nodes" (碎屑计划便签), the plugin-owned RPC
 * channel the browser half calls, and the one-shot LLM call behind the manual
 * "AI 完善" button.
 *
 * The enrichment call is deliberately tool-less: `ctx.llm.stream()` is given
 * messages only, so the model has no way to execute, edit or run anything. The
 * user's own text is never rewritten — the answer is stored beside it.
 *
 * @module dsh-todonote
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { SECTIONS, SYSTEM_PROMPT, REFINE_TOOL, buildUserPrompt, missingSections } from './prompt.js'

/** Cordis plugin name; also the service key provided to other plugins. */
export const name = 'todoNote'

/**
 * `connection` supplies the trusted-request admission check, `storage` the KV
 * unit, and `webServer` the route the browser half talks to. `llm` is resolved
 * lazily per call through `ctx.get`, so a profile without a model provider
 * still loads the plugin and reports the failure to the UI.
 */
export const inject = ['connection', 'storage', 'webServer']

/** Absolute RPC channel registered on the shared Connection transport. */
export const CHANNEL = '/todonote'

/** Largest request body accepted on the plugin route, in bytes. */
export const MAX_REQUEST_BYTES = 1_000_000

/** KV unit identity inside the routed storage backend. */
export const UNIT = Object.freeze({ name: 'todonote', version: 1, tables: ['nodes'], hasGlobal: false, layout: 'single' })

/**
 * Separate unit for the console's own preferences (which model to enrich
 * with). It has its own file so changing them never rewrites the notes
 * document, and so an older notes unit keeps opening unchanged.
 */
export const META_UNIT = Object.freeze({ name: 'todonote-settings', version: 1, tables: ['settings'], hasGlobal: true, layout: 'single' })

/** Field bounds applied to every wire value before it is stored. */
export const LIMITS = Object.freeze({
  title: 120,
  body: 20000,
  content: 60000,
  workspaceId: 200,
  workspaceTitle: 200,
  workspacePath: 1000,
  hint: 2000,
  history: 5,
  nodes: 300,
})

/**
 * Working defaults; every one of them is overridable from the loader row.
 * `maxTokens` covers reasoning tokens too on a thinking model, so it is sized
 * for a five-section answer plus the provider's thinking budget.
 */
export const DEFAULTS = Object.freeze({
  backend: 'json',
  provider: '',
  model: '',
  maxTokens: 8000,
  refineTimeoutMs: 180000,
})

/** @param {unknown} value - candidate wire value. @returns {string} bounded text. */
function text(value, max) {
  if (typeof value !== 'string') return ''
  const trimmed = value.length > max ? value.slice(0, max) : value
  return trimmed
}

/** @param {unknown} value - candidate payload. @returns {Record<string, unknown>} a plain object. */
function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

/** @param {unknown} error - thrown value. @returns {string} a user-facing message. */
function message(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

/** @returns {string} a fresh node id. */
function newId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  return typeof uuid === 'string' ? uuid : `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** @returns {string} the current time as an ISO string. */
function now() {
  return new Date().toISOString()
}

/** @returns {object} the empty refinement record of a new node. */
function emptyRefine() {
  return { status: 'idle', content: '', provider: '', model: '', at: '', error: '', warning: '', startedAt: '', history: [] }
}

/** @param {unknown} value - stored refinement. @returns {object} a complete refinement record. */
function normalizeRefine(value) {
  const raw = asObject(value)
  const status = raw.status === 'running' || raw.status === 'done' || raw.status === 'error' ? raw.status : 'idle'
  const history = Array.isArray(raw.history)
    ? raw.history.slice(-LIMITS.history).map((entry) => {
      const item = asObject(entry)
      return { content: text(item.content, LIMITS.content), at: text(item.at, 40), provider: text(item.provider, 80), model: text(item.model, 200) }
    })
    : []
  return {
    status,
    content: text(raw.content, LIMITS.content),
    provider: text(raw.provider, 80),
    model: text(raw.model, 200),
    at: text(raw.at, 40),
    error: text(raw.error, 2000),
    warning: text(raw.warning, 400),
    startedAt: text(raw.startedAt, 40),
    history,
  }
}

/**
 * Coerce one stored record into a complete node. Never throws: a record that
 * carries no usable identity is dropped by the caller.
 * @param raw - the stored record.
 * @param fallbackId - the KV key it was stored under.
 * @returns the normalized node, or undefined when it has no identity.
 */
export function normalizeNode(raw, fallbackId) {
  const value = asObject(raw)
  const id = text(value.id, 200) || text(fallbackId, 200)
  if (!id) return undefined
  return {
    id,
    title: text(value.title, LIMITS.title) || '未命名计划',
    body: text(value.body, LIMITS.body),
    workspaceId: text(value.workspaceId, LIMITS.workspaceId),
    workspaceTitle: text(value.workspaceTitle, LIMITS.workspaceTitle),
    workspacePath: text(value.workspacePath, LIMITS.workspacePath),
    status: value.status === 'archived' ? 'archived' : 'active',
    createdAt: text(value.createdAt, 40) || now(),
    updatedAt: text(value.updatedAt, 40) || text(value.createdAt, 40) || now(),
    archivedAt: text(value.archivedAt, 40),
    refine: normalizeRefine(value.refine),
  }
}

/**
 * Coerce the stored console preferences.
 * @param value - the stored global value.
 * @returns the model choice (an empty pair means "follow the profile default")
 * and the preset line used when handing a note to a session.
 */
export function normalizePreferences(value) {
  const raw = asObject(value)
  return {
    provider: text(raw.provider, 80),
    model: text(raw.model, 200),
    alignPrompt: text(raw.alignPrompt, 500),
  }
}

/** @param node - a stored node. @returns {object} a detached copy. */
function clone(node) {
  return { ...node, refine: { ...node.refine, history: node.refine.history.map((entry) => ({ ...entry })) } }
}

/** @param ms - milliseconds to wait. @returns a promise resolving afterwards. */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Cut a model answer at the first tool-call marker.
 *
 * The enrichment call carries no tools, but a model that expects to investigate
 * can still emit the provider's tool-call markup as plain text (DeepSeek's DSML
 * blocks, `<tool_call>`, `<invoke>`, …). Everything from that marker on is
 * tool arguments rather than an answer, so it is dropped — and the caller can
 * tell the user what happened instead of storing the markup as a refinement.
 * @param text - the raw streamed answer.
 * @returns the safe prefix plus whether a tool attempt was seen.
 */
export function stripToolMarkup(text) {
  const value = typeof text === 'string' ? text : ''
  const marker = /<[^>]{0,24}DSML[^>]{0,24}>|<\/?(?:tool_calls?|function_calls?|invoke|parameter)\b[^>]*>|<\|tool_call\|>/i
  const hit = marker.exec(value)
  if (hit === null) return { text: value, toolAttempted: false }
  return { text: value.slice(0, hit.index), toolAttempted: true, rest: value.length - hit.index }
}

/** @param body - the user's text. @returns {string} a title derived from its first line. */
function deriveTitle(body) {
  const line = String(body ?? '').split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? ''
  return line.replace(/^#+\s*/, '').slice(0, LIMITS.title)
}

/**
 * Where this plugin's bytes live. The JSON backend keeps one file per unit at
 * `<root>/<unit name>.json`, and its root is `$DSH_HOME/storages` — an empty or
 * whitespace-only `DSH_HOME` counts as unset, and a leading `~` is the home
 * directory (the same precedence the harness itself uses).
 * @param env - environment mapping; `DSH_HOME` is read from it.
 * @param home - the user's home directory.
 * @returns absolute paths plus whether each file exists yet.
 */
export function storagePaths(env = process.env, home = homedir()) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const root = configured.length === 0
    ? join(home, '.dsh')
    : configured.startsWith('~')
      ? join(home, configured.slice(1))
      : configured
  const dir = join(root, 'storages')
  const nodes = join(dir, `${UNIT.name}.json`)
  const settings = join(dir, `${META_UNIT.name}.json`)
  return {
    dir,
    nodes,
    settings,
    nodesExists: existsSync(nodes),
    settingsExists: existsSync(settings),
  }
}

/**
 * Process-wide KV handles, keyed by backend object then unit name.
 *
 * A storage backend allows exactly one live handle per unit name, and a plugin
 * reload (config patch, HMR) disposes the previous generation while a new one
 * mounts. Refcounting through this registry makes the replacement generation
 * adopt the live handle instead of opening a second one, and closes the unit
 * only when the last generation releases it.
 */
const UNIT_REGISTRY_KEY = Symbol.for('dsh-todonote.kv-units')

/** @param backend - the storage backend instance. @returns its unit table. */
function unitsOf(backend) {
  const host = globalThis
  let byBackend = host[UNIT_REGISTRY_KEY]
  if (!(byBackend instanceof WeakMap)) {
    byBackend = new WeakMap()
    host[UNIT_REGISTRY_KEY] = byBackend
  }
  let units = byBackend.get(backend)
  if (!(units instanceof Map)) {
    units = new Map()
    byBackend.set(backend, units)
  }
  return units
}

/**
 * Take one reference to a KV unit, opening it when this backend has no live
 * entry. Never opens a second handle for a name that is still closing.
 * @param backend - the storage backend instance.
 * @param descriptor - unit identity.
 * @returns the handle to use, plus the function that releases this reference.
 */
async function acquireUnit(backend, descriptor) {
  const units = unitsOf(backend)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let entry = units.get(descriptor.name)
    if (entry === undefined) {
      entry = { refs: 0, open: backend.kv.open(descriptor), closing: null }
      units.set(descriptor.name, entry)
      entry.open.catch(() => {
        if (units.get(descriptor.name) === entry) units.delete(descriptor.name)
      })
    }
    if (entry.closing !== null) {
      await entry.closing
      continue
    }
    entry.refs += 1
    try {
      const unit = await entry.open
      return { unit, release: () => releaseUnit(units, descriptor.name, entry) }
    } catch (error) {
      entry.refs -= 1
      if (entry.refs <= 0) units.delete(descriptor.name)
      throw error
    }
  }
  throw new Error(`存储单元 ${descriptor.name} 正在切换，请重试`)
}

/**
 * Drop one reference; the last one closes the unit.
 * @param units - the backend's unit table.
 * @param name - unit name.
 * @param entry - the entry the reference belongs to.
 * @returns a promise settling after the close attempt.
 */
function releaseUnit(units, name, entry) {
  entry.refs -= 1
  if (entry.refs > 0) return Promise.resolve()
  if (units.get(name) !== entry) return Promise.resolve()
  entry.closing = entry.open
    .then((unit) => unit.close())
    .catch(() => {})
    .then(() => {
      if (units.get(name) === entry) units.delete(name)
    })
  return entry.closing
}

/** @param reason - a terminal `finish` chunk reason. @returns {string} a non-empty failure message, or ''. */
function finishFailure(reason) {
  if (typeof reason !== 'object' || reason === null) return ''
  const kind = reason.kind
  if (kind === 'stop' || kind === 'tool-calls' || kind === 'max-tokens') return ''
  const failure = asObject(reason.failure)
  const detail = text(failure.message, 400) || text(failure.code, 200) || text(failure.detail, 400)
  return `模型调用失败（${String(kind)}）${detail ? `：${detail}` : ''}`
}

/**
 * Build the storage-owning, RPC-serving core.
 *
 * The core is a plain object so tests can drive it with fakes; `apply()` only
 * wires it into Cordis.
 * @param options - service accessors, logger and the row config.
 * @returns the core API.
 */
export function createTodoCore({ getStorage, getLlm, getDefaultModel, logger, config } = {}) {
  const settings = { ...DEFAULTS, ...asObject(config) }
  const nodes = new Map()
  const running = new Map()
  const listeners = new Set()
  let unit = null
  let metaUnit = null
  const handles = []
  let openPromise = null
  let backendName = ''
  /** Model choice and preset line made in the console; both override the row config. */
  let preferences = { provider: '', model: '', alignPrompt: '' }
  let storageError = ''
  let writeChain = Promise.resolve()
  let closed = false

  /** @returns {void} */
  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        logger?.warn?.(`todonote: change listener failed: ${message(error)}`)
      }
    }
  }

  /** @param node - the node to persist behind the serialized write chain. */
  function persist(node) {
    if (unit === null) return Promise.resolve()
    const record = clone(node)
    writeChain = writeChain
      .then(() => unit.putRecord('nodes', record.id, record))
      .catch((error) => {
        storageError = `写入失败：${message(error)}`
        logger?.warn?.(`todonote: ${storageError}`)
      })
    return writeChain
  }

  /** @param id - node id. */
  function drop(id) {
    if (unit === null) return Promise.resolve()
    writeChain = writeChain
      .then(() => unit.deleteRecord('nodes', id))
      .catch((error) => {
        storageError = `删除失败：${message(error)}`
        logger?.warn?.(`todonote: ${storageError}`)
      })
    return writeChain
  }

  /** @param require - a node lookup that fails loud. @returns {object} the node. */
  function must(id) {
    const node = nodes.get(text(id, 200))
    if (node === undefined) throw new Error('便签不存在（可能已被删除）')
    return node
  }

  /**
   * Resolve the one route an enrichment call uses, in precedence order:
   * the console's saved choice, the row config, the profile's live default
   * selection, then the first provider's first model. Each source only pins
   * the parts it actually sets (provider and model resolve independently).
   * @returns {Promise<{provider: string, model: string, reasoningEffort?: string}>} the resolved route.
   */
  async function resolveModel() {
    const llm = getLlm?.()
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      throw new Error('llm 服务不可用，无法完善')
    }
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    if (!Array.isArray(providers) || providers.length === 0) throw new Error('没有可用的模型提供方')
    const names = providers.map((entry) => entry?.id).filter((id) => typeof id === 'string' && id.length > 0)
    const usable = (id) => names.includes(id)
    const firstModelOf = async (provider) => {
      const models = typeof llm.listModels === 'function' ? await llm.listModels(provider) : []
      if (!Array.isArray(models) || models.length === 0) throw new Error(`提供方 ${provider} 没有可用模型`)
      return models[0].id
    }

    let selection
    try {
      selection = getDefaultModel?.()?.currentSelection?.()
    } catch (error) {
      logger?.warn?.(`todonote: 读取默认模型失败：${message(error)}`)
    }
    const selectedProvider = text(selection?.provider, 80)
    const fallbackProvider = usable(selectedProvider) ? selectedProvider : names[0]

    const pinnedProvider = [text(preferences.provider, 80), text(settings.provider, 80)]
      .find((id) => id.length > 0 && usable(id))
    const pinnedModel = text(preferences.model, 200) || text(settings.model, 200)
    if (pinnedProvider !== undefined && pinnedModel.length > 0) return { provider: pinnedProvider, model: pinnedModel }
    if (pinnedProvider !== undefined) return { provider: pinnedProvider, model: await firstModelOf(pinnedProvider) }
    if (pinnedModel.length > 0) return { provider: fallbackProvider, model: pinnedModel }

    const selectedModel = text(selection?.model, 200)
    if (selectedModel.length > 0 && fallbackProvider === selectedProvider) {
      const effort = text(selection?.reasoningEffort, 80)
      return effort.length > 0
        ? { provider: fallbackProvider, model: selectedModel, reasoningEffort: effort }
        : { provider: fallbackProvider, model: selectedModel }
    }
    return { provider: fallbackProvider, model: await firstModelOf(fallbackProvider) }
  }

  /**
   * Run one enrichment call and settle the node's refinement record.
   * @param node - the node being enriched (mutated in place).
   * @param hint - optional user instruction for this run.
   * @param controller - owns cancellation of this call.
   */
  async function runRefine(node, hint, controller) {
    const timeoutMs = Number.isFinite(Number(settings.refineTimeoutMs)) ? Math.max(5000, Number(settings.refineTimeoutMs)) : DEFAULTS.refineTimeoutMs
    const timer = setTimeout(() => controller.abort(new Error('完善超时（可以让模型或提示词更短后重试）')), timeoutMs)
    try {
      const target = await resolveModel()
      const llm = getLlm()
      const maxTokens = Number.isFinite(Number(settings.maxTokens)) ? Math.max(256, Number(settings.maxTokens)) : DEFAULTS.maxTokens
      const pieces = []
      let failure = ''
      let finishKind = ''
      let reasoningChars = 0
      const stream = llm.stream({
        provider: target.provider,
        model: target.model,
        ...target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(node, hint) }] }],
        maxTokens,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') pieces.push(chunk.text)
        else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningChars += chunk.text.length
        else if (chunk?.type === 'finish') {
          failure = finishFailure(chunk.reason)
          finishKind = String(chunk.reason?.kind ?? '')
        }
      }
      if (failure) throw new Error(failure)
      const raw = pieces.join('')
      const cleaned = stripToolMarkup(raw)
      const content = cleaned.text.trim()
      if (content.length === 0) {
        throw new Error(cleaned.toolAttempted
          ? '模型想调用工具（它试图去看工作区或执行命令），而不是按五节补充。'
            + '「去工作区完善」会在绑定工作区的会话里做这件事；就地完善请换个模型或重试'
          : finishKind === 'max-tokens'
            ? `模型没有返回正文：输出上限（maxTokens=${maxTokens}）被推理占满了，把配置里的 maxTokens 调大后重试`
            : `模型没有返回正文（finish=${finishKind || 'unknown'}，推理片段 ${reasoningChars} 字）`)
      }
      const missing = missingSections(content)
      if (missing.length === SECTIONS.length) {
        throw new Error(cleaned.toolAttempted
          ? '模型只给了工具调用和一句开场白，没有五节内容。可以点「去工作区完善」让它到工作区里调研后用工具写回'
          : '模型没有按五节格式回答（一节都没有），这次结果没有写回便签；可以重试或换个模型')
      }
      const previous = node.refine.content
      const history = previous.trim().length > 0
        ? [...node.refine.history, { content: previous, at: node.refine.at, provider: node.refine.provider, model: node.refine.model }].slice(-LIMITS.history)
        : node.refine.history
      node.refine = {
        status: 'done',
        content,
        provider: target.provider,
        model: target.model,
        at: now(),
        error: '',
        warning: missing.length > 0 ? `模型漏了小节：${missing.join('、')}` : '',
        startedAt: node.refine.startedAt,
        history,
      }
    } catch (error) {
      const aborted = controller.signal.aborted
      const reason = controller.signal.reason
      node.refine = {
        ...node.refine,
        status: 'error',
        error: aborted && reason instanceof Error ? message(reason) : message(error),
      }
    } finally {
      clearTimeout(timer)
      running.delete(node.id)
      node.updatedAt = now()
      await persist(node)
      notify()
    }
  }

  const core = {
    /** Open the KV unit, load every node, and settle interrupted runs. */
    async start() {
      if (openPromise !== null) return openPromise
      if (closed) return undefined
      openPromise = (async () => {
        const storage = getStorage?.()
        if (storage === undefined || storage === null) {
          storageError = 'storage 服务不可用，便签无法持久化'
          return
        }
        const registry = storage.backend
        let chosen
        try {
          const names = typeof registry?.names === 'function' ? registry.names() : []
          const preferred = text(settings.backend, 80) || DEFAULTS.backend
          for (const candidate of [preferred, ...names.filter((entry) => entry !== preferred)]) {
            try {
              const backend = registry.get(candidate)
              if (backend?.kv !== undefined && typeof backend.kv.open === 'function') {
                chosen = { name: candidate, backend }
                break
              }
            } catch {
              // An unregistered name is the expected miss while scanning.
            }
          }
        } catch (error) {
          storageError = `读取存储后端失败：${message(error)}`
          return
        }
        if (chosen === undefined) {
          storageError = `没有可用的 KV 存储后端（配置的 "${text(settings.backend, 80) || DEFAULTS.backend}" 未注册）`
          return
        }
        let acquired
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            acquired = await acquireUnit(chosen.backend, UNIT)
            break
          } catch (error) {
            const detail = message(error)
            const occupied = /already open/i.test(detail)
            if (!occupied || attempt === 3) {
              storageError = occupied
                ? `打开便签存储失败：${detail}`
                  + '（该单元句柄由更早的一次插件加载持有，本进程内无法回收；重启一次客户端即可恢复）'
                : `打开便签存储失败：${detail}`
              logger?.warn?.(`todonote: ${storageError}`)
              return
            }
            // A replaced generation may still be closing the unit it held.
            await sleep(1000)
          }
        }
        if (acquired === undefined) return
        if (closed) {
          // Disposed while the open was in flight: hand the reference straight back.
          await acquired.release()
          return
        }
        unit = acquired.unit
        handles.push(acquired.release)
        backendName = chosen.name
        storageError = ''
        try {
          const snapshot = await unit.loadAll()
          const records = asObject(asObject(snapshot).tables).nodes
          for (const [key, raw] of Object.entries(asObject(records))) {
            const node = normalizeNode(raw, key)
            if (node !== undefined) nodes.set(node.id, node)
          }
          for (const node of [...nodes.values()]) {
            if (node.refine.status === 'running') {
              node.refine = { ...node.refine, status: 'error', error: '上次完善没有跑完（进程已重启）' }
              await persist(node)
            }
          }
          logger?.info?.(`todonote: ${nodes.size} 条便签已就绪（backend=${backendName}）`)
        } catch (error) {
          const release = handles.pop()
          unit = null
          if (release !== undefined) await release()
          storageError = `读取便签失败：${message(error)}`
          logger?.warn?.(`todonote: ${storageError}`)
          return
        }
        // The console's own preferences are optional: without them the plugin
        // simply follows the row config and the profile default.
        try {
          const meta = await acquireUnit(chosen.backend, META_UNIT)
          if (closed) {
            await meta.release()
            return
          }
          metaUnit = meta.unit
          handles.push(meta.release)
          const snapshot = await metaUnit.loadAll()
          preferences = normalizePreferences(asObject(snapshot).global)
        } catch (error) {
          metaUnit = null
          logger?.warn?.(`todonote: 读取设置失败，将跟随默认模型：${message(error)}`)
        }
      })()
      return openPromise
    },

    /** Stop the core: abort running calls and release the unit reference. */
    async close() {
      closed = true
      for (const controller of running.values()) {
        try {
          controller.abort(new Error('插件已卸载'))
        } catch {
          // Aborting an already-settled controller is not an error.
        }
      }
      running.clear()
      listeners.clear()
      // Let an in-flight open settle before releasing, so the unit is never
      // left open by a generation that was disposed while starting.
      if (openPromise !== null) {
        try {
          await openPromise
        } catch {
          // start() contains its own failures.
        }
      }
      await writeChain.catch(() => {})
      unit = null
      metaUnit = null
      const releases = handles.splice(0, handles.length)
      for (const release of releases.reverse()) {
        try {
          await release()
        } catch (error) {
          logger?.warn?.(`todonote: 关闭存储失败：${message(error)}`)
        }
      }
    },

    /** @param listener - called after every committed change. @returns an unsubscribe function. */
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /**
     * List every provider route with the models it advertises, plus the
     * profile's live default, so the console can offer a model picker.
     * @returns the catalog and the currently saved choice.
     */
    async catalog() {
      const llm = getLlm?.()
      if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') {
        throw new Error('llm 服务不可用，无法读取模型列表')
      }
      const listed = llm.listProviders()
      const providers = []
      for (const entry of Array.isArray(listed) ? listed : []) {
        const id = text(entry?.id, 80)
        if (id.length === 0) continue
        let models = []
        try {
          const catalog = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
          models = (Array.isArray(catalog) ? catalog : [])
            .map((model) => ({ id: text(model?.id, 200), name: text(model?.name, 200) || text(model?.id, 200) }))
            .filter((model) => model.id.length > 0)
        } catch (error) {
          logger?.warn?.(`todonote: 读取提供方 ${id} 的模型列表失败：${message(error)}`)
        }
        providers.push({ id, name: text(entry?.name, 200) || id, models })
      }
      let fallback = null
      try {
        const selection = getDefaultModel?.()?.currentSelection?.()
        if (selection?.provider && selection?.model) {
          fallback = { provider: text(selection.provider, 80), model: text(selection.model, 200) }
        }
      } catch (error) {
        logger?.warn?.(`todonote: 读取默认模型失败：${message(error)}`)
      }
      return { providers, fallback, selected: { ...preferences } }
    },

    /**
     * Persist the console's preferences: the enrichment model route (an empty
     * pair means "follow the profile default") and the preset line used when
     * handing a plan to a session.
     * @param payload - `provider`, `model` and `alignPrompt`.
     * @returns the stored preference.
     */
    async saveSettings(payload) {
      const input = asObject(payload)
      const provider = text(input.provider, 80)
      const model = text(input.model, 200)
      const alignPrompt = text(input.alignPrompt, 500)
      if ((provider.length === 0) !== (model.length === 0)) {
        throw new Error('提供方和模型要么都选，要么都不选（都空＝跟随默认模型）')
      }
      if (provider.length > 0) {
        const llm = getLlm?.()
        const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
        if (!Array.isArray(providers) || !providers.some((entry) => entry?.id === provider)) {
          throw new Error(`提供方 ${provider} 当前不可用`)
        }
      }
      if (metaUnit === null) throw new Error('设置存储不可用，无法保存')
      preferences = { provider, model, alignPrompt }
      await metaUnit.setGlobal({ ...preferences })
      notify()
      return { ...preferences }
    },

    /** @returns the full state the console renders. */
    snapshot() {
      const all = [...nodes.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      return {
        nodes: all.slice(0, LIMITS.nodes).map(clone),
        total: all.length,
        truncated: all.length > LIMITS.nodes,
        storage: { ok: unit !== null, backend: backendName, error: storageError },
        sections: [...SECTIONS],
        // What the console shows in its settings: the saved choices, plus the
        // row config the model falls back to.
        preferences: { ...preferences },
        modelDefaults: { provider: text(settings.provider, 80), model: text(settings.model, 200) },
      }
    },

    /**
     * Create one node.
     * @param payload - `title`, `body` and the optional workspace binding.
     * @returns the created node.
     */
    async create(payload) {
      const input = asObject(payload)
      const body = text(input.body, LIMITS.body)
      const node = normalizeNode({
        id: newId(),
        title: text(input.title, LIMITS.title) || deriveTitle(body),
        body,
        workspaceId: text(input.workspaceId, LIMITS.workspaceId),
        workspaceTitle: text(input.workspaceTitle, LIMITS.workspaceTitle),
        workspacePath: text(input.workspacePath, LIMITS.workspacePath),
        status: 'active',
        createdAt: now(),
        updatedAt: now(),
      }, '')
      nodes.set(node.id, node)
      await persist(node)
      notify()
      return clone(node)
    },

    /**
     * Update the user-owned fields of one node. The AI refinement is never
     * touched here.
     * @param payload - `id` plus any of title/body/workspace fields.
     * @returns the updated node.
     */
    async update(payload) {
      const input = asObject(payload)
      const node = must(input.id)
      if (input.title !== undefined) node.title = text(input.title, LIMITS.title) || '未命名计划'
      if (input.body !== undefined) node.body = text(input.body, LIMITS.body)
      if (input.workspaceId !== undefined) node.workspaceId = text(input.workspaceId, LIMITS.workspaceId)
      if (input.workspaceTitle !== undefined) node.workspaceTitle = text(input.workspaceTitle, LIMITS.workspaceTitle)
      if (input.workspacePath !== undefined) node.workspacePath = text(input.workspacePath, LIMITS.workspacePath)
      node.updatedAt = now()
      await persist(node)
      notify()
      return clone(node)
    },

    /**
     * Archive or restore one node. Archived nodes stay readable.
     * @param payload - `id` and the target `archived` flag.
     * @returns the updated node.
     */
    async archive(payload) {
      const input = asObject(payload)
      const node = must(input.id)
      const archived = input.archived === true
      node.status = archived ? 'archived' : 'active'
      node.archivedAt = archived ? now() : ''
      node.updatedAt = now()
      await persist(node)
      notify()
      return clone(node)
    },

    /**
     * Delete one node for good.
     * @param payload - `id`.
     * @returns `{ id }`.
     */
    async remove(payload) {
      const input = asObject(payload)
      const node = must(input.id)
      nodes.delete(node.id)
      await drop(node.id)
      notify()
      return { id: node.id }
    },

    /**
     * Start one manual enrichment run. Returns immediately: the client polls
     * the returned node's `refine.status` instead of holding a request open.
     * @param payload - `id` and an optional `hint`.
     * @returns the node as it was when the run started.
     */
    async refine(payload) {
      const input = asObject(payload)
      const node = must(input.id)
      if (running.has(node.id)) throw new Error('这条便签正在完善中')
      const controller = new AbortController()
      running.set(node.id, controller)
      node.refine = { ...node.refine, status: 'running', error: '', warning: '', startedAt: now() }
      node.updatedAt = now()
      await persist(node)
      notify()
      void runRefine(node, text(input.hint, LIMITS.hint), controller).catch((error) => {
        logger?.warn?.(`todonote: 完善任务异常结束：${message(error)}`)
      })
      return clone(node)
    },

    /**
     * Write a five-section answer produced by a session tool call.
     *
     * Same commit path as the one-shot call, so the console reacts identically;
     * the only difference is who produced the text and that a badly shaped
     * answer is reported back to the model instead of being stored.
     * @param payload - `id`, `markdown`, and optional `provider`/`model`.
     * @returns `{ok, missing, warning}` — the model sees this as the tool result.
     */
    async applyRefinement(payload) {
      const input = asObject(payload)
      const node = nodes.get(text(input.id, 200))
      if (node === undefined) {
        return { ok: false, missing: [...SECTIONS], warning: '便签不存在（可能已被删除或 id 传错了）' }
      }
      const cleaned = stripToolMarkup(text(input.markdown, LIMITS.content))
      const content = cleaned.text.trim()
      const missing = missingSections(content)
      if (content.length === 0 || missing.length === SECTIONS.length) {
        return {
          ok: false,
          missing,
          warning: '回答里一节都没识别到：markdown 要用 ## 背景 / ## 边界 / ## 影响面 / ## 成本 / ## 预期效果 五个二级标题',
        }
      }
      const previous = node.refine.content
      const history = previous.trim().length > 0
        ? [...node.refine.history, { content: previous, at: node.refine.at, provider: node.refine.provider, model: node.refine.model }].slice(-LIMITS.history)
        : node.refine.history
      node.refine = {
        status: 'done',
        content,
        provider: text(input.provider, 80),
        model: text(input.model, 200),
        at: now(),
        error: '',
        warning: missing.length > 0 ? `模型漏了小节：${missing.join('、')}` : '',
        startedAt: node.refine.startedAt,
        history,
      }
      node.updatedAt = now()
      await persist(node)
      notify()
      logger?.info?.(`todonote: 会话写回便签「${node.title}」（${content.length} 字）`)
      return { ok: true, missing, warning: node.refine.warning }
    },

    /** @returns {boolean} whether the core is shutting down. */
    get closed() {
      return closed
    },
  }
  return core
}

/**
 * Wire the core into Cordis: provide the `todoNote` service, open storage, and
 * register the browser-facing RPC channel.
 * @param ctx - the plugin context.
 * @param config - validated row config (all fields optional).
 * @returns {void}
 */
export function apply(ctx, config) {
  const core = createTodoCore({
    getStorage: () => ctx.get('storage'),
    getLlm: () => ctx.get('llm'),
    getDefaultModel: () => ctx.get('agentDefaultModel'),
    logger: ctx.logger,
    config,
  })

  ctx.provide('todoNote', {
    snapshot: () => core.snapshot(),
    create: (payload) => core.create(payload),
    update: (payload) => core.update(payload),
    archive: (payload) => core.archive(payload),
    remove: (payload) => core.remove(payload),
    refine: (payload) => core.refine(payload),
    onChange: (listener) => core.onChange(listener),
  })

  ctx.effect(() => {
    void core.start().catch((error) => {
      ctx.logger?.warn?.(`todonote: 初始化失败：${message(error)}`)
    })
    return () => core.close()
  }, 'todonote: storage and core lifecycle')

  const dispatch = async (endpoint, payload) => {
    switch (endpoint) {
      case 'state': return core.snapshot()
      case 'create': return core.create(payload)
      case 'update': return core.update(payload)
      case 'archive': return core.archive(payload)
      case 'remove': return core.remove(payload)
      case 'refine': return core.refine(payload)
      case 'models': return core.catalog()
      case 'settings/set': return core.saveSettings(payload)
      case 'storage/path': return storagePaths()
      default: throw new Error(`未知的便签操作：${endpoint}`)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) {
        res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      /** Reply with the Connection response envelope the browser caller expects. */
      const respond = (rpcId, result, status = 200) => {
        const body = JSON.stringify({ type: 'server-response', rpcId, result })
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      }
      let rpcId = ''
      try {
        const endpoint = new URL(req.url ?? '/', 'http://todonote.invalid').pathname
          .slice(CHANNEL.length)
          .replace(/^\//, '')
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > MAX_REQUEST_BYTES) throw new Error('请求体过大')
          chunks.push(chunk)
        }
        const envelope = asObject(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        rpcId = text(envelope.rpcId, 200)
        const method = text(envelope.method, 200)
        if (envelope.type !== 'client-request' || rpcId.length === 0 || method !== endpoint) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('bad request envelope')
          return
        }
        respond(rpcId, { ok: true, value: await dispatch(endpoint, envelope.payload) })
      } catch (error) {
        const detail = message(error)
        ctx.logger?.warn?.(`todonote: 请求失败：${detail}`)
        if (rpcId.length === 0) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('bad request')
          return
        }
        respond(rpcId, { ok: false, error: { code: 'todonote/failed', message: detail, details: {} } })
      }
    },
  }), `todonote: ${CHANNEL} route`)

  // The session-side half of "AI 完善": a workspace session investigates and
  // then calls this to write its five-section answer back. Registered through
  // `ctx.get` so a profile without the tools service still loads the plugin.
  const tools = ctx.get('tools')
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    ctx.logger?.warn?.('todonote: tools 服务不可用，会话写回工具没有注册（就地完善不受影响）')
    return
  }
  ctx.effect(() => tools.register({
    name: REFINE_TOOL,
    description: '把「计划便签」的补充写回指定便签：markdown 必须包含 ## 背景 / ## 边界 / ## 影响面 / '
      + '## 成本 / ## 预期效果 五节。只写回分析结论，不改动用户原文。调研完成后调用一次。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '目标便签的 id（提示词里给出的那一串）。' },
        markdown: {
          type: 'string',
          description: '完整五节 Markdown：## 背景 / ## 边界 / ## 影响面 / ## 成本 / ## 预期效果。',
        },
      },
      required: ['id', 'markdown'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: '是否已写回便签。' },
          missing: { type: 'array', items: { type: 'string' }, description: '没有识别到的小节。' },
          warning: { type: 'string', description: '写回结果或需要补齐的内容。' },
        },
        required: ['ok', 'missing', 'warning'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === true
          ? `已写回计划便签${value.warning === '' ? '' : `（${value.warning}）`}。`
          : `没有写回：${value.warning}`
            + (Array.isArray(value.missing) && value.missing.length > 0 ? ` 缺少：${value.missing.join('、')}` : ''),
      }],
    },
    execute: async (args, exec) => {
      let provider = ''
      let model = ''
      try {
        const selection = exec?.agent?.session?.projections?.faceOf?.('modelSelection')?.getSnapshot?.()
        const chosen = selection?.next ?? selection?.lastUsed
        provider = text(chosen?.provider, 80)
        model = text(chosen?.model, 200)
      } catch {
        // The model label is cosmetic in the note; a missing projection is fine.
      }
      return core.applyRefinement({ ...asObject(args), provider, model })
    },
    presentCall: args => ({ card: 'generic', title: '写回计划便签', kind: 'other', rawInput: args }),
  }), 'todonote: session write-back tool')
}
