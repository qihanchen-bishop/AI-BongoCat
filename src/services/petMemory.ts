import { appDataDir } from '@tauri-apps/api/path'
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'

import { join } from '@/utils/path'

import { logPetDebug } from './petDebugLog'

export interface PetMemoryItem {
  id: string
  content: string
  updatedAt: string
}

export interface PetMemoryUpdate {
  id: string
  content: string
}

interface PetMemoryFile {
  version: 1
  updatedAt: string
  items: PetMemoryItem[]
}

const MEMORY_DIR_NAME = 'pet-memory'
const MEMORY_FILE_NAME = 'memory.json'

async function getMemoryPath() {
  const dir = join(await appDataDir(), MEMORY_DIR_NAME)

  return {
    dir,
    file: join(dir, MEMORY_FILE_NAME),
  }
}

function createEmptyMemory(): PetMemoryFile {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: [],
  }
}

async function ensureMemoryDir() {
  const { dir } = await getMemoryPath()

  if (await exists(dir)) return

  await mkdir(dir, { recursive: true })
}

export async function loadPetMemory() {
  const { file } = await getMemoryPath()

  if (!await exists(file)) return createEmptyMemory()

  try {
    const data = JSON.parse(await readTextFile(file)) as PetMemoryFile

    return {
      version: 1,
      updatedAt: data.updatedAt,
      items: Array.isArray(data.items) ? data.items : [],
    } satisfies PetMemoryFile
  } catch {
    return createEmptyMemory()
  }
}

export async function savePetMemory(memory: PetMemoryFile) {
  const { file } = await getMemoryPath()

  await ensureMemoryDir()
  await writeTextFile(file, JSON.stringify(memory, null, 2))
}

export function formatPetMemoryForPrompt(memory: PetMemoryFile) {
  if (!memory.items.length) return '暂无长期记忆。'

  return memory.items
    .map(item => `- ${item.id}: ${item.content}`)
    .join('\n')
}

export async function applyPetMemoryUpdates(updates: PetMemoryUpdate[]) {
  const validUpdates = updates
    .map(update => ({
      id: update.id.trim(),
      content: update.content.trim(),
    }))
    .filter(update => update.id && update.content)

  if (!validUpdates.length) return

  const memory = await loadPetMemory()
  const now = new Date().toISOString()
  const itemMap = new Map(memory.items.map(item => [item.id, item]))

  for (const update of validUpdates) {
    itemMap.set(update.id, {
      id: update.id,
      content: update.content,
      updatedAt: now,
    })
  }

  const nextMemory = {
    version: 1,
    updatedAt: now,
    items: [...itemMap.values()],
  } satisfies PetMemoryFile

  await savePetMemory(nextMemory)
  await logPetDebug('memory.updated', { updates: validUpdates, items: nextMemory.items })
}
