import { ACTIVE_JOB_STATUSES, type Job, type JobProgress } from '@/api/types'

export interface JobGroup {
  key: string
  batchId: string | null
  title: string
  jobs: Job[]
  createdAt: number
  doneCount: number
  totalCount: number
  queuedCount: number
  activeJob: Job | null
  nextQueuedJob: Job | null
  overallPercent: number
  totalElapsedSec: number
  totalRemainingSec: number | null
}

const PAGE_SUFFIX_RE = /(?:\s*[-·]?\s*第\s*\d+\s*页|\s*\(\d+\)|\s*#\d+)$/

function deriveGroupTitle(jobs: Job[]): string {
  const cleaned = jobs.map((j) => j.name.replace(PAGE_SUFFIX_RE, '').trim()).filter(Boolean)
  if (cleaned.length === 0) return jobs[0]?.name || '未命名任务'
  if (cleaned.length === 1) return cleaned[0]
  // Find longest common prefix among cleaned names
  let prefix = cleaned[0]
  for (let i = 1; i < cleaned.length; i++) {
    const s = cleaned[i]
    let k = 0
    while (k < prefix.length && k < s.length && prefix[k] === s[k]) k++
    prefix = prefix.slice(0, k)
    if (!prefix) break
  }
  const trimmed = prefix.replace(/[\s\-·_(/#]+$/, '').trim()
  return trimmed.length >= 2 ? trimmed : cleaned[0]
}

function compareJobsFixedOrder(a: Job, b: Job): number {
  const seqDiff = (a.seq ?? 0) - (b.seq ?? 0)
  if (seqDiff !== 0) return seqDiff
  const timeDiff = a.created_at - b.created_at
  if (timeDiff !== 0) return timeDiff
  return a.id.localeCompare(b.id)
}

function effectiveJobPercent(job: Job, liveProgress?: JobProgress | null): number {
  if (job.status === 'done') return 100
  if (!ACTIVE_JOB_STATUSES.includes(job.status)) return 0
  if (liveProgress && liveProgress.job_id === job.id) {
    return Math.max(0, Math.min(100, liveProgress.percent))
  }
  if (typeof job.percent === 'number' && Number.isFinite(job.percent)) {
    return Math.max(0, Math.min(100, job.percent))
  }
  if (job.total_lines > 0) {
    return Math.max(0, Math.min(100, (100 * (job.acked_line ?? 0)) / job.total_lines))
  }
  return 0
}

function effectiveElapsed(job: Job, liveProgress?: JobProgress | null): number {
  if (liveProgress && liveProgress.job_id === job.id && Number.isFinite(liveProgress.elapsed_s)) {
    return Math.max(0, liveProgress.elapsed_s)
  }
  if (job.started_at && job.finished_at) {
    return Math.max(0, job.finished_at - job.started_at)
  }
  return Math.max(0, job.elapsed_s ?? 0)
}

function effectiveEta(job: Job, liveProgress?: JobProgress | null): number | null {
  if (!ACTIVE_JOB_STATUSES.includes(job.status)) return null
  if (liveProgress && liveProgress.job_id === job.id && liveProgress.eta_s != null && Number.isFinite(liveProgress.eta_s)) {
    return Math.max(0, liveProgress.eta_s)
  }
  if (job.eta_s != null && Number.isFinite(job.eta_s)) {
    return Math.max(0, job.eta_s)
  }
  if (job.est_s > 0) {
    const elapsed = effectiveElapsed(job, liveProgress)
    return Math.max(0, job.est_s - elapsed)
  }
  return null
}

/**
 * Group jobs by send batch (`batch_id`, falling back to `source.render_id` or `solo:<id>`).
 * Groups are ordered by latest send time descending; jobs within each group are strictly
 * fixed in `seq -> created_at -> id` ascending order regardless of status changes or retries.
 */
export function groupJobsBySend(
  jobs: Job[],
  live?: { job?: Job | null; progress?: JobProgress | null },
): JobGroup[] {
  const buckets = new Map<string, { batchId: string | null; jobs: Job[] }>()

  for (const job of jobs) {
    const merged = live?.job && live.job.id === job.id ? live.job : job
    let key: string
    let batchId: string | null = null
    if (merged.batch_id) {
      key = `batch:${merged.batch_id}`
      batchId = merged.batch_id
    } else if (merged.source?.render_id) {
      key = `render:${merged.source.render_id}`
    } else {
      key = `solo:${merged.id}`
    }

    const existing = buckets.get(key)
    if (existing) {
      existing.jobs.push(merged)
    } else {
      buckets.set(key, { batchId, jobs: [merged] })
    }
  }

  const groups: JobGroup[] = []
  const liveProgress = live?.progress ?? null

  for (const [key, bucket] of buckets.entries()) {
    const sorted = bucket.jobs.slice().sort(compareJobsFixedOrder)
    let createdAt = 0
    let doneCount = 0
    let queuedCount = 0
    let activeJob: Job | null = null
    let nextQueuedJob: Job | null = null
    let totalWeight = 0
    let doneWeight = 0
    let totalElapsedSec = 0
    let remainingSum = 0
    let hasRemainingEstimate = false

    for (const j of sorted) {
      if (j.created_at > createdAt) createdAt = j.created_at
      if (j.status === 'done') doneCount++
      if (j.status === 'queued') {
        queuedCount++
        if (!nextQueuedJob) nextQueuedJob = j
      }
      if (!activeJob && ACTIVE_JOB_STATUSES.includes(j.status)) {
        activeJob = j
      }

      const weight = j.total_lines > 0 ? j.total_lines : j.est_s > 0 ? j.est_s : 1
      const pct = effectiveJobPercent(j, liveProgress)
      totalWeight += weight
      doneWeight += weight * (pct / 100)
      totalElapsedSec += effectiveElapsed(j, liveProgress)

      if (ACTIVE_JOB_STATUSES.includes(j.status)) {
        const eta = effectiveEta(j, liveProgress)
        if (eta != null) {
          remainingSum += eta
          hasRemainingEstimate = true
        }
      } else if (j.status === 'queued' && j.est_s > 0) {
        remainingSum += j.est_s
        hasRemainingEstimate = true
      }
    }

    const overallPercent = totalWeight > 0 ? Math.max(0, Math.min(100, (doneWeight / totalWeight) * 100)) : 0
    const totalRemainingSec =
      activeJob || queuedCount > 0 ? (hasRemainingEstimate ? remainingSum : null) : 0

    groups.push({
      key,
      batchId: bucket.batchId,
      title: deriveGroupTitle(sorted),
      jobs: sorted,
      createdAt,
      doneCount,
      totalCount: sorted.length,
      queuedCount,
      activeJob,
      nextQueuedJob,
      overallPercent,
      totalElapsedSec,
      totalRemainingSec,
    })
  }

  groups.sort((a, b) => b.createdAt - a.createdAt)
  return groups
}
