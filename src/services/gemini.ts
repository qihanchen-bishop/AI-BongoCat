import heartbeat from '@/assets/pet/heartbeat.json'
import persona from '@/assets/pet/persona.json'
import { GROQ_API_KEY, GROQ_API_URL, GROQ_MODELS, LLM_PROVIDER } from '@/config/llm'

import type { PetActivitySummary } from './petActivity'
import type { PetMemoryUpdate } from './petMemory'
import type { PetTaskUpdate } from './petTasks'

import { formatPetActivityForPrompt } from './petActivity'
import { logPetDebug } from './petDebugLog'
import { formatPetMemoryForPrompt, loadPetMemory } from './petMemory'
import { formatPetTasksForPrompt, loadPetTasks } from './petTasks'

type LLMRole = 'user' | 'model'

export interface LLMMessage {
  role: LLMRole
  text: string
}

type GroqRole = 'system' | 'user' | 'assistant'

interface GroqMessage {
  role: GroqRole
  content: string
}

interface GroqResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

export interface PetReplyPayload {
  reply: string
  memory_updates: PetMemoryUpdate[]
  task_updates: PetTaskUpdate[]
}

function extractResponseText(data: GroqResponse) {
  return data.choices?.[0]?.message?.content?.trim()
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
      // Try the next candidate. Models may wrap the JSON as a string.
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

function toGroqMessages(systemPrompt: string, messages: LLMMessage[]): GroqMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    ...messages.map(message => ({
      role: message.role === 'model' ? 'assistant' : 'user',
      content: message.text,
    }) satisfies GroqMessage),
  ]
}

function isFallbackError(status: number, data: GroqResponse) {
  const message = data.error?.message?.toLowerCase() ?? ''
  const code = data.error?.code?.toLowerCase() ?? ''
  const type = data.error?.type?.toLowerCase() ?? ''

  return status === 429
    || status === 503
    || status === 500
    || status === 400
    || message.includes('rate limit')
    || message.includes('quota')
    || message.includes('model')
    || code.includes('rate')
    || code.includes('quota')
    || type.includes('rate')
}

async function createChatCompletion(messages: GroqMessage[], maxTokens: number) {
  if (!GROQ_API_KEY) {
    throw new Error('请先配置 Groq API Key')
  }

  if (!GROQ_MODELS.length) {
    throw new Error('请至少配置一个 Groq 模型')
  }

  let lastError: Error | undefined

  for (const model of GROQ_MODELS) {
    await logPetDebug('llm.model_attempt', { provider: LLM_PROVIDER, model })

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.8,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    })

    const data = await response.json() as GroqResponse

    if (response.ok) {
      await logPetDebug('llm.model_success', { provider: LLM_PROVIDER, model })

      const text = extractResponseText(data)

      if (!text) {
        lastError = new Error('Groq 没有返回内容')
        continue
      }

      return {
        model,
        text,
      }
    }

    lastError = new Error(data.error?.message ?? `Groq 请求失败，HTTP ${response.status}`)

    await logPetDebug('llm.model_failed', {
      provider: LLM_PROVIDER,
      model,
      status: response.status,
      error: data.error,
      willFallback: isFallbackError(response.status, data),
    })

    if (!isFallbackError(response.status, data)) {
      break
    }
  }

  throw lastError ?? new Error('Groq 请求失败')
}

export async function generatePetReply(messages: LLMMessage[]) {
  if (!GROQ_API_KEY) {
    throw new Error('请先配置 Groq API Key')
  }

  const memory = await loadPetMemory()
  const memoryText = formatPetMemoryForPrompt(memory)

  await logPetDebug('chat.request', {
    messages,
    memory: memory.items,
  })

  const systemPrompt = [
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
  ].join('\n')

  const { model, text } = await createChatCompletion(toGroqMessages(systemPrompt, messages), 256)

  await logPetDebug('chat.raw_response', { model, text })

  try {
    const payload = parsePetReplyPayload(text)

    if (!payload.reply) {
      throw new Error('empty reply')
    }

    await logPetDebug('chat.parsed_response', payload)

    return payload
  } catch (error) {
    const payload = {
      reply: extractReplyFallback(text),
      memory_updates: [],
      task_updates: [],
    } satisfies PetReplyPayload

    await logPetDebug('chat.parse_fallback', {
      error: error instanceof Error ? error.message : String(error),
      payload,
    })

    return payload
  }
}

export async function generatePetHeartbeat(activitySummary: PetActivitySummary) {
  if (!GROQ_API_KEY) {
    throw new Error('请先配置 Groq API Key')
  }

  const [memory, tasks] = await Promise.all([
    loadPetMemory(),
    loadPetTasks(),
  ])

  const memoryText = formatPetMemoryForPrompt(memory)
  const taskText = formatPetTasksForPrompt(tasks)
  const activityText = formatPetActivityForPrompt(activitySummary)

  await logPetDebug('heartbeat.request', {
    memory: memory.items,
    tasks: tasks.tasks,
    activity: activitySummary,
  })

  const systemPrompt = [
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
    '两次心跳之间的键盘鼠标活动统计：',
    activityText,
    '输出格式只能是一个 JSON 对象，不要输出 Markdown、代码块或额外解释。',
    'JSON 格式：{"reply":"适合主动显示时填写简短回复，否则为空字符串","memory_updates":[{"id":"稳定的英文或拼音记忆键","content":"更新后的中文记忆内容"}],"task_updates":[{"action":"upsert","id":"task_id","title":"任务标题","content":"任务内容","enabled":true},{"action":"delete","id":"task_id"}]}',
    '每次心跳 reply 都必须填写一句自然、简短、能显示在气泡里的话。',
    'task_updates 只返回需要新增、覆盖或删除的任务；没有更新时返回空数组。',
    '不要把当前已有任务原样放进 task_updates。',
    '如果只是执行提醒，不要更新任务；只在 reply 中给出一句自然提醒。',
  ].join('\n')
  const userPrompt = [
    '心跳触发。',
    `当前时间：${new Date().toLocaleString()}`,
    '请检查记忆、定时任务和键盘鼠标活动，给出一句主动回复，并维护需要更新的记忆和任务。',
  ].join('\n')
  const { model, text } = await createChatCompletion(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    320,
  )

  await logPetDebug('heartbeat.raw_response', { model, text })

  try {
    const payload = parsePetReplyPayload(text)

    await logPetDebug('heartbeat.parsed_response', payload)

    return payload
  } catch (error) {
    const payload = createEmptyPetReplyPayload()

    await logPetDebug('heartbeat.parse_failed', {
      error: error instanceof Error ? error.message : String(error),
      payload,
    })

    return payload
  }
}
