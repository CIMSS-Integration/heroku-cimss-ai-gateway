"use client"

import { PenSquare, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatSessionSummary } from "@/lib/types"

type ChatSidebarProps = {
  sessions: ChatSessionSummary[]
  activeSessionId: string | null
  isLoadingSessions: boolean
  disabled: boolean
  onSelect: (id: string) => void
  onNewChat: () => void
  onDelete: (id: string) => void
}

export function ChatSidebar({
  sessions,
  activeSessionId,
  isLoadingSessions,
  disabled,
  onSelect,
  onNewChat,
  onDelete,
}: ChatSidebarProps) {
  return (
    <div className="bg-sidebar text-sidebar-foreground flex h-full w-full flex-col">
      <div className="flex items-center gap-2 px-3 pt-4 pb-2">
        <span className="bg-primary text-primary-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sm font-semibold">
          ✳
        </span>
        <span className="font-serif text-base font-medium">Chat</span>
      </div>

      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={onNewChat}
          disabled={disabled}
          className="text-primary hover:bg-sidebar-accent flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-60"
        >
          <PenSquare className="h-4 w-4" />
          New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1">
        {isLoadingSessions ? (
          <p className="text-muted-foreground px-3 py-4 text-xs">
            Loading chats…
          </p>
        ) : sessions.length === 0 ? (
          <p className="text-muted-foreground px-3 py-4 text-xs">No chats yet</p>
        ) : (
          <>
            <p className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium">
              Recents
            </p>
            <ul className="space-y-0.5">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(session.id)}
                    disabled={disabled}
                    className={cn(
                      "group/session flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors disabled:opacity-60",
                      session.id === activeSessionId
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "hover:bg-sidebar-accent/60 text-muted-foreground hover:text-sidebar-foreground"
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {session.title || "New chat"}
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Delete chat"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(session.id)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.stopPropagation()
                          e.preventDefault()
                          onDelete(session.id)
                        }
                      }}
                      className="hover:text-destructive shrink-0 rounded p-0.5 opacity-0 group-hover/session:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
