"use client"

import { createContext, useCallback, useContext, useRef, useState } from "react"

import { Modal, ModalDescription, ModalTitle } from "./dialog"
import { Button } from "./button"

export type ConfirmOptions = {
  title: string
  /** Optional body text explaining the consequence. */
  body?: string
  /** Confirm-button label (default "Confirm"). */
  confirmLabel?: string
  /** Cancel-button label (default "Cancel"). */
  cancelLabel?: string
  /** Style the confirm button as destructive (for deletes). */
  danger?: boolean
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/**
 * Promise-based replacement for `window.confirm`. Call `const confirm =
 * useConfirm()` then `if (!(await confirm({ title, body }))) return`. Resolves
 * true on confirm, false on cancel / backdrop / Escape.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error("useConfirm must be used within a <ConfirmProvider>")
  }
  return ctx
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolverRef = useRef<((value: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((opts) => {
    setOptions(opts)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
    })
  }, [])

  // Resolve the pending promise exactly once and close.
  const settle = useCallback((result: boolean) => {
    resolverRef.current?.(result)
    resolverRef.current = null
    setOptions(null)
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={options !== null}
        onOpenChange={(open) => {
          // Any dismissal (backdrop, Escape, close) counts as cancel.
          if (!open) settle(false)
        }}
      >
        {options && (
          <>
            <ModalTitle>{options.title}</ModalTitle>
            {options.body && <ModalDescription>{options.body}</ModalDescription>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => settle(false)}>
                {options.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={options.danger ? "destructive" : "default"}
                size="sm"
                onClick={() => settle(true)}
              >
                {options.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </ConfirmContext.Provider>
  )
}
