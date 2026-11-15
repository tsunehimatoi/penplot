import * as React from 'react'

export function SelectionBox({ checked, mixed, label, disabled, onChange }: {
  checked: boolean; mixed?: boolean; label: string; disabled?: boolean; onChange: () => void
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = !!mixed }, [mixed])
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled}
    onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={onChange}
    className="focus-ring size-4 shrink-0 cursor-pointer accent-[rgb(var(--accent))] pointer-coarse:size-5" />
}
