"use client"

import { useEffect, useState } from "react"
import { ArrowUp, PanelLeft } from "lucide-react"
import { Show, SignIn, UserButton } from "@clerk/nextjs"

import {
  ChatContainerContent,
  ChatContainerRoot,
} from "@/components/ui/chat-container"
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "@/components/ui/message"
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
import type { ChatMessage, ChatSessionSummary } from "@/lib/types"

export default function ChatPage() {
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(true)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isResuming, setIsResuming] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const canSend = input.trim().length > 0 && !isLoading
  const sidebarDisabled = isLoading || isResuming

  async function refreshSessions(): Promise<ChatSessionSummary[]> {
    try {
      const res = await fetch("/api/chat/sessions")
      if (!res.ok) return []
      const data = await res.json()
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
      const data = await res.json()
      const session = data?.session as {
        id: string
        model: string
        messages: ChatMessage[]
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

  // On load: fetch the sidebar list and resume the most recent chat, if any.
  useEffect(() => {
    let cancelled = false

    async function init() {
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
    const userMessage: ChatMessage = { role: "user", content: text }
    const history = [...messages, userMessage]
    setMessages(history)
    setInput("")
    setIsLoading(true)

    // Send the full conversation each turn so the model has context.
    const requestMessages: ChatMessage[] = SYSTEM_PROMPT
      ? [{ role: "system", content: SYSTEM_PROMPT }, ...history]
      : history

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: requestMessages,
          sessionId,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.error ?? `Request failed (${res.status})`)
      }
      if (data.sessionId) setSessionId(data.sessionId)
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.content || "_(empty response)_",
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

  const activeModel = MODELS.find((m) => m.id === model)

  return (
    <>
      <Show when="signed-out">
        <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
          <div className="text-center">
            <h1 className="text-xl font-bold">Salesforce Models API Chat</h1>
            <p className="text-muted-foreground text-sm">
              Sign in to chat with Salesforce-hosted LLMs.
            </p>
          </div>
          <SignIn routing="hash" />
        </div>
      </Show>

      <Show when="signed-in">
        <div className="flex h-dvh w-full">
          {isSidebarOpen && (
            <div
              className="fixed inset-0 z-30 bg-black/30 md:hidden"
              onClick={() => setIsSidebarOpen(false)}
            />
          )}

          <div
            className={cn(
              "bg-background fixed inset-y-0 left-0 z-40 w-72 transition-transform duration-200 md:static md:z-auto md:w-64 md:shrink-0 md:translate-x-0",
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
            <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
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
                <div>
                  <h1 className="text-sm font-semibold">
                    Salesforce Models API Chat
                  </h1>
                  {activeModel?.description && (
                    <p className="text-muted-foreground text-xs">
                      {activeModel.description}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground hidden sm:inline">
                    Model
                  </span>
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={isLoading}
                    className="border-input bg-background focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm shadow-xs focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
                  >
                    {MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <UserButton />
              </div>
            </header>

            <div className="relative flex-1 overflow-hidden">
              <ChatContainerRoot className="h-full">
                <ChatContainerContent className="space-y-6 px-4 py-6">
                  {isResuming ? (
                    <div className="text-muted-foreground flex flex-col items-center justify-center pt-24 text-center">
                      <Loader variant="typing" />
                    </div>
                  ) : (
                    messages.length === 0 &&
                    !isLoading && (
                      <div className="text-muted-foreground flex flex-col items-center justify-center pt-24 text-center">
                        <p className="text-base font-medium">
                          Start a conversation
                        </p>
                        <p className="text-sm">
                          Messages are sent to the Salesforce Models API.
                        </p>
                      </div>
                    )
                  )}

                  {messages.map((message, index) =>
                    message.role === "user" ? (
                      <Message key={index} className="justify-end">
                        <MessageContent className="bg-primary text-primary-foreground max-w-[80%]">
                          {message.content}
                        </MessageContent>
                      </Message>
                    ) : (
                      <Message key={index} className="justify-start">
                        <MessageAvatar
                          src=""
                          alt="Assistant"
                          fallback="AI"
                          className="bg-muted"
                        />
                        <MessageContent
                          markdown
                          className="max-w-none bg-transparent p-0"
                        >
                          {message.content}
                        </MessageContent>
                      </Message>
                    )
                  )}

                  {isLoading && (
                    <Message className="justify-start">
                      <MessageAvatar
                        src=""
                        alt="Assistant"
                        fallback="AI"
                        className="bg-muted"
                      />
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

            <div className="px-4 pb-4">
              {error && (
                <div className="border-destructive/40 bg-destructive/10 text-destructive mb-2 rounded-md border px-3 py-2 text-sm">
                  {error}
                </div>
              )}
              <PromptInput
                value={input}
                onValueChange={setInput}
                isLoading={isLoading}
                onSubmit={handleSubmit}
                className="w-full"
              >
                <PromptInputTextarea placeholder="Send a message..." />
                <PromptInputActions className="justify-end pt-2">
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
                Powered by Salesforce Models API · prompt-kit
              </p>
            </div>
          </div>
        </div>
      </Show>
    </>
  )
}
