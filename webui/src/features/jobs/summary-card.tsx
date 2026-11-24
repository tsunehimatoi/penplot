import {
  ChevronDown, CirclePlay, Hand, Pause, Play, RotateCcw, Square, TriangleAlert,
} from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { useRole } from '@/api/collab'
import { useJobActions } from '@/api/jobs'
import { pauseJob, resumeJob } from '@/api/machine'
import { isJobActive, useLive } from '@/api/store'
import { TERMINAL_JOB_STATUSES, type Job } from '@/api/types'
import { useWsEvent } from '@/api/ws'
import { confirmStopJob } from '@/app/job-actions'
import {
  Badge, Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, ProgressBar, ProgressRing,
} from '@/components/ui'
import { explainGrblLine } from '@/features/console/grbl-codes'
import { runAction } from '@/features/machine/errors'
import { useMachineGate } from '@/features/machine/gate'
import { cn } from '@/lib/cn'
import { formatDuration, formatDurationSpoken, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import type { JobGroup } from './grouping'
import { PaperSlipped } from './paper-slipped'
import { confirmStart } from './queue-card'
import { JobStatusBadge } from './shared'

function useTrail(jobId: string | null) {
  const [trail, setTrail] = React.useState<{ id: string | null; pts: [number, number, boolean][] }>({ id: null, pts: [] })
  React.useEffect(() => {
    setTrail({ id: jobId, pts: [] })
  }, [jobId])
  useWsEvent('progress', (p) => {
    if (!jobId || p.job_id !== jobId || !p.wpos) return
    const [x, y, z] = p.wpos
    setTrail((t) => (t.id !== jobId ? t : { id: jobId, pts: [...t.pts.slice(-3000), [x, y, (z ?? 0) > 0.5]] }))
  })
  return trail.pts
}

function LiveTrack({ job }: { job: Job }) {
  const pts = useTrail(job.id)
  const wpos = useLive((s) => s.progress?.wpos ?? s.machine?.wpos ?? null)
  const bb = job.bbox && job.bbox.length === 4 ? job.bbox : null
  if (!bb) return null
  const [x0, y0, x1, y1] = bb
  const w = Math.max(1, x1 - x0)
  const h = Math.max(1, y1 - y0)
  const pad = Math.max(w, h) * 0.05
  const segs: string[] = []
  let cur = ''
  for (const [x, y, down] of pts) {
    if (down) cur += `${cur ? 'L' : 'M'}${(x - x0).toFixed(2)} ${(y1 - y).toFixed(2)}`
    else if (cur) {
      segs.push(cur)
      cur = ''
    }
  }
  if (cur) segs.push(cur)
  return (
    <svg viewBox={`${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`} className="h-full max-h-48 w-full" role="img" aria-label="实时笔迹">
      <rect x={0} y={0} width={w} height={h} rx={1} className="fill-canvas-paper stroke-separator" strokeWidth={Math.max(w, h) / 300} />
      {segs.map((d, i) => (
        <path key={i} d={d} fill="none" className="stroke-ink" strokeWidth={Math.max(w, h) / 220} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {wpos ? (
        <circle cx={wpos[0] - x0} cy={y1 - wpos[1]} r={Math.max(w, h) / 70} className="fill-accent stroke-bg-elevated" strokeWidth={Math.max(w, h) / 300} />
      ) : null}
    </svg>
  )
}

function Stat({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-footnote text-secondary-label">{label}</span>
      <span className={cn('truncate text-body font-semibold tabular-nums text-label', mono && 'font-mono')}>{value}</span>
    </div>
  )
}

function formatFinishClock(etaSec: number | null, paused: boolean): string | null {
  if (etaSec == null || !Number.isFinite(etaSec) || paused || etaSec <= 0) return null
  return new Date(Date.now() + etaSec * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

export interface SummaryCardProps {
  group: JobGroup
  focusedJob: Job | null
  compact?: boolean
  onOpenDetail?: (jobId: string) => void
}

export function SummaryCard({ group, focusedJob, compact, onOpenDetail }: SummaryCardProps) {
  const { start, retry } = useJobActions()
  const { liveJob, progress, machine, firmwareErrors } = useLive(
    useShallow((s) => ({
      liveJob: s.job,
      progress: s.progress,
      machine: s.machine,
      firmwareErrors: s.firmwareErrors,
    })),
  )
  const blocked = useMachineGate().leaseBlocked
  const admin = useRole() === 'admin'
  const machineBusy = isJobActive(liveJob)
  const canOperate = !!machine?.connected && !blocked

  const targetJob = focusedJob ?? group.activeJob ?? group.nextQueuedJob ?? group.jobs[0] ?? null
  const isTargetLive = !!targetJob && liveJob?.id === targetJob.id && isJobActive(liveJob)
  const job = isTargetLive && liveJob ? liveJob : targetJob

  const overallPct = Math.round(group.overallPercent)
  const groupAllDone = group.totalCount > 0 && group.doneCount === group.totalCount
  const groupFinishClock = formatFinishClock(group.totalRemainingSec, group.activeJob?.status === 'paused')

  const jobPct = job
    ? isTargetLive && progress?.job_id === job.id
      ? progress.percent
      : job.status === 'done'
        ? 100
        : (job.percent ?? (job.total_lines ? (100 * (job.acked_line ?? 0)) / job.total_lines : 0))
    : 0
  const acked = job ? (isTargetLive && progress?.job_id === job.id ? progress.line_acked : (job.acked_line ?? 0)) : 0
  const totalLines = job ? (isTargetLive && progress?.job_id === job.id ? progress.total : job.total_lines) : 0
  const elapsed = job ? (isTargetLive && progress?.job_id === job.id ? progress.elapsed_s : (job.elapsed_s ?? 0)) : 0
  const eta = job
    ? isTargetLive && progress?.job_id === job.id
      ? (progress.eta_s ?? job.eta_s ?? null)
      : (job.eta_s ?? (job.status === 'queued' && job.est_s > 0 ? job.est_s : null))
    : null
  const wpos = isTargetLive ? (progress?.wpos ?? machine?.wpos ?? null) : (machine?.wpos ?? null)
  const isRunning = job?.status === 'running'
  const isPaused = job?.status === 'paused'
  const isStopping = job?.status === 'stopping'
  const isPreparing = job?.status === 'preparing'
  const isActive = isRunning || isPaused || isStopping || isPreparing
  const isQueued = job?.status === 'queued'
  const isTerminal = !!job && TERMINAL_JOB_STATUSES.includes(job.status)
  const jobFinishClock = formatFinishClock(eta, isPaused)

  const errors = job
    ? [
        ...(job.errors ?? []).map((e) => ({ line: e.line, reply: e.reply, cmd: e.cmd })),
        ...firmwareErrors
          .filter((e) => e.job_id === job.id && !(job.errors ?? []).some((x) => x.line === e.line))
          .map((e) => ({ line: e.line, reply: e.reply, cmd: e.cmd })),
      ]
    : []

  const ringTone = isPaused ? 'orange' : job?.status === 'failed' ? 'red' : job?.status === 'done' ? 'green' : 'accent'
  const btnSize = compact ? 'lg' : 'md'

  const handleReprint = async (j: Job) => {
    await retry.mutateAsync({ id: j.id, in_place: true })
    if (machineBusy || !canOperate) {
      toast.info('已原地重置为排队中')
      return
    }
    start.mutate({ id: j.id })
  }

  return (
    <Card className="overflow-hidden">
      {/* 1. Overall Group Progress */}
      <div className="hairline-b flex flex-col gap-2.5 bg-secondary-fill/40 px-4 py-3.5 md:px-5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-headline text-label" title={group.title}>
              {group.title}
            </h2>
            <p className="text-footnote text-secondary-label tabular-nums">
              已完成 {group.doneCount} / {group.totalCount} 项
              {group.totalRemainingSec != null && group.totalRemainingSec > 0 ? (
                <>
                  {' · '}总剩余 {formatDuration(group.totalRemainingSec)}
                  {groupFinishClock ? `（预计 ${groupFinishClock} 完成）` : ''}
                </>
              ) : groupAllDone ? (
                ' · 本组已全部完成'
              ) : null}
            </p>
          </div>
          <span className="shrink-0 text-title3 font-semibold tabular-nums text-label">{overallPct}%</span>
        </div>
        <ProgressBar
          value={group.overallPercent}
          tone={groupAllDone ? 'green' : group.activeJob?.status === 'paused' ? 'orange' : 'accent'}
          label="分组总进度"
          valueText={`已完成 ${overallPct}%`}
          className="h-2"
        />
      </div>

      {/* 2. Focused / Active Job Progress & Controls */}
      {job ? (
        <div className="flex flex-col gap-4 p-4 md:p-5">
          <div className={cn('flex gap-4', compact ? 'flex-col' : 'flex-row items-start')}>
            <div className="flex items-center gap-4">
              <ProgressRing
                value={jobPct}
                size={compact ? 96 : 112}
                stroke={9}
                tone={ringTone}
                label="当前任务进度"
                valueText={`${Math.floor(jobPct)}%，剩余${formatDurationSpoken(eta)}`}
              >
                <div className="flex flex-col items-center">
                  <span className="text-title2 font-semibold tabular-nums text-label">{Math.floor(jobPct)}%</span>
                  <span className="text-caption text-secondary-label">
                    {isPaused ? '已暂停' : jobFinishClock ? `${jobFinishClock}` : job.status === 'done' ? '已完成' : isQueued ? '待打印' : '进行中'}
                  </span>
                </div>
              </ProgressRing>
              {compact && isActive && job.bbox ? (
                <div className="min-w-0 flex-1 rounded-md bg-quaternary-fill p-1.5">
                  <LiveTrack job={job} />
                </div>
              ) : null}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {onOpenDetail ? (
                  <button
                    type="button"
                    onClick={() => onOpenDetail(job.id)}
                    className="focus-ring min-w-0 truncate rounded-sm text-left text-title3 text-label hover:underline"
                  >
                    {job.seq ? `#${job.seq} · ` : ''}
                    {job.name}
                  </button>
                ) : (
                  <Link to={`/jobs/${job.id}`} className="min-w-0 truncate text-title3 text-label hover:underline">
                    {job.seq ? `#${job.seq} · ` : ''}
                    {job.name}
                  </Link>
                )}
                <JobStatusBadge job={job} />
                {isPaused && job.pause_mode === 'hold' ? <Badge tone="orange">马上停住 · 笔可能还在纸上</Badge> : null}
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <Stat label="行数" value={`${acked.toLocaleString()} / ${totalLines.toLocaleString()}`} />
                <Stat label="已用时间" value={formatDuration(elapsed)} />
                <Stat label="预计剩余" value={isPaused ? '—' : formatDuration(eta)} />
                <Stat label="实时笔位置" mono value={wpos ? `${formatNumber(wpos[0], 1)}, ${formatNumber(wpos[1], 1)}` : '—'} />
              </div>

              {/* 3. Action Buttons */}
              <div className={cn('flex flex-wrap gap-2', compact && 'grid grid-cols-2')}>
                {isRunning ? (
                  <>
                    <div className="flex">
                      <Button
                        size={btnSize}
                        variant="filled"
                        icon={<Pause />}
                        className="flex-1 rounded-r-none"
                        disabled={blocked}
                        onClick={() => runAction('暂停任务失败', () => pauseJob(job, 'soft'))}
                      >
                        暂停
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size={btnSize}
                            variant="filled"
                            className="rounded-l-none border-l border-white/25 px-2"
                            aria-label="暂停方式"
                            disabled={blocked}
                          >
                            <ChevronDown />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="max-w-80">
                          <DropdownMenuItem icon={<Pause />} onSelect={() => runAction('暂停任务失败', () => pauseJob(job, 'soft'))}>
                            <div className="flex flex-col">
                              <span>写完这一笔再停（推荐）</span>
                              <span className="text-footnote opacity-80">几秒后停下并抬笔</span>
                            </div>
                          </DropdownMenuItem>
                          <DropdownMenuItem icon={<Hand />} onSelect={() => runAction('暂停任务失败', () => pauseJob(job, 'hold'))}>
                            <div className="flex flex-col">
                              <span>马上停住</span>
                              <span className="text-footnote opacity-80">笔可能停在纸上洇墨</span>
                            </div>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <Button size={btnSize} variant="gray" icon={<Square />} disabled={blocked} onClick={() => confirmStopJob(job)}>
                      停止
                    </Button>
                  </>
                ) : isPaused ? (
                  <>
                    <Button size={btnSize} variant="filled" icon={<Play />} disabled={blocked} onClick={() => runAction('恢复任务失败', () => resumeJob(job))}>
                      恢复
                    </Button>
                    <Button size={btnSize} variant="gray" icon={<Square />} disabled={blocked} onClick={() => confirmStopJob(job)}>
                      停止
                    </Button>
                  </>
                ) : isActive ? (
                  <Button size={btnSize} variant="gray" icon={<Square />} disabled={blocked || isStopping} onClick={() => confirmStopJob(job)}>
                    {isStopping ? '正在停止…' : '停止'}
                  </Button>
                ) : isQueued ? (
                  job.out_of_work_area && !admin ? (
                    <Button asChild size={btnSize} variant="gray">
                      <Link to={`/jobs/${job.id}`}>超出行程 · 查看原因</Link>
                    </Button>
                  ) : (
                    <Button
                      size={btnSize}
                      variant="filled"
                      icon={<Play />}
                      disabled={machineBusy || !canOperate}
                      loading={start.isPending && start.variables?.id === job.id}
                      onClick={async () => {
                        if (await confirmStart(job, machine?.origin_valid)) start.mutate({ id: job.id })
                      }}
                    >
                      开始打印
                    </Button>
                  )
                ) : isTerminal ? (
                  <Button
                    size={btnSize}
                    variant="filled"
                    icon={<RotateCcw />}
                    loading={(retry.isPending && retry.variables?.id === job.id) || (start.isPending && start.variables?.id === job.id)}
                    onClick={() => void handleReprint(job)}
                  >
                    重新打印
                  </Button>
                ) : null}
              </div>

              {isQueued && (!machine?.connected || blocked || machineBusy) ? (
                <p className="text-footnote text-secondary-label">
                  {!machine?.connected
                    ? '写字机未连接，先到「控制」页连接后再开始打印。'
                    : blocked
                      ? '控制权在别人手里，暂时无法操作。'
                      : '当前有其他任务正在运行，完成后可开始此任务。'}
                </p>
              ) : null}

              {isPaused ? <PaperSlipped job={job} disabled={blocked} /> : null}
            </div>
          </div>

          {!compact && isActive && job.bbox ? (
            <div className="flex items-center justify-center rounded-md bg-quaternary-fill p-2">
              <LiveTrack job={job} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
          <CirclePlay className="size-8 text-tertiary-label" />
          <p className="text-body text-secondary-label">当前分组没有任务</p>
        </div>
      )}

      {errors.length > 0 ? (
        <div className="hairline-t flex flex-col gap-1 bg-red/5 px-4 py-3 md:px-5" role="alert">
          <p className="flex items-center gap-1.5 text-footnote font-semibold text-on-tint-red">
            <TriangleAlert className="size-3.5" /> 控制板报错 {errors.length} 次
          </p>
          {errors.slice(0, 3).map((e, i) => {
            const x = explainGrblLine(e.reply)
            return (
              <p key={i} className="truncate text-footnote text-secondary-label">
                第 {e.line ?? '?'} 行的命令没有被执行{x ? `：${x.title}` : ''}
              </p>
            )
          })}
        </div>
      ) : null}
    </Card>
  )
}
