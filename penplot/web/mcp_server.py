"""MCP (Model Context Protocol) server exposing penplot's capabilities and machine control.

Supports:
- Streamable HTTP mounted on FastAPI at `/mcp` (shares live AppContext with the desktop UI)
- Standalone CLI (`penplot-mcp` / `python -m penplot.web mcp`) via `stdio` or `streamable-http`
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sys
from typing import Any, Literal, Optional

from mcp.server.mcpserver import MCPServer

import penplot

from .config import Config
from .errors import ApiError
from .schemas import (JobCreate, JobSource, PaperRef, ProjectCreate, ProjectUpdate,
                      RenderRequest, RenderTextRequest, TeletypeSessionCreate)

log = logging.getLogger('penplot.mcp')


def _j(obj: Any) -> str:
    if hasattr(obj, 'model_dump'):
        obj = obj.model_dump()
    return json.dumps(obj, ensure_ascii=False, default=str)


def build_mcp(get_ctx, lifespan=None) -> MCPServer:
    """Build an MCPServer wired to the AppContext returned by `get_ctx()`."""
    mcp = MCPServer(
        name='penplot',
        version=penplot.__version__,
        instructions=(
            'Penplot desktop workbench MCP server. '
            'Use these tools to inspect system/machine status, manage fonts and projects, '
            'render text/projects into G-code, control the plotter (connect, jog, zero, pen, frame, estop), '
            'and run print jobs or teletype sessions.'
        ),
        lifespan=lifespan,
    )

    def _ctx():
        c = get_ctx()
        if c is None:
            raise RuntimeError('AppContext is not initialized')
        return c

    # ------------------------------------------------------------------ System & Profiles
    @mcp.tool()
    def system_info() -> str:
        """Get penplot system info, version, features, data directory, and active machine profile."""
        return _j(_ctx().system.info())

    @mcp.tool()
    def system_health() -> str:
        """Get penplot health status, uptime, machine connection state, and active job flag."""
        return _j(_ctx().system.health())

    @mcp.tool()
    def list_profiles() -> str:
        """List all machine profiles (GRBL, Marlin, EBB, K_AT)."""
        return _j(_ctx().profiles.list())

    @mcp.tool()
    def get_profile(profile_id: str) -> str:
        """Get details of a specific machine profile by ID."""
        return _j(_ctx().profiles.get(profile_id))

    @mcp.tool()
    async def activate_profile(profile_id: str) -> str:
        """Activate a machine profile by ID."""
        return _j(await _ctx().profiles.activate(profile_id, actor='mcp'))

    @mcp.tool()
    def list_papers() -> str:
        """List all paper presets (sizes and margins)."""
        return _j(_ctx().papers.list())

    @mcp.tool()
    async def run_diagnostics(pen_test: bool = False, confirm: bool = False) -> str:
        """Run machine and system self-test diagnostics (serial, firmware settings, disk, fonts)."""
        return _j(await _ctx().diagnostics.run(pen_test, confirm))

    # ------------------------------------------------------------------ Fonts
    @mcp.tool()
    def list_fonts(q: Optional[str] = None, covers: Optional[str] = None,
                   format: Optional[str] = None, include_hidden: bool = False) -> str:
        """List available stroke fonts. Filter by search query `q`, required characters `covers`, or `format`."""
        return _j(_ctx().fonts.list(q=q, covers=covers, fmt=format, include_hidden=include_hidden))

    @mcp.tool()
    def get_font(font_id: str) -> str:
        """Get detailed metadata for a font by ID."""
        return _j(_ctx().fonts.detail(font_id))

    @mcp.tool()
    def check_font_coverage(font_id: str, text: str) -> str:
        """Check whether `font_id` contains glyphs for every character in `text`."""
        return _j(_ctx().fonts.coverage(font_id, text))

    # ------------------------------------------------------------------ Projects
    @mcp.tool()
    def list_projects(template: Optional[int] = None, q: Optional[str] = None, limit: int = 200) -> str:
        """List saved projects (or templates if `template=1`)."""
        return _j(_ctx().projects.list(template=template, q=q, limit=limit))

    @mcp.tool()
    def get_project(project_id: str) -> str:
        """Get full project document and metadata by ID."""
        return _j(_ctx().projects.get(project_id))

    @mcp.tool()
    def create_project(name: str, doc: Optional[dict[str, Any]] = None, is_template: bool = False) -> str:
        """Create a new penplot project (or template)."""
        body = ProjectCreate(name=name, doc=doc or {}, is_template=is_template)
        return _j(_ctx().projects.create(body))

    @mcp.tool()
    def update_project(project_id: str, rev: int, doc: dict[str, Any], name: Optional[str] = None) -> str:
        """Update an existing project's document and/or name (requires current `rev`)."""
        body = ProjectUpdate(name=name, doc=doc, rev=rev)
        return _j(_ctx().projects.update(project_id, body, None, None))

    @mcp.tool()
    def delete_project(project_id: str) -> str:
        """Delete a project by ID."""
        _ctx().projects.delete(project_id)
        return _j({'deleted': project_id})

    @mcp.tool()
    async def render_project(project_id: str, variables: Optional[dict[str, str]] = None,
                             wait_s: float = 10.0) -> str:
        """Render a project into toolpaths and G-code. Returns RenderResult with `rid`, bounds, and stats."""
        c = _ctx()
        body = RenderRequest(variables=variables or {})
        task = await asyncio.to_thread(c.render.submit_project, project_id, body)
        res = await _wait_task(c, task, wait_s)
        return _j(res)

    # ------------------------------------------------------------------ Render & G-code
    @mcp.tool()
    async def render_text(
        text: str,
        font_id: str = 'open-wenkai-stroke',
        paper_id: str = 'a4-normal',
        text_size: float = 1.0,
        char_space: float = 0.0,
        align: Literal['L', 'C', 'R', 'D'] = 'L',
        optimize: bool = False,
        wait_s: float = 10.0,
    ) -> str:
        """Render plain text into single-line plotter paths and G-code. Returns `rid` and page stats."""
        c = _ctx()
        body = RenderTextRequest(
            text=text,
            font_id=font_id,
            paper=PaperRef(paper_id=paper_id),
            text_size=text_size,
            char_space=char_space,
            align=align,
            optimize=optimize,
        )
        task = await asyncio.to_thread(c.render.submit_text, body, None)
        res = await _wait_task(c, task, wait_s)
        return _j(res)

    @mcp.tool()
    def get_render(rid: str) -> str:
        """Get metadata, bounds, and page list for a completed render `rid`."""
        return _j(_ctx().render.get(rid))

    @mcp.tool()
    def get_render_gcode(rid: str, page_index: int = 0) -> str:
        """Read the generated G-code text for render `rid` and `page_index`."""
        path = _ctx().render.gcode_path(rid, page_index)
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()

    @mcp.tool()
    def get_render_svg(rid: str, page_index: int = 0, space: Literal['page', 'machine'] = 'page',
                       travel: bool = False) -> str:
        """Get the SVG preview for render `rid` and `page_index`."""
        return _ctx().render.preview_svg(rid, page_index, space, travel)

    @mcp.tool()
    def save_render(rid: str, page: Optional[int] = None, name: Optional[str] = None) -> str:
        """Save rendered G-code to the persistent file library."""
        return _j(_ctx().render.save(rid, page, name))

    # ------------------------------------------------------------------ Machine Control
    @mcp.tool()
    def machine_status() -> str:
        """Get live plotter/machine status: connected, port, state, position, pen state, origin_valid."""
        return _j(_ctx().machine.status())

    @mcp.tool()
    def machine_ports() -> str:
        """List available serial ports on this computer."""
        return _j(_ctx().machine.ports())

    @mcp.tool()
    async def machine_connect(port: Optional[str] = None, baud: Optional[int] = None,
                              reset: bool = True) -> str:
        """Connect to the plotter serial port."""
        return _j(await _ctx().machine.connect(port, baud, reset))

    @mcp.tool()
    async def machine_disconnect() -> str:
        """Disconnect from the plotter serial port."""
        return _j(await _ctx().machine.disconnect())

    @mcp.tool()
    async def machine_jog(dx: float = 0.0, dy: float = 0.0, dz: float = 0.0,
                          feed: Optional[float] = None) -> str:
        """Relative jog move in millimeters (`dx`, `dy`, `dz`)."""
        return _j(await _ctx().machine.jog(dx, dy, dz, feed, None, client='mcp'))

    @mcp.tool()
    def machine_jog_cancel() -> str:
        """Cancel an in-progress jog motion."""
        _ctx().machine.jog_cancel()
        return _j({'ok': True})

    @mcp.tool()
    async def machine_zero(axes: Literal['xy', 'z', 'xyz'] = 'xy') -> str:
        """Set the current pen position as the work origin for `axes` ('xy', 'z', or 'xyz')."""
        return _j(await _ctx().machine.zero(axes))

    @mcp.tool()
    async def machine_pen(state: Literal['up', 'down']) -> str:
        """Raise ('up') or lower ('down') the pen."""
        return _j(await _ctx().machine.pen(state == 'up'))

    @mcp.tool()
    async def machine_goto_origin() -> str:
        """Lift the pen and move to work origin (0, 0)."""
        return _j(await _ctx().machine.goto_origin())

    @mcp.tool()
    async def machine_homing() -> str:
        """Run machine homing cycle ($H)."""
        return _j(await _ctx().machine.homing())

    @mcp.tool()
    async def machine_unlock() -> str:
        """Unlock GRBL alarm state ($X)."""
        return _j(await _ctx().machine.unlock())

    @mcp.tool()
    async def machine_estop() -> str:
        """Emergency stop: immediately halt motion and lift/stop."""
        return _j(await _ctx().machine.estop(actor='mcp'))

    @mcp.tool()
    async def machine_frame(x0: float, y0: float, x1: float, y1: float,
                            feed: Optional[float] = None, corners_only: bool = False) -> str:
        """Trace the bounding box [x0, y0, x1, y1] (in mm) with pen up to preview placement."""
        return _j(await _ctx().machine.frame([x0, y0, x1, y1], feed, None, corners_only))

    @mcp.tool()
    async def machine_command(line: str, timeout_s: float = 5.0) -> str:
        """Send a raw G-code or firmware command line to the controller."""
        return _j(await _ctx().machine.command(line, timeout_s, actor='mcp'))

    # ------------------------------------------------------------------ Jobs
    @mcp.tool()
    def list_jobs(status: Optional[str] = None, limit: int = 50) -> str:
        """List print jobs (optionally filtered by `status`)."""
        return _j(_ctx().jobs.list(status=status, limit=limit))

    @mcp.tool()
    def get_job(job_id: str) -> str:
        """Get details of a specific job by ID."""
        return _j(_ctx().jobs.get(job_id))

    @mcp.tool()
    async def create_job(
        name: str,
        render_id: Optional[str] = None,
        page_index: int = 0,
        file_id: Optional[str] = None,
        project_id: Optional[str] = None,
        start: bool = False,
        allow_out_of_bounds: bool = False,
    ) -> str:
        """Create a print job from a `render_id`, `file_id`, or `project_id`. Optionally start immediately."""
        src = JobSource(
            render_id=render_id,
            page=page_index if render_id else None,
            file_id=file_id,
            project_id=project_id,
        )
        body = JobCreate(
            name=name,
            source=src,
            start=start,
            allow_out_of_bounds=allow_out_of_bounds,
        )
        return _j(await _ctx().jobs.create(body, actor='mcp'))

    @mcp.tool()
    async def start_job(job_id: str, set_zero: bool = False, pen_up_confirmed: bool = False,
                        allow_out_of_bounds: bool = False) -> str:
        """Start a queued/paused job."""
        return _j(await _ctx().jobs.start(job_id, set_zero, actor='mcp',
                                          pen_up_confirmed=pen_up_confirmed,
                                          allow_out_of_bounds=allow_out_of_bounds))

    @mcp.tool()
    async def pause_job(job_id: str, mode: Literal['hold', 'lift_after_move'] = 'hold') -> str:
        """Pause an active job."""
        return _j(await _ctx().jobs.pause(job_id, mode))

    @mcp.tool()
    async def resume_job(job_id: str) -> str:
        """Resume a paused job."""
        return _j(await _ctx().jobs.resume(job_id))

    @mcp.tool()
    async def stop_job(job_id: str) -> str:
        """Stop an active or paused job."""
        return _j(await _ctx().jobs.stop(job_id))

    @mcp.tool()
    def delete_job(job_id: str) -> str:
        """Delete a job by ID."""
        _ctx().jobs.delete(job_id)
        return _j({'deleted': job_id})

    # ------------------------------------------------------------------ Teletype
    @mcp.tool()
    def teletype_state() -> str:
        """Get current teletype (live typewriter) session state."""
        return _j(_ctx().teletype.state())

    @mcp.tool()
    async def teletype_start(font_id: str = 'mono', mode: Literal['type', 'term'] = 'type',
                             set_zero: bool = True) -> str:
        """Start a live teletype session at the current pen position."""
        body = TeletypeSessionCreate(font_id=font_id, mode=mode, set_zero=set_zero)
        return _j(await _ctx().teletype.create(body, actor='mcp'))

    @mcp.tool()
    def teletype_type(text: str) -> str:
        """Send text to the active teletype session to write immediately."""
        return _j(_ctx().teletype.keys(text))

    @mcp.tool()
    async def teletype_stop() -> str:
        """Close the active teletype session, lift pen, and return to origin."""
        await _ctx().teletype.close(actor='mcp')
        return _j(_ctx().teletype.state())

    # ------------------------------------------------------------------ Resources
    @mcp.resource('penplot://status')
    def resource_status() -> str:
        """Live snapshot of machine, current job, tasks, and teletype state."""
        return _j(_ctx().snapshot())

    @mcp.resource('penplot://fonts')
    def resource_fonts() -> str:
        """List of all available stroke fonts."""
        return _j(_ctx().fonts.list())

    @mcp.resource('penplot://profiles')
    def resource_profiles() -> str:
        """List of all configured machine profiles."""
        return _j(_ctx().profiles.list())

    @mcp.resource('penplot://papers')
    def resource_papers() -> str:
        """List of all paper presets."""
        return _j(_ctx().papers.list())

    return mcp


async def _wait_task(ctx, task, timeout_s: float):
    res = await ctx.tasks.wait(task, timeout_s)
    if res is None:
        return {'task_id': task.id, 'kind': task.kind, 'state': task.state}
    return res


def run_mcp(transport: str = 'stdio', host: str = '127.0.0.1', port: int = 8081) -> int:
    """Run penplot as a standalone MCP server (stdio or streamable-http)."""
    from .context import AppContext

    logging.basicConfig(
        level=getattr(logging, Config.from_env().log_level.upper(), logging.INFO),
        format='%(levelname)s %(name)s %(message)s',
        stream=sys.stderr,
    )
    holder: dict[str, Any] = {'ctx': None}

    @contextlib.asynccontextmanager
    async def _lifespan(_server):
        ctx = AppContext(Config.from_env())
        holder['ctx'] = ctx
        await ctx.start()
        try:
            yield
        finally:
            await ctx.stop()
            holder['ctx'] = None

    mcp = build_mcp(lambda: holder['ctx'], lifespan=_lifespan)
    if transport == 'streamable-http':
        import uvicorn
        app = mcp.streamable_http_app(streamable_http_path='/mcp', host=host)
        uvicorn.run(app, host=host, port=port, log_level='info')
    else:
        mcp.run(transport='stdio')
    return 0


def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog='penplot-mcp', description='Penplot MCP Server')
    ap.add_argument('--transport', choices=['stdio', 'streamable-http'], default='stdio')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8081)
    args = ap.parse_args(argv)
    return run_mcp(transport=args.transport, host=args.host, port=args.port)


if __name__ == '__main__':
    sys.exit(main())
