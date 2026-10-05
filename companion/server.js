import { createClient } from '@supabase/supabase-js'
import { config as loadEnvironment } from 'dotenv'
import express from 'express'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import { fileURLToPath } from 'node:url'

loadEnvironment({ path: fileURLToPath(new URL('.env', import.meta.url)), override: true })

const app = express()
const port = Number(process.env.PORT || 3001)
const model = process.env.OPENAI_MODEL || 'gpt-6-luna'
const endpoint = 'https://api.openai.com/v1/chat/completions'
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
const useSupabase = Boolean(process.env.SUPABASE_URL && supabaseSecretKey)
const supabase = useSupabase
  ? createClient(process.env.SUPABASE_URL, supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null

const companionPrompt = `You are Urvashi, the user's practical personal assistant first and an authorized cybersecurity assistant when they ask about security. Speak in natural, warm, attentive English and respond directly. Keep simple answers concise, and give step-by-step detail when useful; do not impose a fixed maximum length. Ask a relevant follow-up only when it would help.

Help with everyday questions, learning, programming, debugging, writing, editing, planning, organization, productivity, technical troubleshooting, research, explanations, and analysis of user-provided files. Be practical, accurate, and easy to understand. Explain technical terms clearly and be honest about limitations.

Privacy and memory: Do not claim to remember information unless it is available through the application's explicit memory feature or the user explicitly asks you to remember it. Treat passwords, API keys, authentication tokens, financial details, and private documents as sensitive. Do not request sensitive information unless genuinely necessary, expose private information to another user, or suggest storing secrets in plain text. Uploaded files are for the current request only.

Cybersecurity: Help with education, defensive analysis, secure configuration, authorized scanner results, code review, vulnerability explanations, security labs, and CTFs. Distinguish education, defense, authorized testing, and unauthorized activity. Real-world security testing requires a clearly authorized target and a real application tool that supports the requested test. Prefer localhost, private networks, CTFs, and dedicated test environments; use conservative rates and avoid destructive actions. Never help steal credentials, break into unauthorized accounts or systems, deploy malware, establish unauthorized persistence, destroy data, or evade monitoring. If authorization is unclear, do not perform or claim a test; offer a safe lab alternative. No attack-simulation execution tool is currently connected, so never claim that a scan or test ran. For results actually supplied by an authorized tool, report the target, test, finding, severity, evidence, impact, fix, and safe verification procedure. Never invent evidence or results.

You are an AI, not a human. Be supportive without manipulation, pressure, or harm. Follow the language explicitly requested by the application; English is the default.`

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

async function getStoredKnowledge() {
  if (!supabase) return ''

  const { data, error } = await supabase
    .from('knowledge')
    .select('title, content, tags, updated_at')
    .order('updated_at', { ascending: false })
    .limit(8)

  if (error) {
    console.warn('Could not load knowledge from Supabase:', error.message)
    return ''
  }
  if (!Array.isArray(data) || data.length === 0) return ''

  return data
    .map((item) => {
      const title = normalizeText(item.title)
      const content = normalizeText(item.content)
      const tags = Array.isArray(item.tags) ? item.tags.filter(Boolean).join(', ') : ''
      if (!content) return ''
      return `- ${title || 'Untitled knowledge'}${tags ? ` [${tags}]` : ''}: ${content}`
    })
    .filter(Boolean)
    .join('\n')
}

async function getDatabaseStatus() {
  if (!supabase) {
    return {
      configured: false,
      connected: false,
      error: 'Add SUPABASE_URL and SUPABASE_SECRET_KEY to companion/.env.',
    }
  }

  const [knowledge, talks] = await Promise.all([
    supabase.from('knowledge').select('id').limit(1),
    supabase.from('important_talks').select('id').limit(1),
  ])
  const error = knowledge.error || talks.error
  if (error) {
    console.error('Supabase health check failed:', error.message)
    if (error.code === 'PGRST205' || error.code === '42P01' || error.message.includes('Could not find the table')) {
      return {
        configured: true,
        connected: true,
        schemaReady: false,
        error: 'Supabase is connected, but a required table is missing. Run supabase-schema.sql in the Supabase SQL editor.',
      }
    }
    return {
      configured: true,
      connected: false,
      schemaReady: false,
      error: 'Supabase could not be reached or a required table is missing. Run supabase-schema.sql.',
    }
  }

  return { configured: true, connected: true, schemaReady: true, error: '' }
}

function decodeAttachment(attachment) {
  if (
    !attachment ||
    typeof attachment.name !== 'string' ||
    typeof attachment.mimeType !== 'string' ||
    typeof attachment.dataBase64 !== 'string' ||
    !attachment.dataBase64
  ) {
    throw new Error('The attached file could not be read. Please select it again.')
  }

  const data = Buffer.from(attachment.dataBase64, 'base64')
  if (!data.length || data.length > 10 * 1024 * 1024) {
    throw new Error('Attachments must be smaller than 10 MB.')
  }
  return data
}

async function getAttachmentContent(attachment) {
  if (!attachment) return []

  const name = attachment.name.toLowerCase()
  if (/\.(png|jpe?g|webp)$/u.test(name)) {
    const data = decodeAttachment(attachment)
    const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
    if (!supportedTypes.has(attachment.mimeType)) {
      throw new Error('Use a PNG, JPEG, or WebP image.')
    }
    return [{
      type: 'image_url',
      image_url: { url: `data:${attachment.mimeType};base64,${data.toString('base64')}`, detail: 'auto' },
    }]
  }

  if (/\.(mp4|webm|mov)$/u.test(name)) {
    if (!Array.isArray(attachment.frames) || attachment.frames.length < 1 || attachment.frames.length > 5) {
      throw new Error('Could not read video frames. Try an MP4, WebM, or MOV video.')
    }
    const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
    return attachment.frames.map((frame) => {
      if (
        !frame ||
        !supportedTypes.has(frame.mimeType) ||
        typeof frame.dataBase64 !== 'string' ||
        !frame.dataBase64
      ) {
        throw new Error('The video contains an unsupported frame format.')
      }
      const data = Buffer.from(frame.dataBase64, 'base64')
      if (!data.length || data.length > 3 * 1024 * 1024) {
        throw new Error('Video frames are too large to analyze.')
      }
      return {
        type: 'image_url',
        image_url: {
          url: `data:${frame.mimeType};base64,${data.toString('base64')}`,
          detail: 'auto',
        },
      }
    })
  }

  const data = decodeAttachment(attachment)
  let text
  if (name.endsWith('.pdf')) {
    const parser = new PDFParse({ data })
    try {
      const parsed = await parser.getText()
      text = parsed.text
    } finally {
      await parser.destroy()
    }
  } else if (name.endsWith('.docx')) {
    const parsed = await mammoth.extractRawText({ buffer: data })
    text = parsed.value
  } else if (/\.(txt|md|csv)$/u.test(name)) {
    text = data.toString('utf8')
  } else {
    throw new Error('Supported files are PNG/JPEG/WebP images, MP4/WebM/MOV videos, PDF, DOCX, TXT, MD, and CSV.')
  }

  const cleanText = text.trim()
  if (!cleanText) {
    throw new Error('No readable text was found in that document.')
  }
  return [{
    type: 'text',
    text: `Document: ${attachment.name}\n${cleanText.slice(0, 40000)}${cleanText.length > 40000 ? '\n[Document text truncated]' : ''}`,
  }]
}

async function saveImportantTalk(userText, assistantText) {
  if (!supabase) return

  const trimmedUser = normalizeText(userText)
  const trimmedAssistant = normalizeText(assistantText)
  if (!trimmedUser || !trimmedAssistant) return

  const { error } = await supabase.from('important_talks').insert([
    { speaker: 'user', content: trimmedUser, importance: 1, tags: ['conversation'] },
    { speaker: 'assistant', content: trimmedAssistant, importance: 1, tags: ['conversation'] },
  ])
  if (error) {
    console.warn('Could not save conversation to Supabase:', error.message)
  }
}

app.use(express.json({ limit: '16mb' }))

app.get('/api/health', async (_request, response) => {
  const database = await getDatabaseStatus()
  response.json({
    configured: Boolean(process.env.OPENAI_API_KEY),
    model,
    database,
  })
})

app.get('/api/knowledge', async (_request, response) => {
  if (!supabase) {
    return response.status(503).json({
      error: 'Add SUPABASE_URL and SUPABASE_SECRET_KEY to companion/.env.',
    })
  }

  const { data, error } = await supabase
    .from('knowledge')
    .select('id, title, content, tags, updated_at')
    .order('updated_at', { ascending: false })
    .limit(20)

  if (error) {
    return response.status(500).json({ error: 'Could not load knowledge from Supabase.' })
  }

  return response.json({ items: data ?? [] })
})

app.post('/api/knowledge', async (request, response) => {
  const title = normalizeText(request.body?.title)
  const content = normalizeText(request.body?.content)
  const tags = Array.isArray(request.body?.tags)
    ? request.body.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim())
    : []

  if (!content || !title) {
    return response.status(400).json({ error: 'Provide both a title and content for the knowledge item.' })
  }

  if (!supabase) {
    return response.status(503).json({
      error: 'Set SUPABASE_URL and SUPABASE_SECRET_KEY in companion/.env to enable the knowledge database.',
    })
  }

  const { data, error } = await supabase
    .from('knowledge')
    .insert({ title, content, tags })
    .select('id, title, content, tags, updated_at')
    .single()

  if (error) {
    return response.status(500).json({ error: 'Could not save knowledge item to Supabase.' })
  }

  return response.status(201).json({ item: data })
})

app.post('/api/chat', async (request, response) => {
  const messages = request.body?.messages
  const attachment = request.body?.attachment
  const language = request.body?.language === 'en-IN' ? 'en-IN' : 'hi-IN'
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.some(
      (message) =>
        !message ||
        !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string',
    )
  ) {
    return response.status(400).json({ error: 'Send a conversation with valid messages.' })
  }

  if (!process.env.OPENAI_API_KEY) {
    return response.status(503).json({
      error: 'Set OPENAI_API_KEY in companion/.env, then restart the app to connect.',
    })
  }

  try {
    let attachmentContent = []
    try {
      attachmentContent = await getAttachmentContent(attachment)
    } catch (attachmentError) {
      const message = attachmentError instanceof Error
        ? attachmentError.message
        : 'Could not read the attached file.'
      return response.status(400).json({ error: message })
    }

    const knowledgeContext = await getStoredKnowledge()
    const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
    let upstream
    for (let attempt = 0; attempt < 3; attempt += 1) {
      upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: `${companionPrompt}${knowledgeContext ? `\n\nImportant remembered knowledge:\n${knowledgeContext}` : ''}\nReply in ${language === 'hi-IN' ? 'Hindi using Devanagari script' : 'English'}, regardless of the language used in earlier messages.`,
            },
            ...messages.map((message, index) => ({
              role: message.role,
              content: index === lastUserIndex && attachmentContent.length > 0
                ? [{ type: 'text', text: message.content }, ...attachmentContent]
                : message.content,
            })),
          ],
        }),
      })
      if ((upstream.status !== 429 && upstream.status < 500) || attempt === 2) break
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
    }

    if (!upstream.ok) {
      let providerMessage = ''
      try {
        const parsedError = await upstream.json()
        if (typeof parsedError.error?.message === 'string') {
          providerMessage = parsedError.error.message
        }
      } catch {
        providerMessage = ''
      }
      return response.status(502).json({
        error: providerMessage
          ? `The model service returned an error (${upstream.status}): ${providerMessage.slice(0, 300)}`
          : `The model service returned an error (${upstream.status}). Check your provider settings.`,
      })
    }

    const result = await upstream.json()
    const reply = result.choices?.[0]?.message?.content ?? ''
    if (typeof reply !== 'string' || !reply.trim()) {
      return response.status(502).json({
        error: 'OpenAI returned an empty reply. Try again.',
      })
    }

    const lastUserMessage = messages.filter((message) => message.role === 'user').at(-1)?.content
    if (lastUserMessage) await saveImportantTalk(lastUserMessage, reply)

    return response.json({ reply })
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error
        ? error.message
        : 'Unknown error'
    console.error('Chat request failed before receiving a model response:', cause)
    return response.status(502).json({
      error: 'The chat request failed before receiving a model response. Check the server connection and try again.',
    })
  }
})

app.post('/api/search', async (request, response) => {
  const query = request.body?.query
  const language = request.body?.language === 'en-IN' ? 'English' : 'Hindi using Devanagari script'
  if (typeof query !== 'string' || !query.trim() || query.length > 500) {
    return response.status(400).json({ error: 'Enter a search query up to 500 characters.' })
  }

  if (!process.env.OPENAI_API_KEY) {
    return response.status(503).json({
      error: 'Set OPENAI_API_KEY in companion/.env, then restart the app to search.',
    })
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        input: `Search the web for the user's query and summarize the most useful, current findings in ${language}. Keep the answer concise and factual. The UI will show the cited source links separately.\n\nQuery: ${query.trim()}`,
      }),
    })

    if (!upstream.ok) {
      let providerMessage = ''
      try {
        const parsedError = await upstream.json()
        if (typeof parsedError.error?.message === 'string') {
          providerMessage = parsedError.error.message
        }
      } catch {
        providerMessage = ''
      }
      return response.status(502).json({
        error: providerMessage
          ? `Web search failed (${upstream.status}): ${providerMessage.slice(0, 300)}`
          : `Web search failed (${upstream.status}). Check your OpenAI model and API access.`,
      })
    }

    const result = await upstream.json()
    const outputMessages = Array.isArray(result.output)
      ? result.output.filter((item) => item.type === 'message')
      : []
    const answerParts = []
    const sources = new Map()
    for (const message of outputMessages) {
      for (const content of Array.isArray(message.content) ? message.content : []) {
        if (content.type === 'output_text' && typeof content.text === 'string') {
          answerParts.push(content.text)
        }
        for (const annotation of Array.isArray(content.annotations) ? content.annotations : []) {
          if (annotation.type !== 'url_citation' || typeof annotation.url !== 'string') continue
          try {
            const url = new URL(annotation.url)
            if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
            sources.set(url.href, {
              title: typeof annotation.title === 'string' ? annotation.title : url.hostname,
              url: url.href,
            })
          } catch {
            continue
          }
        }
      }
    }

    const answer = answerParts.join('\n').trim()
    if (!answer) {
      return response.status(502).json({ error: 'OpenAI returned no web search results. Try again.' })
    }
    await saveImportantTalk(`Search the web for: ${query.trim()}`, answer)
    return response.json({ answer, sources: [...sources.values()] })
  } catch {
    return response.status(502).json({ error: 'Could not reach OpenAI web search. Check your connection.' })
  }
})

app.listen(port, '0.0.0.0', () => {
  console.log(`Urvashi API listening on port ${port}`)
})