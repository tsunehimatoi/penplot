"""Bounded, reusable page processes; no executor queues or unowned grandchildren.

Only finish_page runs here. Pagination and result publication stay in the caller.
Each child has one in-flight page and watches its parent sentinel, so terminating
a TaskRunner worker also terminates its page workers (including idle ones).
"""
import multiprocessing as mp
from concurrent.futures import ThreadPoolExecutor, wait as wait_futures, FIRST_COMPLETED
from multiprocessing.connection import wait
from multiprocessing.util import Finalize
import os
import sys
import threading


def watch_parent():
    """Exit even when a parent is killed before it can run its cleanup hooks."""
    parent = mp.parent_process()
    if parent is None:
        return

    def exited():
        wait([parent.sentinel])
        os._exit(0)

    threading.Thread(target=exited, name='parent-lifetime', daemon=True).start()


def _page_main(conn):
    watch_parent()
    from .web.tasks.worker import _sandbox
    _sandbox()
    from .compose import finish_page
    try:
        while True:
            args = conn.recv()
            if args is None:
                return
            try:
                result = finish_page(*args)
                conn.send(('result', result))
            except BaseException as exc:
                # ComposeError is not pickle-reconstructible from Exception.args.
                # Preserve its public error contract explicitly.
                code = 'out_of_memory' if isinstance(exc, MemoryError) else 'task_failed'
                conn.send(('error', (getattr(exc, 'code', None) or code,
                                     str(exc) or type(exc).__name__, getattr(exc, 'detail', None))))
    except (EOFError, BrokenPipeError, OSError):
        return
    finally:
        conn.close()


def _stop_children(children):
    # Terminate all first; then reap, so cleanup time is not N task durations.
    for proc, conn in children:
        conn.close()
        if proc.is_alive():
            proc.terminate()
    for proc, _ in children:
        proc.join(2)
        if proc.is_alive():
            proc.kill()
            proc.join()
        proc.close()
    children.clear()


class PagePool:
    def __init__(self, workers=2):
        self.children = []
        self._finalize = Finalize(self, _stop_children, (self.children,), exitpriority=20)
        # spawn is also the supported Windows PyInstaller entrypoint protocol.
        # forkserver avoids forking the server's application threads on Unix.
        method = 'spawn' if sys.platform == 'win32' else 'forkserver'
        ctx = mp.get_context(method)
        try:
            for _ in range(workers):
                conn, child = ctx.Pipe()
                proc = ctx.Process(target=_page_main, args=(child,), daemon=True)
                try:
                    proc.start()
                except BaseException:
                    conn.close()
                    raise
                finally:
                    child.close()
                self.children.append((proc, conn))
        except BaseException:
            self.close()
            raise

    def close(self):
        self._finalize()

    def map(self, jobs, progress=None):
        """Return page-order results, report completion order, abort on any error."""
        from .compose import ComposeError
        count = len(jobs)
        results = [None] * count
        pending = {}
        next_job = done = 0
        try:
            for proc, conn in self.children:
                if next_job >= count:
                    break
                conn.send(jobs[next_job])
                pending[conn] = (next_job, proc)
                next_job += 1
            while pending:
                ready = wait(list(pending) + [p.sentinel for _, p in pending.values()], timeout=0.1)
                if not ready:
                    # Thread-mode tasks cancel cooperatively via this callback;
                    # process mode cancels by killing the parent (watch_parent).
                    if progress:
                        progress(0.6 + 0.4 * done / count, '已完成 %d / %d 页' % (done, count))
                    continue
                for conn, (index, proc) in list(pending.items()):
                    if conn not in ready:
                        if proc.sentinel in ready:
                            raise ComposeError('page_worker_crashed', '页面处理进程异常退出')
                        continue
                    try:
                        kind, value = conn.recv()
                    except (EOFError, OSError) as exc:
                        raise ComposeError('page_worker_crashed', '页面处理进程异常退出') from exc
                    if kind == 'error':
                        raise ComposeError(*value)
                    results[index] = value
                    del pending[conn]
                    done += 1
                    if progress:
                        progress(0.6 + 0.4 * done / count, '已完成 %d / %d 页' % (done, count))
                    if next_job < count:
                        conn.send(jobs[next_job])
                        pending[conn] = (next_job, proc)
                        next_job += 1
            return results
        except BaseException:
            self.close()
            raise


_pool = None
_pool_lock = threading.Lock()
_worker_limit = 2


def configure(workers):
    """TaskRunner divides the CPU budget across its concurrent task workers."""
    global _worker_limit
    _worker_limit = max(1, min(2, int(workers)))


def close_pool():
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def _native_jobs(jobs):
    # Query the generator itself rather than duplicating its evolving profile
    # validation rules. Empty emission is tiny and checks ABI + actual settings.
    from .native_generated import try_generate
    seen = set()
    for job in jobs:
        machine = job[5]
        if id(machine) not in seen:
            if try_generate([], machine) is None:
                return False
            seen.add(id(machine))
        # Python path ordering/simplification can dominate and holds the GIL.
        if job[8].get('optimize') or job[8].get('simplify'):
            return False
    return True


def _thread_pages(jobs, workers, progress):
    """Only used with a working CDLL generator, whose calls release the GIL."""
    from .compose import finish_page
    results = [None] * len(jobs)
    next_job = done = 0
    pending = {}
    # Bound submissions as for the process pool. On cooperative cancellation,
    # wait for at most the currently running pages; there are no queued pages.
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix='finish-page') as pool:
        for _ in range(min(workers, len(jobs))):
            pending[pool.submit(finish_page, *jobs[next_job])] = next_job
            next_job += 1
        while pending:
            ready, _ = wait_futures(pending, timeout=0.1, return_when=FIRST_COMPLETED)
            if not ready and progress:
                progress(0.6 + 0.4 * done / len(jobs), '已完成 %d / %d 页' % (done, len(jobs)))
            for future in ready:
                index = pending.pop(future)
                results[index] = future.result()
                done += 1
                if progress:
                    progress(0.6 + 0.4 * done / len(jobs), '已完成 %d / %d 页' % (done, len(jobs)))
                if next_job < len(jobs):
                    pending[pool.submit(finish_page, *jobs[next_job])] = next_job
                    next_job += 1
    return results


def finish_pages(jobs, progress=None):
    """Dispatch substantial multi-page renders; small documents stay serial.

    PENPLOT_PAGE_WORKERS=1 explicitly selects serial operation for comparison.
    A compatible native generator uses GIL-releasing threads without copying
    page graphs. Pure Python uses processes. Daemon callers and unsupported
    frozen POSIX executables retain serial fallback when native is unavailable.
    """
    from .compose import finish_page
    global _pool
    try:
        requested = int(os.environ.get('PENPLOT_PAGE_WORKERS', _worker_limit))
    except ValueError:
        requested = _worker_limit
    workers = min(_worker_limit, max(1, requested), os.cpu_count() or 1)
    substantial = len(jobs) >= 4 and sum(len(p.ops) for job in jobs for p in job[3]) >= 20000
    if workers >= 2 and substantial and _native_jobs(jobs):
        return _thread_pages(jobs, workers, progress)
    if (workers < 2 or not substantial or mp.current_process().daemon
            or (getattr(sys, 'frozen', False) and sys.platform != 'win32')):
        results = []
        for i, job in enumerate(jobs):
            results.append(finish_page(*job))
            if progress:
                progress(0.6 + 0.4 * (i + 1) / len(jobs), '已完成 %d / %d 页' % (i + 1, len(jobs)))
        return results
    # A worker serves one task at a time; the lock also protects direct callers
    # in debug/thread mode. They do not each create another page pool.
    with _pool_lock:
        if _pool is None or not _pool.children:
            _pool = PagePool(workers)
        return _pool.map(jobs, progress)
