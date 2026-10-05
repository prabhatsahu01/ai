import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Languages, Mic, MicOff, MoonStar, Paperclip, RotateCcw, Send, Volume2, VolumeX, X } from 'lucide-react'
import type { AvatarActivity } from './AvatarScene.tsx'
import './AvatarExperience.css'

const AvatarScene = lazy(() => import('./AvatarScene.tsx'))

type ConversationMessage = {
  role: 'assistant' | 'user'
  content: string
  sources?: SearchSource[]
}

type SearchSource = {
  title: string
  url: string
}

type EncodedAttachment = {
  name: string
  mimeType: string
  dataBase64: string
  frames?: { mimeType: string; dataBase64: string }[]
}

type SpeechLanguage = 'hi-IN' | 'en-IN'

type SpeechResult = {
  isFinal: boolean
  0: { transcript: string }
}

type SpeechResultEvent = Event & {
  resultIndex: number
  results: { length: number; [index: number]: SpeechResult }
}

type SpeechErrorEvent = Event & { error: string }

type SpeechRecognitionInstance = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onresult: ((event: SpeechResultEvent) => void) | null
  onerror: ((event: SpeechErrorEvent) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

const historyKey = 'urvashi-call-history'

function getExplicitSearchQuery(text: string): string | null {
  const match = text.match(/(?:search(?:\s+the)?\s+web(?:\s+for)?|search\s+online(?:\s+for)?|look\s+up(?:\s+online)?|find\s+online)\s*[:,-]?\s*(.+)/iu)
  return match?.[1]?.trim() || null
}

function isSafeSourceUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function getSpeechRecognition(): SpeechRecognitionConstructor | undefined {
  const speechWindow = window as SpeechWindow
  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition
}

function loadHistory(): ConversationMessage[] {
  try {
    const saved = window.localStorage.getItem(historyKey)
    if (!saved) return []
    const parsed: unknown = JSON.parse(saved)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((message): message is ConversationMessage => (
      message &&
      ['assistant', 'user'].includes(message.role) &&
      typeof message.content === 'string' &&
      (message.sources === undefined ||
        (Array.isArray(message.sources) &&
          message.sources.every((source: SearchSource) =>
            typeof source?.title === 'string' && typeof source?.url === 'string',
          )))
    ))
  } catch {
    return []
  }
}

function getBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Could not read the selected file.'))
        return
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('Could not read the selected file.'))
    reader.readAsDataURL(file)
  })
}

function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      resolve()
    }
    const onError = () => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      reject(new Error('Could not read frames from this video. Try another video format.'))
    }
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    video.currentTime = time
  })
}

async function prepareAttachment(file: File): Promise<EncodedAttachment> {
  if (file.type.startsWith('video/')) {
    const objectUrl = URL.createObjectURL(file)
    try {
      const video = document.createElement('video')
      video.preload = 'auto'
      video.muted = true
      video.src = objectUrl
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => reject(new Error('Could not open this video. Try an MP4, WebM, or MOV file.'))
      })
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error('This video has no readable duration.')
      }

      const frames: EncodedAttachment['frames'] = []
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Your browser could not prepare video frames.')
      for (let index = 1; index <= 4; index += 1) {
        await seekVideo(video, Math.max(0, Math.min(video.duration * index / 5, video.duration - 0.05)))
        const scale = Math.min(1, 768 / Math.max(video.videoWidth, video.videoHeight))
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const frame = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) resolve(blob)
            else reject(new Error('Could not prepare a video frame for analysis.'))
          }, 'image/jpeg', 0.78)
        })
        frames.push({ mimeType: 'image/jpeg', dataBase64: await getBase64(frame) })
      }
      return { name: file.name, mimeType: file.type, dataBase64: '', frames }
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  return {
    name: file.name,
    mimeType: file.type,
    dataBase64: await getBase64(file),
  }
}

function AvatarExperience() {
  const [activity, setActivity] = useState<AvatarActivity>('ready')
  const [speechLanguage, setSpeechLanguage] = useState<SpeechLanguage>('en-IN')
  const [speakerEnabled, setSpeakerEnabled] = useState(true)
  const [modelReady, setModelReady] = useState(false)
  const [voiceSupported, setVoiceSupported] = useState(true)
  const [error, setError] = useState('')
  const [messageDraft, setMessageDraft] = useState('')
  const [attachment, setAttachment] = useState<File | null>(null)
  const [databaseMessage, setDatabaseMessage] = useState('')
  const [chatMessages, setChatMessages] = useState<ConversationMessage[]>(loadHistory)
  const [latestReply, setLatestReply] = useState('')
  const activityRef = useRef<AvatarActivity>('ready')
  const speakingRef = useRef(false)
  const speechMotionRef = useRef(0)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const historyRef = useRef(chatMessages)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [chatMessages, activity])

  useEffect(() => {
    fetch('/api/health')
      .then((response) => response.json())
      .then((health: {
        configured: boolean
        database?: { connected: boolean; schemaReady?: boolean; error?: string }
      }) => {
        setModelReady(health.configured)
        setDatabaseMessage(
          health.database?.connected && health.database.schemaReady
            ? ''
            : health.database?.error || 'Supabase is not connected.',
        )
      })
      .catch(() => {
        setModelReady(false)
        setDatabaseMessage('Could not check the Supabase connection.')
      })
  }, [])

  useEffect(() => () => {
    recognitionRef.current?.stop()
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [])

  function updateActivity(next: AvatarActivity) {
    activityRef.current = next
    setActivity(next)
    speakingRef.current = next === 'speaking'
    if (next !== 'speaking') speechMotionRef.current = 0
  }

  function appendHistory(message: ConversationMessage) {
    historyRef.current = [...historyRef.current, message]
    setChatMessages(historyRef.current)
    try {
      window.localStorage.setItem(historyKey, JSON.stringify(historyRef.current))
    } catch {
      setError('Conversation history could not be saved in this browser.')
    }
  }

  function speakReply(text: string, force = false) {
    if (!speakerEnabled && !force) {
      updateActivity('ready')
      return
    }
    if (!('speechSynthesis' in window)) {
      const message = 'Speech playback is not supported in this browser.'
      setError(message)
      updateActivity('ready')
      return
    }

    try {
      const synthesis = window.speechSynthesis
      synthesis.cancel()
      synthesis.resume()

      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = speechLanguage
      utterance.rate = 0.95
      utterance.pitch = 0.9
      const voices = synthesis.getVoices()
      const language = utterance.lang.toLowerCase()
      const voice = voices.find((candidate) => candidate.lang.toLowerCase() === language)
        ?? voices.find((candidate) => candidate.lang.toLowerCase().startsWith(language.split('-')[0]))
      if (voice) utterance.voice = voice
      utterance.onstart = () => {
        speechMotionRef.current = 0
        updateActivity('speaking')
      }
      utterance.onboundary = (event) => {
        if (!speakingRef.current) return
        const segment = text.slice(event.charIndex, event.charIndex + Math.max(event.charLength, 1))
        speechMotionRef.current = /[aeiouअआइईउऊएऐओऔऋािीुूृेैोौंः]/iu.test(segment) ? 1 : 0.48
      }
      utterance.onend = () => updateActivity('ready')
      utterance.onerror = (event) => {
        updateActivity('ready')
        if (event.error === 'canceled' || event.error === 'interrupted') return
        const message = 'Speech playback failed. Check your device volume and try again.'
        setError(message)
      }
      synthesis.speak(utterance)
    } catch {
      const message = 'Speech playback could not start. Check your browser audio settings.'
      setError(message)
      updateActivity('ready')
    }
  }

  async function sendTurn(text: string, file?: File) {
    if ((!text && !file) || activityRef.current === 'thinking') return
    recognitionRef.current?.stop()
    recognitionRef.current = null
    updateActivity('thinking')
    setError('')
    appendHistory({ role: 'user', content: text })

    try {
      const webSearchQuery = file ? null : getExplicitSearchQuery(text)
      if (webSearchQuery) {
        const response = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: webSearchQuery, language: speechLanguage }),
        })
        const result: { answer?: string; sources?: SearchSource[]; error?: string } = await response.json()
        if (!response.ok || !result.answer) {
          throw new Error(result.error || 'Web search could not complete. Try again.')
        }

        appendHistory({
          role: 'assistant',
          content: result.answer,
          sources: result.sources ?? [],
        })
        setLatestReply(result.answer)
        speakReply(result.answer)
        return
      }

      const encodedAttachment = file ? await prepareAttachment(file) : undefined
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: historyRef.current,
          language: speechLanguage,
          attachment: encodedAttachment,
        }),
      })
      const result: { reply?: string; error?: string } = await response.json()
      if (!response.ok || !result.reply) {
        throw new Error(result.error || 'Urvashi could not answer just now. Try again shortly.')
      }

      setModelReady(true)
      appendHistory({ role: 'assistant', content: result.reply })
      setLatestReply(result.reply)
      speakReply(result.reply)
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'The connection faltered.'
      if (message.includes('OPENAI_API_KEY')) setModelReady(false)
      setError(message)
      updateActivity('ready')
    }
  }

  function handleMessageSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = messageDraft.trim()
    if ((!text && !attachment) || activityRef.current === 'thinking') return
    if ('speechSynthesis' in window) window.speechSynthesis.resume()
    setMessageDraft('')
    setAttachment(null)
    void sendTurn(text || `Please analyze the attached file: ${attachment?.name ?? ''}`, attachment ?? undefined)
  }

  function handleAttachmentChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const supportedExtension = /\.(png|jpe?g|webp|mp4|webm|mov|pdf|docx|txt|md|csv)$/iu.test(file.name)
    if (!supportedExtension) {
      setError('Choose an image, video, PDF, DOCX, TXT, MD, or CSV file.')
      event.target.value = ''
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Attachments must be smaller than 10 MB.')
      event.target.value = ''
      return
    }
    setError('')
    setAttachment(file)
  }

  function replayLatestReply() {
    if (!latestReply) return
    if (!speakerEnabled) setSpeakerEnabled(true)
    if ('speechSynthesis' in window) window.speechSynthesis.resume()
    speakReply(latestReply, true)
  }

  function beginListening() {
    if (activityRef.current === 'thinking') return
    if (activityRef.current === 'listening') {
      recognitionRef.current?.stop()
      recognitionRef.current = null
      updateActivity('ready')
      return
    }

    if (!window.isSecureContext) {
      const message = 'Voice input needs a secure connection. Open the app over HTTPS or localhost.'
      setError(message)
      return
    }

    const Recognition = getSpeechRecognition()
    if (!Recognition) {
      setVoiceSupported(false)
      const message = 'Voice input is unavailable here. Use Chrome or Edge over HTTPS or localhost.'
      setError(message)
      return
    }

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      window.speechSynthesis.resume()
    }
    const recognition = new Recognition()
    recognition.lang = speechLanguage
    recognition.continuous = false
    recognition.interimResults = true
    let receivedSpeech = false
    recognition.onstart = () => {
      if (recognitionRef.current === recognition) updateActivity('listening')
    }
    recognition.onresult = (event) => {
      receivedSpeech = true
      let finalTranscript = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result.isFinal) finalTranscript += result[0].transcript
      }
      if (finalTranscript.trim()) void sendTurn(finalTranscript.trim())
    }
    recognition.onerror = (event) => {
      if (event.error === 'aborted') return
      updateActivity('ready')
      const messages: Record<string, string> = {
        'audio-capture': 'No microphone was found. Connect or enable a microphone, then try again.',
        'network': 'Speech recognition could not connect. Check your internet connection and try again.',
        'no-speech': 'I did not hear anything. Check your microphone and try again.',
        'not-allowed': 'Microphone access was blocked. Allow microphone access in your browser settings.',
        'service-not-allowed': 'The browser speech service is blocked. Try Chrome or Edge over HTTPS.',
      }
      const message = messages[event.error] || 'Voice input stopped. Check microphone permissions and try again.'
      setError(message)
    }
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null
      if (activityRef.current === 'listening') {
        updateActivity('ready')
        if (!receivedSpeech) {
          const message = 'I did not hear anything. Check your microphone and try again.'
          setError(message)
        }
      }
    }

    recognitionRef.current = recognition
    setError('')
    try {
      recognition.start()
    } catch {
      recognitionRef.current = null
      updateActivity('ready')
      const message = 'The microphone could not start. Check browser permissions and try again.'
      setError(message)
    }
  }

  function toggleSpeaker() {
    const nextValue = !speakerEnabled
    setSpeakerEnabled(nextValue)
    if (!nextValue && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      if (activityRef.current === 'speaking') updateActivity('ready')
    }
  }

  return (
    <main className={`avatar-experience avatar-${activity}`}>
      <Suspense fallback={null}>
        <AvatarScene
          activity={activity}
          speakingRef={speakingRef}
          speechMotionRef={speechMotionRef}
        />
      </Suspense>
      <div className="avatar-shading" aria-hidden="true" />

      <header className="avatar-header">
        <a className="avatar-brand" href="#home" aria-label="Urvashi home">
          <span className="avatar-brand-mark"><MoonStar size={18} strokeWidth={1.6} /></span>
          <span>urvashi<span className="brand-period">.</span></span>
        </a>
      </header>

      <footer className="avatar-controls">
        <section className="chat-panel" aria-label="Conversation">
          <header className="chat-panel-header">
            <span>MESSAGES</span>
            {activity === 'listening' && <span className="chat-listening">LISTENING</span>}
          </header>
          <div className="chat-messages" aria-live="polite" aria-relevant="additions text">
            {chatMessages.length === 0 ? (
              <p className="chat-empty">
                {speechLanguage === 'hi-IN'
                  ? 'बातचीत शुरू करने के लिए संदेश भेजें। वेब खोजने के लिए कहें: “वेब पर खोजें...”'
                  : 'Send a message to start. To search the web, say “search the web for...”'}
              </p>
            ) : chatMessages.map((message, index) => (
              <div
                className={`chat-message-wrap chat-message-wrap-${message.role}`}
                key={`${index}-${message.role}`}
              >
                <p className={`chat-message chat-message-${message.role}`}>{message.content}</p>
                {message.sources?.some((source) => isSafeSourceUrl(source.url)) && (
                  <div className="chat-sources">
                    <span>SOURCES</span>
                    {message.sources.filter((source) => isSafeSourceUrl(source.url)).map((source) => (
                      <a href={source.url} key={source.url} target="_blank" rel="noreferrer">
                        {source.title || source.url}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {activity === 'thinking' && (
              <p className="chat-message chat-message-assistant typing-indicator" aria-label="Replying">
                <i aria-hidden="true" />
                <i aria-hidden="true" />
                <i aria-hidden="true" />
              </p>
            )}
            <div ref={messagesEndRef} />
          </div>

          {error && <p className="avatar-error" role="status">{error}</p>}
          {!modelReady && (
            <p className="avatar-setup">Add your <code>OPENAI_API_KEY</code> to <code>.env</code>, then restart the server.</p>
          )}
          {databaseMessage && <p className="avatar-setup" role="status">Supabase: {databaseMessage}</p>}
          {!voiceSupported && <p className="avatar-error">Voice input works in Chrome or Edge.</p>}

          <div className="chat-controls">
            <div className="language-switch" role="group" aria-label="Reply language">
              <Languages size={15} aria-hidden="true" />
              <button
                type="button"
                className={speechLanguage === 'hi-IN' ? 'language-option language-option-active' : 'language-option'}
                aria-pressed={speechLanguage === 'hi-IN'}
                disabled={activity === 'listening' || activity === 'thinking'}
                onClick={() => setSpeechLanguage('hi-IN')}
              >
                हिन्दी
              </button>
              <button
                type="button"
                className={speechLanguage === 'en-IN' ? 'language-option language-option-active' : 'language-option'}
                aria-pressed={speechLanguage === 'en-IN'}
                disabled={activity === 'listening' || activity === 'thinking'}
                onClick={() => setSpeechLanguage('en-IN')}
              >
                English
              </button>
            </div>
            {attachment && (
              <div className="attachment-pill">
                <span title={attachment.name}>{attachment.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  title="Remove attachment"
                  onClick={() => {
                    setAttachment(null)
                    if (attachmentInputRef.current) attachmentInputRef.current.value = ''
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <form className="message-form" onSubmit={handleMessageSubmit}>
              <label className="screen-reader-only" htmlFor="message-input">
                {speechLanguage === 'hi-IN' ? 'उर्वशी से कुछ पूछें' : 'Ask Urvashi something'}
              </label>
              <button
                className="attachment-button"
                type="button"
                aria-label="Attach a photo, video, or document"
                title="Attach a photo, video, or document"
                disabled={activity === 'thinking'}
                onClick={() => attachmentInputRef.current?.click()}
              >
                <Paperclip size={17} />
              </button>
              <input
                ref={attachmentInputRef}
                hidden
                type="file"
                accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,.pdf,.docx,.txt,.md,.csv"
                aria-label="Choose a photo, video, or document"
                onChange={handleAttachmentChange}
                disabled={activity === 'thinking'}
              />
              <input
                id="message-input"
                type="text"
                value={messageDraft}
                onChange={(event) => setMessageDraft(event.target.value)}
                placeholder={speechLanguage === 'hi-IN' ? 'उर्वशी से कुछ पूछें...' : 'Ask Urvashi something...'}
                autoComplete="off"
                maxLength={2000}
                disabled={activity === 'thinking'}
              />
              <button
                className="message-send-button"
                type="submit"
                aria-label="Send message"
                title="Send message"
                disabled={(!messageDraft.trim() && !attachment) || activity === 'thinking'}
              >
                <Send size={18} />
              </button>
            </form>
            <div className="control-row">
              <button
                className={`speaker-button ${speakerEnabled ? '' : 'speaker-muted'}`}
                aria-label={speakerEnabled ? 'Mute spoken replies' : 'Enable spoken replies'}
                title={speakerEnabled ? 'Mute spoken replies' : 'Enable spoken replies'}
                onClick={toggleSpeaker}
              >
                {speakerEnabled ? <Volume2 size={19} /> : <VolumeX size={19} />}
              </button>
              <button
                className={`voice-button ${activity === 'listening' ? 'voice-button-active' : ''}`}
                aria-label={activity === 'listening' ? 'Stop listening' : 'Speak to Urvashi'}
                title={activity === 'listening' ? 'Stop listening' : 'Speak to Urvashi'}
                onClick={beginListening}
                disabled={activity === 'thinking'}
              >
                {activity === 'listening' ? <MicOff size={21} /> : <Mic size={21} />}
              </button>
              <button
                className="speaker-button replay-button"
                aria-label="Replay last reply"
                title="Replay last reply"
                onClick={replayLatestReply}
                disabled={!latestReply}
              >
                <RotateCcw size={18} />
              </button>
            </div>
          </div>
          <p className="voice-disclosure">No camera. Voice uses browser services; attached files are analyzed temporarily.</p>
        </section>
      </footer>

      <span className="scene-index" aria-hidden="true">V.01&nbsp;&nbsp; / &nbsp;&nbsp;AFTER HOURS</span>
      <span className="screen-reader-only">An animated three-dimensional human portrait.</span>
    </main>
  )
}

export default AvatarExperience