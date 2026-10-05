# Urvashi

A fictional AI companion represented by a textured 3D human model rendered with Three.js. The local server keeps the model API key out of the browser.

## Run locally

1. Copy `.env.example` to `.env`, replace the placeholder with your OpenAI API key, and choose a model available to your project. Put secrets only in `.env`, never in `.env.example`.
2. Run `npm run dev`.
3. Open the URL printed by Vite.

The server uses OpenAI Chat Completions for conversation and the Responses API with its built-in web search tool for the right-side search panel. Configure `OPENAI_API_KEY` and `OPENAI_MODEL` in `.env`; the example defaults to `gpt-6-luna`. The selected model and API project must support web search. Search results include clickable source links. The key is read only by the local server and is never sent to the client.

Persistent conversation history is saved in this browser and, when Supabase is configured, conversation turns are also saved in the `important_talks` table. This history is used as chat context in the current browser. Uploaded file contents are not saved. Set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env` to enable persistent database history and the knowledge feature. Keep the secret key in `.env` only; never place it in `.env.example` or client-side code. Run [`supabase-schema.sql`](./supabase-schema.sql) in the Supabase SQL editor. Knowledge items are loaded into chat context.

Use Chrome or Edge over HTTPS or localhost, and allow microphone access when prompted. English is the default language; use the Hindi/English selector to choose the language for voice recognition, AI replies, and speech playback. Tap the microphone to speak, type a question, or use the paperclip to attach one photo, video, or document. Supported attachments are PNG/JPEG/WebP, MP4/WebM/MOV, PDF, DOCX, TXT, MD, and CSV, up to 10 MB. Videos are analyzed using four sampled frames; uploaded file contents are not added to saved conversation history. Ask Urvashi to “search the web for …” when you want a web search; its answer and source links appear in the conversation. Ordinary messages do not trigger web search. Conversation history is saved automatically in this browser and in Supabase when configured. Replies use the browser's system voice. The 3D avatar uses procedural head, nod, and facial gestures while speaking, with lip motion paced by available speech-boundary events. Use the replay button to hear the latest reply again if playback is blocked or interrupted. No camera or video feed is used.

Without a valid key, the interface still opens, but Urvashi cannot generate or speak replies. Check the on-screen message if microphone access or speech playback is unavailable.
