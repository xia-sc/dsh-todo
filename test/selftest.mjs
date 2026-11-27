// 离线自检：不启动宿主，用桩 ctx 验证 Host 半侧的存储、路由、工具注册开关与工具行为。
// 运行：node test/selftest.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('..', import.meta.url))
const HOME = join(HERE, '.selftest-home')
process.env.DSH_HOME = HOME

rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'dsh-todo'), { recursive: true })

const logs = []
const routes = []
let registered = []

const webCtx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
  effect(fn) {
    const disposer = fn()
    return () => { if (typeof disposer === 'function') disposer() }
  },
}

function makeContext() {
  return {
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(`warn: ${message}`) },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect(fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    on() {
      return () => {}
    },
    inject(names, callback) { callback(webCtx) },
    get(name) {
      if (name === 'workspaceRegistry') {
        return { list: () => [{ id: 'ws-research', title: '研发', path: 'E:\\dsh' }] }
      }
      return undefined
    },
  }
}

async function callRoute(path, method, body) {
  const route = routes.find((entry) => entry.path === `/dsh-todo/api${path}`)
  if (!route) throw new Error(`no route ${path}`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const request = {
    method,
    url: `${route.path}`,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let status = 0
  let text = ''
  const response = {
    headersSent: false,
    writeHead(nextStatus) { status = nextStatus; this.headersSent = true },
    end(payload) { if (payload !== undefined) text = String(payload) },
  }
  await route.handler(request, response)
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  return { status, body: parsed, route }
}

const results = []
function check(label, condition, detail) {
  results.push({ label, ok: condition === true, detail })
  if (condition !== true) console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  else console.log(`ok    ${label}`)
}

// ---------------------------------------------------------------- 默认关闭

writeFileSync(join(HOME, 'dsh-todo', 'config.json'), JSON.stringify({ llmTools: false }))
const { apply } = await import('../index.js')
apply(makeContext(), {})
check('默认配置下不注册任何工具', registered.length === 0, `registered=${registered.length}`)
check('默认设置落盘为 llmTools=false', JSON.parse(readFileSync(join(HOME, 'dsh-todo', 'config.json'), 'utf8')).llmTools === false)
check('路由已注册且要求登录', routes.length === 6 && routes.every((route) => route.auth === 'required'), `routes=${routes.length}`)

// ---------------------------------------------------------------- 普通便签

const created = await callRoute('/tasks', 'POST', { title: '写周报' })
check('只给正文即可创建', created.status === 200 && created.body?.ok === true, JSON.stringify(created.body))
const plain = created.body?.data?.task
check('全部可选字段留空 = 普通便签',
  plain.workspaceId === null && plain.planStartAt === null && plain.planEndAt === null && plain.attachments.length === 0,
  JSON.stringify(plain))

const state = await callRoute('/state', 'GET')
check('state 返回任务与设置',
  state.body?.data?.tasks?.length === 1 && state.body?.data?.config?.llmTools === false,
  JSON.stringify(state.body?.data?.config))
check('state 带工作区清单供关联',
  Array.isArray(state.body?.data?.workspaces) && state.body.data.workspaces[0].id === 'ws-research')

// ---------------------------------------------------------------- 可选字段

const full = await callRoute('/tasks', 'POST', {
  title: '评审设计稿',
  note: '带附件和时间',
  status: 'active',
  workspaceId: 'ws-research',
  planStartAt: '2026-11-25T09:00',
  planEndAt: '2026-11-25T18:00',
  attachments: [{ name: '设计稿', path: 'E:\\docs\\design.md' }],
})
const rich = full.body?.data?.task
check('可选字段可以一起填', rich?.workspaceId === 'ws-research' && rich?.status === 'active' && rich?.attachments?.length === 1,
  JSON.stringify(rich))
check('时间按 ISO 归一化', typeof rich?.planStartAt === 'string' && rich.planStartAt.includes('T'), rich?.planStartAt)

const badStatus = await callRoute('/tasks', 'POST', { title: '非法状态', status: 'blocked' })
check('拒绝第五种状态', badStatus.status === 400 && /status must be one of/.test(badStatus.body?.error || ''), String(badStatus.body?.error))
check('状态错误带稳定错误码', badStatus.body?.code === 'STATUS_INVALID', String(badStatus.body?.code))

const missingUpdate = await callRoute('/tasks/update', 'POST', { id: 'todo_nope', patch: { status: 'done' } })
check('改不存在的便签返回 404 与 NOT_FOUND',
  missingUpdate.status === 404 && missingUpdate.body?.code === 'NOT_FOUND',
  JSON.stringify(missingUpdate.body))

const inverted = await callRoute('/tasks/update', 'POST', {
  id: rich.id,
  patch: { planStartAt: '2026-11-26T09:00', planEndAt: '2026-11-25T09:00' },
})
check('起止时间倒置只提示不拦截',
  inverted.body?.ok === true && typeof inverted.body?.data?.warning === 'string',
  JSON.stringify(inverted.body?.data?.warning))

const cleared = await callRoute('/tasks/update', 'POST', {
  id: rich.id,
  patch: { clear: ['workspaceId', 'planStartAt', 'planEndAt', 'attachments'] },
})
const clearedTask = cleared.body?.data?.task
check('清空可选字段回到普通便签',
  clearedTask?.workspaceId === null && clearedTask?.planStartAt === null && clearedTask?.attachments.length === 0,
  JSON.stringify(clearedTask))

// ---------------------------------------------------------------- 开关与工具

const enabled = await callRoute('/config', 'POST', { llmTools: true })
check('设置开启写入文件', enabled.body?.data?.llmTools === true
  && JSON.parse(readFileSync(join(HOME, 'dsh-todo', 'config.json'), 'utf8')).llmTools === true)
check('开启后只注册按需加载入口',
  registered.length === 1 && registered[0].name === 'todo_load_tools',
  registered.map((tool) => tool.name).join(','))

// 模拟调用该入口的 agent：作用域内注册的工具单独收集。
const agentRegistered = []
const fakeAgent = {
  id: 'agent-selftest',
  ctx: {
    tools: {
      register(definition) {
        agentRegistered.push(definition)
        return () => {
          const index = agentRegistered.indexOf(definition)
          if (index >= 0) agentRegistered.splice(index, 1)
        }
      },
    },
  },
}
const loader = registered[0]
const loadedText = (await loader.execute({}, { agent: fakeAgent })).text
check('加载入口调用后出现三个工具',
  agentRegistered.length === 3
  && agentRegistered.map((tool) => tool.name).sort().join(',') === 'todo_list,todo_split,todo_update',
  `${agentRegistered.map((tool) => tool.name).join(',')} :: ${loadedText}`)

const againText = (await loader.execute({}, { agent: fakeAgent })).text
check('重复调用不会重复注册', agentRegistered.length === 3 && /already loaded/.test(againText), againText)
const noAgentText = (await loader.execute({}, {})).text
check('没有 agent 上下文时不加载', agentRegistered.length === 3 && /No agent context/.test(noAgentText), noAgentText)

const listTool = agentRegistered.find((tool) => tool.name === 'todo_list')
const updateTool = agentRegistered.find((tool) => tool.name === 'todo_update')
const splitTool = agentRegistered.find((tool) => tool.name === 'todo_split')

// 只留一张待完成便签，验证默认只列 pending。
await callRoute('/tasks/update', 'POST', { id: rich.id, patch: { status: 'done' } })
const listText = (await listTool.execute({}, {})).text
check('todo_list 默认只列待完成', listText.includes('写周报'), listText)
check('todo_list 不列已完成', listText.includes('评审设计稿') === false, listText)
check('普通便签在列表里有标记', /plain note/.test(listText), listText)

const createdPlain = await callRoute('/tasks', 'POST', { title: '整理素材' })
const plainId = createdPlain.body?.data?.task?.id
const updatedText = (await updateTool.execute({
  id: plainId,
  status: 'active',
  workspaceId: 'ws-research',
  planStartAt: '2026-11-27T10:00',
}, {})).text
check('todo_update 改状态与工作区', /Updated/.test(updatedText) && /active/.test(updatedText), updatedText)

const splitText = (await splitTool.execute({ id: plainId, subtasks: ['收集图片', '写图注'] }, {})).text
check('todo_split 生成两张子便签', /into 2 note/.test(splitText), splitText)
const afterSplit = await callRoute('/state', 'GET')
const children = afterSplit.body.data.tasks.filter((task) => task.parentId === plainId)
check('子便签带 parentId 且为规划中', children.length === 2 && children.every((task) => task.status === 'planned'),
  JSON.stringify(children.map((task) => [task.title, task.status])))

// 归档：默认视图与 all 都不含，显式 status: archived 才返回。
const archivedUpdate = (await updateTool.execute({ id: plainId, status: 'archived' }, {})).text
check('todo_update 可以归档', /Updated/.test(archivedUpdate) && /archived/.test(archivedUpdate), archivedUpdate)
const allText = (await listTool.execute({ status: 'all' }, {})).text
check('todo_list 的 all 不含已归档', allText.includes('整理素材') === false, allText)
const archivedText = (await listTool.execute({ status: 'archived' }, {})).text
check('todo_list 显式列出已归档', archivedText.includes('整理素材'), archivedText)

const disabled = await callRoute('/config', 'POST', { llmTools: false })
check('关闭后入口与已加载工具都撤销',
  disabled.body?.data?.llmTools === false && registered.length === 0 && agentRegistered.length === 0,
  `registered=${registered.length} agent=${agentRegistered.length}`)

// ---------------------------------------------------------------- 摆放、纸色与整理

const posA = (await callRoute('/tasks', 'POST', { title: '摆放 A', x: 40, y: 60, color: 'mint' })).body.data.task
check('创建时写入位置与纸色', posA.x === 40 && posA.y === 60 && posA.color === 'mint', JSON.stringify(posA))

const posB = (await callRoute('/tasks', 'POST', { title: '摆放 B' })).body.data.task
check('没有位置时自动补网格与默认纸色',
  typeof posB.x === 'number' && typeof posB.y === 'number' && posB.color === 'cream',
  JSON.stringify(posB))

const badColor = await callRoute('/tasks', 'POST', { title: '坏纸色', color: 'rainbow' })
check('拒绝预选色之外的纸色',
  badColor.status === 400 && badColor.body?.code === 'COLOR_INVALID',
  JSON.stringify(badColor.body))

const badPos = await callRoute('/tasks/update', 'POST', { id: posA.id, patch: { x: -5 } })
check('拒绝负数坐标',
  badPos.status === 400 && badPos.body?.code === 'POSITION_INVALID',
  JSON.stringify(badPos.body))

const arranged = await callRoute('/tasks/arrange', 'POST', {
  positions: [{ id: posA.id, x: 100, y: 120 }, { id: posB.id, x: 364, y: 120 }],
})
check('arrange 批量保存位置',
  arranged.body?.ok === true && arranged.body?.data?.count === 2,
  JSON.stringify(arranged.body))

const afterArrange = await callRoute('/state', 'GET')
const arrangedTasks = afterArrange.body.data.tasks.filter((task) => [posA.id, posB.id].includes(task.id))
check('位置持久化', arrangedTasks.every((task) => task.x >= 100)
  && arrangedTasks.find((task) => task.id === posB.id)?.x === 364,
  JSON.stringify(arrangedTasks.map((task) => [task.title, task.x, task.y])))

const badArrange = await callRoute('/tasks/arrange', 'POST', { positions: [{ id: 'todo_nope', x: 1, y: 2 }] })
check('arrange 拒绝不存在的便签',
  badArrange.status === 404 && badArrange.body?.code === 'NOT_FOUND',
  JSON.stringify(badArrange.body))

// ---------------------------------------------------------------- 旧数据迁移

writeFileSync(join(HOME, 'dsh-todo', 'tasks.json'), JSON.stringify({
  version: 1,
  tasks: [
    { id: 'todo_legacy1', title: '旧便签一', status: 'planned', planStartAt: null, updatedAt: '2026-11-20T00:00:00.000Z', createdAt: '2026-11-20T00:00:00.000Z' },
    { id: 'todo_legacy2', title: '旧便签二', status: 'planned', planStartAt: null, updatedAt: '2026-11-21T00:00:00.000Z', createdAt: '2026-11-21T00:00:00.000Z' },
    { id: 'todo_legacy3', title: '旧便签三', status: 'cancelled', planStartAt: null, updatedAt: '2026-11-22T00:00:00.000Z', createdAt: '2026-11-22T00:00:00.000Z' },
  ],
}))
apply(makeContext(), {})
const migratedFile = JSON.parse(readFileSync(join(HOME, 'dsh-todo', 'tasks.json'), 'utf8'))
const migratedTasks = migratedFile.tasks
check('旧数据自动补位置与纸色',
  migratedTasks.every((task) => typeof task.x === 'number' && typeof task.y === 'number')
  && migratedTasks.every((task) => task.color === 'cream')
  && migratedTasks[0].x === 24 && migratedTasks[1].x === 288,
  JSON.stringify(migratedTasks.map((task) => [task.title, task.x, task.y, task.color])))
check('旧 cancelled 一次性迁移为 archived',
  migratedTasks.find((task) => task.id === 'todo_legacy3')?.status === 'archived',
  JSON.stringify(migratedTasks.map((task) => [task.id, task.status])))
check('存储版本升到 2', migratedFile.version === 2, String(migratedFile.version))

// ---------------------------------------------------------------- 删除与留档

const removed = await callRoute('/tasks/delete', 'POST', { id: plainId })
const afterDelete = await callRoute('/state', 'GET')
check('删除父便签不连带删除子便签',
  removed.body?.ok === true
  && afterDelete.body.data.tasks.filter((task) => task.title === '收集图片').every((task) => task.parentId === null),
  JSON.stringify(removed.body?.data))

writeFileSync(join(HOME, 'dsh-todo', 'tasks.json'), '{ broken json')
apply(makeContext(), {})
const moved = readFileSync(join(HOME, 'dsh-todo', 'tasks.json'), 'utf8')
check('坏掉的任务文件被改名留档', moved.includes('"tasks": []'))

rmSync(HOME, { recursive: true, force: true })

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
