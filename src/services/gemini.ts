import { GEMINI_API_KEY, GEMINI_MODEL } from '@/config/gemini'

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

const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

export async function generatePetReply(messages: GeminiMessage[]) {
  if (!GEMINI_API_KEY) {
    throw new Error('请先配置 Gemini API Key')
  }

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
            '你是一只桌面宠物猫，性格温暖、活泼、稍微调皮。',
            '你正在和用户聊天，请根据用户的话自然回复。',
            '回复使用简体中文，尽量短，适合显示在小气泡里。',
            '不要使用 Markdown，不要列清单，通常控制在 40 个中文字符以内。',
          ].join('\n'),
        }],
      },
      contents: messages.map(message => ({
        role: message.role,
        parts: [{ text: message.text }],
      })),
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 96,
      },
    }),
  })

  const data = await response.json() as GeminiResponse

  if (!response.ok) {
    throw new Error(data.error?.message ?? 'Gemini 请求失败')
  }

  const text = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text)
    .filter(Boolean)
    .join('')
    .trim()

  if (!text) {
    throw new Error('Gemini 没有返回内容')
  }

  return text
}
