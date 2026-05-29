import { appDataDir } from '@tauri-apps/api/path'
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'

import defaultTasks from '@/assets/pet/scheduledTasks.json'
import { join } from '@/utils/path'

import { logPetDebug } from './petDebugLog'

export interface PetTask {
  id: string
  title: string
  content: string
  enabled: boolean
  updatedAt: string
  source?: 'config' | 'runtime'
}

export interface PetTaskUpdate {
  action: 'upsert' | 'delete'
  id: string
  title?: string
  content?: string
  enabled?: boolean
}

interface PetTaskFile {
  version: 1
  updatedAt: string
  tasks: PetTask[]
}

const TASK_DIR_NAME = 'pet-memory'
const TASK_FILE_NAME = 'tasks.json'
const LEGACY_CONFIG_TASK_IDS = new Set(['drink_water', 'rest_eyes', 'daily_mood'])

async function getTaskPath() {
  const dir = join(await appDataDir(), TASK_DIR_NAME)

  return {
    dir,
    file: join(dir, TASK_FILE_NAME),
  }
}

function normalizeTask(task: Partial<PetTask>, now: string): PetTask | null {
  const id = String(task.id ?? '').trim()
  const title = String(task.title ?? '').trim()
  const content = String(task.content ?? '').trim()

  if (!id || !title || !content) return null

  return {
    id,
    title,
    content,
    enabled: task.enabled ?? true,
    updatedAt: task.updatedAt ?? now,
  }
}

function createDefaultTaskFile(): PetTaskFile {
  const now = new Date().toISOString()

  return {
    version: 1,
    updatedAt: now,
    tasks: defaultTasks
      .map(task => normalizeTask({ ...task, source: 'config' }, now))
      .filter(task => task !== null),
  }
}

function syncConfiguredTasks(taskFile: PetTaskFile) {
  const now = new Date().toISOString()
  const configTasks = defaultTasks
    .map(task => normalizeTask({ ...task, source: 'config' }, now))
    .filter(task => task !== null)
  const configTaskIds = new Set(configTasks.map(task => task.id))
  const runtimeTasks = taskFile.tasks.filter((task) => {
    return task.source !== 'config'
      && !configTaskIds.has(task.id)
      && !LEGACY_CONFIG_TASK_IDS.has(task.id)
  })

  return {
    version: 1,
    updatedAt: now,
    tasks: [...configTasks, ...runtimeTasks],
  } satisfies PetTaskFile
}

async function ensureTaskDir() {
  const { dir } = await getTaskPath()

  if (await exists(dir)) return

  await mkdir(dir, { recursive: true })
}

export async function loadPetTasks() {
  const { file } = await getTaskPath()

  if (!await exists(file)) {
    const taskFile = createDefaultTaskFile()

    await savePetTasks(taskFile)
    await logPetDebug('tasks.initialized', { path: file, tasks: taskFile.tasks })

    return taskFile
  }

  try {
    const data = JSON.parse(await readTextFile(file)) as PetTaskFile
    const taskFile = syncConfiguredTasks({
      version: 1,
      updatedAt: data.updatedAt,
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
    })

    await savePetTasks(taskFile)
    await logPetDebug('tasks.loaded', { path: file, tasks: taskFile.tasks })

    return taskFile
  } catch {
    const taskFile = createDefaultTaskFile()

    await logPetDebug('tasks.load_failed_fallback', { path: file, tasks: taskFile.tasks })

    return taskFile
  }
}

export async function savePetTasks(taskFile: PetTaskFile) {
  const { file } = await getTaskPath()

  await ensureTaskDir()
  await writeTextFile(file, JSON.stringify(taskFile, null, 2))
}

export function formatPetTasksForPrompt(taskFile: PetTaskFile) {
  const tasks = taskFile.tasks.filter(task => task.enabled)

  if (!tasks.length) return '暂无启用的定时任务。'

  return tasks
    .map(task => `- ${task.id}｜${task.title}：${task.content}`)
    .join('\n')
}

export async function applyPetTaskUpdates(updates: PetTaskUpdate[]) {
  const taskFile = await loadPetTasks()
  const now = new Date().toISOString()
  const taskMap = new Map(taskFile.tasks.map(task => [task.id, task]))

  for (const update of updates) {
    const id = update.id.trim()

    if (!id) continue

    if (update.action === 'delete') {
      taskMap.delete(id)
      continue
    }

    const existing = taskMap.get(id)
    const nextTask = normalizeTask({
      id,
      title: update.title ?? existing?.title,
      content: update.content ?? existing?.content,
      enabled: update.enabled ?? existing?.enabled ?? true,
      updatedAt: now,
    }, now)

    if (nextTask) {
      taskMap.set(id, {
        ...nextTask,
        source: existing?.source ?? 'runtime',
      })
    }
  }

  const nextTaskFile = {
    version: 1,
    updatedAt: now,
    tasks: [...taskMap.values()],
  } satisfies PetTaskFile

  await savePetTasks(nextTaskFile)
  await logPetDebug('tasks.updated', { updates, tasks: nextTaskFile.tasks })
}
