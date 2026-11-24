import {
  ArrowDown, ArrowUp, CircleCheck, CircleDashed, CirclePause, CircleStop, CircleX, Clock,
  Crosshair, Frame, Info, Loader, Play, RotateCcw, TriangleAlert,
} from 'lucide-react'
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useRole } from '@/api/collab'
import { JOB_STATUS_LABEL, useJobActions } from '@/api/jobs'
import { isJobActive, useLive } from '@/api/store'
import { TERMINAL_JOB_STATUSES, type Job, type JobStatus } from '@/api/types'
import { Badge, Button, Card, IconButton } from '@/components/ui'
import { useMachineGate } from '@/features/machine/gate'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { toast } from '@/lib/toast'
import type { JobGroup } from './grouping'
import { confirmStart } from './queue-card'

const STATUS_ICON: Record<JobStatus, typeof CircleCheck> = {
  queued: Clock,
  preparing: Loader,
  running: Loader,
  paused: CirclePause,
  stopping: CircleDashed,
  done: CircleCheck,
  failed: CircleX,
  aborted: CircleStop,
}

export interface RollingJobListProps {
  group: JobGroup
  focusedJobId: string | null
  onFocusJob: (jobId: string) => void
  onOpenDetail: (jobId: string) => void
}

export function RollingJobList({ group, focusedJobId, onFocusJob, onOpenDetail }: RollingJobListProps) {
  const { start, retry, frame } = useJobActions()
  const { liveJob, progress, machine } = useLive(
    useShallow((s) => ({
      liveJob: s.job,
      progress: s.progress,
      machine: s.machine,
    })),
  )
  const blocked = useMachineGate().leaseBlocked
  const admin = useRole() === 'admin'
  const machineBusy = isJobActive(liveJob)
  const canOperate = !!machine?.connected && !blocked

  const jobs = group.jobs
  const focusedIdx = React.useMemo(() => {
    if (!jobs.length) return -1
    const idx = focusedJobId ? jobs.findIndex((j) => j.id === focusedJobId) : -1
    return idx >= 0 ? idx : 0
  }, [jobs, focusedJobId])

  const scrollRef = React.useRef<HTMLDivElement>(null)
  const rowRefs = React.useRef<Map<string, HTMLDivElement>>(new Map())

  const setRowRef = React.useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el)
    else rowRefs.current.delete(id)
  }, [])

  // Smoothly scroll focused row into the upper-middle focus zone so completed jobs stay above
  React.useEffect(() => {
    if (!focusedJobId) return
    const container = scrollRef.current
    const row = rowRefs.current.get(focusedJobId)
    if (!container || !row) return
    const targetTop = Math.max(0, row.offsetTop - Math.round(container.clientHeight * 0.28))
    container.scrollTo({ top: targetTop, behavior: 'smooth' })
  }, [focusedJobId, group.key])

  const stepFocus = React.useCallback(
    (delta: -1 | 1) => {
      if (!jobs.length) return
      const nextIdx = Math.max(0, Math.min(jobs.length - 1, (focusedIdx < 0 ? 0 : focusedIdx) + delta))
      const next = jobs[nextIdx]
      if (next) onFocusJob(next.id)
    },
    [jobs, focusedIdx, onFocusJob],
  )

  // Keyboard ArrowUp / ArrowDown navigation
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement | null)?.isContentEditable) return
      e.preventDefault()
      stepFocus(e.key === 'ArrowUp' ? -1 : 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [stepFocus])

  const handleReprint = async (job: Job) => {
    await retry.mutateAsync({ id: job.id, in_place: true })
    onFocusJob(job.id)
    if (machineBusy || !canOperate) {
      toast.info('已原地重置为排队中')
      return
    }
    start.mutate({ id: job.id })
  }

  const activeJob = group.activeJob
  const deviatedFromActive = !!activeJob && focusedJobId !== activeJob.id

  return (
    <Card className="flex flex-col overflow-hidden">
      {/* Top navigation bar */}
      <div className="hairline-b flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h3 className="text-headline text-label">任务滚动表</h3>
          <span className="text-footnote text-secondary-label tabular-nums">
            {jobs.length > 0 ? `${focusedIdx + 1} / ${jobs.length}` : '0 / 0'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {deviatedFromActive ? (
            <Button
              size="sm"
              variant="tinted"
              icon={<Crosshair />}
              onClick={() => onFocusJob(activeJob.id)}
            >
              回到当前打印
            </Button>
          ) : null}
          <IconButton
            size="sm"
            variant="gray"
            label="上一个任务 (↑)"
            disabled={focusedIdx <= 0}
            onClick={() => stepFocus(-1)}
          >
            <ArrowUp />
          </IconButton>
          <IconButton
            size="sm"
            variant="gray"
            label="下一个任务 (↓)"
            disabled={focusedIdx < 0 || focusedIdx >= jobs.length - 1}
            onClick={() => stepFocus(1)}
          >
            <ArrowDown />
          </IconButton>
        </div>
      </div>

      {/* Fixed-viewport scrollable list */}
      <div
        ref={scrollRef}
        className="relative flex h-[min(58vh,520px)] min-h-[280px] flex-col divide-y divide-separator/60 overflow-y-auto scroll-smooth"
        role="listbox"
        aria-label="分组任务列表"
      >
        {jobs.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-subheadline text-secondary-label">
            当前分组暂无任务
          </div>
        ) : (
          jobs.map((job, idx) => {
            const isFocused = job.id === (focusedJobId ?? jobs[0]?.id)
            const isActive = job.status === 'running' || job.status === 'paused' || job.status === 'preparing' || job.status === 'stopping'
            const isTerminal = TERMINAL_JOB_STATUSES.includes(job.status)
            const isQueued = job.status === 'queued'
            const Icon = STATUS_ICON[job.status]
            const livePct =
              isActive && progress?.job_id === job.id
                ? progress.percent
                : job.status === 'done'
                  ? 100
                  : (job.percent ?? 0)

            return (
              <div
                key={job.id}
                ref={(el) => setRowRef(job.id, el)}
                role="option"
                aria-selected={isFocused}
                onClick={() => onFocusJob(job.id)}
                className={cn(
                  'group relative flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors',
                  isFocused && 'bg-accent/8 ring-1 ring-inset ring-accent/40',
                  !isFocused && isActive && 'bg-blue/5',
                  !isFocused && !isActive && 'hover:bg-secondary-fill/50',
                  isTerminal && !isFocused && 'opacity-55',
                  isTerminal && isFocused && 'opacity-80',
                )}
              >
                {/* Left focus indicator bar */}
                <span
                  aria-hidden
                  className={cn(
                    'h-8 w-1 shrink-0 rounded-full transition-colors',
                    isActive ? 'bg-accent' : isFocused ? 'bg-accent/60' : 'bg-transparent',
                  )}
                />

                {/* Sequence number & status icon */}
                <div className="flex w-10 shrink-0 items-center gap-1.5">
                  <span className="w-5 text-right text-caption font-medium tabular-nums text-tertiary-label">
                    {job.seq ?? idx + 1}
                  </span>
                  <Icon
                    className={cn(
                      'size-4 shrink-0',
                      job.status === 'done' && 'text-green',
                      job.status === 'failed' && 'text-red',
                      job.status === 'aborted' && 'text-secondary-label',
                      job.status === 'paused' && 'text-orange',
                      (job.status === 'running' || job.status === 'preparing') && 'animate-spin text-accent',
                      job.status === 'queued' && 'text-secondary-label',
                    )}
                    aria-hidden
                  />
                </div>

                {/* Title & metadata */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onFocusJob(job.id)
                        onOpenDetail(job.id)
                      }}
                      className={cn(
                        'focus-ring min-w-0 truncate rounded-sm text-left text-body font-medium hover:underline',
                        isTerminal ? 'text-secondary-label' : 'text-label',
                      )}
                    >
                      {job.name}
                    </button>
                    {isActive ? (
                      <Badge size="sm" tone={job.status === 'paused' ? 'orange' : 'blue'}>
                        {JOB_STATUS_LABEL[job.status]} · {Math.floor(livePct)}%
                      </Badge>
                    ) : null}
                    {job.out_of_work_area ? (
                      <Badge size="sm" tone="orange" icon={TriangleAlert}>
                        超出行程
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-footnote text-secondary-label tabular-nums">
                    {isTerminal ? JOB_STATUS_LABEL[job.status] : '排队中'}
                    {' · '}
                    {job.total_lines.toLocaleString()} 行
                    {job.est_s > 0 ? ` · 约 ${formatDuration(job.est_s)}` : ''}
                  </p>
                </div>

                {/* Row actions (stopPropagation so clicking buttons doesn't hijack) */}
                <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {isTerminal ? (
                    <Button
                      size="sm"
                      variant="gray"
                      icon={<RotateCcw />}
                      loading={(retry.isPending && retry.variables?.id === job.id) || (start.isPending && start.variables?.id === job.id)}
                      onClick={() => void handleReprint(job)}
                    >
                      重新打印
                    </Button>
                  ) : null}

                  {isQueued ? (
                    <>
                      {job.out_of_work_area && !admin ? (
                        <Button size="sm" variant="gray" onClick={() => onOpenDetail(job.id)}>
                          查看原因
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="tinted"
                          icon={<Play />}
                          disabled={machineBusy || !canOperate}
                          loading={start.isPending && start.variables?.id === job.id}
                          onClick={async () => {
                            onFocusJob(job.id)
                            if (await confirmStart(job, machine?.origin_valid)) start.mutate({ id: job.id })
                          }}
                        >
                          开始
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="gray"
                        icon={<Frame />}
                        disabled={machineBusy || !canOperate || !job.bbox}
                        loading={frame.isPending && frame.variables === job.id}
                        onClick={() => frame.mutate(job.id)}
                      >
                        走边框
                      </Button>
                    </>
                  ) : null}

                  <IconButton
                    size="sm"
                    label="查看详情"
                    onClick={() => {
                      onFocusJob(job.id)
                      onOpenDetail(job.id)
                    }}
                  >
                    <Info />
                  </IconButton>
                </div>
              </div>
            )
          })
        )}
      </div>
    </Card>
  )
}
