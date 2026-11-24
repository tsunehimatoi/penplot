import { ChevronLeft, ChevronRight, CirclePlay, Trash2 } from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { useJobActions, useJobs } from '@/api/jobs'
import { isJobActive, useLive } from '@/api/store'
import { useHideMiniPlayer } from '@/app/mini-player'
import { Page } from '@/app/page'
import { Button, Card, EmptyState, ErrorState, IconButton, SkeletonList } from '@/components/ui'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { useBreakpoint } from '@/lib/media'
import { CLEAR_JOB_LABELS, runJobCleanup } from './bulk-actions'
import { groupJobsBySend, type JobGroup } from './grouping'
import { JobDetailSheet } from './job-detail'
import { RecoveryBanner } from './recovery-wizard'
import { RollingJobList } from './rolling-list'
import { SummaryCard } from './summary-card'

function defaultFocusForGroup(group: JobGroup | undefined): string | null {
  if (!group) return null
  return group.activeJob?.id ?? group.nextQueuedJob?.id ?? group.jobs[0]?.id ?? null
}

export default function JobsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const bp = useBreakpoint()
  const compact = bp === 'compact'
  const all = useJobs()
  const { remove, removeBatch, clear } = useJobActions()
  const { liveJob, progress } = useLive(
    useShallow((s) => ({
      liveJob: s.job,
      progress: s.progress,
    })),
  )

  useHideMiniPlayer()

  const groups = React.useMemo(
    () => groupJobsBySend(all.data ?? [], { job: liveJob, progress }),
    [all.data, liveJob, progress],
  )

  const [selectedGroupKey, setSelectedGroupKey] = React.useState<string | null>(null)
  const [focusedJobId, setFocusedJobId] = React.useState<string | null>(null)

  const activeGroupIndex = React.useMemo(() => {
    if (!groups.length) return -1
    if (selectedGroupKey) {
      const idx = groups.findIndex((g) => g.key === selectedGroupKey)
      if (idx >= 0) return idx
    }
    const runningIdx = groups.findIndex((g) => !!g.activeJob)
    return runningIdx >= 0 ? runningIdx : 0
  }, [groups, selectedGroupKey])

  const currentGroup = activeGroupIndex >= 0 ? groups[activeGroupIndex] : undefined

  const effectiveFocusedJobId = React.useMemo(() => {
    if (!currentGroup) return null
    if (focusedJobId && currentGroup.jobs.some((j) => j.id === focusedJobId)) {
      return focusedJobId
    }
    return defaultFocusForGroup(currentGroup)
  }, [currentGroup, focusedJobId])

  const focusedJob = React.useMemo(
    () => currentGroup?.jobs.find((j) => j.id === effectiveFocusedJobId) ?? null,
    [currentGroup, effectiveFocusedJobId],
  )

  // Auto-focus group and running job whenever a new job becomes active
  const lastActiveJobIdRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    const activeId = isJobActive(liveJob) ? liveJob?.id ?? null : null
    if (!activeId || activeId === lastActiveJobIdRef.current) return
    lastActiveJobIdRef.current = activeId
    const ownerGroup = groups.find((g) => g.jobs.some((j) => j.id === activeId))
    if (ownerGroup) {
      setSelectedGroupKey(ownerGroup.key)
      setFocusedJobId(activeId)
    }
  }, [liveJob, groups])

  const selectGroup = React.useCallback(
    (group: JobGroup) => {
      setSelectedGroupKey(group.key)
      setFocusedJobId(defaultFocusForGroup(group))
    },
    [],
  )

  const stepGroup = React.useCallback(
    (delta: -1 | 1) => {
      if (groups.length <= 1 || activeGroupIndex < 0) return
      const nextIdx = Math.max(0, Math.min(groups.length - 1, activeGroupIndex + delta))
      if (nextIdx !== activeGroupIndex && groups[nextIdx]) {
        selectGroup(groups[nextIdx])
      }
    },
    [groups, activeGroupIndex, selectGroup],
  )

  // Keyboard ArrowLeft / ArrowRight to switch groups
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (id) return // Do not hijack keys while detail sheet is open
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement | null)?.isContentEditable) return
      e.preventDefault()
      stepGroup(e.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [stepGroup, id])

  // Auto-scroll active group tab into view
  const tabRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())
  React.useEffect(() => {
    if (!currentGroup) return
    tabRefs.current.get(currentGroup.key)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [currentGroup])

  const handleDeleteGroup = async (group: JobGroup) => {
    if (group.activeJob) return
    const ok = await confirm({
      title: `删除分组「${group.title}」？`,
      description: `将删除该组内的 ${group.totalCount} 个任务记录，此操作不可撤销。`,
      confirmLabel: '删除整组',
      destructive: true,
    })
    if (!ok) return
    if (group.batchId) {
      await removeBatch.mutateAsync(group.batchId)
    } else {
      await Promise.all(group.jobs.map((j) => remove.mutateAsync(j.id)))
    }
  }

  const closeDetail = React.useCallback(() => navigate('/jobs', { replace: true }), [navigate])
  const openDetail = React.useCallback((jobId: string) => navigate(`/jobs/${jobId}`), [navigate])

  return (
    <Page title="任务">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 empty:hidden">
          <RecoveryBanner jobs={all.data} />
        </div>

        <div role="group" aria-label="清理任务" className="flex flex-wrap justify-end gap-2">
          {(['queued', 'history'] as const).map((scope) => (
            <Button key={scope} size="sm" variant="gray" icon={<Trash2 />}
              disabled={!all.data?.length || !!all.error || clear.isPending}
              loading={clear.isPending && clear.variables?.scope === scope}
              onClick={() => void runJobCleanup(clear, scope)}
            >
              {CLEAR_JOB_LABELS[scope]}
            </Button>
          ))}
        </div>

        {/* Group Switcher Bar */}
        {groups.length > 0 ? (
          <div className="flex items-center gap-2">
            <IconButton
              size="sm"
              variant="gray"
              label="上一个分组 (←)"
              disabled={activeGroupIndex <= 0}
              onClick={() => stepGroup(-1)}
            >
              <ChevronLeft />
            </IconButton>

            <div
              className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-0.5"
              role="tablist"
              aria-label="打印任务分组"
            >
              {groups.map((g) => {
                const selected = currentGroup?.key === g.key
                const allDone = g.totalCount > 0 && g.doneCount === g.totalCount
                const isPaused = g.activeJob?.status === 'paused'
                const isActive = !!g.activeJob
                return (
                  <div
                    key={g.key}
                    ref={(el) => {
                      if (el) tabRefs.current.set(g.key, el)
                      else tabRefs.current.delete(g.key)
                    }}
                    className={cn(
                      'group flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-footnote transition-colors',
                      selected
                        ? 'border-accent bg-accent/10 text-label shadow-xs'
                        : 'border-separator/70 bg-bg-elevated text-secondary-label hover:bg-secondary-fill/60 hover:text-label',
                    )}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => selectGroup(g)}
                      className="focus-ring flex items-center gap-2 rounded-xs text-left"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          isPaused
                            ? 'bg-orange'
                            : isActive
                              ? 'animate-pulse bg-accent'
                              : allDone
                                ? 'bg-green'
                                : g.queuedCount > 0
                                  ? 'bg-blue'
                                  : 'bg-tertiary-label',
                        )}
                      />
                      <span className="max-w-44 truncate font-medium">{g.title}</span>
                      <span className="tabular-nums text-secondary-label">
                        {g.doneCount}/{g.totalCount}
                      </span>
                    </button>
                    {!isActive ? (
                      <button
                        type="button"
                        aria-label={`删除分组 ${g.title}`}
                        title="删除整组"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleDeleteGroup(g)
                        }}
                        className="focus-ring ml-0.5 rounded-xs p-0.5 text-tertiary-label opacity-70 transition-opacity hover:bg-fill hover:text-red group-hover:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </div>

            <IconButton
              size="sm"
              variant="gray"
              label="下一个分组 (→)"
              disabled={activeGroupIndex < 0 || activeGroupIndex >= groups.length - 1}
              onClick={() => stepGroup(1)}
            >
              <ChevronRight />
            </IconButton>
          </div>
        ) : null}

        {/* Main Body */}
        {all.isLoading ? (
          <SkeletonList rows={5} />
        ) : all.error ? (
          <ErrorState error={all.error} onRetry={() => all.refetch()} />
        ) : !currentGroup ? (
          <Card>
            <EmptyState
              className="py-12"
              icon={CirclePlay}
              title="还没有打印任务"
              description="在创作台点击「打印」发送任务后，这里会按发送批次展示进度与滚动任务表。"
              action={
                <Button asChild variant="filled" size="lg">
                  <Link to="/studio">去创作台</Link>
                </Button>
              }
            />
          </Card>
        ) : (
          <div className={cn('grid grid-cols-1 items-start gap-4', !compact && 'lg:grid-cols-12')}>
            <div className={cn(!compact && 'lg:col-span-5')}>
              <SummaryCard
                group={currentGroup}
                focusedJob={focusedJob}
                compact={compact}
                onOpenDetail={openDetail}
              />
            </div>
            <div className={cn(!compact && 'lg:col-span-7')}>
              <RollingJobList
                group={currentGroup}
                focusedJobId={effectiveFocusedJobId}
                onFocusJob={setFocusedJobId}
                onOpenDetail={openDetail}
              />
            </div>
          </div>
        )}
      </div>

      <JobDetailSheet id={id} onClose={closeDetail} />
    </Page>
  )
}
