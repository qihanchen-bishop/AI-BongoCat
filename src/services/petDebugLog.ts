import { appDataDir } from '@tauri-apps/api/path'
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { info, warn } from '@tauri-apps/plugin-log'

import { join } from '@/utils/path'

const LOG_DIR_NAME = 'pet-memory'
const LOG_FILE_NAME = 'debug.log'
const MAX_LOG_LENGTH = 200_000

async function getLogPath() {
  const dir = join(await appDataDir(), LOG_DIR_NAME)

  return {
    dir,
    file: join(dir, LOG_FILE_NAME),
  }
}

function stringifyDetails(details?: unknown) {
  if (details === undefined) return ''

  try {
    return ` ${JSON.stringify(details)}`
  } catch {
    return ` ${String(details)}`
  }
}

export async function logPetDebug(event: string, details?: unknown) {
  const line = `[${new Date().toISOString()}] ${event}${stringifyDetails(details)}`

  console.warn(`[AI BongoCat] ${event}`, details ?? '')
  await info(line).catch(() => {})

  try {
    const { dir, file } = await getLogPath()

    if (!await exists(dir)) {
      await mkdir(dir, { recursive: true })
    }

    const prevLog = await readTextFile(file).catch(() => '')
    const nextLog = `${prevLog}${line}\n`.slice(-MAX_LOG_LENGTH)

    await writeTextFile(file, nextLog)
  } catch (error) {
    console.warn('[AI BongoCat] failed to write debug log', error)
    await warn(`[AI BongoCat] failed to write debug log ${String(error)}`).catch(() => {})
  }
}
