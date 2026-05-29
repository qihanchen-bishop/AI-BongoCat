export const LLM_PROVIDER = 'groq'

export const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY ?? ''

export const GROQ_MODELS = (import.meta.env.VITE_GROQ_MODELS ?? 'llama-3.3-70b-versatile,llama-3.1-8b-instant')
  .split(',')
  .map(model => model.trim())
  .filter(Boolean)

export const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
