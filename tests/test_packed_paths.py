"""Continuous page buffers retain legacy path/encoding/export behavior."""
import pickle
from pathlib import Path as FilePath

import pytest

from penplot.compose import encode_paths, finish_page
from penplot.geometry import Path, bbox_of, translate_all
from penplot.layout import export_transform_mm
from penplot.packed_paths import PackedPaths
from penplot.settings import MachineConfig
from penplot.gcode import generate_gcode
from penplot.generated_gcode import generate_analyzed_gcode
from penplot.native_generated import native_available
from penplot.native_geometry import native_available as geometry_available


def paths():
    return [Path(), Path([9, 8, 1, 2, 3, 4, 4, 5, 6, 7], [1, 0, 1, 0, 0]),
            Path([.123456789012345, -0., 3.0045, 2.0055], [0, 1])]


def snapshot(items):
    return [(p.coords, p.ops) for p in items]


def machine():
    return MachineConfig.load(str(FilePath(__file__).resolve().parents[1] / 'configs/grbl-zpen.json'))


def test_split_encode_and_legacy_mutation():
    expected = [sub for p in paths() for sub in p.subpaths()]
    packed = PackedPaths.from_paths(paths(), split=True)
    assert packed.offsets.tolist() == [0, 2, 3, 4, 6]
    for flip in (False, True):
        assert encode_paths(packed, flip) == encode_paths(expected, flip)
    assert packed._paths is None
    assert snapshot(pickle.loads(pickle.dumps(packed))) == snapshot(expected)
    assert snapshot(packed) == snapshot(expected)
    packed[0].coords[0] = 42
    assert packed.buffers()[0][0] == 42
    assert snapshot(packed.clone()) == snapshot(packed)
    assert packed.bbox() == bbox_of(list(packed))


def test_legacy_mutation_then_geometry():
    packed = PackedPaths.from_paths(paths(), split=True)
    packed[0].coords[0] = 42
    expected = [p.clone() for p in packed]
    translate_all(packed, 3.5, 8.5)
    translate_all(expected, 3.5, 8.5)
    assert snapshot(packed) == snapshot(expected)
    assert packed.buffers()[0].tolist() == [v for p in expected for v in p.coords]


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
@pytest.mark.parametrize('anchor', ['paper', 'content'])
@pytest.mark.parametrize('corner', [0, 1, 2, 3])
def test_finish_matches_reference(rotation, anchor, corner):
    origin = dict(rotation=rotation, anchor=anchor, corner=corner,
                  offset_x_mm=2.3, offset_y_mm=4.5, revxy=True, x_rev=True)
    mc = machine()
    original = paths()
    ordered = [sub for p in original for sub in p.subpaths()]
    transformed = [p.clone() for p in ordered]
    export_transform_mm(transformed, 210, 297, origin, machine_type=mc.type)
    actual = finish_page(0, 0, dict(width_mm=210, height_mm=297), original,
                         {'missing': set()}, mc, origin, (300, 300), {'optimize': False})
    assert actual.gcode == generate_gcode(transformed, mc, optimize=False)
    assert actual.bbox == bbox_of(ordered)
    assert actual.machine_bbox == bbox_of(transformed)
    assert encode_paths(actual.page_paths) == encode_paths(ordered)
    assert encode_paths(actual.machine_paths) == encode_paths(transformed)
    assert actual.page_paths._paths is None
    if native_available() and geometry_available():
        assert actual.machine_paths._paths is None
    assert snapshot(actual.machine_paths) == snapshot(transformed)


def test_native_borrows_and_fallback(monkeypatch):
    mc = machine()
    source = paths()
    packed = PackedPaths.from_paths(source, split=True)
    expected = generate_gcode(source, mc, optimize=False)
    if native_available():
        assert generate_analyzed_gcode(packed, mc)[0] == expected
        assert packed._paths is None
    monkeypatch.setenv('PENPLOT_NATIVE_GENERATION', '0')
    assert generate_analyzed_gcode(packed, mc)[0] == expected


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
@pytest.mark.parametrize('corner', [0, 1, 2, 3])
def test_letter_frame_origin_stays_packed(rotation, corner):
    if not geometry_available() or not native_available():
        pytest.skip('requires both native kernels')
    origin = {'anchor': 'content', 'anchor_bbox': [15., 20., 195., 277.],
              'rotation': rotation, 'corner': corner, 'offset_x_mm': 1.25, 'offset_y_mm': 2.5}
    mc = machine()
    expected = [sub for p in paths() for sub in p.subpaths()]
    export_transform_mm(expected, 210, 297, origin, machine_type=mc.type)
    actual = finish_page(0, 0, {'width_mm': 210, 'height_mm': 297}, paths(),
                         {'missing': set()}, mc, origin, (300, 300), {'optimize': False})
    assert actual.machine_paths._paths is None
    assert actual.page_paths._paths is None
    assert actual.gcode == generate_gcode(expected, mc, optimize=False)
    assert encode_paths(actual.machine_paths) == encode_paths(expected)


@pytest.mark.parametrize('source', [[], [Path()], [Path([1, 2], [1])]])
def test_empty(source):
    packed = PackedPaths.from_paths(source, split=True)
    assert packed.bbox() is None
    assert encode_paths(packed) == encode_paths([])
    assert generate_analyzed_gcode(packed, machine())[0] == generate_gcode([], machine(), optimize=False)
