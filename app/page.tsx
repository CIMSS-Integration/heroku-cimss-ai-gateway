"use client"

import { useEffect, useState } from "react"
import { ArrowUp } from "lucide-react"
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
import { MODELS, DEFAULT_MODEL, SYSTEM_PROMPT } from "@/config/models"
import type { ChatMessage } from "@/lib/types"

export default function ChatPage() {
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isResuming, setIsResuming] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const canSend = input.trim().length > 0 && !isLoading

  // Resume the user's last chat (if any) on load instead of starting blank.
  useEffect(() => {
    let cancelled = false

    async function resume() {
      try {
        const res = await fetch("/api/chat/session")
        if (!res.ok) return
        const data = await res.json()
        const session = data?.session as {
          id: string
          model: string
          messages: ChatMessage[]
        } | null
        if (!cancelled && session) {
          setSessionId(session.id)
          setMessages(session.messages)
          if (MODELS.some((m) => m.id === session.model)) {
            setModel(session.model)
          }
        }
      } catch {
        // No saved session reachable — fall back to a blank chat.
      } finally {
        if (!cancelled) setIsResuming(false)
      }
    }

    resume()
    return () => {
      cancelled = true
    }
  }, [])

  function handleNewChat() {
    setSessionId(null)
    setMessages([])
    setInput("")
    setError(null)
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
        <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
          <header className="flex items-center justify-between gap-4 border-b px-4 py-3">
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
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleNewChat}
                disabled={isLoading || isResuming || messages.length === 0}
              >
                New chat
              </Button>
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
                  <p className="text-base font-medium">Start a conversation</p>
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
      </Show>
    </>
  )
}
