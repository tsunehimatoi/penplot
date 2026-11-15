from typing import Optional

from fastapi import APIRouter, Header, Path, Request

from ..schemas import (CommandRequest, CommandResult, ConnectRequest, FrameRequest, GrblSetting,
                       GrblSettingsUpdate, JogRequest, MachineStatus, Ok, PenRequest, PortInfo,
                       RealtimeRequest, ZeroRequest)

router = APIRouter(prefix='/machine', tags=['machine'])


def _svc(request):
    return request.app.state.ctx.machine


async def _idem(request, key, fn):
    """Idempotency-Key dedupe (30 s) for non-idempotent calls."""
    c = request.app.state.ctx
    return await c.idem.run(key, fn)


@router.get('/status', response_model=MachineStatus)
def status(request: Request):
    return _svc(request).status()


@router.get('/ports', response_model=list[PortInfo])
def ports(request: Request):
    return _svc(request).ports()


@router.post('/connect', response_model=MachineStatus)
async def connect(request: Request, body: Optional[ConnectRequest] = None):
    b = body or ConnectRequest()
    return await _svc(request).connect(b.port, b.baud, b.reset)


@router.post('/disconnect', response_model=MachineStatus)
async def disconnect(request: Request):
    return await _svc(request).disconnect()


@router.post('/jog', response_model=MachineStatus)
async def jog(body: JogRequest, request: Request,
              idempotency_key: Optional[str] = Header(None)):
    return await _idem(request, idempotency_key,
                       lambda: _svc(request).jog(body.dx, body.dy, body.dz, body.feed, body.seq,
                                                 client='rest:desktop'))


@router.post('/jog/cancel', response_model=Ok)
def jog_cancel(request: Request):
    _svc(request).jog_cancel()
    return Ok()


@router.post('/zero', response_model=MachineStatus)
async def zero(request: Request, body: Optional[ZeroRequest] = None,
               idempotency_key: Optional[str] = Header(None)):
    axes = (body or ZeroRequest()).axes
    return await _idem(request, idempotency_key, lambda: _svc(request).zero(axes))


@router.post('/pen', response_model=MachineStatus)
async def pen(body: PenRequest, request: Request):
    return await _svc(request).pen(body.state == 'up')


@router.post('/goto-origin', response_model=MachineStatus)
async def goto_origin(request: Request):
    return await _svc(request).goto_origin()


@router.post('/homing', response_model=MachineStatus)
async def homing(request: Request):
    return await _svc(request).homing()


@router.post('/clear-hold', response_model=MachineStatus)
async def clear_hold(request: Request):
    """Release a feed hold that no job owns (machine pause button, hold kept over a
    reconnect): soft reset, buffered moves are discarded, position kept after Hold:0."""
    return await _svc(request).clear_hold()


@router.post('/unlock', response_model=MachineStatus)
async def unlock(request: Request):
    return await _svc(request).unlock()


@router.post('/sleep', response_model=MachineStatus)
async def sleep(request: Request):
    return await _svc(request).sleep()


@router.post('/reset', response_model=MachineStatus)
async def reset(request: Request):
    return await _svc(request).soft_reset(actor='desktop')


@router.post('/estop', response_model=MachineStatus)
async def estop(request: Request):
    """E-stop: never rate limited."""
    return await _svc(request).estop(actor='desktop')


@router.post('/frame', response_model=MachineStatus)
async def frame(body: FrameRequest, request: Request):
    return await _svc(request).frame(body.bbox_mm, body.feed, body.z, body.corners_only)


@router.post('/command', response_model=CommandResult)
async def command(body: CommandRequest, request: Request,
                  idempotency_key: Optional[str] = Header(None)):
    return await _idem(request, idempotency_key,
                       lambda: _svc(request).command(body.line, body.timeout_s, actor='desktop'))


@router.post('/realtime', response_model=Ok)
def realtime(body: RealtimeRequest, request: Request):
    _svc(request).realtime(body.byte)
    return Ok()


@router.get('/grbl-settings', response_model=list[GrblSetting])
async def grbl_settings(request: Request, refresh: int = 0):
    return await _svc(request).grbl_settings(bool(refresh))


@router.put('/grbl-settings', response_model=list[GrblSetting])
async def put_grbl_settings(body: GrblSettingsUpdate, request: Request):
    return await _svc(request).write_grbl_settings(body, actor='desktop')


@router.post('/macro/{n}', response_model=MachineStatus)
async def macro(request: Request, n: int = Path(ge=1, le=3)):
    return await _svc(request).macro(n)
