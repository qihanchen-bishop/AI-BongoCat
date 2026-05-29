import { appDataDir } from '@tauri-apps/api/path'
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'

import defaultTasks from '@/assets/pet/scheduledTasks.json'
import { join } from '@/utils/path'

export interface PetTask {
  id: string
  title: string
  content: string
  enabled: boolean
  updatedAt: string
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
      .map(task => normalizeTask(task, now))
      .filter(task => task !== null),
  }
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

    return taskFile
  }

  try {
    const data = JSON.parse(await readTextFile(file)) as PetTaskFile

    return {
      version: 1,
      updatedAt: data.updatedAt,
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
    } satisfies PetTaskFile
  } catch {
    return createDefaultTaskFile()
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
      taskMap.set(id, nextTask)
    }
  }

  await savePetTasks({
    version: 1,
    updatedAt: now,
    tasks: [...taskMap.values()],
  })
}
