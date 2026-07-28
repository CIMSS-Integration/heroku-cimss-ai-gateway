# Models API probes

Small standalone scripts that answer "does the Salesforce Models API actually
support X?" by asking the real endpoint, rather than trusting the docs. They
exist because the platform **silently ignores unknown request fields**, so an
unsupported feature often returns `200` with a plausible reply instead of an
error — the docs and the HTTP status both fail to tell you the truth, and only a
discriminating test does.

They are not part of the app or its build: plain `.mjs`, zero dependencies, run
with a bare `node`.

## Running

Needs a working `.env.local` at the repo root (`SF_LOGIN_URL`, `SF_CLIENT_ID`,
`SF_CLIENT_SECRET` — the same client-credentials app the server uses).

```bash
node scripts/probes/multimodal-payload-shapes.mjs        # default model only
node scripts/probes/multimodal-payload-shapes.mjs all    # every model in config/models.ts
node scripts/probes/inline-binary.mjs all
```

Model ids are scraped from `config/models.ts`, so `all` always matches what the
app actually offers. `all` costs one real generation per shape per model — a few
dozen calls, so it does consume org quota.

| Script | Question it answers |
| --- | --- |
| `multimodal-payload-shapes.mjs` | Which request-body envelopes does `chat-generations` accept? Do any carry an image? |
| `inline-binary.mjs` | Can the binary ride inside the `content` string, or as `multipart/form-data`? |
| `pdf-base64-size-ladder.mjs` | At what payload size does a base64 document get cut off, and by what — request size, context window, or timeout? |
| `probe-lib.mjs` | Shared helpers: env loading, token, POST, valid-PNG generation. Not a probe. |

The size ladder takes a file path:

```bash
node scripts/probes/pdf-base64-size-ladder.mjs "MIMIT Admin Guide .pdf"
node scripts/probes/pdf-base64-size-ladder.mjs <file.pdf> <modelId>
```

It stops after two consecutive failures, but the passing steps are real
generations at up to ~1M input tokens each — this one is not cheap to run.

## Current findings (2026-07-28, all 6 configured models)

**No image can reach a model through `chat-generations`.** Array-shaped
`content` → `400 BAD_ARGUMENT` / `E30020`; `multipart/form-data` → `415`;
`attachments[]` and inline base64 → `200` with the image silently dropped and
the answer fabricated. The measured detail — 5 correct colors out of 36 trials,
all 5 on the green image and 0/18 on orange, with most models asserting they
could see it — is in `docs/ARCHITECTURE.md` under "Multimodal / file input is not
possible on `chat-generations`". Note `docs/` is gitignored, so that write-up is
local to a working copy; this file is the committed summary.

**PDFs are a partial exception worth understanding.** Base64 in `content` does
carry a PDF's *uncompressed* bytes — Opus 4.8 correctly read
`/Title (MIMIT Admin Guide )` from byte offset 33 at every size tested, which is
genuine base64 decoding. But compressed content streams stay opaque, and base64
costs **~0.945 tokens per character (~1.26 tokens per PDF byte)**, so the hard
ceiling is ~793 KB of PDF ≈ 3 pages ≈ 1.2% of that 65 MB file. Past it you get a
loud `400` with the exact count (`prompt is too long: N tokens > 1000000
maximum`) — never silent truncation. Extracting text server-side and sending it
as ordinary string content is ~5× cheaper per source byte and is the actual
answer.

Re-run these after a Salesforce release to detect if that ever changes. Don't
re-derive the finding from scratch.

## Writing another probe

The pattern that makes these trustworthy, and worth copying:

1. **Send a genuinely valid artifact.** `solidPng()` builds a real PNG with
   correct CRCs, so a rejection can't be blamed on a bad test file.
2. **Include a control.** Run the same prompt with the feature absent. Without
   it you can't tell a real success from the model's blind guess.
3. **Vary the answer.** Two different colors, not one. If the reply doesn't
   track the input, the input never arrived — no matter what the model claims.
4. **Never treat `200` as support.** Check that the response actually reflects
   what you sent.
