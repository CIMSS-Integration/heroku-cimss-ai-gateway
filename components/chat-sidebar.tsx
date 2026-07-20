"use client"

import { useEffect, useRef, useState } from "react"
import {
  ChevronLeft,
  FolderPlus,
  Folder,
  FolderInput,
  Pencil,
  PenSquare,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatProjectSummary, ChatSessionSummary } from "@/lib/types"

export type SidebarTab = "chats" | "projects"

type ChatSidebarProps = {
  activeTab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  disabled: boolean

  // Chats tab (unfiled chats)
  sessions: ChatSessionSummary[]
  activeSessionId: string | null
  isLoadingSessions: boolean
  onSelect: (id: string) => void
  onNewChat: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onMoveToProject: (id: string, projectId: string | null) => void

  // Projects tab
  projects: ChatProjectSummary[]
  isLoadingProjects: boolean
  activeProjectId: string | null
  projectChats: ChatSessionSummary[]
  isLoadingProjectChats: boolean
  onOpenProject: (id: string) => void
  onCloseProject: () => void
  onNewProject: () => void
  onRenameProject: (id: string, name: string) => void
  onDeleteProject: (id: string) => void
  onNewChatInProject: (projectId: string) => void
}

// Match the auto-title cap so a manual rename can't exceed what's stored.
const TITLE_MAX_LENGTH = 80

/** Shared inline rename input used by both chat and project rows. */
function RenameInput({
  initial,
  ariaLabel,
  onCommit,
  onCancel,
}: {
  initial: string
  ariaLabel: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  // Guards against a double-commit when Enter/Escape unmount the input and blur
  // then fires: whichever path runs first wins, the rest are no-ops.
  const settledRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function commit() {
    if (settledRef.current) return
    settledRef.current = true
    const next = draft.trim()
    if (next && next !== initial) onCommit(next)
    else onCancel()
  }

  function cancel() {
    if (settledRef.current) return
    settledRef.current = true
    onCancel()
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      maxLength={TITLE_MAX_LENGTH}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          commit()
        } else if (e.key === "Escape") {
          e.preventDefault()
          cancel()
        }
      }}
      onBlur={commit}
      className="border-primary bg-background text-foreground focus-visible:ring-ring w-full rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2"
    />
  )
}

/** A small icon button revealed on row hover. */
function RowAction({
  label,
  onActivate,
  className,
  children,
}: {
  label: string
  onActivate: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onActivate()
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.stopPropagation()
          e.preventDefault()
          onActivate()
        }
      }}
      className={cn(
        "shrink-0 rounded p-0.5 opacity-0 group-hover/session:opacity-100",
        className
      )}
    >
      {children}
    </span>
  )
}

type SessionRowProps = {
  session: ChatSessionSummary
  isActive: boolean
  disabled: boolean
  projects: ChatProjectSummary[]
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onMoveToProject: (id: string, projectId: string | null) => void
}

function SessionRow({
  session,
  isActive,
  disabled,
  projects,
  onSelect,
  onDelete,
  onRename,
  onMoveToProject,
}: SessionRowProps) {
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const rowRef = useRef<HTMLLIElement>(null)

  // Close the move-menu on any outside interaction.
  useEffect(() => {
    if (!menuOpen) return
    function onDown(e: MouseEvent) {
      if (!rowRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [menuOpen])

  if (editing) {
    return (
      <li>
        <RenameInput
          initial={session.title ?? ""}
          ariaLabel="Rename chat"
          onCommit={(value) => {
            setEditing(false)
            onRename(session.id, value)
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    )
  }

  const moveTargets = projects.filter((p) => p.id !== session.projectId)

  return (
    <li ref={rowRef} className="relative">
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        disabled={disabled}
        className={cn(
          "group/session flex w-full items-center gap-1 rounded-lg px-3 py-2 text-left text-sm transition-colors disabled:opacity-60",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "hover:bg-sidebar-accent/60 text-muted-foreground hover:text-sidebar-foreground"
        )}
      >
        <span
          className="min-w-0 flex-1 truncate"
          onDoubleClick={(e) => {
            e.stopPropagation()
            if (!disabled) setEditing(true)
          }}
        >
          {session.title || "New chat"}
        </span>
        <RowAction
          label="Move to project"
          onActivate={() => !disabled && setMenuOpen((o) => !o)}
          className="hover:text-foreground"
        >
          <FolderInput className="h-3.5 w-3.5" />
        </RowAction>
        <RowAction
          label="Rename chat"
          onActivate={() => !disabled && setEditing(true)}
          className="hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </RowAction>
        <RowAction
          label="Delete chat"
          onActivate={() => onDelete(session.id)}
          className="hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </RowAction>
      </button>

      {menuOpen && (
        <div className="border-border bg-popover absolute right-2 top-full z-10 mt-1 w-52 rounded-lg border p-1 shadow-md">
          <p className="text-muted-foreground px-2 py-1 text-xs font-medium">
            Move to project
          </p>
          {session.projectId && (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                onMoveToProject(session.id, null)
              }}
              className="hover:bg-sidebar-accent text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
            >
              Remove from project
            </button>
          )}
          {moveTargets.length === 0 && !session.projectId ? (
            <p className="text-muted-foreground px-2 py-1.5 text-xs">
              No projects yet
            </p>
          ) : (
            moveTargets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onMoveToProject(session.id, p.id)
                }}
                className="hover:bg-sidebar-accent text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
              >
                <Folder className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{p.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </li>
  )
}

type ProjectRowProps = {
  project: ChatProjectSummary
  disabled: boolean
  onOpen: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}

function ProjectRow({
  project,
  disabled,
  onOpen,
  onRename,
  onDelete,
}: ProjectRowProps) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <li>
        <RenameInput
          initial={project.name}
          ariaLabel="Rename project"
          onCommit={(value) => {
            setEditing(false)
            onRename(project.id, value)
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    )
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(project.id)}
        disabled={disabled}
        className="group/session hover:bg-sidebar-accent/60 text-muted-foreground hover:text-sidebar-foreground flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors disabled:opacity-60"
      >
        <Folder className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        <span className="text-muted-foreground shrink-0 text-xs group-hover/session:hidden">
          {project.chatCount}
        </span>
        <RowAction
          label="Rename project"
          onActivate={() => !disabled && setEditing(true)}
          className="hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </RowAction>
        <RowAction
          label="Delete project"
          onActivate={() => onDelete(project.id)}
          className="hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </RowAction>
      </button>
    </li>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:text-sidebar-foreground"
      )}
    >
      {children}
    </button>
  )
}

export function ChatSidebar(props: ChatSidebarProps) {
  const {
    activeTab,
    onTabChange,
    disabled,
    sessions,
    activeSessionId,
    isLoadingSessions,
    onSelect,
    onNewChat,
    onDelete,
    onRename,
    onMoveToProject,
    projects,
    isLoadingProjects,
    activeProjectId,
    projectChats,
    isLoadingProjectChats,
    onOpenProject,
    onCloseProject,
    onNewProject,
    onRenameProject,
    onDeleteProject,
    onNewChatInProject,
  } = props

  const openProject = projects.find((p) => p.id === activeProjectId) ?? null

  return (
    <div className="bg-sidebar text-sidebar-foreground flex h-full w-full flex-col">
      <div className="flex items-center gap-2 px-3 pt-4 pb-2">
        <span className="bg-primary text-primary-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sm font-semibold">
          ✳
        </span>
        <span className="font-serif text-base font-medium">Chat</span>
      </div>

      {/* Chats | Projects tabs */}
      <div className="bg-muted mx-2 mb-2 flex gap-1 rounded-lg p-1">
        <TabButton
          active={activeTab === "chats"}
          onClick={() => onTabChange("chats")}
        >
          Chats
        </TabButton>
        <TabButton
          active={activeTab === "projects"}
          onClick={() => onTabChange("projects")}
        >
          Projects
        </TabButton>
      </div>

      {activeTab === "chats" ? (
        <>
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
              <p className="text-muted-foreground px-3 py-4 text-xs">
                No chats yet
              </p>
            ) : (
              <>
                <p className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium">
                  Recents
                </p>
                <ul className="space-y-0.5">
                  {sessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      isActive={session.id === activeSessionId}
                      disabled={disabled}
                      projects={projects}
                      onSelect={onSelect}
                      onDelete={onDelete}
                      onRename={onRename}
                      onMoveToProject={onMoveToProject}
                    />
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      ) : openProject ? (
        // Drilled into a single project: its chats.
        <>
          <div className="px-2 pb-1">
            <button
              type="button"
              onClick={onCloseProject}
              className="text-muted-foreground hover:text-sidebar-foreground flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              All projects
            </button>
          </div>
          <div className="flex items-center gap-2 px-4 pb-1">
            <Folder className="text-primary h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {openProject.name}
            </span>
          </div>
          <div className="px-2 pb-2">
            <button
              type="button"
              onClick={() => onNewChatInProject(openProject.id)}
              disabled={disabled}
              className="text-primary hover:bg-sidebar-accent flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-60"
            >
              <PenSquare className="h-4 w-4" />
              New chat in project
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-1">
            {isLoadingProjectChats ? (
              <p className="text-muted-foreground px-3 py-4 text-xs">
                Loading chats…
              </p>
            ) : projectChats.length === 0 ? (
              <p className="text-muted-foreground px-3 py-4 text-xs">
                No chats in this project yet
              </p>
            ) : (
              <ul className="space-y-0.5">
                {projectChats.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    isActive={session.id === activeSessionId}
                    disabled={disabled}
                    projects={projects}
                    onSelect={onSelect}
                    onDelete={onDelete}
                    onRename={onRename}
                    onMoveToProject={onMoveToProject}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        // Projects list.
        <>
          <div className="px-2 pb-2">
            <button
              type="button"
              onClick={onNewProject}
              disabled={disabled}
              className="text-primary hover:bg-sidebar-accent flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:opacity-60"
            >
              <FolderPlus className="h-4 w-4" />
              New project
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-1">
            {isLoadingProjects ? (
              <p className="text-muted-foreground px-3 py-4 text-xs">
                Loading projects…
              </p>
            ) : projects.length === 0 ? (
              <p className="text-muted-foreground px-3 py-4 text-xs">
                No projects yet
              </p>
            ) : (
              <ul className="space-y-0.5">
                {projects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    disabled={disabled}
                    onOpen={onOpenProject}
                    onRename={onRenameProject}
                    onDelete={onDeleteProject}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}
