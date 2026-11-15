import { ChevronDown, ChevronRight, Layers, Plus, Trash2, X } from 'lucide-react'
import * as React from 'react'
import type { FontMixEntry, FontRoles } from '@/api/studio'
import { Button, NumberField, Slider } from '@/components/ui'
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
  const isMixed = mixList.length > 1
  const singleFontId = mixList.length === 1 ? mixList[0].font_id : fontId

  const [rolesOpen, setRolesOpen] = React.useState(activeRoleCount > 0)

  const setRole = (key: keyof FontRoles, val: string | null) => {
    const next: FontRoles = { ...roles, [key]: val || null }
    const hasAny = Object.values(next).some((v) => !!v)
    onChange({ font_roles: hasAny ? next : null })
  }

  const updateMix = (next: FontMixEntry[]) => {
    if (next.length <= 1) {
      const keepId = next[0]?.font_id ?? fontId ?? null
      onChange({ font_id: keepId, font_mix: null }, 'font_mix')
    } else {
      onChange({ font_mix: next }, 'font_mix')
    }
  }

  const addMixFont = () => {
    if (!allFonts.length) return
    const baseList: FontMixEntry[] =
      mixList.length >= 1
        ? mixList
        : [{ font_id: singleFontId ?? allFonts[0].id, weight: 1 }]
    const used = new Set(baseList.map((m) => m.font_id))
    const candidate = allFonts.find((f) => !used.has(f.id)) ?? allFonts[0]
    if (!candidate) return
    updateMix([...baseList, { font_id: candidate.id, weight: 1 }])
  }

  const totalWeight = mixList.reduce((sum, m) => sum + Math.max(0, m.weight), 0)

  return (
    <>
      <Row label="字体" htmlFor={mainId}>
        {isMixed ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <div
              id={mainId}
              className="inline-flex h-7 min-w-0 flex-1 items-center justify-between gap-1.5 rounded-sm bg-bg-elevated px-2 text-body text-label shadow-sm pointer-coarse:h-11"
            >
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                <Layers className="size-3.5 shrink-0 text-accent" />
                <span className="truncate font-medium">混合字体</span>
              </span>
              <span className="shrink-0 rounded bg-accent/12 px-1.5 py-0.5 text-caption font-medium text-accent">
                {mixList.length} 种
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              title="退出混排并恢复单字体"
              onClick={() => updateMix(mixList.slice(0, 1))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <FontPicker
            id={mainId}
            value={singleFontId}
            onChange={(v) => onChange({ font_id: v, font_mix: null })}
            text={text}
          />
        )}
      </Row>

      <div className="px-1">
        {isMixed ? (
          <div className="space-y-1.5 rounded-md bg-quaternary-fill p-2">
            {mixList.map((entry, idx) => {
              const pct = totalWeight > 0 ? Math.round((Math.max(0, entry.weight) / totalWeight) * 100) : 0
              return (
                <div key={idx} className="space-y-1.5 rounded-sm bg-bg-elevated p-2 shadow-sm">
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
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-caption text-secondary-label">权重</span>
                    <Slider
                      min={0}
                      max={10}
                      step={0.5}
                      value={[entry.weight]}
                      onValueChange={([w]) => {
                        const next = mixList.map((m, i) => (i === idx ? { ...m, weight: Math.max(0, w) } : m))
                        updateMix(next)
                      }}
                      className="flex-1"
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
                    <span className="w-8 text-right text-caption tabular-nums text-secondary-label">
                      {pct}%
                    </span>
                  </div>
                </div>
              )
            })}
            <Button
              size="sm"
              variant="tinted"
              onClick={addMixFont}
              disabled={!allFonts.length}
              className="w-full"
            >
              <Plus className="size-3.5" />
              添加混合字体
            </Button>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              onClick={addMixFont}
              disabled={!allFonts.length}
              title="添加混合字体"
              className="h-6 px-2 text-caption text-secondary-label hover:text-label"
            >
              <Plus className="size-3" />
              添加混合字体
            </Button>
          </div>
        )}
      </div>

      <div className="px-1 pt-0.5">
        <button
          type="button"
          onClick={() => setRolesOpen((v) => !v)}
          className="flex w-full items-center justify-between rounded-sm py-1 text-footnote font-medium text-secondary-label transition-colors hover:text-label"
        >
          <span className="flex items-center gap-1">
            {rolesOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            分类字体
          </span>
          {activeRoleCount > 0 && (
            <span className="rounded bg-accent/12 px-1.5 py-0.5 text-caption font-medium text-accent">
              已设 {activeRoleCount} 项
            </span>
          )}
        </button>

        {rolesOpen && (
          <div className="mt-1 space-y-1.5 rounded-md bg-quaternary-fill p-2">
            {ROLE_ITEMS.map(({ key, label, sample }) => {
              const val = roles[key] ?? null
              return (
                <div key={key} className="grid grid-cols-[36px_1fr_auto] items-center gap-1.5">
                  <span className="text-footnote text-secondary-label">{label}</span>
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
                      <X className="size-3" />
                    </Button>
                  ) : (
                    <span className="w-7 text-center text-caption text-tertiary-label">默认</span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
