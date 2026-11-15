import { ChevronDown, ChevronRight, Plus, Trash2, X } from 'lucide-react'
import * as React from 'react'
import type { FontMixEntry, FontRoles } from '@/api/studio'
import { Button, NumberField } from '@/components/ui'
import { useFonts } from '../data'
import { Row } from './controls'
import { FontPicker } from './font-picker'

const ROLE_ITEMS: { key: keyof FontRoles; label: string; sample: string }[] = [
  { key: 'en', label: '英文', sample: 'Abc123' },
  { key: 'zh', label: '中文', sample: '汉字示例' },
  { key: 'symbol', label: '符号', sample: '，。！？+-=' },
  { key: 'fallback', label: '补充', sample: 'αβγ①②' },
]

interface FontConfigProps {
  fontId: string | null | undefined
  fontRoles: FontRoles | null | undefined
  fontMix: FontMixEntry[] | null | undefined
  text: string
  onChange: (patch: Record<string, unknown>, key?: string) => void
}

export function FontConfig({ fontId, fontRoles, fontMix, text, onChange }: FontConfigProps) {
  const mainId = React.useId()
  const fonts = useFonts()
  const allFonts = (fonts.data ?? []).filter((f) => !f.hidden)

  const roles = fontRoles ?? {}
  const activeRoleCount = ROLE_ITEMS.filter((r) => !!roles[r.key]).length
  const mixList = fontMix ?? []

  const [rolesOpen, setRolesOpen] = React.useState(activeRoleCount > 0)
  const [mixOpen, setMixOpen] = React.useState(mixList.length > 0)

  const setRole = (key: keyof FontRoles, val: string | null) => {
    const next: FontRoles = { ...roles, [key]: val || null }
    const hasAny = Object.values(next).some((v) => !!v)
    onChange({ font_roles: hasAny ? next : null })
  }

  const updateMix = (next: FontMixEntry[]) => {
    onChange({ font_mix: next.length ? next : null }, 'font_mix')
  }

  const addMixFont = () => {
    if (!allFonts.length) return
    const used = new Set(mixList.map((m) => m.font_id))
    const candidate =
      (mixList.length === 0 && fontId ? allFonts.find((f) => f.id === fontId) : undefined) ??
      allFonts.find((f) => !used.has(f.id)) ??
      allFonts[0]
    if (!candidate) return
    if (mixList.length === 0 && fontId && candidate.id !== fontId) {
      updateMix([
        { font_id: fontId, weight: 1 },
        { font_id: candidate.id, weight: 1 },
      ])
    } else {
      updateMix([...mixList, { font_id: candidate.id, weight: 1 }])
    }
  }

  const totalWeight = mixList.reduce((sum, m) => sum + Math.max(0, m.weight), 0)

  return (
    <>
      <Row label="字体" htmlFor={mainId}>
        <FontPicker
          id={mainId}
          value={fontId}
          onChange={(v) => onChange({ font_id: v })}
          text={text}
        />
      </Row>

      <div className="pt-0.5">
        <button
          type="button"
          onClick={() => setRolesOpen((v) => !v)}
          className="flex w-full items-center justify-between py-1 text-[11px] font-medium text-[var(--ink-2)] hover:text-[var(--ink)]"
        >
          <span className="flex items-center gap-1">
            {rolesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            分类字体
          </span>
          {activeRoleCount > 0 && (
            <span className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
              已设 {activeRoleCount} 项
            </span>
          )}
        </button>

        {rolesOpen && (
          <div className="mt-1 space-y-1.5 rounded border border-[var(--line)] bg-[var(--bg-2)]/40 p-2">
            {ROLE_ITEMS.map(({ key, label, sample }) => {
              const val = roles[key] ?? null
              return (
                <div key={key} className="grid grid-cols-[40px_1fr_auto] items-center gap-1.5">
                  <span className="text-[11px] text-[var(--ink-2)]">{label}</span>
                  <FontPicker
                    value={val}
                    onChange={(v) => setRole(key, v)}
                    text={key === 'fallback' ? text || sample : sample}
                  />
                  {val ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      title={`清除${label}字体`}
                      onClick={() => setRole(key, null)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  ) : (
                    <span className="w-6 text-center text-[10px] text-[var(--ink-3)]">默认</span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="pt-0.5">
        <button
          type="button"
          onClick={() => setMixOpen((v) => !v)}
          className="flex w-full items-center justify-between py-1 text-[11px] font-medium text-[var(--ink-2)] hover:text-[var(--ink)]"
        >
          <span className="flex items-center gap-1">
            {mixOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            按比例混排
          </span>
          {mixList.length > 0 && (
            <span className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
              {mixList.length} 种字体
            </span>
          )}
        </button>

        {mixOpen && (
          <div className="mt-1 space-y-2 rounded border border-[var(--line)] bg-[var(--bg-2)]/40 p-2">
            {mixList.length === 0 ? (
              <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--ink-3)]">
                <span>未启用混排，当前仅使用主字体</span>
                <Button size="sm" variant="bordered" onClick={addMixFont}>
                  <Plus className="mr-1 h-3 w-3" />
                  启用
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  {mixList.map((entry, idx) => {
                    const pct = totalWeight > 0 ? Math.round((Math.max(0, entry.weight) / totalWeight) * 100) : 0
                    return (
                      <div key={idx} className="space-y-1 rounded border border-[var(--line)]/60 bg-[var(--bg-1)] p-1.5">
                        <div className="grid grid-cols-[1fr_auto] items-center gap-1">
                          <FontPicker
                            value={entry.font_id}
                            onChange={(v) => {
                              const next = mixList.map((m, i) => (i === idx ? { ...m, font_id: v } : m))
                              updateMix(next)
                            }}
                            text={text}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            title="移除此字体"
                            onClick={() => updateMix(mixList.filter((_, i) => i !== idx))}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-[var(--ink-2)]">权重</span>
                          <input
                            type="range"
                            min={0}
                            max={10}
                            step={0.5}
                            value={entry.weight}
                            onChange={(e) => {
                              const w = Math.max(0, parseFloat(e.currentTarget.value) || 0)
                              const next = mixList.map((m, i) => (i === idx ? { ...m, weight: w } : m))
                              updateMix(next)
                            }}
                            className="h-1.5 flex-1 accent-[var(--accent)]"
                          />
                          <NumberField
                            value={entry.weight}
                            min={0}
                            max={100}
                            step={0.5}
                            onChange={(w) => {
                              const next = mixList.map((m, i) => (i === idx ? { ...m, weight: Math.max(0, w) } : m))
                              updateMix(next)
                            }}
                            className="w-14"
                          />
                          <span className="w-8 text-right text-[10px] tabular-nums text-[var(--ink-2)]">
                            {pct}%
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center justify-between pt-0.5">
                  <Button size="sm" variant="bordered" onClick={addMixFont}>
                    <Plus className="mr-1 h-3 w-3" />
                    添加字体
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => updateMix([])}>
                    清空混排
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}
