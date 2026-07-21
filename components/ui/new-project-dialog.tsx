"use client"

import { useEffect, useRef, useState } from "react"
import { Globe } from "lucide-react"

import { Modal, ModalDescription, ModalTitle } from "./dialog"
import { Button } from "./button"

export type NewProjectFields = {
  name: string
  instructions: string
  isPublic: boolean
}

const NAME_MAX_LENGTH = 80

/**
 * Form modal for creating a project — replaces the old prompt() chain. Collects
 * name, optional instructions, and a public/shared toggle, then hands them to
 * `onCreate`. Resets each time it opens.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (fields: NewProjectFields) => void
}) {
  const [name, setName] = useState("")
  const [instructions, setInstructions] = useState("")
  const [isPublic, setIsPublic] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  // Reset fields and focus the name each time the dialog opens.
  useEffect(() => {
    if (open) {
      setName("")
      setInstructions("")
      setIsPublic(false)
      // Focus after the popup mounts.
      const t = setTimeout(() => nameRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [open])

  const canCreate = name.trim().length > 0

  function submit() {
    if (!canCreate) return
    onCreate({ name: name.trim(), instructions: instructions.trim(), isPublic })
    onOpenChange(false)
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalTitle>New project</ModalTitle>
      <ModalDescription>
        Group related chats. Instructions are prepended to every chat in the
        project.
      </ModalDescription>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        className="mt-4 space-y-3"
      >
        <div className="space-y-1">
          <label
            htmlFor="new-project-name"
            className="text-foreground text-xs font-medium"
          >
            Name
          </label>
          <input
            id="new-project-name"
            ref={nameRef}
            value={name}
            maxLength={NAME_MAX_LENGTH}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Onboarding docs"
            className="border-border bg-background text-foreground focus-visible:ring-ring w-full rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2"
          />
        </div>

        <div className="space-y-1">
          <label
            htmlFor="new-project-instructions"
            className="text-foreground text-xs font-medium"
          >
            Instructions <span className="text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id="new-project-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={3}
            placeholder="Guidance applied to every chat in this project…"
            className="border-border bg-background text-foreground focus-visible:ring-ring w-full resize-none rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2"
          />
        </div>

        <button
          type="button"
          onClick={() => setIsPublic((v) => !v)}
          className="border-border hover:bg-muted/60 flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors"
        >
          <span
            className={cnCheckbox(isPublic)}
            aria-hidden
          >
            {isPublic && <CheckMark />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-foreground flex items-center gap-1.5 text-sm font-medium">
              <Globe className="text-primary h-3.5 w-3.5" />
              Public project
            </span>
            <span className="text-muted-foreground mt-0.5 block text-xs">
              Shared with everyone — others can view all chats here and add their
              own. Only you can rename or delete it.
            </span>
          </span>
        </button>

        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canCreate}>
            Create project
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function cnCheckbox(checked: boolean): string {
  return [
    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
    checked
      ? "border-primary bg-primary text-primary-foreground"
      : "border-border bg-background",
  ].join(" ")
}

function CheckMark() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
      <path
        d="M2.5 6.5L5 9L9.5 3.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
