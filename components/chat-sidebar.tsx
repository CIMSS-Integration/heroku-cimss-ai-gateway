"use client"

import { MessageSquare, Plus, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
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
    <div className="flex h-full w-full flex-col border-r">
      <div className="border-b p-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={onNewChat}
          disabled={disabled}
        >
          <Plus className="h-4 w-4" />
          New chat
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {isLoadingSessions ? (
          <p className="text-muted-foreground px-2 py-4 text-center text-xs">
            Loading chats…
          </p>
        ) : sessions.length === 0 ? (
          <p className="text-muted-foreground px-2 py-4 text-center text-xs">
            No chats yet
          </p>
        ) : (
          <ul className="space-y-0.5">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  disabled={disabled}
                  className={cn(
                    "group/session flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors disabled:opacity-60",
                    session.id === activeSessionId
                      ? "bg-muted text-foreground"
                      : "hover:bg-muted/60 text-muted-foreground hover:text-foreground"
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-70" />
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
        )}
      </div>
    </div>
  )
}
