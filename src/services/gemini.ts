import persona from '@/assets/pet/persona.json'
import { GEMINI_API_KEY, GEMINI_MODEL } from '@/config/gemini'

import type { PetMemoryUpdate } from './petMemory'

import { formatPetMemoryForPrompt, loadPetMemory } from './petMemory'

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
  const candidates = [
    normalized,
    normalized.match(/\{[\s\S]*\}/)?.[0],
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
            'JSON 格式：{"reply":"给用户看的简短回复","memory_updates":[{"id":"稳定的英文或拼音记忆键","content":"更新后的中文记忆内容"}]}',
            'memory_updates 必须只包含需要新增或覆盖的重要长期记忆；没有更新时返回空数组。',
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
    } satisfies PetReplyPayload
  }
}
