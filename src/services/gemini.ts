import heartbeat from '@/assets/pet/heartbeat.json'
import persona from '@/assets/pet/persona.json'
import { GEMINI_API_KEY, GEMINI_MODEL } from '@/config/gemini'

import type { PetMemoryUpdate } from './petMemory'
import type { PetTaskUpdate } from './petTasks'

import { formatPetMemoryForPrompt, loadPetMemory } from './petMemory'
import { formatPetTasksForPrompt, loadPetTasks } from './petTasks'

type GeminiRole = 'user' | 'model'

export interface GeminiMessage {
  role: GeminiRole
  text: string
}

interface GeminiPart {
  text?: string
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[]
    }
  }>
  error?: {
    message?: string
  }
}

interface PetReplyPayload {
  reply: string
  memory_updates: PetMemoryUpdate[]
  task_updates: PetTaskUpdate[]
}

const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

function extractResponseText(data: GeminiResponse) {
  return data.candidates?.[0]?.content?.parts
    ?.map(part => part.text)
    .filter(Boolean)
    .join('')
    .trim()
}

function parsePetReplyPayload(text: string): PetReplyPayload {
  const normalized = text
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()
  const relaxedJson = normalized
    .replace(/'/g, '"')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
  const candidates = [
    normalized,
    normalized.match(/\{[\s\S]*\}/)?.[0],
    relaxedJson,
    relaxedJson.match(/\{[\s\S]*\}/)?.[0],
  ].filter(Boolean) as string[]

  let payload: Partial<PetReplyPayload> | undefined

  for (const candidate of candidates) {
    try {
      let parsed = JSON.parse(candidate) as Partial<PetReplyPayload> | string

      for (let index = 0; index < 3 && typeof parsed === 'string'; index += 1) {
        parsed = JSON.parse(parsed.trim()) as Partial<PetReplyPayload> | string
      }

      if (typeof parsed !== 'string') {
        payload = parsed
        break
      }
    } catch {
      // Try the next candidate. Gemini may wrap the JSON as a string.
    }
  }

  if (!payload) {
    throw new Error('invalid pet reply payload')
  }

  return {
    reply: String(payload.reply ?? '').trim(),
    memory_updates: Array.isArray(payload.memory_updates)
      ? payload.memory_updates.map(update => ({
          id: String(update.id ?? ''),
          content: String(update.content ?? ''),
        }))
      : [],
    task_updates: Array.isArray(payload.task_updates)
      ? payload.task_updates.map(update => ({
          action: update.action === 'delete' ? 'delete' : 'upsert',
          id: String(update.id ?? ''),
          title: update.title === undefined ? undefined : String(update.title),
          content: update.content === undefined ? undefined : String(update.content),
          enabled: update.enabled === undefined ? undefined : Boolean(update.enabled),
        }))
      : [],
  }
}

function extractReplyFallback(text: string) {
  const normalized = text.replace(/\\"/g, '"')
  const matched = normalized.match(/"reply"\s*:\s*"((?:\\.|[^"\\])*)"/)
  const reply = matched?.[1]

  if (!reply) return text

  return reply
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .trim()
}

function createEmptyPetReplyPayload(): PetReplyPayload {
  return {
    reply: '',
    memory_updates: [],
    task_updates: [],
  }
}

export async function generatePetReply(messages: GeminiMessage[]) {
  if (!GEMINI_API_KEY) {
    throw new Error('请先配置 Gemini API Key')
  }

  const memory = await loadPetMemory()
  const memoryText = formatPetMemoryForPrompt(memory)

  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{
          text: [
            '你是一个桌面宠物猫对话引擎。你必须严格按照 JSON 输出。',
            `小猫名字：${persona.name}`,
            `小猫物种：${persona.species}`,
            `对用户的称呼：${persona.userAddress}`,
            `小猫性格：${persona.personality.join('；')}`,
            `回复规则：${persona.replyRules.join('；')}`,
            `记忆规则：${persona.memoryRules.join('；')}`,
            '已保存的长期记忆：',
            memoryText,
            '输出格式只能是一个 JSON 对象，不要输出 Markdown、代码块或额外解释。',
            'JSON 格式：{"reply":"给用户看的简短回复","memory_updates":[{"id":"稳定的英文或拼音记忆键","content":"更新后的中文记忆内容"}],"task_updates":[]}',
            'memory_updates 必须只包含需要新增或覆盖的重要长期记忆；没有更新时返回空数组。',
            '普通聊天通常不要修改 task_updates，除非用户明确要求创建、修改或删除提醒任务。',
          ].join('\n'),
        }],
      },
      contents: messages.map(message => ({
        role: message.role,
        parts: [{ text: message.text }],
      })),
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 256,
        responseMimeType: 'application/json',
      },
    }),
  })

  const data = await response.json() as GeminiResponse

  if (!response.ok) {
    throw new Error(data.error?.message ?? 'Gemini 请求失败')
  }

  const text = extractResponseText(data)

  if (!text) {
    throw new Error('Gemini 没有返回内容')
  }

  try {
    const payload = parsePetReplyPayload(text)

    if (!payload.reply) {
      throw new Error('empty reply')
    }

    return payload
  } catch {
    return {
      reply: extractReplyFallback(text),
      memory_updates: [],
      task_updates: [],
    } satisfies PetReplyPayload
  }
}

export async function generatePetHeartbeat() {
  if (!GEMINI_API_KEY) {
    throw new Error('请先配置 Gemini API Key')
  }

  const [memory, tasks] = await Promise.all([
    loadPetMemory(),
    loadPetTasks(),
  ])

  const memoryText = formatPetMemoryForPrompt(memory)
  const taskText = formatPetTasksForPrompt(tasks)

  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{
          text: [
            '你是桌面宠物猫的心跳维护引擎。你必须严格按照 JSON 输出。',
            `小猫名字：${persona.name}`,
            `小猫物种：${persona.species}`,
            `对用户的称呼：${persona.userAddress}`,
            `小猫性格：${persona.personality.join('；')}`,
            `回复规则：${persona.replyRules.join('；')}`,
            `记忆规则：${persona.memoryRules.join('；')}`,
            `心跳规则：${heartbeat.rules.join('；')}`,
            '已保存的长期记忆：',
            memoryText,
            '当前启用的定时任务：',
            taskText,
            '输出格式只能是一个 JSON 对象，不要输出 Markdown、代码块或额外解释。',
            'JSON 格式：{"reply":"适合主动显示时填写简短回复，否则为空字符串","memory_updates":[{"id":"稳定的英文或拼音记忆键","content":"更新后的中文记忆内容"}],"task_updates":[{"action":"upsert","id":"task_id","title":"任务标题","content":"任务内容","enabled":true},{"action":"delete","id":"task_id"}]}',
            '如果没有必要主动说话，reply 必须是空字符串。',
            'task_updates 只返回需要新增、覆盖或删除的任务；没有更新时返回空数组。',
            '不要把当前已有任务原样放进 task_updates。',
            '如果只是执行提醒，不要更新任务；只在 reply 中给出一句自然提醒。',
          ].join('\n'),
        }],
      },
      contents: [{
        role: 'user',
        parts: [{
          text: [
            '心跳触发。',
            `当前时间：${new Date().toLocaleString()}`,
            '请检查记忆和定时任务，决定是否主动回复，并维护需要更新的记忆和任务。',
          ].join('\n'),
        }],
      }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 320,
        responseMimeType: 'application/json',
      },
    }),
  })

  const data = await response.json() as GeminiResponse

  if (!response.ok) {
    throw new Error(data.error?.message ?? 'Gemini 请求失败')
  }

  const text = extractResponseText(data)

  if (!text) {
    throw new Error('Gemini 没有返回内容')
  }

  try {
    return parsePetReplyPayload(text)
  } catch {
    return createEmptyPetReplyPayload()
  }
}
