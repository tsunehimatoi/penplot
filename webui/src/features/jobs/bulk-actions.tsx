import * as React from 'react'
import { Trash2 } from 'lucide-react'
import { useJobActions } from '@/api/jobs'
import type { Job } from '@/api/types'
import { Button } from '@/components/ui'
import { confirm } from '@/lib/confirm'
import { toast } from '@/lib/toast'
import { SelectionBox } from './selection-box'

type ClearScope = 'queued' | 'history'

export const CLEAR_JOB_LABELS: Record<ClearScope, string> = {
  queued: '清空待打印',
  history: '清空已结束记录',
}

export async function runJobCleanup(
  clear: ReturnType<typeof useJobActions>['clear'],
  scope: ClearScope,
  ids?: string[],
  onRemoved?: (removedIds: string[]) => void,
) {
  const title = ids ? `删除选中的 ${ids.length} 个任务？` : `${CLEAR_JOB_LABELS[scope]}？`
  const description = scope === 'queued'
    ? '移除待打印任务，正在打印的任务会保留。此操作无法撤销。'
    : '移除已完成、失败和已停止的记录，不影响待打印或进行中的任务。此操作无法撤销。'
  if (!await confirm({
    title,
    description: description + (ids ? '' : '清空范围包括未显示的记录。'),
    confirmLabel: ids ? '删除' : '清空',
    destructive: true,
  })) return
  clear.mutate({ scope, ...(ids ? { ids } : {}) }, { onSuccess: (result) => {
    onRemoved?.(result.removed_ids)
    toast.success(`已清理 ${result.removed_ids.length} 个任务`, {
      description: result.skipped_ids.length ? `${result.skipped_ids.length} 个任务状态已变化或不可移除，已保留。` : undefined,
    })
  } })
}

export function useJobSelection(rows: Job[], scope: ClearScope) {
  const [selected, setSelected] = React.useState<string[]>([])
  const { clear } = useJobActions()
  const ids = rows.map((j) => j.id)
  const visible = selected.filter((id) => ids.includes(id))
  // A status change or filter change must not leave invisible tasks selected for deletion.
  if (visible.length !== selected.length) setSelected(visible)
  const toggle = (id: string) => setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  const execute = (all: boolean) => runJobCleanup(clear, scope, all ? undefined : visible, (removedIds) => {
    setSelected((prev) => prev.filter((id) => !removedIds.includes(id)))
  })
  const checkbox = (job: Job) => <SelectionBox label={`选择「${job.name}」`} checked={visible.includes(job.id)} disabled={clear.isPending} onChange={() => toggle(job.id)} />
  const toolbar = <div className="flex flex-wrap items-center gap-3 text-footnote text-secondary-label" aria-busy={clear.isPending}>
    <label className="flex items-center gap-2">
      <SelectionBox label={scope === 'queued' ? '全选当前待打印任务' : '全选当前历史记录'} checked={ids.length > 0 && visible.length === ids.length}
        mixed={visible.length > 0 && visible.length < ids.length} disabled={!ids.length || clear.isPending}
        onChange={() => setSelected(visible.length === ids.length ? [] : ids)} />全选当前列表
    </label>
    <span role="status">已选 {visible.length} 项</span>
    <Button size="sm" variant="gray" icon={<Trash2 />} disabled={!visible.length || clear.isPending} onClick={() => void execute(false)}>删除选中</Button>
    <Button size="sm" variant="plain" loading={clear.isPending} onClick={() => void execute(true)}>{CLEAR_JOB_LABELS[scope]}</Button>
  </div>
  return { checkbox, toolbar, clearing: clear.isPending }
}
