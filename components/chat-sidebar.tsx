"use client"

import { useEffect, useRef, useState } from "react"
import {
  ChevronLeft,
  FolderPlus,
  Folder,
  FolderInput,
  Globe,
  Loader2,
  Lock,
  Pencil,
  PenSquare,
  Share2,
  Sparkles,
  Trash2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatProjectSummary, ChatSessionSummary } from "@/lib/types"

export type SidebarTab = "chats" | "projects"

type ChatSidebarProps = {
  activeTab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  disabled: boolean

  // A brand-new (unsaved) chat is open — show a "New chat" draft row so it's
  // visible in the sidebar before the first message is sent (UAT #2).
  draftActive: boolean
  /** The project the draft belongs to (from "New chat in project"), or null. */
  draftProjectId: string | null

  // Chats tab (unfiled chats)
  sessions: ChatSessionSummary[]
  activeSessionId: string | null
  isLoadingSessions: boolean
  onSelect: (id: string) => void
  onNewChat: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onAiRename: (id: string) => Promise<void>
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
  onToggleProjectPublic: (id: string, makePublic: boolean) => void
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
      title={label}
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
  onAiRename: (id: string) => Promise<void>
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
  onAiRename,
  onMoveToProject,
}: SessionRowProps) {
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [aiRenaming, setAiRenaming] = useState(false)
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
  // A chat surfaced from a public project that the viewer didn't create is
  // view-only: no move/rename/delete, and we badge whose chat it is instead.
  const canManage = session.isOwner !== false

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
            if (!disabled && canManage) setEditing(true)
          }}
        >
          {session.title || "New chat"}
        </span>
        {canManage ? (
          <>
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
            <RowAction
              label="Rename with AI — reads the chat and suggests a title"
              onActivate={async () => {
                if (disabled || aiRenaming) return
                setAiRenaming(true)
                try {
                  await onAiRename(session.id)
                } finally {
                  setAiRenaming(false)
                }
              }}
              className={cn("hover:text-primary", aiRenaming && "opacity-100")}
            >
              {aiRenaming ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
            </RowAction>
          </>
        ) : (
          session.creator && (
            <span
              className="text-muted-foreground max-w-[45%] shrink-0 truncate text-[10px]"
              title={`Shared by ${session.creator}`}
            >
              {session.creator}
            </span>
          )
        )}
      </button>

      {canManage && menuOpen && (
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
  onToggleShare: (id: string, makePublic: boolean) => void
}

function ProjectRow({
  project,
  disabled,
  onOpen,
  onRename,
  onDelete,
  onToggleShare,
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
        {project.isPublic ? (
          <Globe className="text-primary h-4 w-4 shrink-0" />
        ) : (
          <Folder className="h-4 w-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        <span className="text-muted-foreground shrink-0 text-xs group-hover/session:hidden">
          {project.chatCount}
        </span>
        {/* Only the creator can share/rename/delete a project. Non-owned
            (public) projects show no manage actions. */}
        {project.isOwner && (
          <>
            <RowAction
              label={project.isPublic ? "Make private" : "Share (make public)"}
              onActivate={() =>
                !disabled && onToggleShare(project.id, !project.isPublic)
              }
              className="hover:text-foreground"
            >
              {project.isPublic ? (
                <Lock className="h-3.5 w-3.5" />
              ) : (
                <Share2 className="h-3.5 w-3.5" />
              )}
            </RowAction>
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
          </>
        )}
      </button>
    </li>
  )
}

/**
 * A non-interactive, highlighted row shown while a brand-new chat is open but
 * not yet saved — so it's obvious in the sidebar that the new chat is already
 * active and waiting for a first message, rather than nothing appearing until
 * the user types (UAT #2).
 */
function DraftRow() {
  return (
    <li>
      <div
        aria-current="true"
        className="bg-sidebar-accent text-sidebar-accent-foreground flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm"
      >
        <PenSquare className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">New chat</span>
        <span className="text-muted-foreground shrink-0 text-[10px] font-medium tracking-wide uppercase">
          Draft
        </span>
      </div>
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
    draftActive,
    draftProjectId,
    sessions,
    activeSessionId,
    isLoadingSessions,
    onSelect,
    onNewChat,
    onDelete,
    onRename,
    onAiRename,
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
    onToggleProjectPublic,
    onNewChatInProject,
  } = props

  const openProject = projects.find((p) => p.id === activeProjectId) ?? null
  // "Your projects" (owned, may be public) vs "Public projects" (shared by
  // others, view-only). Non-owned projects are only visible because they're
  // public, so this split is exhaustive.
  const ownedProjects = projects.filter((p) => p.isOwner)
  const sharedProjects = projects.filter((p) => !p.isOwner)

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
            {draftActive && !draftProjectId && (
              <ul className="mb-1 space-y-0.5">
                <DraftRow />
              </ul>
            )}
            {isLoadingSessions ? (
              <p className="text-muted-foreground px-3 py-4 text-xs">
                Loading chats…
              </p>
            ) : sessions.length === 0 ? (
              draftActive && !draftProjectId ? null : (
                <p className="text-muted-foreground px-3 py-4 text-xs">
                  No chats yet
                </p>
              )
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
                      onAiRename={onAiRename}
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
          <div className="flex items-center gap-2 px-4 pb-0.5">
            {openProject.isPublic ? (
              <Globe className="text-primary h-4 w-4 shrink-0" />
            ) : (
              <Folder className="text-primary h-4 w-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {openProject.name}
            </span>
          </div>
          {openProject.isPublic && (
            <p className="text-muted-foreground px-4 pb-1 text-[11px]">
              {openProject.isOwner
                ? "Shared with everyone — others can view your chats here."
                : `This project is owned by ${openProject.owner}. You can read all chats, add your own, but to edit any items contact the original author.`}
            </p>
          )}
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
            {draftActive && draftProjectId === openProject.id && (
              <ul className="mb-1 space-y-0.5">
                <DraftRow />
              </ul>
            )}
            {isLoadingProjectChats ? (
              <p className="text-muted-foreground px-3 py-4 text-xs">
                Loading chats…
              </p>
            ) : projectChats.length === 0 ? (
              draftActive && draftProjectId === openProject.id ? null : (
                <p className="text-muted-foreground px-3 py-4 text-xs">
                  No chats in this project yet
                </p>
              )
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
                    onAiRename={onAiRename}
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
              <>
                {ownedProjects.length > 0 && (
                  <>
                    <p className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium">
                      Your projects
                    </p>
                    <ul className="space-y-0.5">
                      {ownedProjects.map((project) => (
                        <ProjectRow
                          key={project.id}
                          project={project}
                          disabled={disabled}
                          onOpen={onOpenProject}
                          onRename={onRenameProject}
                          onDelete={onDeleteProject}
                          onToggleShare={onToggleProjectPublic}
                        />
                      ))}
                    </ul>
                  </>
                )}
                {sharedProjects.length > 0 && (
                  <>
                    <p className="text-muted-foreground px-3 pt-3 pb-1 text-xs font-medium">
                      Public projects
                    </p>
                    <ul className="space-y-0.5">
                      {sharedProjects.map((project) => (
                        <ProjectRow
                          key={project.id}
                          project={project}
                          disabled={disabled}
                          onOpen={onOpenProject}
                          onRename={onRenameProject}
                          onDelete={onDeleteProject}
                          onToggleShare={onToggleProjectPublic}
                        />
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
