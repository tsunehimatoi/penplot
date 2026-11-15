"""History/queue cleanup without a serial connection or real machine."""
import asyncio
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from penplot.web import errors
from penplot.web.db import DB
from penplot.web.events import EventBus
from penplot.web.machine.jobs import JobService
from penplot.web.routers import jobs, render
from penplot.web.tasks.runner import REUSE_DONE_S, Task, TaskRunner


@pytest.fixture
def cleanup(tmp_path):
    bus = EventBus()
    # Synchronous delivery makes event ordering assertions deterministic.
    bus.publish_threadsafe = bus.publish
    db = DB(':memory:')
    db.migrate()
    ctx = SimpleNamespace(db=db, bus=bus, cfg=SimpleNamespace(jobs_dir=str(tmp_path / 'jobs')))
    ctx.tasks = TaskRunner(ctx, mode='thread')
    ctx.jobs = JobService(ctx)
    app = FastAPI()
    app.state.ctx = ctx
    errors.install(app)
    app.include_router(render.router, prefix='/api/v1')
    app.include_router(jobs.router, prefix='/api/v1')
    with TestClient(app) as client:
        yield client, ctx
    db.close()


def task(ctx, state='done', result=None):
    t = Task('render_text')
    ctx.tasks.tasks[t.id] = t
    if state in ('done', 'failed', 'cancelled'):
        ctx.tasks._done(t, state, result=result)
    else:
        t.state = state
    return t


def job(ctx, jid, state):
    ctx.db.execute("INSERT INTO jobs(id,name,source,profile_snapshot,status,created_at) VALUES(?,?,?,?,?,?)",
                   (jid, jid, '{}', '{}', state, time.time()))


def test_clear_tasks_selection_result_retention_and_ws(cleanup, tmp_path):
    client, ctx = cleanup
    sub = ctx.bus.subscribe({'task'})
    output = tmp_path / 'result.json'
    output.write_text('{}')
    done = task(ctx, result={'rid': 'render-stays'})
    failed = task(ctx, 'failed')
    running = task(ctx, 'running')
    queued = task(ctx, 'queued')
    response = client.post('/api/v1/tasks/clear', json={'ids': [done.id, running.id, 'missing', done.id]})
    assert response.json() == {'removed_ids': [done.id], 'skipped_ids': [running.id, 'missing']}
    assert {t['id'] for t in client.get('/api/v1/tasks').json()} == {failed.id, running.id, queued.id}
    assert client.get('/api/v1/tasks/' + done.id).json()['result'] == {'rid': 'render-stays'}
    assert asyncio.run(ctx.tasks.wait(done, 0)) == {'rid': 'render-stays'}
    assert output.exists()
    events = sub.drain()
    assert events[-1]['type'] == 'tasks_cleared'
    assert events[-1]['data'] == {'removed_ids': [done.id]}
    assert client.post('/api/v1/tasks/clear', json={'ids': []}).json()['removed_ids'] == []
    assert client.post('/api/v1/tasks/clear', json={}).json()['removed_ids'] == [failed.id]
    assert running.cancel_flag is False and queued.state == 'queued'


def test_clear_tasks_retained_under_load_then_expire(cleanup, monkeypatch):
    _, ctx = cleanup
    first = task(ctx)
    ctx.tasks.clear([first.id])
    for _ in range(210):
        task(ctx)
    ctx.tasks._gc()
    assert ctx.tasks.get(first.id) is first
    monkeypatch.setattr('penplot.web.tasks.runner.time.time', lambda: first.cleared_at + REUSE_DONE_S + 1)
    ctx.tasks._gc()
    with pytest.raises(errors.ApiError, match='任务不存在'):
        ctx.tasks.get(first.id)


def test_clear_tasks_cancellation_still_uses_delete(cleanup):
    client, ctx = cleanup
    queued = task(ctx, 'queued')
    assert client.post('/api/v1/tasks/clear', json={'ids': [queued.id]}).json()['skipped_ids'] == [queued.id]
    assert client.delete('/api/v1/tasks/' + queued.id).json()['state'] == 'cancelled'
    assert client.post('/api/v1/tasks/clear', json={'ids': [queued.id]}).json()['removed_ids'] == [queued.id]


def test_clear_jobs_protects_every_active_state_and_other_service(cleanup, tmp_path):
    client, ctx = cleanup
    sub = ctx.bus.subscribe({'job'})
    states = ['queued', 'done', 'failed', 'aborted', 'preparing', 'running', 'paused', 'stopping', 'held']
    for state in states:
        job(ctx, state, state)
    # Even a stale DB status cannot remove the current in-memory machine owner.
    job(ctx, 'owner', 'queued')
    ctx.jobs.active = SimpleNamespace(id='owner')
    t = task(ctx)
    source = tmp_path / 'source-render.json'
    source.write_text('{}')
    result = client.post('/api/v1/jobs/clear', json={
        'scope': 'history', 'ids': states + ['owner', 'missing', 'done']}).json()
    assert result['removed_ids'] == states[1:4]
    assert result['skipped_ids'] == ['queued'] + states[4:] + ['owner', 'missing']
    assert source.exists() and ctx.tasks.get(t.id) is t
    assert ctx.jobs.active.id == 'owner'
    assert len(ctx.db.all('SELECT * FROM jobs')) == 7
    assert [e['data']['job_id'] for e in sub.drain()] == states[1:4]
    result = client.post('/api/v1/jobs/clear', json={'scope': 'queued'}).json()
    assert result['removed_ids'] == ['queued']
    assert result['skipped_ids'] == ['owner']
    assert client.delete('/api/v1/jobs/owner').status_code == 409


def test_clear_jobs_all_empty_and_instance_isolation(cleanup, tmp_path):
    client, ctx = cleanup
    job(ctx, 'one', 'queued')
    other_db = DB(':memory:')
    other_db.migrate()
    other = SimpleNamespace(db=other_db)
    try:
        job(other, 'one', 'done')
        assert client.post('/api/v1/jobs/clear', json={'scope': 'queued', 'ids': []}).json() == {
            'removed_ids': [], 'skipped_ids': []}
        assert client.post('/api/v1/jobs/clear', json={'scope': 'queued'}).json() == {
            'removed_ids': ['one'], 'skipped_ids': []}
        assert other_db.scalar('SELECT COUNT(*) FROM jobs') == 1
        assert client.post('/api/v1/jobs/clear', json={'scope': 'queued'}).json()['removed_ids'] == []
        assert client.post('/api/v1/jobs/clear', json={'scope': 'queued', 'ids': 'one'}).status_code == 422
        assert client.post('/api/v1/jobs/clear', json={}).status_code == 422
    finally:
        other_db.close()


def test_clear_jobs_all_is_not_limited_to_visible_page(cleanup):
    client, ctx = cleanup
    for i in range(205):
        job(ctx, str(i), 'done')
    job(ctx, 'queued', 'queued')
    result = client.post('/api/v1/jobs/clear', json={'scope': 'history'}).json()
    assert len(result['removed_ids']) == 205
    assert result['skipped_ids'] == []


def test_start_rechecks_cleared_job_before_machine_preparation(cleanup, monkeypatch):
    _, ctx = cleanup
    job(ctx, 'race', 'queued')
    ctx.machine = SimpleNamespace(require_connected=lambda: None, estopping=False,
                                  origin_valid=True, mc=None)
    def load_then_clear(*args):
        assert ctx.jobs.clear(['race'], 'queued')['removed_ids'] == ['race']
        return 'G90', {}
    monkeypatch.setattr(ctx.jobs, '_load_job_analysis', load_then_clear)
    with pytest.raises(errors.ApiError) as exc:
        asyncio.run(ctx.jobs.start('race', set_zero=False))
    assert exc.value.status == 404
    assert ctx.jobs.active is None
