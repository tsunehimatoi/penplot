"""Tests for penplot.web.mcp_server (MCP tools, resources, and /mcp Streamable HTTP endpoint)."""
import json

import pytest
from fastapi.testclient import TestClient

from conftest import H


@pytest.mark.anyio
async def test_mcp_tools_and_resources(app):
    from penplot.web.mcp_server import build_mcp

    with TestClient(app, base_url='http://127.0.0.1:8080') as c:
        assert c.post('/api/v1/machine/connect', json={'port': 'test-serial'}, headers=H).status_code == 200
        assert c.post('/api/v1/machine/zero', json={'axes': 'xyz'}, headers=H).status_code == 200

        mcp = build_mcp(lambda: app.state.ctx)

        tools = await mcp.list_tools()
        tool_names = {t.name for t in tools}
        assert {
            'system_info',
            'system_health',
            'list_fonts',
            'render_text',
            'get_render_gcode',
            'machine_status',
            'machine_jog',
            'machine_pen',
            'machine_estop',
            'create_job',
            'list_jobs',
            'teletype_start',
        }.issubset(tool_names)

        # Call system_health
        res = await mcp.call_tool('system_health', {})
        data = json.loads(res.content[0].text)
        assert data['status'] == 'ok'
        assert data['machine_connected'] is True

        # Call list_fonts
        res = await mcp.call_tool('list_fonts', {})
        fonts = json.loads(res.content[0].text)
        assert any(f['id'] == 'penplot-sans' for f in fonts)

        # Call render_text -> get_render_gcode
        res = await mcp.call_tool('render_text', {
            'text': 'Hello MCP',
            'font_id': 'penplot-sans',
            'text_size': 1.0,
        })
        rendered = json.loads(res.content[0].text)
        assert 'rid' in rendered and rendered['pages']
        rid = rendered['rid']

        gcode_res = await mcp.call_tool('get_render_gcode', {'rid': rid, 'page_index': 0})
        gcode = gcode_res.content[0].text
        assert 'G1' in gcode or 'G0' in gcode

        # Call machine_status & machine_pen
        st = json.loads((await mcp.call_tool('machine_status', {})).content[0].text)
        assert st['connected'] is True

        pen_res = json.loads((await mcp.call_tool('machine_pen', {'state': 'down'})).content[0].text)
        assert pen_res['connected'] is True
        await mcp.call_tool('machine_pen', {'state': 'up'})

        # Read MCP resource
        resources = await mcp.list_resources()
        uris = {str(r.uri) for r in resources}
        assert 'penplot://status' in uris
        assert 'penplot://fonts' in uris
        status_contents = list(await mcp.read_resource('penplot://status'))
        snap = json.loads(status_contents[0].content)
        assert snap['machine']['connected'] is True


def test_mcp_http_mount_present(app):
    """Verify /mcp is mounted on FastAPI and responds to MCP Streamable HTTP requests."""
    with TestClient(app, base_url='http://127.0.0.1:8080') as c:
        r = c.post(
            '/mcp',
            json={
                'jsonrpc': '2.0',
                'id': 1,
                'method': 'initialize',
                'params': {
                    'protocolVersion': '2025-03-26',
                    'capabilities': {},
                    'clientInfo': {'name': 'pytest', 'version': '1.0'},
                },
            },
            headers={'Accept': 'application/json, text/event-stream'},
        )
        assert r.status_code == 200, r.text
        assert 'penplot' in r.text
