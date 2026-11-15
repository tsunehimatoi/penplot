"""Bit-exact native geometry parity, including Python bbox corner cases."""
import math
import os
import random
import struct
import sys
from array import array
from pathlib import Path as FilePath
from types import SimpleNamespace

import pytest
sys.path.insert(0, str(FilePath(__file__).resolve().parents[1]))
from penplot import native_geometry as native
from penplot.geometry import Path, bbox_of, rotate_all_around, translate_all, scale_all
from penplot.layout import export_transform_mm
from penplot.packed_paths import PackedPaths


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '1')
    if not native.native_available():
        if os.environ.get('PENPLOT_REQUIRE_NATIVE') == '1':
            pytest.fail('geometry native ABI required')
        pytest.skip('optional geometry library unavailable')


def bits(values):
    return [b'nan' if math.isnan(v) else struct.pack('d', v) for v in values]


def paths():
    rng = random.Random(123)
    return [Path([rng.uniform(-300, 300) for _ in range(600)], [0] + [1] * 299)
            for _ in range(4)]


@pytest.mark.parametrize('rotation', [0, 30, 90, 180, 270])
@pytest.mark.parametrize('corner', [0, 1, 2, 3])
@pytest.mark.parametrize('mapping', range(8))
@pytest.mark.parametrize('machine', [None, 'Ebb'])
@pytest.mark.parametrize('anchor', ['paper', 'content', 'explicit', 'origin_override'])
def test_export(enabled, monkeypatch, rotation, corner, mapping, machine, anchor):
    original = paths()
    original[0].coords[:8] = [-0., 0., float('nan'), 1., float('inf'), -1., 1e-300, -1e-300]
    expected = [p.clone() for p in original]
    original = PackedPaths.from_paths(original)
    origin = dict(rotation=rotation, corner=corner, revxy=bool(mapping & 1),
                  x_rev=bool(mapping & 2), y_rev=bool(mapping & 4),
                  offset_x_mm=1.25, offset_y_mm=-2.5)
    anchor_bbox = None
    if anchor != 'paper':
        origin['anchor'] = 'content'
    if anchor in ('explicit', 'origin_override'):
        anchor_bbox = (12.3, -0., 190.2, 270.8)
    if anchor == 'origin_override':
        origin['anchor_bbox'] = (-0., 5.6, 180.1, 290.3)
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '0')
    export_transform_mm(expected, 210, 297, origin, machine, anchor_bbox)
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '1')
    assert native.try_export_mm  # public path must really invoke the native bridge
    calls = []
    real = native._transform
    monkeypatch.setattr(native, '_transform', lambda *a: (calls.append(1), real(*a))[-1])
    export_transform_mm(original, 210, 297, origin, machine, anchor_bbox)
    assert original._paths is None
    assert calls == ([1, 1] if anchor == 'content' and rotation else [1])
    for a, b in zip(original, expected):
        assert bits(a.coords) == bits(b.coords)


def test_bulk_and_bbox(enabled, monkeypatch):
    original = paths()
    original[0].coords[:6] = [-0., 0., float('nan'), float('nan'), 2., -3.]
    original[1].coords[:2] = [float('nan'), float('nan')]
    expected = [p.clone() for p in original]
    original = PackedPaths.from_paths(original)
    def apply(ps):
        rotate_all_around(ps, 37, -2., 3.)
        translate_all(ps, -.0, 1.234)
        scale_all(ps, -1., .01)
        return bbox_of(ps)
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '0')
    expected_bbox = apply(expected)
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '1')
    actual_bbox = apply(original)
    assert bits(actual_bbox) == bits(expected_bbox)
    assert [bits(p.coords) for p in original] == [bits(p.coords) for p in expected]


def test_packed_zero_copy(enabled):
    coords = array('d', [-0., 0., 2., 3.])
    packed = SimpleNamespace(xy=coords, offsets=array('Q', [0, 0, 2]))
    assert native._buffers(packed)[0] is coords
    assert native.try_transform(packed, [(1, 4., -2., 0, 0, 0, 0)])
    assert list(coords) == [4., -2., 6., 1.]
    assert native.try_bbox(packed) == (4., -2., 6., 1.)
    empty = SimpleNamespace(xy=array('d'), offsets=array('Q', [0]))
    assert native.try_bbox(empty) is None


def test_alias_and_fallback(enabled, monkeypatch):
    p = paths()[0]
    original = p.coords[:]
    assert not native.try_transform([p, p], [(1, 2., 3., 0, 0, 0, 0)])
    translate_all([p, p], 2., 3.)
    assert p.coords == [((v + 2.) + 2.) if i % 2 == 0 else ((v + 3.) + 3.)
                        for i, v in enumerate(original)]
    q = Path()
    q.coords = p.coords
    assert native._buffers([p, q]) is None
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '0')
    assert native.try_bbox([p]) is native.UNSUPPORTED


@pytest.mark.parametrize('first', [-0., 0., float('nan')])
def test_bbox_ordering(enabled, monkeypatch, first):
    ps = [Path([first, first, 0., -0.], [0, 1]), Path()]
    monkeypatch.setattr(native, 'MIN_COORDS', 0)
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '0')
    expected = bbox_of(ps)
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '1')
    actual = bbox_of(PackedPaths.from_paths(ps))
    assert actual is None if expected is None else bits(actual) == bits(expected)


def test_materialized_mutation_then_geometry(enabled, monkeypatch):
    from penplot.packed_paths import PackedPaths
    source = paths()
    packed = PackedPaths.from_paths(source)
    legacy = packed[0]
    legacy.coords[0] = 9876.
    expected = [p.clone() for p in packed]
    assert native._buffers(packed) is None
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '0')
    wanted_bbox = bbox_of(expected)
    export_transform_mm(expected, 210, 297, dict(rotation=90, corner=3))
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '1')
    assert packed.bbox() == wanted_bbox
    export_transform_mm(packed, 210, 297, dict(rotation=90, corner=3))
    assert packed[0] is legacy
    assert [bits(p.coords) for p in packed] == [bits(p.coords) for p in expected]
    assert packed.buffers()[0][0] == legacy.coords[0]


@pytest.mark.parametrize('source', [[], [Path()], [Path([-0., 0., 1., 2.], [0, 1])]])
@pytest.mark.parametrize('probe', [None, (float('nan'), 1., 3., 4.), (-0., -0., 0., 0.)])
@pytest.mark.parametrize('rotation', [0, 30, 90])
def test_content_edge_cases(enabled, monkeypatch, source, probe, rotation):
    expected = [p.clone() for p in source]
    actual = PackedPaths.from_paths(source)
    origin = dict(anchor='content', rotation=rotation, corner=3)
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '0')
    export_transform_mm(expected, 210, 297, origin, anchor_bbox=probe)
    monkeypatch.setenv('PENPLOT_NATIVE_GEOMETRY', '1')
    export_transform_mm(actual, 210, 297, origin, anchor_bbox=probe)
    assert actual._paths is None
    assert [bits(p.coords) for p in actual] == [bits(p.coords) for p in expected]


def test_finish_content_frame_stays_packed(enabled):
    from penplot.compose import finish_page
    from penplot.settings import MachineConfig
    from penplot.gcode import generate_gcode
    from penplot.native_generated import native_available
    if not native_available():
        pytest.skip('generation library needed to check complete packed pipeline')
    mc = MachineConfig.load(str(FilePath(__file__).resolve().parents[1] / 'configs/grbl-zpen.json'))
    source = paths()
    origin = dict(anchor='content', anchor_bbox=(15., 20., 195., 277.))
    actual = finish_page(0, 0, dict(width_mm=210, height_mm=297), source,
                         {'missing': set()}, mc, origin, (300, 300), {'optimize': False})
    assert actual.page_paths._paths is None
    assert actual.machine_paths._paths is None
    expected = [p.clone() for p in source]
    export_transform_mm(expected, 210, 297, origin, machine_type=mc.type)
    assert actual.gcode == generate_gcode(expected, mc, optimize=False)
    assert actual.machine_bbox == bbox_of(expected)
