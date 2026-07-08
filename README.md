# Salesforce Models API Chat

A chat interface for Salesforce-hosted LLMs (the [Models API](https://developer.salesforce.com/docs/einstein/genai/guide/models-api.html)), built with [Next.js](https://nextjs.org) and [prompt-kit](https://prompt-kit.com) UI components.

- Multi-turn chat — the full conversation is sent to the model each turn.
- Model picker driven by a simple config file.
- Salesforce credentials stay **server-side**; the browser only talks to a local `/api/chat` route.

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
| `lib/salesforce.ts` | Server-side Models API client (token + chat-generations) |
| `lib/types.ts` | Shared `ChatMessage` type (matches the API schema) |
| `app/api/chat/route.ts` | Validates input, proxies to Salesforce |
| `app/page.tsx` | Chat UI (prompt-kit components) |
| `components/ui/*` | prompt-kit + shadcn components |
| `docs/` | Reference API notes |

## Notes

- Replies are **non-streaming** (single complete response). The Models API also has a
  streaming variant; wiring it up would mean switching `lib/salesforce.ts` and the route
  to Server-Sent Events and updating the UI to append chunks.
- Do not commit real secrets. `.env*` is gitignored.
