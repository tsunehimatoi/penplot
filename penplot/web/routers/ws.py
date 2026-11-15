"""WebSocket /api/v1/ws (03 §5)."""
import asyncio
import json
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..errors import ApiError
from ..events import ALL_TOPICS

log = logging.getLogger('penplot.web.ws')
router = APIRouter()


def _no_nan(v):
    raise ValueError('NaN/Infinity not allowed')


MAX_MSG = 64 * 1024
RATE = 20.0           # messages per second (token bucket)


@router.websocket('/ws')
async def ws_endpoint(ws: WebSocket):
    c = ws.app.state.ctx
    protos = [p.strip() for p in ws.headers.get('sec-websocket-protocol', '').split(',') if p.strip()]
    proto = 'penplot.v1' if 'penplot.v1' in protos else None
    await ws.accept(subprotocol=proto)
    sub = c.bus.subscribe()
    sub.client = (ws.headers.get('user-agent') or '')[:40]
    sub.last_jog = 0.0
    seq = 0
    inbox = asyncio.Queue(maxsize=64)

    async def send(msg):
        nonlocal seq
        seq += 1
        msg = {k: v for k, v in msg.items() if not k.startswith('_')}
        msg['seq'] = seq
        msg.setdefault('ts', time.time())
        await asyncio.wait_for(ws.send_text(json.dumps(msg, ensure_ascii=False, default=str)), 5.0)

    async def sender():
        while True:
            await sub.wake.wait()
            for m in sub.drain():
                await send(m)

    def ack(cid, ok, res=None, err=None):
        if cid is not None:
            sub.offer({'type': 'ack', 'id': str(cid), 'ok': ok, 'result': res, 'error': err})

    async def handle(msg):
        t = msg.get('type')
        cid = msg.get('id')
        try:
            if t == 'subscribe':
                topics = set(msg.get('topics') or []) & ALL_TOPICS
                sub.topics = topics | {'notice', 'attention'}
                return
            if t == 'ping':
                sub.offer({'type': 'pong', 't': msg.get('t') if isinstance(msg.get('t'), (int, float)) else None})
                return
            if t == 'tt_keys':
                data = msg.get('data')
                if not isinstance(data, str) or len(data) > 20000:
                    raise ApiError(422, 'validation_error', 'data 必须是字符串（≤20000）')
                tt = c.teletype
                if tt.session is not None and tt.session.mode == 'term':
                    tt._check_terminal()
                tt.keys(data)
                ack(cid, True)
                return
            if t == 'cmd':
                op = msg.get('op')
                args = msg.get('args') or {}
                if not isinstance(args, dict):
                    raise ApiError(422, 'validation_error', 'args 必须是对象')
                if op == 'jog':
                    sub.last_jog = time.time()
                    c.machine.last_ws_jog = (sub.id, sub.last_jog)
                res = await c.ws_command(op, args, actor='desktop')
                if hasattr(res, 'model_dump'):
                    res = res.model_dump()
                ack(cid or '', True, res if isinstance(res, dict) else {'value': res})
                return
        except ApiError as e:
            ack(cid if cid is not None else (t or ''), False, err=e.body()['error'])
        except Exception as e:  # noqa
            log.exception('ws %s', t)
            ack(cid if cid is not None else (t or ''), False,
                err={'code': 'internal', 'message': '服务器内部错误', 'detail': str(e)[:200]})

    async def worker():
        while True:
            m = await inbox.get()
            await handle(m)

    stask = wtask = None
    tokens, last = RATE, time.time()
    try:
        await send({'type': 'hello', 'server_version': c.version, 'conn_id': sub.id,
                    'snapshot': c.snapshot()})
        stask = asyncio.create_task(sender())
        wtask = asyncio.create_task(worker())
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), 45.0)
            except asyncio.TimeoutError:
                sub.offer({'type': 'pong', 't': None})
                continue
            if len(raw) > MAX_MSG:
                continue
            try:
                msg = json.loads(raw, parse_constant=_no_nan)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get('type') == 'cmd' and msg.get('op') == 'estop':
                await handle(msg)      # never queued, never rate limited
                continue
            now = time.time()
            tokens = min(RATE, tokens + (now - last) * RATE)
            last = now
            if tokens < 1.0:
                if msg.get('id') is not None:
                    sub.offer({'type': 'ack', 'id': str(msg.get('id')), 'ok': False,
                               'error': {'code': 'rate_limited', 'message': '消息太频繁', 'detail': None}})
                continue
            tokens -= 1.0
            try:
                inbox.put_nowait(msg)
            except asyncio.QueueFull:
                pass
            if stask.done():
                break
    except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
        pass
    except Exception:
        log.exception('ws')
    finally:
        c.bus.unsubscribe(sub)
        if time.time() - sub.last_jog < 3.0:
            try:
                c.machine.jog_cancel()
            except Exception:
                pass
        for t in (stask, wtask):
            if t:
                t.cancel()
        try:
            await ws.close(code=1013 if stask and stask.done() else 1000)
        except Exception:
            pass
