"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
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
import { useConfirm } from "@/components/ui/confirm-dialog"
import {
  NewProjectDialog,
  type NewProjectFields,
} from "@/components/ui/new-project-dialog"
import { ChatSidebar, type SidebarTab } from "@/components/chat-sidebar"
import {
  MODELS,
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
  CONTEXT_WARN_RATIO,
  contextWindowFor,
} from "@/config/models"
import { cn } from "@/lib/utils"
import type {
  ChatMessage,
  ChatMessageWithModel,
  ChatProjectSummary,
  ChatSessionSummary,
} from "@/lib/types"

/** The MIMIT Healthcare brand mark — the sage-teal leaf tile from the logo.
 *  Size it via `className` on the wrapper; the image is scaled slightly to
 *  crop the logo's white margin so only the teal tile shows. */
function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative inline-block shrink-0 overflow-hidden rounded-md",
        className
      )}
    >
      <Image
        src="/MIMIT_Logo.png"
        alt="MIMIT Healthcare logo"
        fill
        sizes="48px"
        className="scale-[1.12] object-cover"
        priority
      />
    </span>
  )
}

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
  const confirm = useConfirm()
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [messages, setMessages] = useState<ChatMessageWithModel[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(true)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)

  // Projects: a container a chat can be filed under. The sidebar has a Chats
  // tab (unfiled chats) and a Projects tab (projects → drill in to their chats).
  const [activeTab, setActiveTab] = useState<SidebarTab>("chats")
  const [projects, setProjects] = useState<ChatProjectSummary[]>([])
  const [isLoadingProjects, setIsLoadingProjects] = useState(true)
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [projectChats, setProjectChats] = useState<ChatSessionSummary[]>([])
  const [isLoadingProjectChats, setIsLoadingProjectChats] = useState(false)
  // When starting a NEW chat inside a project, the project it should be filed
  // under on first send. Null for a normal (unfiled) new chat.
  const [composerProjectId, setComposerProjectId] = useState<string | null>(null)

  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isResuming, setIsResuming] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // True when the open chat belongs to a public project and was created by
  // someone else: visible but view-only (only its creator can add messages).
  const [activeChatReadOnly, setActiveChatReadOnly] = useState(false)

  // Context-window management. `inputTokens` is the last reply's input-token
  // count (from Salesforce) — how full the window is. `contextLimitHit` is set
  // when a send is rejected outright for exceeding the limit. The summarize /
  // new-chat prompt shows when we're near the limit or after a hard rejection.
  const [inputTokens, setInputTokens] = useState<number | null>(null)
  const [contextLimitHit, setContextLimitHit] = useState(false)
  const [isSummarizing, setIsSummarizing] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Identity gate: this app requires a linked Salesforce account so every chat
  // is logged under a Salesforce username. Until we've checked, show a loader;
  // if none is linked, block the chat entirely.
  const [identityChecked, setIdentityChecked] = useState(false)
  const [sfUsername, setSfUsername] = useState<string | null>(null)
  const [linkedProviders, setLinkedProviders] = useState<string[]>([])

  const canSend =
    input.trim().length > 0 &&
    !isLoading &&
    !isSummarizing &&
    !activeChatReadOnly
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

  async function refreshProjects(): Promise<ChatProjectSummary[]> {
    try {
      const res = await fetch("/api/chat/projects")
      if (!res.ok) return []
      const data = await readJson(res)
      const list = (data?.projects as ChatProjectSummary[]) ?? []
      setProjects(list)
      return list
    } catch {
      return []
    }
  }

  // Load (or reload) a project's chats into the drill-in view.
  async function loadProjectChats(id: string) {
    setIsLoadingProjectChats(true)
    try {
      const res = await fetch(`/api/chat/projects/${id}`)
      if (!res.ok) throw new Error()
      const data = await readJson(res)
      const project = data?.project as { chats?: ChatSessionSummary[] } | null
      setProjectChats(project?.chats ?? [])
    } catch {
      setProjectChats([])
    } finally {
      setIsLoadingProjectChats(false)
    }
  }

  async function loadSession(id: string) {
    setIsResuming(true)
    setError(null)
    // The new turn will report fresh token usage; clear any prior measurement.
    resetContextState()
    try {
      const res = await fetch(`/api/chat/sessions/${id}`)
      if (!res.ok) throw new Error()
      const data = await readJson(res)
      const session = data?.session as {
        id: string
        model: string
        messages: ChatMessageWithModel[]
        isOwner?: boolean
      } | null
      if (session) {
        setSessionId(session.id)
        setMessages(session.messages)
        // Only a public-project chat you didn't create comes back with
        // isOwner === false; everything else is writable.
        setActiveChatReadOnly(session.isOwner === false)
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
        setIsLoadingProjects(false)
        return
      }

      // Projects power the sidebar's Projects tab and the per-chat "move" menu;
      // load them alongside the chats.
      refreshProjects().finally(() => {
        if (!cancelled) setIsLoadingProjects(false)
      })

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

  // Clears the context-window prompt/measurement — call whenever the active
  // conversation changes (new chat, switching chats).
  function resetContextState() {
    setInputTokens(null)
    setContextLimitHit(false)
    setBannerDismissed(false)
    setNotice(null)
  }

  function handleNewChat() {
    setSessionId(null)
    setMessages([])
    setInput("")
    setError(null)
    setComposerProjectId(null)
    setActiveChatReadOnly(false)
    resetContextState()
    setIsSidebarOpen(false)
  }

  function handleSelectSession(id: string) {
    if (id === sessionId || sidebarDisabled) return
    // Opening an existing chat: its project is fixed server-side, so the
    // composer's new-chat project context no longer applies.
    setComposerProjectId(null)
    loadSession(id)
  }

  function handleTabChange(tab: SidebarTab) {
    setActiveTab(tab)
  }

  function handleOpenProject(id: string) {
    if (sidebarDisabled) return
    setActiveProjectId(id)
    loadProjectChats(id)
  }

  function handleCloseProject() {
    setActiveProjectId(null)
    setProjectChats([])
  }

  function handleNewChatInProject(projectId: string) {
    setSessionId(null)
    setMessages([])
    setInput("")
    setError(null)
    // First send of this chat files it under the project. Even in a public
    // project this is the user's own new chat, so it's writable.
    setComposerProjectId(projectId)
    setActiveChatReadOnly(false)
    resetContextState()
    setIsSidebarOpen(false)
  }

  function handleNewProject() {
    setNewProjectOpen(true)
  }

  // Create a project from the New-Project modal's fields (name / instructions /
  // public). The modal handles its own validation and closing.
  async function createProjectFromDialog(fields: NewProjectFields) {
    try {
      const res = await fetch("/api/chat/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fields.name,
          instructions: fields.instructions || undefined,
          isPublic: fields.isPublic,
        }),
      })
      if (!res.ok) throw new Error()
      await refreshProjects()
    } catch {
      setError("Couldn't create that project.")
    }
  }

  async function handleRenameProject(id: string, name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    const previous = projects
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p))
    )
    try {
      const res = await fetch(`/api/chat/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) throw new Error()
      const data = await readJson(res)
      const stored = (data?.name as string) ?? trimmed
      setProjects((prev) =>
        prev.map((p) => (p.id === id ? { ...p, name: stored } : p))
      )
    } catch {
      setProjects(previous)
      setError("Couldn't rename that project.")
    }
  }

  // Toggle an existing project between private and public (shared). Creator-only
  // (the server 403s otherwise). Confirm first — it's an outward-facing change
  // that exposes/withdraws the project's chats to every user.
  async function handleToggleProjectPublic(id: string, makePublic: boolean) {
    const confirmed = await confirm(
      makePublic
        ? {
            title: "Share this project?",
            body: "All chats in it become visible to every signed-in user (view-only for them). They can also add their own chats. Only you can rename or delete it.",
            confirmLabel: "Share",
          }
        : {
            title: "Make this project private?",
            body: "Other users will lose access to it and its chats. Any chats they added here move back to their own unfiled list.",
            confirmLabel: "Make private",
          }
    )
    if (!confirmed) return

    const previous = projects
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, isPublic: makePublic } : p))
    )
    try {
      const res = await fetch(`/api/chat/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: makePublic }),
      })
      if (!res.ok) throw new Error()
      // Membership counts / other users' chats may shift; re-sync.
      refreshProjects()
      if (activeProjectId === id) loadProjectChats(id)
    } catch {
      setProjects(previous)
      setError("Couldn't update sharing for that project.")
    }
  }

  async function handleDeleteProject(id: string) {
    const ok = await confirm({
      title: "Delete this project?",
      body: "Its chats are kept and moved back to Chats.",
      confirmLabel: "Delete",
      danger: true,
    })
    if (!ok) return
    try {
      const res = await fetch(`/api/chat/projects/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error()
      setProjects((prev) => prev.filter((p) => p.id !== id))
      if (activeProjectId === id) handleCloseProject()
      // Orphaned chats are now unfiled — refresh the Chats list.
      refreshSessions()
    } catch {
      setError("Couldn't delete that project.")
    }
  }

  async function handleMoveToProject(id: string, projectId: string | null) {
    try {
      const res = await fetch(`/api/chat/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      })
      if (!res.ok) throw new Error()
      // Both lists and the project counts can change; refresh what's visible.
      refreshSessions()
      refreshProjects()
      if (activeProjectId) loadProjectChats(activeProjectId)
    } catch {
      setError("Couldn't move that chat.")
    }
  }

  async function handleRenameSession(id: string, title: string) {
    const trimmed = title.trim()
    if (!trimmed) return

    // Optimistically retitle in whichever list holds it (a chat lives in one:
    // the unfiled list or the open project's list), remembering the prior state
    // so we can roll back if the write fails.
    const previousSessions = sessions
    const previousProjectChats = projectChats
    const retitle = (s: ChatSessionSummary) =>
      s.id === id ? { ...s, title: trimmed } : s
    setSessions((prev) => prev.map(retitle))
    setProjectChats((prev) => prev.map(retitle))

    try {
      const res = await fetch(`/api/chat/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      })
      if (!res.ok) throw new Error()
      const data = await readJson(res)
      // Reflect the authoritative stored title (server normalizes/truncates).
      const stored = (data?.title as string) ?? trimmed
      const store = (s: ChatSessionSummary) =>
        s.id === id ? { ...s, title: stored } : s
      setSessions((prev) => prev.map(store))
      setProjectChats((prev) => prev.map(store))
    } catch {
      setSessions(previousSessions)
      setProjectChats(previousProjectChats)
      setError("Couldn't rename that chat.")
    }
  }

  async function handleDeleteSession(id: string) {
    const ok = await confirm({
      title: "Delete this chat?",
      body: "This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
    })
    if (!ok) return

    try {
      const res = await fetch(`/api/chat/sessions/${id}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error()
      setSessions((prev) => prev.filter((s) => s.id !== id))
      setProjectChats((prev) => prev.filter((s) => s.id !== id))
      // A project's chat count may have changed.
      refreshProjects()
      if (id === sessionId) {
        handleNewChat()
      }
    } catch {
      setError("Couldn't delete that chat.")
    }
  }

  async function handleSubmit() {
    const text = input.trim()
    if (!text || isLoading || isSummarizing) return

    setError(null)
    setNotice(null)
    // Re-evaluate the context prompt for this turn: clear a prior hard-limit
    // flag and any earlier dismissal so a fresh measurement can re-show it.
    setContextLimitHit(false)
    setBannerDismissed(false)
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

    // A new chat started inside a project is filed there on this first send.
    const isNewChat = !sessionId
    const filedUnderProject = isNewChat ? composerProjectId : null

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelUsed,
          messages: requestMessages,
          sessionId,
          projectId: filedUnderProject,
        }),
      })
      const data = await readJson(res)
      if (!res.ok || !data) {
        // A context-limit rejection isn't a generic error: keep the user's
        // message and surface the summarize / new-chat prompt instead.
        if (data?.code === "context_limit") {
          setContextLimitHit(true)
          setMessages((prev) => prev.slice(0, -1))
          setInput(text)
          return
        }
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
      // Track how full the context window now is (drives the summarize prompt).
      const usage = data.usage as { inputTokenCount?: number } | null | undefined
      setInputTokens(
        typeof usage?.inputTokenCount === "number"
          ? usage.inputTokenCount
          : null
      )
      // The chat now has a server id, so it's no longer a "new chat in project".
      if (isNewChat) setComposerProjectId(null)
      if (filedUnderProject) {
        // Filed under a project: it won't appear in the unfiled Chats list;
        // refresh project counts and, if open, that project's chat list.
        refreshProjects()
        if (activeProjectId === filedUnderProject) {
          loadProjectChats(filedUnderProject)
        }
      } else {
        // Pick up the new/reordered session (title, position) in the sidebar.
        refreshSessions()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.")
      // Drop the user turn back into the input so it isn't lost.
      setMessages((prev) => prev.slice(0, -1))
      setInput(text)
    } finally {
      setIsLoading(false)
    }
  }

  // Compact the current chat: the server summarizes the older turns and keeps
  // the recent ones verbatim, so subsequent sends fit the window again.
  async function handleSummarize() {
    if (!sessionId || isSummarizing || isLoading) return
    setIsSummarizing(true)
    setError(null)
    try {
      const res = await fetch("/api/chat/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
      const data = await readJson(res)
      if (!res.ok) {
        throw new Error(errorFor(res, data, "Couldn't summarize this chat"))
      }
      if (data?.summarized === false) {
        setNotice("This chat is too short to summarize yet.")
        return
      }
      // The summary is stored server-side; the next send will use it, so the
      // window pressure is relieved. Hide the prompt and confirm.
      setInputTokens(null)
      setContextLimitHit(false)
      const droppedOldest =
        typeof data?.droppedOldest === "number" ? data.droppedOldest : 0
      setNotice(
        droppedOldest > 0
          ? `Earlier messages were summarized to save space; the ${droppedOldest} oldest were too long to include and were dropped from context. You can keep chatting.`
          : "Earlier messages were summarized to save space — you can keep chatting."
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't summarize this chat.")
    } finally {
      setIsSummarizing(false)
    }
  }

  // The greeting-centred empty state only appears once we've confirmed there's
  // no conversation to show and nothing is in flight.
  const showGreeting = !isResuming && !isLoading && messages.length === 0
  const greeting = greetingText()

  // Context-window prompt: shown as we near the limit (proactive) or after a
  // hard rejection. Summarizing needs a persisted chat, so it's gated on a
  // sessionId; the near-limit check compares the last turn's input tokens.
  const contextWindow = contextWindowFor(model)
  const nearLimit =
    inputTokens != null && inputTokens >= contextWindow * CONTEXT_WARN_RATIO
  const contextPct =
    inputTokens != null
      ? Math.min(100, Math.round((inputTokens / contextWindow) * 100))
      : null
  const showContextBanner =
    !bannerDismissed && (contextLimitHit || (nearLimit && !!sessionId))

  // The composer is rendered in two places — centred under the greeting, and
  // pinned to the bottom during a conversation — so it lives in one variable.
  const composer = activeChatReadOnly ? (
    <div className="border-border bg-muted rounded-2xl border px-4 py-3 text-center text-sm">
      <p className="text-foreground font-medium">Shared chat — view only</p>
      <p className="text-muted-foreground mt-0.5 text-xs">
        Only the person who created this chat can add messages. Start your own
        chat in the project to contribute.
      </p>
    </div>
  ) : (
    <>
      {showContextBanner && (
        <div className="border-primary/40 bg-primary/5 text-foreground mb-2 rounded-lg border px-3 py-2.5 text-sm">
          <p className="font-medium">
            {contextLimitHit
              ? "This chat has reached the model's context limit."
              : `This chat is getting long${
                  contextPct != null
                    ? ` — about ${contextPct}% of the context window`
                    : ""
                }.`}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Summarize the earlier messages to keep going (recent messages stay
            intact), or start a new chat.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleSummarize}
              disabled={isSummarizing || isLoading || !sessionId}
            >
              {isSummarizing ? "Summarizing…" : "Summarize & continue"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleNewChat}
              disabled={isSummarizing}
            >
              Start new chat
            </Button>
            {!contextLimitHit && (
              <button
                type="button"
                onClick={() => setBannerDismissed(true)}
                className="text-muted-foreground hover:text-foreground ml-auto text-xs"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
      {notice && (
        <div className="border-border bg-muted text-muted-foreground mb-2 rounded-lg border px-3 py-2 text-xs">
          {notice}
        </div>
      )}
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
            <BrandMark className="mx-auto mb-3 h-12 w-12" />
            <h1 className="text-2xl tracking-tight">
              <span className="text-brand-navy font-brand font-semibold">
                MIMIT
              </span>{" "}
              <span className="font-serif font-medium">Health LLM Client</span>
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
            <NewProjectDialog
              open={newProjectOpen}
              onOpenChange={setNewProjectOpen}
              onCreate={createProjectFromDialog}
            />
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
                activeTab={activeTab}
                onTabChange={handleTabChange}
                disabled={sidebarDisabled}
                sessions={sessions}
                activeSessionId={sessionId}
                isLoadingSessions={isLoadingSessions}
                onSelect={handleSelectSession}
                onNewChat={handleNewChat}
                onDelete={handleDeleteSession}
                onRename={handleRenameSession}
                onMoveToProject={handleMoveToProject}
                projects={projects}
                isLoadingProjects={isLoadingProjects}
                activeProjectId={activeProjectId}
                projectChats={projectChats}
                isLoadingProjectChats={isLoadingProjectChats}
                onOpenProject={handleOpenProject}
                onCloseProject={handleCloseProject}
                onNewProject={handleNewProject}
                onRenameProject={handleRenameProject}
                onDeleteProject={handleDeleteProject}
                onToggleProjectPublic={handleToggleProjectPublic}
                onNewChatInProject={handleNewChatInProject}
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
                  <BrandMark className="h-8 w-8" />
                  <h1 className="text-xl tracking-tight sm:text-2xl">
                    <span className="text-brand-navy font-brand font-semibold">
                      MIMIT
                    </span>{" "}
                    <span className="font-serif font-medium">
                      Health LLM Client
                    </span>
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
