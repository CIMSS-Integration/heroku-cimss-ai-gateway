"use client"

import { useEffect, useState } from "react"
import { ArrowUp, PanelLeft } from "lucide-react"
import { Sparkles } from "lucide-react"
import { Show, SignIn, UserButton } from "@clerk/nextjs"

import {
  ChatContainerContent,
  ChatContainerRoot,
} from "@/components/ui/chat-container"
import { Message, MessageContent } from "@/components/ui/message"
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from "@/components/ui/prompt-input"
import { ScrollButton } from "@/components/ui/scroll-button"
import { Loader } from "@/components/ui/loader"
import { Button } from "@/components/ui/button"
import { ChatSidebar } from "@/components/chat-sidebar"
import { MODELS, DEFAULT_MODEL, SYSTEM_PROMPT } from "@/config/models"
import { cn } from "@/lib/utils"
import type {
  ChatMessage,
  ChatMessageWithModel,
  ChatSessionSummary,
} from "@/lib/types"

function modelLabel(id: string | null): string | null {
  if (!id) return null
  return MODELS.find((m) => m.id === id)?.label ?? id
}

/** Time-of-day greeting for the empty state, in the viewer's local time. */
function greetingText(): string {
  const hour = new Date().getHours()
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

/** Parse a response as JSON without throwing on an HTML error page (e.g. a
 *  Heroku H12 timeout returns `<!DOCTYPE …>`, not JSON). */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

function errorFor(
  res: Response,
  data: Record<string, unknown> | null,
  fallback: string
): string {
  if (typeof data?.error === "string") return data.error
  if (res.status === 503 || res.status === 504) {
    return "The model took too long and the server timed out. Try a shorter prompt or a faster model."
  }
  return `${fallback} (${res.status})`
}

export default function ChatPage() {
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [messages, setMessages] = useState<ChatMessageWithModel[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(true)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isResuming, setIsResuming] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Identity gate: this app requires a linked Salesforce account so every chat
  // is logged under a Salesforce username. Until we've checked, show a loader;
  // if none is linked, block the chat entirely.
  const [identityChecked, setIdentityChecked] = useState(false)
  const [sfUsername, setSfUsername] = useState<string | null>(null)
  const [linkedProviders, setLinkedProviders] = useState<string[]>([])

  const canSend = input.trim().length > 0 && !isLoading
  const sidebarDisabled = isLoading || isResuming

  async function refreshSessions(): Promise<ChatSessionSummary[]> {
    try {
      const res = await fetch("/api/chat/sessions")
      if (!res.ok) return []
      const data = await readJson(res)
      const list = (data?.sessions as ChatSessionSummary[]) ?? []
      setSessions(list)
      return list
    } catch {
      return []
    }
  }

  async function loadSession(id: string) {
    setIsResuming(true)
    setError(null)
    try {
      const res = await fetch(`/api/chat/sessions/${id}`)
      if (!res.ok) throw new Error()
      const data = await readJson(res)
      const session = data?.session as {
        id: string
        model: string
        messages: ChatMessageWithModel[]
      } | null
      if (session) {
        setSessionId(session.id)
        setMessages(session.messages)
        if (MODELS.some((m) => m.id === session.model)) {
          setModel(session.model)
        }
      }
    } catch {
      setError("Couldn't load that chat.")
    } finally {
      setIsResuming(false)
      setIsSidebarOpen(false)
    }
  }

  // On load: verify a Salesforce account is linked, then fetch the sidebar list
  // and resume the most recent chat.
  useEffect(() => {
    let cancelled = false

    async function init() {
      let identity: { sfUsername: string | null; linkedProviders: string[] } = {
        sfUsername: null,
        linkedProviders: [],
      }
      try {
        const res = await fetch("/api/identity")
        const data = await readJson(res)
        if (res.ok && data) {
          identity = {
            sfUsername: (data.sfUsername as string | null) ?? null,
            linkedProviders: (data.linkedProviders as string[]) ?? [],
          }
        }
      } catch {
        // Treated as "no Salesforce account" below.
      }
      if (cancelled) return

      setSfUsername(identity.sfUsername)
      setLinkedProviders(identity.linkedProviders)
      setIdentityChecked(true)

      if (!identity.sfUsername) {
        // Blocked — no chat to load.
        setIsResuming(false)
        setIsLoadingSessions(false)
        return
      }

      const list = await refreshSessions()
      if (cancelled) return
      setIsLoadingSessions(false)
      if (list.length > 0) {
        await loadSession(list[0].id)
      } else {
        setIsResuming(false)
      }
    }

    init()
    return () => {
      cancelled = true
    }
  }, [])

  function handleNewChat() {
    setSessionId(null)
    setMessages([])
    setInput("")
    setError(null)
    setIsSidebarOpen(false)
  }

  function handleSelectSession(id: string) {
    if (id === sessionId || sidebarDisabled) return
    loadSession(id)
  }

  async function handleDeleteSession(id: string) {
    if (!window.confirm("Delete this chat? This can't be undone.")) return

    try {
      const res = await fetch(`/api/chat/sessions/${id}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error()
      setSessions((prev) => prev.filter((s) => s.id !== id))
      if (id === sessionId) {
        handleNewChat()
      }
    } catch {
      setError("Couldn't delete that chat.")
    }
  }

  async function handleSubmit() {
    const text = input.trim()
    if (!text || isLoading) return

    setError(null)
    // Capture the model at send time — the picker may change before the
    // reply lands, and this turn was generated by the model chosen now.
    const modelUsed = model
    const userMessage: ChatMessageWithModel = {
      role: "user",
      content: text,
      model: null,
    }
    const history = [...messages, userMessage]
    setMessages(history)
    setInput("")
    setIsLoading(true)

    // Send the full conversation each turn so the model has context. The
    // stored `model` field is client-only; the wire format stays role+content.
    const wireHistory: ChatMessage[] = history.map(({ role, content }) => ({
      role,
      content,
    }))
    const requestMessages: ChatMessage[] = SYSTEM_PROMPT
      ? [{ role: "system", content: SYSTEM_PROMPT }, ...wireHistory]
      : wireHistory

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelUsed,
          messages: requestMessages,
          sessionId,
        }),
      })
      const data = await readJson(res)
      if (!res.ok || !data) {
        throw new Error(errorFor(res, data, "Request failed"))
      }
      if (data.sessionId) setSessionId(data.sessionId as string)
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: (data.content as string) || "_(empty response)_",
          model: modelUsed,
        },
      ])
      // Pick up the new/reordered session (title, position) in the sidebar.
      refreshSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.")
      // Drop the user turn back into the input so it isn't lost.
      setMessages((prev) => prev.slice(0, -1))
      setInput(text)
    } finally {
      setIsLoading(false)
    }
  }

  // The greeting-centred empty state only appears once we've confirmed there's
  // no conversation to show and nothing is in flight.
  const showGreeting = !isResuming && !isLoading && messages.length === 0
  const greeting = greetingText()

  // The composer is rendered in two places — centred under the greeting, and
  // pinned to the bottom during a conversation — so it lives in one variable.
  const composer = (
    <>
      {error && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive mb-2 rounded-lg border px-3 py-2 text-sm">
          {error}
        </div>
      )}
      <PromptInput
        value={input}
        onValueChange={setInput}
        isLoading={isLoading}
        onSubmit={handleSubmit}
        className="border-border bg-card w-full rounded-3xl shadow-sm"
      >
        <PromptInputTextarea placeholder="How can I help you today?" />
        <PromptInputActions className="items-center justify-between pt-2">
          {/* Contain pointer/click here so they don't bubble to PromptInput's
              root onClick, which refocuses the textarea and would snap the
              native <select> dropdown shut the instant it opens. */}
          <label
            className="flex items-center gap-2"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="sr-only">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={isLoading}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring cursor-pointer rounded-md bg-transparent py-1 pr-1 text-xs font-medium outline-none focus-visible:ring-2 disabled:opacity-60"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <PromptInputAction tooltip="Send message">
            <Button
              type="button"
              size="icon"
              className="h-9 w-9 rounded-full"
              disabled={!canSend}
              onClick={handleSubmit}
              aria-label="Send message"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          </PromptInputAction>
        </PromptInputActions>
      </PromptInput>
      <p className="text-muted-foreground mt-2 text-center text-xs">
        Powered by Salesforce Models API
      </p>
    </>
  )

  return (
    <>
      <Show when="signed-out">
        <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
          <div className="text-center">
            <Sparkles className="text-primary mx-auto mb-3 h-8 w-8" />
            <h1 className="font-serif text-2xl font-medium">
              Salesforce Models API Chat
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Sign in with Salesforce to chat with Salesforce-hosted LLMs.
            </p>
          </div>
          <SignIn routing="hash" />
        </div>
      </Show>

      <Show when="signed-in">
        {!identityChecked ? (
          <div className="flex min-h-dvh items-center justify-center">
            <Loader variant="typing" />
          </div>
        ) : !sfUsername ? (
          <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
            <div className="max-w-md space-y-3 text-center">
              <h1 className="font-serif text-2xl font-medium">
                Salesforce account required
              </h1>
              <p className="text-muted-foreground text-sm">
                You&apos;re signed in, but this app requires a linked Salesforce
                account and we couldn&apos;t find one for your login. Please sign
                in with Salesforce, or contact your administrator.
              </p>
              {linkedProviders.length > 0 && (
                <p className="text-muted-foreground text-xs">
                  Linked sign-in providers: {linkedProviders.join(", ")}
                </p>
              )}
            </div>
            <UserButton />
          </div>
        ) : (
          <div className="flex h-dvh w-full">
            {isSidebarOpen && (
              <div
                className="fixed inset-0 z-30 bg-black/30 md:hidden"
                onClick={() => setIsSidebarOpen(false)}
              />
            )}

            <div
              className={cn(
                "bg-sidebar border-border fixed inset-y-0 left-0 z-40 w-72 transition-transform duration-200 md:static md:z-auto md:w-64 md:shrink-0 md:translate-x-0 md:border-r",
                isSidebarOpen ? "translate-x-0" : "-translate-x-full"
              )}
            >
              <ChatSidebar
                sessions={sessions}
                activeSessionId={sessionId}
                isLoadingSessions={isLoadingSessions}
                disabled={sidebarDisabled}
                onSelect={handleSelectSession}
                onNewChat={handleNewChat}
                onDelete={handleDeleteSession}
              />
            </div>

            <div className="mx-auto flex h-dvh w-full max-w-3xl flex-1 flex-col">
              <header className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="md:hidden"
                    onClick={() => setIsSidebarOpen((open) => !open)}
                    aria-label="Toggle chat list"
                  >
                    <PanelLeft className="h-4 w-4" />
                  </Button>
                  <h1 className="font-serif text-base font-medium">
                    Salesforce Models API Chat
                  </h1>
                </div>
                <UserButton />
              </header>

              {showGreeting ? (
                <div className="flex flex-1 flex-col items-center justify-center px-4 pb-20">
                  <div className="w-full max-w-2xl">
                    <div className="mb-8 flex flex-col items-center gap-4 text-center">
                      <Sparkles className="text-primary h-8 w-8" />
                      <h2 className="font-serif text-3xl font-normal tracking-tight sm:text-4xl">
                        {greeting}
                      </h2>
                    </div>
                    {composer}
                  </div>
                </div>
              ) : (
                <>
                  <div className="relative flex-1 overflow-hidden">
                    <ChatContainerRoot className="h-full">
                      <ChatContainerContent className="space-y-8 px-4 py-6">
                        {isResuming && (
                          <div className="text-muted-foreground flex flex-col items-center justify-center pt-24 text-center">
                            <Loader variant="typing" />
                          </div>
                        )}

                        {messages.map((message, index) =>
                          message.role === "user" ? (
                            <Message key={index} className="justify-end">
                              <MessageContent className="bg-secondary text-secondary-foreground max-w-[80%] rounded-2xl px-4 py-2.5">
                                {message.content}
                              </MessageContent>
                            </Message>
                          ) : (
                            <Message key={index} className="justify-start">
                              <div className="min-w-0 flex-1">
                                <MessageContent
                                  markdown
                                  className="max-w-none bg-transparent p-0"
                                >
                                  {message.content}
                                </MessageContent>
                                {modelLabel(message.model) && (
                                  <p className="text-muted-foreground mt-2 text-xs">
                                    {modelLabel(message.model)}
                                  </p>
                                )}
                              </div>
                            </Message>
                          )
                        )}

                        {isLoading && (
                          <Message className="justify-start">
                            <div className="flex items-center pt-1.5">
                              <Loader variant="typing" />
                            </div>
                          </Message>
                        )}
                      </ChatContainerContent>

                      <div className="absolute right-4 bottom-4">
                        <ScrollButton />
                      </div>
                    </ChatContainerRoot>
                  </div>

                  <div className="px-4 pb-4">{composer}</div>
                </>
              )}
            </div>
          </div>
        )}
      </Show>
    </>
  )
}
