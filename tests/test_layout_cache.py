"""Lossless composition reuse across preview/print worker processes."""
import json
import copy
import os
from pathlib import Path as FilePath
import random
import subprocess
import sys

import pytest

from penplot import layout_cache as cache
from penplot.compose import Resolver, compose_pages, render_document
from penplot.geometry import Path
from penplot.layout import FontsSet, PageInfo
from penplot.rich_layout import RichTextDocument
from penplot.settings import MachineConfig


def inputs(tmp_path):
    doc = {'pages': [{'elements': [{'id': 'flow', 'type': 'flow_text', 'props': {
        'text': '# AB\n\n**AB** {{name}}\n\n' + 'AB ' * 50,
        'format': 'markdown', 'seed': 19, 'jitter': {'randomRotate': [-3, 3]}}}]}]}
    papers = [{'width_mm': 50, 'height_mm': 60, 'margins': {'l': 5, 'r': 5, 't': 5, 'b': 5},
               'ruling': {'line_num': 5}}]
    return doc, papers, Resolver(cache_dir=str(tmp_path / 'cache')), MachineConfig(machine_type='Grbl')


def test_roundtrip_preserves_double_precision_ops_and_ownership():
    p = Path([0.123456789012345, -0.0, 1.00000000001, 3, 5, 7], [0, 1, 0])
    pages = [(0, {'width_mm': 20}, [p], {'missing': {'中'}, 'messages': ['x'], 'overflow': True})]
    raw = cache.encode_composition(pages)
    first = cache.decode_composition(raw)
    assert cache.encode_composition(first) == raw
    first[0][2][0].coords[0] = 900
    first[0][3]['missing'].clear()
    second = cache.decode_composition(raw)
    assert second[0][2][0].coords == p.coords
    assert second[0][3]['missing'] == {'中'}


@pytest.mark.parametrize('change', ['text', 'seed', 'jitter', 'paper', 'variables', 'settings',
                                   'transform', 'filter', 'font', 'role_font'])
def test_key_invalidates_every_composition_input(tmp_path, change):
    doc, papers, res, mc = inputs(tmp_path)
    font = tmp_path / 'font.psf'
    font.write_text('one')
    res.fonts = {'primary': str(font), 'fallback': str(font)}
    variables, selected = {'name': 'A'}, None
    before = cache.composition_key(doc, papers, res, mc, variables, selected)
    pr = doc['pages'][0]['elements'][0]['props']
    if change == 'text': pr['text'] += 'B'
    elif change == 'seed': pr['seed'] += 1
    elif change == 'jitter': pr['jitter']['randomY'] = 0.2
    elif change == 'paper': papers[0]['width_mm'] += 1
    elif change == 'variables': variables['name'] = 'B'
    elif change == 'settings': mc.settings.dpi += 1
    elif change == 'transform': doc['pages'][0]['elements'][0]['transform'] = {'x': 5}
    elif change == 'filter': selected = {0}
    elif change == 'font': font.write_text('changed font bytes')
    elif change == 'role_font':
        replacement = tmp_path / 'role.psf'
        replacement.write_text('new role')
        res.fonts['fallback'] = str(replacement)
    assert cache.composition_key(doc, papers, res, mc, variables, selected) != before


def test_same_basename_and_role_font_update_invalidate_element_keys(tmp_path):
    from penplot.compose import _file_ident, _font_idents
    a, b = tmp_path / 'a', tmp_path / 'b'
    a.mkdir()
    b.mkdir()
    first, second = a / 'font.psf', b / 'font.psf'
    first.write_bytes(b'one')
    second.write_bytes(b'two')
    stamp = first.stat().st_mtime_ns
    os.utime(second, ns=(stamp, stamp))
    assert _file_ident(str(first)) != _file_ident(str(second))
    res = Resolver(fonts={'base': str(first), 'role': str(second)})
    props = {'font_id': 'base', 'font_roles': {'en': 'role'}}
    before = _font_idents(props, res)
    second.write_bytes(b'updated role')
    assert _font_idents(props, res) != before


def test_cache_hit_gcode_and_origin_placement_boundaries(tmp_path, monkeypatch):
    import penplot.compose as compose
    doc, papers, res, mc = inputs(tmp_path)
    doc['pages'][0]['elements'].append({'id': 'box', 'type': 'shape', 'props': {'w': 2, 'h': 2}})
    doc['pages'][0]['elements'][0]['props']['text'] += '\U0010ffff'
    opts = {'optimize': False}
    expected = render_document(doc, papers, res, mc, opts=opts, variables={'name': 'A'})
    def fail(*args, **kwargs):
        raise AssertionError('repeated composition')
    monkeypatch.setattr(compose, '_compose_pages', fail)
    hit = render_document(doc, papers, res, mc, opts=opts, variables={'name': 'A'})
    assert [p.gcode for p in hit] == [p.gcode for p in expected]
    assert [p.warnings for p in hit] == [p.warnings for p in expected]
    assert any('\U0010ffff' in p.warnings['missing_glyphs'] for p in hit)
    moved_opts = {**opts, 'placement': {'dx_mm': 3, 'dy_mm': 2}}
    moved = render_document(doc, papers, res, mc, opts=moved_opts, variables={'name': 'A'},
                            origin={'corner': 1})
    assert [p.gcode for p in moved] != [p.gcode for p in expected]
    monkeypatch.undo()
    fresh = render_document(doc, papers, Resolver(), mc, opts=moved_opts, variables={'name': 'A'},
                            origin={'corner': 1})
    assert [p.gcode for p in moved] == [p.gcode for p in fresh]
    assert [p.warnings for p in moved] == [p.warnings for p in fresh]


def test_real_preview_then_print_in_separate_python_processes(tmp_path):
    doc, papers, res, _ = inputs(tmp_path)
    doc['pages'][0]['elements'].append({'id': 'box', 'type': 'shape', 'props': {'w': 2, 'h': 2}})
    args = {'doc': doc, 'papers': papers, 'el_cache': res.cache_dir,
            'profile_doc': {'type': 'Grbl'}, 'project_print': {'optimize': False},
            'rid': 'preview', 'out_dir': str(tmp_path / 'preview'), 'preview_only': True}
    request = tmp_path / 'request.json'
    request.write_text(json.dumps(args), encoding='utf-8')
    script = '''
import json, sys
import penplot.compose as c
from penplot.web.tasks.kinds import render_project
a = json.load(open(sys.argv[1], encoding='utf-8'))
if sys.argv[2] == 'print':
    def fail(*args, **kwargs):
        raise AssertionError('print worker recomposed preview')
    c._compose_pages = fail
    a['preview_only'] = False
    a['rid'] = 'print'
    a['out_dir'] += '-print'
render_project(a, lambda *args: None)
'''
    env = {**os.environ, 'PENPLOT_PAGE_WORKERS': '1'}
    for mode in ('preview', 'print'):
        result = subprocess.run([sys.executable, '-c', script, str(request), mode],
                                cwd=str(FilePath(__file__).resolve().parents[1]), env=env,
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
    assert list((tmp_path / 'preview-print').glob('*.gcode'))


def test_corruption_and_write_failure_fall_back(tmp_path, monkeypatch):
    args = inputs(tmp_path)
    args[0]['pages'][0]['elements'].append({'id': 'box', 'type': 'shape', 'props': {'w': 2, 'h': 2}})
    expected = compose_pages(*args)
    filename, = [p for p in (tmp_path / 'cache' / f'layout-v{cache.VERSION}').glob('*.layout')
                 if not p.name.startswith('flow-')]
    filename.write_bytes(b'broken')
    assert cache.encode_composition(compose_pages(*args)) == cache.encode_composition(expected)
    filename.unlink()
    def no_write(*a, **k): raise OSError('disk unavailable')
    monkeypatch.setattr(cache.os, 'makedirs', no_write)
    assert cache.encode_composition(compose_pages(*args)) == cache.encode_composition(expected)


def test_scratch_preview_then_real_print_reuses_flow_across_processes(tmp_path):
    doc, papers, res, _ = inputs(tmp_path)
    el = doc['pages'][0]['elements'][0]
    del el['props']['seed']  # default seed must still derive from the same element id
    el['props']['text'] += '\U0010ffff'
    el.update(transform={'x': 7, 'y': 9, 'scale': 0.93, 'rotation': 2},
              z=6, hidden=False, locked=True, page_offset=2)
    doc.update(version=1, name='Real print document', variables=[{'name': 'name', 'default': 'A'}],
               print={'optimize': False})
    doc['pages'][0].update(id='real-page', origin={'corner': 1, 'anchor': 'content'})
    scratch_el = copy.deepcopy(el)
    scratch_el.update(transform={'x': 0, 'y': 0, 'scale': 1, 'rotation': 0},
                      page_offset=0, z=0, hidden=False, locked=False)
    scratch_print = {'optimize': False, 'copies': 1, 'simplify': 0, 'multi_page': 'separate_jobs'}
    scratch = {'version': 1, 'name': '_preview', 'variables': [], 'print': scratch_print,
               'pages': [{'id': 's0', 'origin': None, 'elements': [scratch_el]}]}
    extra_font = tmp_path / 'unrelated.psf'
    extra_font.write_text('not used by the flow element')
    base = {'papers': papers, 'el_cache': res.cache_dir, 'profile_doc': {'type': 'Grbl'},
            'project_print': {'optimize': False}, 'rid': 'preview',
            'out_dir': str(tmp_path / 'preview')}
    preview = {**base, 'doc': scratch, 'preview_only': True, 'variables': {'name': 'A'},
               'overrides': scratch_print}
    real = {**base, 'doc': doc, 'preview_only': False, 'rid': 'print',
            'out_dir': str(tmp_path / 'print'), 'fonts': {'other-element-font': str(extra_font)},
            'overrides': {'origin': {'corner': 3}, 'placement': {'dx_mm': 4, 'dy_mm': 2}}}
    request = tmp_path / 'scratch-request.json'
    request.write_text(json.dumps({'preview': preview, 'print': real}), encoding='utf-8')
    script = '''
import json, pathlib, sys
from penplot.rich_layout import RichTextDocument
from penplot.web.tasks.kinds import render_project
a = json.load(open(sys.argv[1], encoding='utf-8'))[sys.argv[2]]
original = RichTextDocument.layout_and_render
if sys.argv[2] == 'print':
    def fail(*args, **kwargs):
        raise AssertionError('real print laid out flow after scratch preview')
    RichTextDocument.layout_and_render = fail
warm = render_project(a, lambda *args: None)
if sys.argv[2] == 'print':
    RichTextDocument.layout_and_render = original
    warm_dir = pathlib.Path(a['out_dir'])
    a['el_cache'] = None
    a['out_dir'] += '-cold'
    cold = render_project(a, lambda *args: None)
    assert warm['pages'] == cold['pages']
    for path in warm_dir.glob('page-*'):
        assert path.read_bytes() == (pathlib.Path(a['out_dir']) / path.name).read_bytes(), path.name
'''
    for mode in ('preview', 'print'):
        result = subprocess.run([sys.executable, '-c', script, str(request), mode],
                                cwd=str(FilePath(__file__).resolve().parents[1]),
                                env={**os.environ, 'PENPLOT_PAGE_WORKERS': '1'},
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr


def test_flow_key_excludes_framing_but_invalidates_layout_inputs(tmp_path):
    doc, papers, res, mc = inputs(tmp_path)
    el = doc['pages'][0]['elements'][0]
    args = (el, papers[0], res, {'name': 'A'}, mc.settings)
    key = cache.flow_key(*args)
    el.update(transform={'x': 99}, z=5, hidden=True, locked=True, page_offset=8)
    res.fonts['unused'] = 'does-not-even-exist.psf'
    assert cache.flow_key(*args) == key
    for name, value in [('text', 'new'), ('seed', 44), ('jitter', {'randomY': 0.7}),
                        ('font_roles', {'en': 'changed'})]:
        changed = copy.deepcopy(el)
        changed['props'][name] = value
        assert cache.flow_key(changed, *args[1:]) != key
    changed = copy.deepcopy(el)
    changed['id'] = 'another-seed-source'
    assert cache.flow_key(changed, *args[1:]) != key
    assert cache.flow_key(el, {**papers[0], 'width_mm': 80}, *args[2:]) != key
    assert cache.flow_key(el, papers[0], res, {'name': 'B'}, mc.settings) != key
    mc.settings.dpi += 1
    assert cache.flow_key(*args) != key


def test_flow_warnings_mutability_and_corrupt_cache(tmp_path):
    doc, papers, res, mc = inputs(tmp_path)
    el = doc['pages'][0]['elements'][0]
    calls = []
    def build(el, paper, res, variables, settings, warn):
        calls.append(1)
        warn['missing'].add('B')
        warn['overflow'] = True
        warn['messages'].append('flow warning')
        return [[Path([1.123456789123, 2, 3, 4], [0, 1])]]
    def run():
        warn = {'missing': {'A'}, 'messages': ['earlier'], 'overflow': False}
        return cache.cached_flow(build, el, papers[0], res, {}, mc.settings, warn), warn
    first, warn = run()
    assert warn == {'missing': {'A', 'B'}, 'messages': ['earlier', 'flow warning'], 'overflow': True}
    first[0][0].coords[0] = 999
    second, other = run()
    assert len(calls) == 1
    assert second[0][0].coords[0] == 1.123456789123
    assert other == warn
    filename, = (tmp_path / 'cache' / f'layout-v{cache.VERSION}').glob('flow-*.layout')
    filename.write_bytes(b'broken')
    run()
    assert len(calls) == 2
    filename.write_bytes(cache.encode_composition([]))
    run()
    assert len(calls) == 3


def test_pure_flow_persists_only_local_layout_and_reuses_it(tmp_path, monkeypatch):
    args = inputs(tmp_path)
    expected = cache.encode_composition(compose_pages(*args))
    files = list((tmp_path / 'cache' / f'layout-v{cache.VERSION}').glob('*.layout'))
    assert len(files) == 1 and files[0].name.startswith('flow-')
    def fail(*args, **kwargs):
        raise AssertionError('pure flow repeated layout')
    monkeypatch.setattr(RichTextDocument, 'layout_and_render', fail)
    assert cache.encode_composition(compose_pages(*args)) == expected


def test_unsupported_path_does_not_break_uncached_result(tmp_path):
    args = inputs(tmp_path)
    pages = [(0, {}, [Path([1, 2], [0, 1])], {'missing': set()})]
    assert cache.cached_compose(lambda *a: pages, *args) is pages


def test_disk_cache_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(cache, 'MAX_ENTRIES', 2)
    for i in range(4):
        (tmp_path / ('%d.layout' % i)).write_bytes(b'1234')
    cache._prune(tmp_path)
    assert len(list(tmp_path.glob('*.layout'))) == 2
    monkeypatch.setattr(cache, 'MAX_BYTES', 4)
    cache._prune(tmp_path)
    assert len(list(tmp_path.glob('*.layout'))) == 1


def test_glyph_cache_is_bounded():
    glyphs = cache.GlyphPathCache(max_entries=2, max_bytes=68)
    p = Path([1, 2, 3, 4], [0, 1])
    for key in range(8):
        glyphs.put(key, p, 4)
    assert len(glyphs.entries) == 2
    assert glyphs.size == 68
    assert glyphs.get(0) is None
    assert glyphs.get(7)[1] == 4


@pytest.mark.parametrize('jitter', [{}, {'randomRotate': [-5, 5], 'randomY': 0.1},
                                  {'randomFontSize': [0.8, 0.8], 'randomRotate': [4, 4]}])
def test_glyph_cache_preserves_rng_layout_and_private_paths(jitter):
    from penplot.builtin_font import load_builtin
    font = load_builtin()
    def make(disabled):
        d = RichTextDocument(PageInfo(), font, FontsSet(**jitter), rng=random.Random(72))
        if disabled:
            d._glyph_cache.max_entries = 0
        result = d.layout_and_render('# AB\n\n**AB** ' + 'AB ' * 80)
        return d, [[(list(p.coords), list(p.ops)) for p in page] for page in result]
    cached, actual = make(False)
    plain, expected = make(True)
    assert actual == expected
    assert cached.rng.getstate() == plain.rng.getstate()
    if not jitter:
        first, _ = cached._glyph_paths('A', 10)
        coords = list(first[0].coords)
        first[0].coords[0] += 100
        second, _ = cached._glyph_paths('A', 10)
        assert list(second[0].coords) == coords
