# MIMIT Health LLM Client

A chat interface for Salesforce-hosted LLMs (the [Models API](https://developer.salesforce.com/docs/einstein/genai/guide/models-api.html)), built with [Next.js](https://nextjs.org) and [prompt-kit](https://prompt-kit.com) UI components.

- Multi-turn chat — the full conversation is sent to the model each turn.
- Model picker driven by a simple config file.
- Salesforce credentials stay **server-side**; the browser only talks to a local `/api/chat` route.
- **File attachments** — attach a `.txt`, `.docx`, or `.pdf` and ask questions about it.

## How it works

```
Browser (app/page.tsx)
   │  POST /api/chat  { model, messages: [{role, content}, ...] }
   ▼
Next.js API route (app/api/chat/route.ts)   ← validates model + messages
   ▼
lib/salesforce.ts
   ├─ POST {SF_LOGIN_URL}/services/oauth2/token         (client_credentials → access_token)
   └─ POST {SF_API_HOST}/einstein/platform/v1/models/{model}/chat-generations
             # token is issued by your org, but the Models API is served from
             # https://api.salesforce.com — NOT the org instance URL.
             headers: Authorization: Bearer …, x-sfdc-app-context: EinsteinGPT,
                      x-client-feature-id: ai-platform-models-connected-app
             body:    { "messages": [ { "role": "system|user|assistant", "content": "…" } ] }
   ▼
Assistant reply ← generationDetails.generations[0].content
```

The OAuth token is cached in memory on the server and refreshed automatically (and again on a `401`).

## File attachments

Click the paperclip in the composer to attach a document and ask questions about it.

**Supported:** `.txt`, `.docx`, `.pdf` (with a text layer). One file per message.

**Everything else is refused with a reason** — images, `.doc`, spreadsheets,
presentations, archives, empty/corrupt files, and PDFs that are scans. Nothing is
silently dropped.

### The document is sent as extracted text, not as the file

This is the important design point, and it is not a matter of taste — the
Salesforce Models API is **text-only**. A chat message is `{role, content: String}`
and nothing else: no image parts, no `attachments` field, no multipart. Sending a
file as base64 inside `content` was measured against all 6 configured models and
**failed on every one** for real `.docx`/`.pdf` (their text lives in compressed
streams the model can't inflate), while several models *invented* plausible answers
instead of reporting failure. Extracted text worked on 6/6 and costs ~2.4× fewer
tokens.

So the server extracts the text and embeds it in the message:

```
Browser: paperclip → POST /api/attach (multipart: file, model, usedTokens)
   ▼
app/api/attach/route.ts     ← Clerk auth → size check → extract → context-fit check
   │  lib/extract-text.ts:  .txt decode │ .docx = ZIP + WordprocessingML │ .pdf = pdf.js
   ▼
{ name, kind, pages, chars, estTokens, text }
   ▼
Composer shows a chip. On send, lib/attachment-format.ts embeds the text:

    The user attached a file: "memo.docx" (Word). Its full extracted text is …

    [file: memo.docx]
    …extracted text…
    [/file]

    <the user's question>
```

The embedded block is stripped back out for display (`splitAttachment`), so the
transcript shows a small chip instead of a 100k-character wall of text — on a fresh
send and after resuming a chat from the database alike.

### Limits

| Limit | Value | Where |
|---|---|---|
| Max upload size | 25 MB | `MAX_UPLOAD_BYTES`, `config/attachments.ts` |
| Max share of remaining context per file | 60% | `MAX_CONTEXT_SHARE` |
| Tokens held back for the reply + estimate slack | 8,000 | `CONTEXT_RESERVE_TOKENS` |
| Token estimate | `chars / 4` | `estimateTokens` (the API exposes no tokenizer) |

Before staging a file, `/api/attach` checks it actually fits: it takes the selected
model's context window, subtracts what the conversation already occupies and the
reserve, caps the result at 60%, and returns `413` naming both numbers if the
document is bigger. Switching to a smaller-window model or a longer chat therefore
changes what will fit.

**Raising the size cap requires two changes together** — `MAX_UPLOAD_BYTES` *and*
`experimental.proxyClientMaxBodySize` in `next.config.ts`. This app runs `proxy.ts`,
so Next buffers the whole request body, and above that limit it **truncates** rather
than rejects, which surfaces to the user as a corrupt file. Note the memory cost:
the body is buffered by the proxy and again as an `ArrayBuffer` for extraction.

### Gotchas

- **`pdfjs-dist` must stay out of the server bundle** (`serverExternalPackages` in
  `next.config.ts`). Bundled, pdf.js resolves its worker relative to the emitted
  chunk and every PDF fails with `Setting up fake worker failed: Cannot find module
  .next/dev/server/chunks/pdf.worker.mjs`. This does *not* reproduce when running
  the extraction module under plain `node` — only through Next.
- **No OCR.** A scanned PDF has no text to extract and is rejected with an
  explanation. Image-heavy PDFs can be huge while holding little text.
- Extracted text is persisted with the turn in `ai.chat_message.content`, so it
  counts toward that chat's stored size and is re-sent as context on every
  subsequent turn.

To re-verify the base64-vs-text finding after a Salesforce release, see
`scripts/probes/` (`document-base64-by-type.mjs` covers this directly).

## Setup

1. **Install dependencies** (already done if you scaffolded this):
   ```bash
   npm install
   ```

2. **Configure credentials.** Copy `.env.example` to `.env.local` and fill in your org values:
   ```
   SF_LOGIN_URL=https://your-domain.my.salesforce.com
   SF_CLIENT_ID=your_consumer_key
   SF_CLIENT_SECRET=your_consumer_secret
   ```
   `.env.local` is gitignored. A pre-filled `.env.local` already exists with the
   client id/secret from `docs/Salesforce Models API V1.md` — **you still need to set
   `SF_LOGIN_URL` to your org's My Domain URL.**

   The Connected App must have the OAuth **client credentials** flow enabled and be
   authorized for the Models API.

3. **Configure models.** Edit `config/models.ts`. Each entry's `id` is the exact
   Salesforce Models API model name used in the endpoint path. Only models listed
   here appear in the picker and are accepted by the API route.

4. **Run:**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000.

## Project layout

| Path | Purpose |
|------|---------|
| `config/models.ts` | List of selectable models + optional system prompt |
| `config/attachments.ts` | Accepted file types, size cap, context-budget constants, rejection copy |
| `lib/salesforce.ts` | Server-side Models API client (token + chat-generations) |
| `lib/extract-text.ts` | Document → text (`.txt`, `.docx` ZIP reader, `.pdf` via pdf.js) |
| `lib/attachment-format.ts` | Embeds an attachment in / strips it from message content |
| `lib/types.ts` | Shared `ChatMessage` type (matches the API schema) |
| `app/api/chat/route.ts` | Validates input, proxies to Salesforce |
| `app/api/attach/route.ts` | Extracts an upload to text + checks it fits the context window |
| `app/page.tsx` | Chat UI (prompt-kit components) |
| `components/ui/*` | prompt-kit + shadcn components |
| `scripts/probes/` | Standalone scripts that test what the Models API really accepts |
| `docs/` | Reference API notes + architecture log (gitignored — local only) |

## Notes

- Replies are **non-streaming** (single complete response). The Models API also has a
  streaming variant; wiring it up would mean switching `lib/salesforce.ts` and the route
  to Server-Sent Events and updating the UI to append chunks.
- The Models API is **text-only**: no images, no native tool/function calling
  (`tools`/`tool_choice` are silently ignored). Unknown request fields are dropped
  without error, so an unsupported feature tends to return `200` with a plausible
  reply rather than failing — don't read a `200` as confirmation that something
  worked. See `scripts/probes/`.
- Do not commit real secrets. `.env*` is gitignored.
