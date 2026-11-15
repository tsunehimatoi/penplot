"""Generated summaries must exactly match the independent public pipeline."""
import random
import sys
from pathlib import Path as FilePath

import pytest

sys.path.insert(0, str(FilePath(__file__).resolve().parents[1]))

import penplot.generated_gcode as generated
from penplot.compose import finish_page
from penplot.gcode import analyze_gcode, generate_gcode
from penplot._gcode_analysis_reference import analyze_gcode_reference
from penplot.geometry import Path
from penplot.settings import MachineConfig, Settings


def assert_equivalent(paths, machine):
    snapshot = [(list(p.coords), list(p.ops)) for p in paths]
    expected = generate_gcode(paths, machine, optimize=False)
    reference = analyze_gcode_reference(expected, machine, keep_arrays=False)
    actual, summary = generated.generate_analyzed_gcode(paths, machine)
    assert actual == expected
    for field in reference.__slots__:
        assert getattr(summary, field) == getattr(reference, field), field
    assert snapshot == [(list(p.coords), list(p.ops)) for p in paths]
    return actual, summary


def paths_fixture(seed=17):
    rng = random.Random(seed)
    paths = [Path(), Path([4, 7, 1, 2], [1, 1]),
             Path([1, 2, 1, 2, 1.0004, 2.0004, 1.0005, 2.0005], [0, 1, 1, 1]),
             Path([1.0005, 2.0005, 3, 4, -0.0004, -0.0005], [0, 0, 1])]
    for _ in range(50):
        coords = [rng.uniform(-300, 300) for _ in range(20)]
        paths.append(Path(coords, [0] + [rng.choice([0, 1, 1, 1]) for _ in range(9)]))
    return paths


@pytest.mark.parametrize('pen_type', ['Servo', 'Laser', 'Stepper'])
@pytest.mark.parametrize('rotate', [0, 90, -37.5])
@pytest.mark.parametrize('rates', [(1500, 2500), (0, 0), (-1, -3), (1234.567, 2345.678), (.5, .2)])
def test_fast_path_exact(pen_type, rotate, rates, monkeypatch):
    machine = MachineConfig(settings=Settings(rotate=rotate, feedRate=rates[0], jogSpeed=rates[1]))
    machine.grbl.type = pen_type
    def unexpected(*args, **kwargs):
        raise AssertionError('supported profile must not reparse')
    monkeypatch.setattr(generated, 'analyze_gcode', unexpected)
    assert_equivalent(paths_fixture(), machine)


@pytest.mark.parametrize('delay', [0, -1, 0.1234567, 1e-7, 1e20])
def test_delays(delay):
    assert_equivalent(paths_fixture(), MachineConfig(settings=Settings(toolOnDelay=delay, toolOffDelay=delay)))


@pytest.mark.parametrize('paths', [[], [Path([0, 0], [0])], [Path([0, 0, .0001, .0002], [0, 1])]])
def test_empty_and_rounded_zero(paths):
    assert_equivalent(paths, MachineConfig())


def test_unused_invalid_power_on_empty_page():
    machine = MachineConfig()
    machine.grbl.laserS = float('nan')
    assert_equivalent([], machine)


@pytest.mark.parametrize('firmware,pen_type', [('Grbl', 'Servo_bachin'),
    ('Marlin', 'Servo'), ('Marlin', 'Stepper'), ('Marlin', 'EStepper'), ('Marlin', 'Fan'),
    ('K_AT', 'Servo'), ('Ebb', 'Servo')])
def test_other_profiles_fallback(firmware, pen_type, monkeypatch):
    machine = MachineConfig(machine_type=firmware)
    machine.grbl.type = machine.marlin.type = pen_type
    calls = []
    def analyze(*args, **kwargs):
        calls.append(1)
        return analyze_gcode(*args, **kwargs)
    monkeypatch.setattr(generated, 'analyze_gcode', analyze)
    assert_equivalent(paths_fixture(), machine)
    assert calls == [1]


@pytest.mark.parametrize('commands', ['G91\nG1 X2 Y3', 'G20\nG1 X2',
    'G92 X2 Y3\nG53 G0 X5\nG28', '$H\n!\n中文', ';' + 'a' * 90,
    'G4 P.25\nM3\nG1 X5 F10', 'G2 X10 Y20 I3 J4'])
def test_custom_commands_fallback(commands):
    machine = MachineConfig()
    machine.advanced.startGcode = commands
    machine.advanced.endGcode = commands
    assert_equivalent(paths_fixture(), machine)


@pytest.mark.parametrize('coordinate', [1e80, float('inf'), float('nan')])
def test_unusual_coordinates_fallback(coordinate):
    assert_equivalent([Path([0, 0, coordinate, 2], [0, 1])], MachineConfig())


@pytest.mark.parametrize('seed', range(12))
def test_randomized_emission(seed):
    rng = random.Random(seed)
    machine = MachineConfig(settings=Settings(rotate=rng.uniform(-360, 360),
        toolOnDelay=rng.choice([0, .1, .12345678]), toolOffDelay=rng.choice([0, .2]),
        feedRate=rng.uniform(-1, 5000), jogSpeed=rng.uniform(-1, 6000)))
    machine.grbl.laserS = rng.choice([-1, 0, 1000, 10 ** 90])
    assert_equivalent(paths_fixture(seed), machine)


@pytest.mark.parametrize('heights', [(8, 0), (0, 8), (2, 2), (-3.123456, 4.56789), (1e-7, 0)])
@pytest.mark.parametrize('z_speed', [0, -1, .5, 5000, 1234.567])
def test_stepper_heights_and_feed(heights, z_speed):
    machine = MachineConfig()
    machine.grbl.type = 'Stepper'
    machine.grbl.zOn, machine.grbl.zOff = heights
    machine.grbl.zSpeed = z_speed
    assert_equivalent(paths_fixture(), machine)
    assert_equivalent([], machine)


@pytest.mark.parametrize('origin', [None, {'anchor': 'content'}, {'corner': 3, 'rotation': 90},
    {'corner': 2, 'revxy': True, 'x_rev': True, 'y_rev': True, 'offset_x_mm': 3.5, 'offset_y_mm': -7}])
@pytest.mark.parametrize('optimize', [False, True])
def test_finish_page(origin, optimize):
    machine = MachineConfig(settings=Settings(rotate=23))
    paths = paths_fixture()
    page = finish_page(0, 0, {'width_mm': 210, 'height_mm': 297}, paths,
                       {'missing': set()}, machine, origin, None,
                       {'optimize': optimize, 'placement': {'dx_mm': 2, 'dy_mm': 3}})
    expected, reference = assert_equivalent(page.machine_paths, machine)
    assert page.gcode == expected
    assert page.analysis.to_dict() == reference.to_dict()
