"""Ordered page results, bounded reuse and real process-worker lifecycle."""
import json
import multiprocessing as mp
import os
import sys
import time
from types import SimpleNamespace

import pytest

from penplot.compose import ComposeError, finish_page
from penplot.geometry import Path
from penplot.page_parallel import PagePool
from penplot.settings import MachineConfig


def jobs(count=6, points=50):
    machine = MachineConfig()
    machine.grbl.type = 'Stepper'
    machine.settings.toolOnDelay = machine.settings.toolOffDelay = 0
    return [(i, i, {'width_mm': 210, 'height_mm': 297},
             [Path([v for n in range(points) for v in (n / 10, i + n % 7)], [0] + [1] * (points - 1))],
             {'missing': {'example'} if i == 2 else set(), 'messages': ['page %d' % i]},
             machine, {'corner': i % 4, 'anchor': 'paper'}, (300, 300), {'optimize': False})
            for i in range(count)]


def snapshot(page):
    return (page.gcode, page.info(), page.origin, page.bounds,
            [(p.coords, p.ops) for p in page.page_paths],
            [(p.coords, p.ops) for p in page.machine_paths],
            [getattr(page.analysis, k) for k in page.analysis.__slots__])


def test_pool_order_and_reuse():
    pool = PagePool(2)
    pids = [proc.pid for proc, _ in pool.children]
    try:
        expected = [snapshot(finish_page(*job)) for job in jobs()]
        for _ in range(2):
            progress = []
            result = pool.map(jobs(), lambda f, m: progress.append(f))
            assert [snapshot(page) for page in result] == expected
            assert [proc.pid for proc, _ in pool.children] == pids
            assert progress == sorted(progress)
            assert progress[-1] == 1.0
    finally:
        pool.close()
    assert not pool.children


def test_page_failure_closes_pool():
    pool = PagePool(2)
    broken = jobs()
    broken[0][2].clear()
    with pytest.raises(ComposeError, match='width_mm'):
        pool.map(broken)
    assert not pool.children


def test_cooperative_cancel_closes_pool():
    pool = PagePool(2)
    class Cancelled(Exception):
        pass
    def progress(*args):
        raise Cancelled()
    with pytest.raises(Cancelled):
        pool.map(jobs(), progress)
    assert not pool.children


def _owner(conn):
    pool = PagePool(2)
    # Receiving a page from each child also proves its watcher has started.
    pool.map(jobs(2))
    conn.send([proc.pid for proc, _ in pool.children])
    conn.recv()


def test_killed_owner_leaves_no_page_workers():
    ctx = mp.get_context('spawn')
    conn, child = ctx.Pipe()
    owner = ctx.Process(target=_owner, args=(child,), daemon=False)
    owner.start()
    child.close()
    handles = []
    try:
        assert conn.poll(20)
        pids = conn.recv()
        if sys.platform == 'win32':
            import _winapi
            handles = [_winapi.OpenProcess(0x100000, False, pid) for pid in pids]
        elif hasattr(os, 'pidfd_open'):
            handles = [os.pidfd_open(pid) for pid in pids]
        else:
            pytest.skip('requires process handles or pidfd to wait without PID reuse races')
        owner.terminate()
        owner.join(5)
        assert not owner.is_alive()
        if sys.platform == 'win32':
            for handle in handles:
                assert _winapi.WaitForSingleObject(handle, 5000) == 0
        else:
            from multiprocessing.connection import wait
            deadline = time.monotonic() + 5
            for pid, handle in zip(pids, handles):
                assert wait([handle], timeout=max(0, deadline - time.monotonic())), (
                    f'Page worker {pid} did not exit after its owner terminated'
                )
    finally:
        if owner.is_alive():
            owner.terminate()
        owner.join(5)
        owner.close()
        conn.close()
        for handle in handles:
            if sys.platform == 'win32':
                _winapi.CloseHandle(handle)
            else:
                os.close(handle)


def render_args(directory, count=4, points=5500):
    pages = [{'elements': [{'type': 'shape', 'props': {
        'kind': 'line', 'points': [[n / 100, (n + i) % 100] for n in range(points)]}}]}
        for i in range(count)]
    return {'doc': {'pages': pages}, 'papers': [{'width_mm': 210, 'height_mm': 297}] * count,
            'profile_doc': {'type': 'Grbl', 'grbl': {'type': 'Stepper'},
                            'settings': {'toolOnDelay': 0, 'toolOffDelay': 0}},
            'project_print': {'optimize': False}, 'rid': 'process-test', 'out_dir': str(directory)}


@pytest.mark.parametrize('native', ['0', '1'])
def test_actual_taskrunner_process_mode(tmp_path, monkeypatch, native):
    if (os.cpu_count() or 1) < 2:
        pytest.skip('parallel execution needs two CPUs')
    from penplot.web.tasks.runner import TaskRunner
    from penplot.web.tasks.kinds import _render_project
    monkeypatch.setenv('PENPLOT_NATIVE_GENERATION', native)
    monkeypatch.setenv('PENPLOT_PAGE_WORKERS', '2')
    runner = TaskRunner(SimpleNamespace(), workers=1, mode='process')
    runner.start()
    try:
        task = runner.submit('render_project', render_args(tmp_path / 'parallel'))
        assert task.done_ev.wait(30)
        assert task.state == 'done', task.error
        assert task.proc.daemon is False
        pid = task.proc.pid
        again = runner.submit('render_project', render_args(tmp_path / 'again'))
        assert again.done_ev.wait(30)
        assert again.state == 'done', again.error
        assert again.proc.pid == pid
        monkeypatch.setenv('PENPLOT_PAGE_WORKERS', '1')
        serial = _render_project(render_args(tmp_path / 'serial'), lambda *args: None)
        assert task.result['pages'] == serial['pages']
        for index in range(4):
            for suffix in ('gcode', 'page.bin', 'machine.bin'):
                name = 'page-%d.%s' % (index, suffix)
                assert (tmp_path / 'parallel' / name).read_bytes() == (tmp_path / 'serial' / name).read_bytes()
        assert json.loads((tmp_path / 'parallel' / 'meta.json').read_text()) == json.loads(
            (tmp_path / 'serial' / 'meta.json').read_text())
    finally:
        runner.stop()


def test_taskrunner_cancel_during_parallel_pages(tmp_path, monkeypatch):
    import threading
    from penplot.web.tasks.runner import TaskRunner
    monkeypatch.setenv('PENPLOT_NATIVE_GENERATION', '0')
    monkeypatch.setenv('PENPLOT_PAGE_WORKERS', '2')
    finishing = threading.Event()
    class Bus:
        def publish_threadsafe(self, channel, data):
            if data['state'] == 'running' and data['message'].startswith('已完成'):
                finishing.set()
    runner = TaskRunner(SimpleNamespace(bus=Bus()), workers=1, mode='process')
    runner.start()
    try:
        task = runner.submit('render_project', render_args(tmp_path / 'cancel', 24, 10000))
        assert finishing.wait(20)
        assert task.state == 'running'
        runner.cancel(task.id)
        assert task.done_ev.wait(10)
        assert task.state == 'cancelled'
        assert not task.proc.is_alive()
        assert not (tmp_path / 'cancel' / 'result.json').exists()
    finally:
        runner.stop()


def test_native_threads_are_conditional(monkeypatch):
    from penplot import page_parallel as parallel
    from penplot.native_generated import native_available
    monkeypatch.setenv('PENPLOT_PAGE_WORKERS', '2')
    work = jobs(4, 5500)
    monkeypatch.setenv('PENPLOT_NATIVE_GENERATION', '0')
    assert not parallel._native_jobs(work)
    monkeypatch.setenv('PENPLOT_NATIVE_GENERATION', '1')
    if not native_available():
        return
    assert parallel._native_jobs(work)
    expected = [snapshot(finish_page(*job)) for job in jobs(4, 5500)]
    def no_process_pool(*args):
        raise AssertionError('native pages should not be copied to processes')
    monkeypatch.setattr(parallel, 'PagePool', no_process_pool)
    actual = parallel.finish_pages(work)
    assert [snapshot(page) for page in actual] == expected


def test_small_document_stays_serial(monkeypatch):
    from penplot import page_parallel as parallel
    monkeypatch.setattr(parallel, 'PagePool', lambda *args: pytest.fail('small document spawned a process'))
    assert len(parallel.finish_pages(jobs(2))) == 2
