"""Stream frames preserve output indices and both coordinate spaces of the page API."""
import struct
import asyncio
import pytest
from penplot.web.errors import ApiError

from conftest import H


def test_paths_stream_matches_pages(client):
    doc = {'name': 'stream', 'pages': [
        {'id': 'p1', 'elements': [{'id': 'e1', 'type': 'shape',
          'props': {'kind': 'grid', 'w': 10, 'h': 20, 'cols': 3}, 'transform': {'x': 12, 'y': 17, 'rotation': 30}, 'page_offset': 1}]},
        {'id': 'p2', 'origin': {'anchor': 'paper', 'corner': 0},
         'elements': [{'id': 'e2', 'type': 'flow_text', 'props': {'text': 'hello\n\n===\n\nworld', 'format': 'markdown', 'font_id': 'penplot-sans'}}]},
    ]}
    project = client.post('/api/v1/projects', json={'name': 'stream', 'doc': doc}, headers=H)
    assert project.status_code == 201, project.text
    rendered = client.post('/api/v1/projects/%s/render' % project.json()['id'], json={'overrides': {'optimize': False, 'copies': 1, 'simplify': 0}}, headers=H)
    assert rendered.status_code == 200, rendered.text
    result = rendered.json()
    for space in ('page', 'machine'):
        response = client.get('/api/v1/render/%s/paths-stream?space=%s' % (result['rid'], space))
        assert response.status_code == 200
        data, offset, indices = response.content, 0, []
        while offset < len(data):
            index, size = struct.unpack_from('<II', data, offset)
            offset += 8
            page = client.get('/api/v1/render/%s/pages/%d/paths?space=%s' % (result['rid'], index, space))
            assert data[offset:offset + size] == page.content
            indices.append(index)
            offset += size
        assert offset == len(data)
        assert indices == [p['index'] for p in result['pages']]
    assert client.get('/api/v1/render/missing/paths-stream').status_code == 404
    assert client.get('/api/v1/render/%s/paths-stream?space=invalid' % result['rid']).status_code == 422

    preview = client.post('/api/v1/projects/%s/preview?wait=60' % project.json()['id'], json={'overrides': {'optimize': False, 'copies': 1, 'simplify': 0}}, headers=H)
    assert preview.status_code == 200, preview.text
    pr = preview.json()
    assert pr['preview_only'] is True
    assert len(pr['pages']) == len(result['pages'])
    for page in pr['pages']:
        assert 'est_s' not in page and 'machine_bbox' not in page
        expected = client.get('/api/v1/render/%s/pages/%d/paths' % (result['rid'], page['index']))
        actual = client.get('/api/v1/render/%s/pages/%d/paths' % (pr['rid'], page['index']))
        assert expected.content == actual.content
    assert client.get('/api/v1/render/%s/paths-stream' % pr['rid']).status_code == 200
    for suffix in ('', '/pages/0/gcode', '/pages/0/paths?space=machine', '/paths-stream?space=machine'):
        rejected = client.get('/api/v1/render/%s%s' % (pr['rid'], suffix))
        assert rejected.status_code == 409, rejected.text
        assert rejected.json()['error']['code'] == 'preview_only'
    with pytest.raises(ApiError) as rejected:
        asyncio.run(client.app.state.ctx.render.rerender(pr['rid'], {'feed_rate': 1000}))
    assert rejected.value.code == 'preview_only'
