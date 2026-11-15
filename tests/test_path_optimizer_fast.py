"""Exact legacy ordering, mutations and pathological endpoint regression tests."""
import builtins
import math
import random
import sys
from pathlib import Path as FilePath

import pytest

sys.path.insert(0, str(FilePath(__file__).resolve().parents[1]))
from penplot.geometry import Path
from penplot.path_optimizer import optimize_paths, _optimize_paths_py, _optimize_paths_scan as legacy


def snapshot(paths):
    return [(tuple('nan' if math.isnan(v) else v for v in p.coords), tuple(p.ops)) for p in paths]


def check(paths, near=0.1, reference=legacy):
    a, b = [p.clone() for p in paths], [p.clone() for p in paths]
    ids_a, ids_b = [id(p) for p in a], [id(p) for p in b]
    expected, actual = reference(a, near), optimize_paths(b, near)
    assert snapshot(actual) == snapshot(expected)
    assert snapshot(b) == snapshot(a)  # includes in-place merges and reversals
    assert [id(p) for p in a] == ids_a
    assert [id(p) for p in b] == ids_b
    assert [ids_b.index(id(p)) for p in actual] == [ids_a.index(id(p)) for p in expected]


def paths_for(n, seed=8):
    rng = random.Random(seed)
    return [Path([rng.random()*20 for _ in range(6)], [0, 1, 1]) for _ in range(n)]


@pytest.mark.parametrize('n', [0, 1, 16, 63, 64, 256, 2047, 2048, 4400])
@pytest.mark.parametrize('near', [-1.0, 0.1, math.inf])
def test_random_exact(n, near):
    check(paths_for(n), near)


@pytest.mark.parametrize('kind', ['identical', 'grid', 'equidistant', 'subnormal', 'overflow'])
def test_pathologies(kind):
    paths = []
    for i in range(2100):
        if kind == 'identical':
            coords = [0., 0., 0., 0.]
        elif kind == 'grid':
            coords = [float(i % 40), float(i // 40), float(i % 40)+1, float(i // 40)]
        elif kind == 'equidistant':
            x, y = [(1., 0.), (0., 1.), (-1., 0.), (0., -1.)][i % 4]
            coords = [x, y, -x, -y]
        elif kind == 'subnormal':
            coords = [float(i)*1e-180, 0., float(i+1)*1e-180, 0.]
        else:
            coords = [(-1.)**i*1e308, 0., (-1.)**i*1e308, 0.]
        paths.append(Path(coords, [0, 1]))
    check(paths, 0.)


@pytest.mark.parametrize('value', [math.inf, -math.inf, math.nan])
@pytest.mark.parametrize('position', [0, 1, 2099])
def test_nonfinite_fallback(value, position):
    paths = paths_for(2100)
    paths[position].coords[0] = value
    check(paths)


def test_head_and_original_index_win_ties():
    paths = [Path([0., 0.], [0]), Path([1., 0., -1., 0.], [0, 1]),
             Path([0., 1., 0., -1.], [0, 1])]
    paths += [Path([100.+i, 100.], [0]) for i in range(2100)]
    result = optimize_paths(paths, -1.)
    assert result[1] is paths[1]
    assert result[1].coords == [1., 0., -1., 0.]
    check([p.clone() for p in paths], -1.)


def test_empty_first_and_empty_later():
    check([Path()] + paths_for(2100))
    for fn in (legacy, optimize_paths):
        with pytest.raises(IndexError):
            fn(paths_for(2100) + [Path()], 0.)


def test_aliases_keep_legacy_mutation():
    a, b = paths_for(2100), paths_for(2100)
    a[100] = a[50]
    b[100] = b[50]
    assert snapshot(legacy(a, 0.1)) == snapshot(optimize_paths(b, 0.1))
    assert snapshot(a) == snapshot(b)


def test_integer_coordinates_keep_numpy_rounding():
    check([Path([2**54+i, i, 2**54+i+1, i+1], [0, 1]) for i in range(2100)])


def test_no_numpy_dependency(monkeypatch):
    original = builtins.__import__
    def without_numpy(name, *args, **kwargs):
        if name == 'numpy' or name.startswith('numpy.'):
            raise ImportError('test optional dependency')
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, '__import__', without_numpy)
    check(paths_for(70), reference=_optimize_paths_py)
    check(paths_for(2100), reference=_optimize_paths_py)


def test_shared_coordinate_list():
    a, b = paths_for(2100), paths_for(2100)
    a[100].coords = a[50].coords
    b[100].coords = b[50].coords
    assert snapshot(legacy(a, 0.1)) == snapshot(optimize_paths(b, 0.1))
    assert snapshot(a) == snapshot(b)


@pytest.mark.parametrize('near', [math.nan, 0.0, 1.0, math.nextafter(1.0, 0.0)])
def test_merge_boundary_and_near_nan(near):
    check([Path([float(i), 0.0], [0]) for i in range(2100)], near)


@pytest.mark.parametrize('machine_type', ['Grbl', 'Marlin', 'K_AT', 'Ebb'])
def test_gcode_byte_equivalence(monkeypatch, machine_type):
    import penplot.gcode as gcode
    from penplot.settings import MachineConfig
    paths = paths_for(2100)
    original = snapshot(paths)
    machine = MachineConfig(machine_type=machine_type)
    monkeypatch.setattr(gcode, 'optimize_paths', legacy)
    expected = gcode.generate_gcode(paths, machine)
    monkeypatch.setattr(gcode, 'optimize_paths', optimize_paths)
    assert gcode.generate_gcode(paths, machine) == expected
    assert snapshot(paths) == original
