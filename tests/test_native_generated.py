"""Run with PENPLOT_REQUIRE_NATIVE=1 after building to forbid silent fallback."""
import math
import os
import random
import sys
import threading
import time
from pathlib import Path as FilePath

import pytest

sys.path.insert(0, str(FilePath(__file__).resolve().parents[1]))

from penplot._gcode_analysis_reference import analyze_gcode_reference
from penplot.gcode import generate_gcode
from penplot.geometry import Path
from penplot.settings import MachineConfig
import penplot.native_generated as native
import penplot.generated_gcode as generated


@pytest.fixture
def enabled():
    available = native.native_available()
    if os.environ.get('PENPLOT_REQUIRE_NATIVE') == '1':
        assert available, 'build native core before running required-native tests'
    if not available:
        pytest.skip('optional native core has not been built')


def machine():
    return MachineConfig.load(str(FilePath(__file__).resolve().parents[1] / 'configs/grbl-zpen.json'))


def compare(paths, mc):
    result = native.try_generate(paths, mc)
    assert result is not None
    text, actual = result
    expected_text = generate_gcode(paths, mc, optimize=False)
    assert text == expected_text
    expected = analyze_gcode_reference(text, mc, keep_arrays=False)
    for field in expected.__slots__:
        value = getattr(expected, field)
        if field in ('draw_mm', 'travel_mm', 'est_s'):
            # Rust's libm hypot and CPython's compensated hypot can differ by
            # a few ulps. Sequential totals retain sub-nanometre precision.
            assert getattr(actual, field) == pytest.approx(value, rel=2e-14, abs=1e-10), field
        else:
            assert getattr(actual, field) == value, field
    return text, actual


@pytest.mark.parametrize('seed', range(20))
def test_native_randomized(enabled, seed):
    rng = random.Random(seed)
    mc = machine()
    mc.grbl.zOn, mc.grbl.zOff = rng.choice([(8., 0.), (-3., 2.), (2., 2.), (.123456789, -.987654321)])
    mc.grbl.zSpeed = rng.randrange(1, 10000)
    mc.settings.feedRate, mc.settings.jogSpeed = rng.randrange(1, 10000), rng.randrange(1, 10000)
    paths = [Path([rng.uniform(-1000, 1000) for _ in range(200)],
                  [rng.choice([0, 1, 1, 1]) for _ in range(100)]) for _ in range(10)]
    compare(paths, mc)


def test_native_rounding_and_duplicate_coordinates(enabled):
    values = [-0., 0., .0004, -.0004, 1e9, -1e9]
    for i in range(-10000, 10000):
        v = (i + .5) / 1000
        values.extend([math.nextafter(v, -math.inf), v, math.nextafter(v, math.inf)])
    coords = [v for value in values for v in (value, -value)]
    compare([Path(coords, [0] + [1] * (len(values) - 1)), Path([2, 3, 2, 3, 4, 5], [0, 0, 1])], machine())


@pytest.mark.parametrize('paths', [[], [Path()], [Path([0, 0], [0])], [Path([1, 2, 3, 4], [1, 1])]])
def test_native_empty_and_initial_lines(enabled, paths):
    compare(paths, machine())


def test_default_dispatch_uses_native(enabled, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('default Stepper must use the native core')
    monkeypatch.setattr(generated, 'GcodeBuilder', forbidden)
    generated.generate_analyzed_gcode([Path([0, 0, 1, 1], [0, 1])], machine())


@pytest.mark.parametrize('field,value', [('rotate', 30), ('toolOnDelay', .1), ('feedRate', 0),
                                        ('feedRate', 12.5), ('jogSpeed', -1)])
def test_native_unsupported_settings_fallback(enabled, field, value):
    mc = machine()
    setattr(mc.settings, field, value)
    assert native.try_generate([], mc) is None


def test_native_invalid_points_and_custom_commands_fallback(enabled):
    mc = machine()
    for value in [float('nan'), float('inf'), 1e10]:
        assert native.try_generate([Path([0, 0, value, 1], [0, 1])], mc) is None
    mc.advanced.startGcode = 'G91'
    assert native.try_generate([], mc) is None


def test_native_disabled_fallback(enabled, monkeypatch):
    monkeypatch.setenv('PENPLOT_NATIVE_GENERATION', '0')
    assert native.try_generate([], machine()) is None


def test_native_rejection_preserves_iterator(enabled):
    paths = [Path([0, 0, 1e10, 2], [0, 1])]
    mc = machine()
    text, _ = generated.generate_analyzed_gcode(iter(paths), mc)
    assert text == generate_gcode(paths, mc, optimize=False)


def test_native_call_releases_gil(enabled, monkeypatch):
    lib = native._load()
    call = lib.penplot_generate
    gate = threading.Event()
    observed = []
    worker = threading.Thread(target=lambda: (gate.wait(), observed.append(time.perf_counter())))
    worker.start()
    bounds = []
    def measured(*args):
        bounds.append(time.perf_counter())
        gate.set()
        result = call(*args)
        bounds.append(time.perf_counter())
        return result
    monkeypatch.setattr(lib, 'penplot_generate', measured)
    old_interval = sys.getswitchinterval()
    try:
        # Disable normal interpreter timeslicing during the call boundary.
        # The waiting Python thread can run only if CDLL releases the GIL.
        sys.setswitchinterval(10.)
        path = Path([float(i % 997) for i in range(400000)], [0] + [1] * 199999)
        assert native.try_generate([path], machine()) is not None
    finally:
        sys.setswitchinterval(old_interval)
        gate.set()
        worker.join(timeout=5)
    assert observed and bounds[0] <= observed[0] < bounds[1]
