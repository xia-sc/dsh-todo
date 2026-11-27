// TODO 便签墙 —— Host 半侧。
//
// 职责：
//  1. 拥有任务数据（%DSH_HOME%\dsh-todo\tasks.json）与插件设置（config.json）。
//  2. 把同一套 operations 交给两个调用方：便签墙面板的 HTTP 路由，以及 agent 工具。
//  3. agent 工具默认不注册；只有设置里 llmTools === true 时才注册，关闭时立即撤销。
//
// 字段约定（对应需求 1/2/3/4）：工作区、状态、计划开始时间、预计结束时间、
// 文档附件全部是可选的；只有便签正文（title）必填，因为它就是便签本身。
// 全部可选字段留空时，任务就是一张普通便签 —— 创建路径不做任何前置校验。

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { registerRoutes } from './routes.js'

export const name = '@xia-sc/dsh-todo'
export const inject = ['tools']

const PLUGIN_VERSION = '0.1.5'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(HOME, 'dsh-todo')
const TASKS_FILE = join(DATA_DIR, 'tasks.json')
const CONFIG_FILE = join(DATA_DIR, 'config.json')
const STORE_VERSION = 2

/** 状态只有这四种，不增不减。 */
const STATUSES = ['planned', 'active', 'done', 'archived']
/** 默认视图（便签墙）可见的状态：已归档只在显式筛选时出现。 */
const WALL_STATUSES = ['planned', 'active', 'done']
/** “待完成” = 规划中 + 进行中。 */
const PENDING = ['planned', 'active']

/** 便签纸预选色；与原型一致，暖色板。 */
const NOTE_COLORS = ['cream', 'lemon', 'mint', 'sky', 'rose', 'lilac']
const DEFAULT_NOTE_COLOR = 'cream'
/** 没有摆放位置的旧便签按这个网格补齐。 */
const GRID_COLUMNS = 4
const GRID_STEP_X = 264
const GRID_STEP_Y = 224

const DEFAULT_CONFIG = Object.freeze({ llmTools: false })

const MAX_TASKS = 2000
const MAX_TITLE = 200
const MAX_NOTE = 4000
const MAX_ATTACHMENTS = 20
const MAX_SPLIT = 12

function log(ctx, message) {
  try {
    ctx.logger?.info?.(`dsh-todo: ${message}`)
  } catch { /* 日志不可用不影响业务 */ }
}

/** 调用方输入问题：以 4xx 返回，不当作 Host 故障；code 供面板本地化，message 供模型阅读。 */
function userError(message, status = 400, code = 'INVALID') {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.expose = true
  return error
}

function nowIso() {
  return new Date().toISOString()
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textField(value, field, max, required = false) {  if (value === undefined || value === null) {
    if (required) throw userError(`${field} is required`)
    return undefined
  }
  if (typeof value !== 'string') throw userError(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') {
    if (required) throw userError(`${field} must not be empty`)
    return undefined
  }
  if (trimmed.length > max) throw userError(`${field} is longer than ${max} characters`)
  return trimmed
}

function isoField(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw userError(`${field} must be an ISO date-time string`, 400, 'TIME_INVALID')
  const trimmed = value.trim()
  if (trimmed === '') return null
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) {
    throw userError(`${field} is not a valid date-time: ${trimmed}`, 400, 'TIME_INVALID')
  }
  return date.toISOString()
}

function statusField(value) {
  if (typeof value !== 'string' || STATUSES.indexOf(value) < 0) {
    throw userError(`status must be one of ${STATUSES.join(', ')}`, 400, 'STATUS_INVALID')
  }
  return value
}

function stringList(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw userError(`${field} must be an array of strings`)
  return value.map((entry) => {
    if (typeof entry !== 'string') throw userError(`${field} must contain strings only`)
    return entry
  })
}

function lastSegment(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/** 便签纸色：只接受预选色。 */
function colorField(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_NOTE_COLOR
  if (typeof value !== 'string' || NOTE_COLORS.indexOf(value) < 0) {
    throw userError(`color must be one of ${NOTE_COLORS.join(', ')}`, 400, 'COLOR_INVALID')
  }
  return value
}

/** 墙上的像素坐标：非负数字，缺省表示“还没摆”。 */
function positionField(value, field) {
  if (value === undefined || value === null || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) {
    throw userError(`${field} must be a non-negative number`, 400, 'POSITION_INVALID')
  }
  return Math.round(number)
}

/** 旧数据没有位置时的落点，保证所有客户端看到同一面墙。 */
function defaultPosition(index) {
  return {
    x: 24 + (index % GRID_COLUMNS) * GRID_STEP_X,
    y: 24 + Math.floor(index / GRID_COLUMNS) * GRID_STEP_Y,
  }
}

/**
 * 把面板传来的对象或工具传来的字符串统一成附件记录。
 * 附件只是引用：路径不存在也照存，只是标一个 missing，避免把“文档还没写”当成错误。
 */
function normalizeAttachment(input) {
  let name = ''
  let path = ''
  if (typeof input === 'string') {
    const raw = input.trim()
    if (!raw) throw userError('attachment must not be empty')
    const separator = raw.indexOf('::')
    if (separator > 0) {
      name = raw.slice(0, separator).trim()
      path = raw.slice(separator + 2).trim()
    } else {
      path = raw
    }
  } else if (isPlainObject(input)) {
    path = typeof input.path === 'string' ? input.path.trim() : ''
    name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!path && typeof input.url === 'string') path = input.url.trim()
  } else {
    throw userError('attachment must be a path string or an object with name and path')
  }
  if (!path) throw userError('attachment path must not be empty')
  if (path.length > 1000) throw userError('attachment path is longer than 1000 characters')
  const kind = /^https?:\/\//i.test(path) ? 'link' : 'file'
  if (!name) name = kind === 'link' ? (lastSegment(path) || path) : basename(path)
  if (name.length > 200) name = name.slice(0, 200)
  const attachment = { id: `att_${randomUUID().replace(/-/g, '').slice(0, 8)}`, name, path, kind }
  if (kind === 'file' && isAbsolute(path)) {
    try {
      const stat = statSync(path)
      if (stat.isFile()) attachment.size = stat.size
      else attachment.missing = true
    } catch {
      attachment.missing = true
    }
  }
  return attachment
}

function normalizeAttachments(value, field = 'attachments') {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw userError(`${field} must be an array`, 400, 'ATTACHMENT_INVALID')
  if (value.length > MAX_ATTACHMENTS) throw userError(`at most ${MAX_ATTACHMENTS} attachments per note`, 400, 'ATTACHMENTS_LIMIT')
  return value.map(normalizeAttachment)
}

/** 起止时间都在时给出软提示：不阻止保存，只在结果里说明。 */
function timeWarning(task) {
  if (!task.planStartAt || !task.planEndAt) return null
  const start = new Date(task.planStartAt).getTime()
  const end = new Date(task.planEndAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return null
  return end < start ? 'planEndAt is earlier than planStartAt' : null
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function readJson(file) {
  try {
    if (!existsSync(file)) return undefined
    const text = readFileSync(file, 'utf8').trim()
    if (!text) return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(DATA_DIR, { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

function shortWhen(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 读工作区清单；没有 workspaceRegistry 时返回空清单，面板照样能用。 */
function workspaceOptions(ctx) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : ctx.workspaceRegistry
    const raw = registry && typeof registry.list === 'function' ? registry.list() : []
    return (Array.isArray(raw) ? raw : [])
      .map((item) => ({
        id: String(item?.id ?? item?.workspaceId ?? ''),
        title: String(item?.title ?? item?.path ?? ''),
        path: item?.path ? String(item.path) : '',
      }))
      .filter((item) => item.id !== '')
  } catch {
    return []
  }
}

function createStore(ctx) {
  const store = {
    items: [],
    load() {
      const payload = readJson(TASKS_FILE)
      if (payload === undefined) {
        store.items = []
        writeJsonAtomic(TASKS_FILE, { version: STORE_VERSION, tasks: [] })
        return
      }
      const raw = Array.isArray(payload) ? payload : (Array.isArray(payload?.tasks) ? payload.tasks : null)
      if (raw === null) {
        // 手改坏的文件不能悄悄覆盖：改名留档，再从空清单开始。
        const backup = `${TASKS_FILE}.corrupt-${Date.now()}.json`
        try { renameSync(TASKS_FILE, backup) } catch { /* 留档失败不阻塞 */ }
        log(ctx, `tasks.json was unreadable; moved it to ${backup}`)
        store.items = []
        writeJsonAtomic(TASKS_FILE, { version: STORE_VERSION, tasks: [] })
        return
      }
      let migrated = false
      store.items = raw
        .filter((task) => isPlainObject(task) && typeof task.id === 'string' && task.id !== '')
        .map((task) => {
          // 0.1.4 及更早版本的「已撤销」（cancelled）一次性并入「已归档」（archived）：
          // 旧状态不再保留，迁移后立即回写，避免两套状态并存。
          const nextStatus = task.status === 'cancelled' ? 'archived' : task.status
          if (nextStatus !== task.status) migrated = true
          return {
            id: String(task.id),
            title: typeof task.title === 'string' ? task.title : '',
            note: typeof task.note === 'string' ? task.note : '',
            status: STATUSES.indexOf(nextStatus) >= 0 ? nextStatus : 'planned',
            workspaceId: typeof task.workspaceId === 'string' ? task.workspaceId : null,
            planStartAt: typeof task.planStartAt === 'string' ? task.planStartAt : null,
            planEndAt: typeof task.planEndAt === 'string' ? task.planEndAt : null,
            attachments: Array.isArray(task.attachments)
              ? task.attachments.filter((entry) => isPlainObject(entry) && typeof entry.path === 'string')
                .map((entry) => ({
                  id: String(entry.id ?? `att_${randomUUID().replace(/-/g, '').slice(0, 8)}`),
                  name: typeof entry.name === 'string' ? entry.name : lastSegment(entry.path),
                  path: String(entry.path),
                  kind: entry.kind === 'link' ? 'link' : 'file',
                  ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
                  ...(entry.missing === true ? { missing: true } : {}),
                }))
              : [],
            parentId: typeof task.parentId === 'string' ? task.parentId : null,
            color: NOTE_COLORS.indexOf(task.color) >= 0 ? task.color : DEFAULT_NOTE_COLOR,
            x: typeof task.x === 'number' && Number.isFinite(task.x) && task.x >= 0 ? Math.round(task.x) : null,
            y: typeof task.y === 'number' && Number.isFinite(task.y) && task.y >= 0 ? Math.round(task.y) : null,
            createdAt: typeof task.createdAt === 'string' ? task.createdAt : nowIso(),
            updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : nowIso(),
          }
        })
      // 旧数据没有摆放位置：按网格补齐并回写，保证每台客户端看到同一面墙。
      let placed = 0
      for (const task of store.items) {
        if (task.x !== null && task.y !== null) continue
        const position = defaultPosition(placed)
        task.x = position.x
        task.y = position.y
        placed += 1
        migrated = true
      }
      if (migrated) writeJsonAtomic(TASKS_FILE, { version: STORE_VERSION, tasks: store.items })
    },
    read() {
      return clone(store.items)
    },
    persist() {
      writeJsonAtomic(TASKS_FILE, { version: STORE_VERSION, tasks: store.items })
    },
  }
  store.load()
  return store
}

/**
 * 生成一张便签。所有可选字段留空时就是普通便签：
 * workspaceId / planStartAt / planEndAt 为 null，attachments 为空数组。
 */
function buildTask(input = {}, overrides = {}) {
  const createdAt = overrides.createdAt ?? nowIso()
  return {
    id: overrides.id ?? `todo_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
    title: textField(input.title, 'title', MAX_TITLE, true),
    note: textField(input.note, 'note', MAX_NOTE) ?? '',
    status: input.status === undefined || input.status === null ? 'planned' : statusField(input.status),
    workspaceId: textField(input.workspaceId, 'workspaceId', 200) ?? null,
    planStartAt: isoField(input.planStartAt, 'planStartAt'),
    planEndAt: isoField(input.planEndAt, 'planEndAt'),
    attachments: normalizeAttachments(input.attachments),
    parentId: textField(input.parentId, 'parentId', 80) ?? null,
    color: colorField(input.color),
    x: positionField(input.x, 'x'),
    y: positionField(input.y, 'y'),
    createdAt,
    updatedAt: nowIso(),
  }
}

function createOperations(ctx, store, configRef, syncTools) {
  function resolveWorkspace(workspaceId) {
    if (!workspaceId) return null
    const found = workspaceOptions(ctx).find((item) => item.id === workspaceId)
    return found ? found.title : '(removed workspace)'
  }

  function describe(task) {
    const parts = [task.status]
    if (task.workspaceId) parts.push(`workspace ${resolveWorkspace(task.workspaceId)}`)
    const start = task.planStartAt ? `start ${shortWhen(task.planStartAt)}` : ''
    const end = task.planEndAt ? `end ${shortWhen(task.planEndAt)}` : ''
    if (start || end) parts.push([start, end].filter(Boolean).join(' -> '))
    if (task.attachments.length > 0) parts.push(`${task.attachments.length} attachment(s)`)
    const children = store.items.filter((item) => item.parentId === task.id).length
    if (children > 0) parts.push(`${children} subtask(s)`)
    if (!task.workspaceId && !start && !end && task.attachments.length === 0 && children === 0) {
      parts.push('plain note, no optional fields')
    }
    if (task.note) parts.push('has body text')
    const line = `- [${task.id}] ${task.title} — ${parts.join(' · ')}`
    const warning = timeWarning(task)
    return warning ? `${line}\n  warning: ${warning}` : line
  }

  function snapshotConfig() {
    return { llmTools: configRef.current.llmTools === true }
  }

  /** 新建便签没有位置时，按当前数量落一个网格位。 */
  function placeNewTask(task) {
    if (task.x !== null && task.y !== null) return
    const position = defaultPosition(store.items.length)
    task.x = position.x
    task.y = position.y
  }

  function filterTasks(options = {}) {
    const status = typeof options.status === 'string' ? options.status : 'pending'
    const wanted = status === 'pending'
      ? PENDING
      : status === 'all'
        // all 与面板的「全部」一致：默认不含已归档，归档要显式问 archived。
        ? WALL_STATUSES
        : [statusField(status)]
    const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''
    const workspace = typeof options.workspace === 'string' ? options.workspace.trim().toLowerCase() : ''
    const workspaces = workspaceOptions(ctx)
    const matchWorkspace = (task) => {
      if (!workspace) return true
      if (!task.workspaceId) return false
      if (task.workspaceId.toLowerCase() === workspace) return true
      const found = workspaces.find((item) => item.id === task.workspaceId)
      return found ? found.title.toLowerCase().includes(workspace) : false
    }
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(50, Math.floor(options.limit))) : 20
    return store.items
      .filter((task) => wanted.indexOf(task.status) >= 0)
      .filter(matchWorkspace)
      .filter((task) => !query || task.title.toLowerCase().includes(query) || task.note.toLowerCase().includes(query))
      .sort((left, right) => {
        // 先按状态分组（规划中→进行中→已完成→已归档），组内最近改过的在前。
        const leftRank = STATUSES.indexOf(left.status)
        const rightRank = STATUSES.indexOf(right.status)
        if (leftRank !== rightRank) return leftRank - rightRank
        return String(right.updatedAt).localeCompare(String(left.updatedAt))
      })
      .slice(0, limit)
  }

  const operations = {
    state() {
      const tasks = store.read()
      return {
        version: PLUGIN_VERSION,
        tasks,
        config: snapshotConfig(),
        statuses: STATUSES.slice(),
        pending: tasks.filter((task) => PENDING.indexOf(task.status) >= 0).length,
        workspaces: workspaceOptions(ctx),
        storage: { dataDir: DATA_DIR, tasksFile: TASKS_FILE, configFile: CONFIG_FILE },
      }
    },

    config() {
      return { ...snapshotConfig(), configFile: CONFIG_FILE }
    },

    updateConfig(body = {}) {
      if (!isPlainObject(body)) throw userError('config payload must be an object', 400, 'CONFIG_INVALID')
      if (has(body, 'llmTools')) {
        if (typeof body.llmTools !== 'boolean') throw userError('llmTools must be a boolean', 400, 'CONFIG_INVALID')
        configRef.current = { ...configRef.current, llmTools: body.llmTools }
        writeJsonAtomic(CONFIG_FILE, { llmTools: configRef.current.llmTools })
        syncTools(configRef.current.llmTools)
        log(ctx, `LLM tools ${configRef.current.llmTools ? 'enabled' : 'disabled'} from settings`)
      }
      return { ...snapshotConfig(), configFile: CONFIG_FILE }
    },

    list(options = {}) {
      const tasks = filterTasks(options)
      return { tasks, total: store.items.length }
    },

    create(body = {}) {
      if (!isPlainObject(body)) throw userError('task payload must be an object')
      if (store.items.length >= MAX_TASKS) throw userError(`the wall already holds ${MAX_TASKS} notes`, 409, 'WALL_FULL')
      const task = buildTask(body)
      placeNewTask(task)
      store.items.push(task)
      store.persist()
      return { task: clone(task), warning: timeWarning(task) }
    },

    update(body = {}) {
      if (!isPlainObject(body)) throw userError('task payload must be an object')
      const id = textField(body.id, 'id', 80, true)
      const patch = isPlainObject(body.patch) ? body.patch : {}
      const index = store.items.findIndex((task) => task.id === id)
      if (index < 0) throw userError(`no task with id ${id}`, 404, 'NOT_FOUND')
      const task = { ...store.items[index] }

      if (has(patch, 'title')) task.title = textField(patch.title, 'title', MAX_TITLE, true)
      if (has(patch, 'note')) task.note = textField(patch.note, 'note', MAX_NOTE) ?? ''
      if (has(patch, 'status')) task.status = statusField(patch.status)
      if (has(patch, 'color')) task.color = colorField(patch.color)
      if (has(patch, 'x')) task.x = positionField(patch.x, 'x') ?? task.x
      if (has(patch, 'y')) task.y = positionField(patch.y, 'y') ?? task.y
      if (has(patch, 'workspaceId')) task.workspaceId = textField(patch.workspaceId, 'workspaceId', 200) ?? null
      if (has(patch, 'planStartAt')) task.planStartAt = isoField(patch.planStartAt, 'planStartAt')
      if (has(patch, 'planEndAt')) task.planEndAt = isoField(patch.planEndAt, 'planEndAt')

      // 显式清空：面板把被清空的字段名放在 clear 里，模型也可以这么做。
      for (const field of stringList(patch.clear, 'clear')) {
        if (field === 'note') task.note = ''
        else if (field === 'workspaceId') task.workspaceId = null
        else if (field === 'planStartAt') task.planStartAt = null
        else if (field === 'planEndAt') task.planEndAt = null
        else if (field === 'attachments') task.attachments = []
        else throw userError(`clear does not accept "${field}"`)
      }

      if (has(patch, 'addAttachments')) {
        const added = normalizeAttachments(patch.addAttachments, 'addAttachments')
        if (task.attachments.length + added.length > MAX_ATTACHMENTS) {
          throw userError(`at most ${MAX_ATTACHMENTS} attachments per note`, 400, 'ATTACHMENTS_LIMIT')
        }
        task.attachments = task.attachments.concat(added)
      }
      if (has(patch, 'removeAttachments')) {
        const removed = new Set(stringList(patch.removeAttachments, 'removeAttachments'))
        task.attachments = task.attachments.filter((entry) => !removed.has(entry.id))
      }
      if (has(patch, 'attachments')) {
        task.attachments = normalizeAttachments(patch.attachments)
      }

      task.updatedAt = nowIso()
      store.items[index] = task
      store.persist()
      return { task: clone(task), warning: timeWarning(task) }
    },

    /**
     * 批量保存墙上的摆放位置（拖动、整理都走这里）。
     * positions: [{ id, x, y }]，一次调用只写一次盘。
     */
    arrange(body = {}) {
      if (!isPlainObject(body)) throw userError('arrange payload must be an object')
      const positions = Array.isArray(body.positions) ? body.positions : null
      if (positions === null || positions.length === 0) {
        throw userError('positions must contain at least one entry', 400, 'POSITION_INVALID')
      }
      if (positions.length > MAX_TASKS) {
        throw userError(`at most ${MAX_TASKS} positions per call`, 400, 'POSITION_INVALID')
      }
      const byId = new Map(store.items.map((task) => [task.id, task]))
      const updates = []
      for (const entry of positions) {
        if (!isPlainObject(entry)) throw userError('each position must be an object', 400, 'POSITION_INVALID')
        const id = textField(entry.id, 'id', 80, true)
        if (!byId.has(id)) throw userError(`no task with id ${id}`, 404, 'NOT_FOUND')
        const x = positionField(entry.x, 'x')
        const y = positionField(entry.y, 'y')
        if (x === null || y === null) throw userError('x and y are required for every position', 400, 'POSITION_INVALID')
        updates.push({ task: byId.get(id), x, y })
      }
      const now = nowIso()
      for (const update of updates) {
        update.task.x = update.x
        update.task.y = update.y
        update.task.updatedAt = now
      }
      store.persist()
      return { count: updates.length }
    },

    remove(body = {}) {
      if (!isPlainObject(body)) throw userError('delete payload must be an object')
      const id = textField(body.id, 'id', 80, true)
      const index = store.items.findIndex((task) => task.id === id)
      if (index < 0) throw userError(`no task with id ${id}`, 404, 'NOT_FOUND')
      const [removed] = store.items.splice(index, 1)
      // 子任务不跟着消失：只解除父子关系，避免误删一片。
      let detached = 0
      for (const task of store.items) {
        if (task.parentId === id) {
          task.parentId = null
          task.updatedAt = nowIso()
          detached += 1
        }
      }
      store.persist()
      return { id, title: removed.title, detached }
    },

    /**
     * 把一张便签拆成多张子便签。子便签只继承父便签的工作区；
     * 状态默认为“规划中”，父便签状态默认不动。
     */
    split(body = {}) {
      if (!isPlainObject(body)) throw userError('split payload must be an object')
      const id = textField(body.id, 'id', 80, true)
      const index = store.items.findIndex((task) => task.id === id)
      if (index < 0) throw userError(`no task with id ${id}`, 404, 'NOT_FOUND')
      const parent = store.items[index]
      const entries = Array.isArray(body.subtasks) ? body.subtasks : []
      if (entries.length === 0) throw userError('subtasks must contain at least one title', 400, 'SUBTASKS_INVALID')
      if (entries.length > MAX_SPLIT) throw userError(`split at most ${MAX_SPLIT} subtasks at a time`, 400, 'SUBTASKS_INVALID')
      if (store.items.length + entries.length > MAX_TASKS) throw userError(`the wall cannot hold more than ${MAX_TASKS} notes`, 409, 'WALL_FULL')

      const inheritWorkspace = body.inheritWorkspace !== false
      const status = body.status === undefined || body.status === null ? 'planned' : statusField(body.status)
      const created = []
      for (const entry of entries) {
        const source = typeof entry === 'string' ? { title: entry } : entry
        if (!isPlainObject(source)) throw userError('each subtask must be a title string or an object')
        const task = buildTask({
          title: source.title,
          note: source.note ?? body.note,
          status: source.status ?? status,
          workspaceId: source.workspaceId ?? (inheritWorkspace ? parent.workspaceId : undefined),
          planStartAt: source.planStartAt,
          planEndAt: source.planEndAt,
          parentId: parent.id,
        })
        store.items.push(task)
        placeNewTask(task)
        created.push(task)
      }

      let parentView = parent
      if (body.markParentActive === true && parent.status !== 'done' && parent.status !== 'archived') {
        parent.status = 'active'
        parent.updatedAt = nowIso()
        parentView = parent
      }
      store.persist()
      return { parent: clone(parentView), created: created.map(clone), warning: timeWarning(parentView) }
    },
  }

  /** 工具结果文本：只读列表，方便模型直接引用 id。 */
  function renderList(result) {
    if (result.tasks.length === 0) {
      return 'No tasks matched. The sticky wall has no notes for this filter.'
    }
    return `${result.tasks.length} task(s) on the sticky wall:\n${result.tasks.map(describe).join('\n')}`
  }

  return { operations, renderList }
}

function toolOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

/**
 * 三个 LLM 工具。它们只在设置 llmTools === true 时注册。
 * 参数与面板操作完全同义：面板与工具调用同一套 operations。
 */
function createTools(operations, renderList) {
  return [
    {
      name: 'todo_list',
      description: 'List notes on the user\'s sticky-note wall (todo list). Pending means planned or in progress; '
        + 'completed and archived notes stay hidden unless status asks for them. Read-only. '
        + 'Call it before todo_update or todo_split to get the current task ids. '
        + 'A note may have no workspace, no start or end time and no attachment: those fields are optional, '
        + 'and such a note is a plain sticky note.',
      parameters: {
        status: {
          type: 'string',
          enum: ['pending', 'planned', 'active', 'done', 'archived', 'all'],
          description: 'Which notes to list. Defaults to pending (planned + in progress). all = every visible note; archived notes only with archived.',
        },
        workspace: {
          type: 'string',
          description: 'Only notes linked to this workspace, by id or by a case-insensitive part of its title. Omit to list every note.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive substring filter on the note title and body text.',
        },
        limit: {
          type: 'number',
          description: 'Maximum notes to return, 1-50. Defaults to 20.',
        },
      },
      output: toolOutput(),
      async execute(args) {
        const result = operations.list({
          status: args.status,
          workspace: args.workspace,
          query: args.query,
          limit: args.limit,
        })
        return { text: renderList(result) }
      },
    },
    {
      name: 'todo_update',
      description: 'Change one note on the user\'s sticky-note wall: its title, body text, status, linked workspace, '
        + 'planned start or expected end time, and its document attachments. Every field is optional and an empty value '
        + 'is valid — passing clear removes a field and turns the note back into a plain sticky note. '
        + 'Status is limited to planned, active, done and archived.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'Task id from todo_list, such as todo_1a2b3c4d5e.',
        },
        title: { type: 'string', description: 'New note title. Must not be empty when supplied.' },
        note: { type: 'string', description: 'New body text. An empty string clears it.' },
        status: {
          type: 'string',
          enum: ['planned', 'active', 'done', 'archived'],
          description: 'New status. planned = 规划中, active = 进行中, done = 已完成, archived = 已归档 (hidden from the wall until the archived filter is used).',
        },
        workspaceId: {
          type: 'string',
          description: 'Workspace id to link. Omit to keep the current link; use clear with "workspaceId" to unlink.',
        },
        planStartAt: {
          type: 'string',
          description: 'Planned start, ISO date-time such as 2026-11-25T09:00:00+08:00. Use clear with "planStartAt" to remove it.',
        },
        planEndAt: {
          type: 'string',
          description: 'Expected end, ISO date-time. Use clear with "planEndAt" to remove it.',
        },
        clear: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional fields to remove: note, workspaceId, planStartAt, planEndAt, attachments.',
        },
        addAttachments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Document references to add, each "name::path" or a bare path or URL.',
        },
        removeAttachments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attachment ids to remove, as listed by todo_list.',
        },
      },
      output: toolOutput(),
      async execute(args) {
        const patch = {}
        for (const field of ['title', 'note', 'status', 'workspaceId', 'planStartAt', 'planEndAt']) {
          if (args[field] !== undefined) patch[field] = args[field]
        }
        for (const field of ['clear', 'addAttachments', 'removeAttachments']) {
          if (args[field] !== undefined) patch[field] = args[field]
        }
        const result = operations.update({ id: args.id, patch })
        const lines = [`Updated [${result.task.id}] ${result.task.title} — ${result.task.status}`]
        if (result.warning) lines.push(`warning: ${result.warning}`)
        if (result.task.parentId) lines.push(`subtask of ${result.task.parentId}`)
        return { text: lines.join('\n') }
      },
    },
    {
      name: 'todo_split',
      description: 'Break one note on the user\'s sticky-note wall into several subtask notes that keep the parent link. '
        + 'Subtasks are created as planned notes by default and inherit the parent\'s linked workspace; the parent note is '
        + 'left unchanged unless markParentActive is true. Use todo_update afterwards to add times or attachments to a subtask.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'Parent task id from todo_list.',
        },
        subtasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Subtask titles in order, 1-12 items. One note is created per title.',
        },
        note: { type: 'string', description: 'Optional body text copied into every new subtask.' },
        status: {
          type: 'string',
          enum: ['planned', 'active'],
          description: 'Status for the new subtasks. Defaults to planned.',
        },
        markParentActive: {
          type: 'boolean',
          description: 'Set the parent note to active (进行中) when it is still planned. Defaults to false.',
        },
        inheritWorkspace: {
          type: 'boolean',
          description: 'Link the subtasks to the parent\'s workspace. Defaults to true.',
        },
      },
      output: toolOutput(),
      async execute(args) {
        const result = operations.split({
          id: args.id,
          subtasks: args.subtasks,
          note: args.note,
          status: args.status,
          markParentActive: args.markParentActive,
          inheritWorkspace: args.inheritWorkspace,
        })
        const lines = [`Split [${result.parent.id}] ${result.parent.title} into ${result.created.length} note(s):`]
        for (const task of result.created) {
          lines.push(`- [${task.id}] ${task.title} — ${task.status} · parent ${task.parentId}`)
        }
        return { text: lines.join('\n') }
      },
    },
  ]
}

/**
 * 按需加载入口：模型先只看到这一个工具，调用后才把三个墙工具注册进
 * 当前 agent 的作用域（下一步起可见）。工具随 agent 销毁；关闭开关或卸载
 * 插件时由 apply 统一撤销。
 * @param tools - 三个墙工具定义。
 * @param agentTools - agentId → 该 agent 作用域内工具 disposer 的映射。
 */
function createLoaderTool(tools, agentTools) {
  return {
    name: 'todo_load_tools',
    description: 'Load the sticky-wall tools for this agent: todo_list (list pending notes), '
      + 'todo_update (change one note) and todo_split (split a note into subtasks). '
      + 'Call this once when the user asks about their sticky wall or todos; the three tools become '
      + 'callable from the next step. They are not loaded before this call.',
    parameters: {},
    output: toolOutput(),
    async execute(_args, exec) {
      const agent = exec && exec.agent
      if (!agent) {
        return { text: 'No agent context is available, so the sticky-wall tools were not loaded.' }
      }
      if (agentTools.has(agent.id)) {
        return { text: 'The sticky-wall tools are already loaded: todo_list, todo_update, todo_split.' }
      }
      const scoped = agent.ctx && agent.ctx.tools
      if (!scoped || typeof scoped.register !== 'function') {
        return { text: 'The sticky-wall tools cannot be loaded for this agent.' }
      }
      const disposers = []
      try {
        for (const tool of tools) disposers.push(scoped.register(tool))
      } catch (error) {
        for (const dispose of disposers) {
          try { dispose() } catch { /* 撤销不能抛错 */ }
        }
        throw error
      }
      agentTools.set(agent.id, disposers)
      return {
        text: 'Sticky-wall tools loaded: todo_list, todo_update, todo_split. '
          + 'They are callable from the next step. todo_list defaults to pending notes (planned + in progress).',
      }
    },
  }
}

/**
 * @param ctx - Host 插件上下文。
 * @param rawConfig - patch 行里的 config（本插件不用它，配置以 config.json 为准）。
 */
export function apply(ctx, rawConfig = {}) {
  mkdirSync(DATA_DIR, { recursive: true })

  const stored = readJson(CONFIG_FILE)
  const config = { ...DEFAULT_CONFIG, ...(isPlainObject(rawConfig) ? rawConfig : {}), ...(isPlainObject(stored) ? stored : {}) }
  config.llmTools = config.llmTools === true
  if (!isPlainObject(stored)) writeJsonAtomic(CONFIG_FILE, { llmTools: config.llmTools })

  const configRef = { current: { llmTools: config.llmTools } }
  const store = createStore(ctx)

  // 工具注册/撤销：设置一改就生效，不需要重载插件。
  // 默认只注册一个按需加载入口；三个墙工具在模型调用入口后进入当前 agent 作用域。
  const toolDisposers = []
  const agentTools = new Map()
  let toolsOn = false
  let tools = null
  let renderList = null
  let operations = null

  function disposeAgentTools() {
    for (const disposers of agentTools.values()) {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 撤销不能抛错 */ }
      }
    }
    agentTools.clear()
  }

  function syncTools(enabled) {
    const next = enabled === true
    if (next === toolsOn) return
    if (!next) {
      for (const dispose of toolDisposers.splice(0)) {
        try { dispose() } catch { /* 撤销不能抛错 */ }
      }
      disposeAgentTools()
      toolsOn = false
      log(ctx, 'LLM tools are now unregistered')
      return
    }
    if (!tools) return
    toolDisposers.push(ctx.tools.register(createLoaderTool(tools, agentTools)))
    toolsOn = true
    log(ctx, 'LLM tools: on-demand loader registered (todo_load_tools)')
  }

  // agent 销毁时清掉它的已加载记录（工具本身随 agent.ctx 一起撤销）。
  ctx.on('agent/disposed', ({ agent }) => {
    const disposers = agentTools.get(agent && agent.id)
    if (!disposers) return
    agentTools.delete(agent.id)
    for (const dispose of disposers) {
      try { dispose() } catch { /* 撤销不能抛错 */ }
    }
  })

  const built = createOperations(ctx, store, configRef, syncTools)
  operations = built.operations
  renderList = built.renderList
  tools = createTools(operations, renderList)

  ctx.effect(() => {
    syncTools(configRef.current.llmTools)
    return () => {
      for (const dispose of toolDisposers.splice(0)) {
        try { dispose() } catch { /* 撤销不能抛错 */ }
      }
      disposeAgentTools()
      toolsOn = false
    }
  }, 'dsh-todo: LLM tools')

  // 面板与 agent 工具共用同一套 operations，经应用自带的 HTTP 载体暴露。
  // webServer 是可选服务：宿主没有它（例如纯 CLI）时保留工具，只是没有面板数据接口。
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const disposeRoutes = registerRoutes(webCtx.webServer, {
        state: () => operations.state(),
        config: () => operations.config(),
        updateConfig: (body) => operations.updateConfig(body),
        create: (body) => operations.create(body),
        update: (body) => operations.update(body),
        arrange: (body) => operations.arrange(body),
        remove: (body) => operations.remove(body),
      })
      webCtx.effect(() => disposeRoutes, 'dsh-todo: panel routes')
      log(ctx, 'panel routes registered')
    } catch (error) {
      log(ctx, `panel routes unavailable: ${String((error && error.message) || error)}`)
    }
  })

  log(ctx, `mounted; llmTools=${configRef.current.llmTools} dataDir=${DATA_DIR}`)
}



