"""Differential coverage of the accelerated analyzer against its frozen oracle."""
import random

import pytest

from penplot._gcode_analysis_reference import analyze_gcode_reference
from penplot.gcode import GcodeAnalysis, analyze_gcode, generate_gcode
from penplot.geometry import Path
from penplot.settings import MachineConfig


def equivalent(text, machine=None, rapid_rate=None, keep_arrays=True):
    args = dict(machine=machine, rapid_rate=rapid_rate, keep_arrays=keep_arrays)
    expected = analyze_gcode_reference(text, **args)
    actual = analyze_gcode(text, **args)
    for name in GcodeAnalysis.__slots__:
        assert getattr(actual, name) == getattr(expected, name), name
    assert actual.to_dict() == expected.to_dict()
    for line in (-1, 0, 1, actual.lines // 2, actual.lines + 3):
        assert actual.time_until(line) == expected.time_until(line)
        assert actual.state_at(line) == expected.state_at(line)


@pytest.mark.parametrize('keep_arrays', [False, True])
def test_edge_cases(keep_arrays):
    text = '\n'.join([
        '', ' ', '; comment', '(one)(two) G1 X1 Y2', 'G1 X5 (unfinished',
        '%', '$H', '$!中文', 'G1 X1\tY2', 'G1 X1Y2F3!', 'G1 X1Y2F3 ;中文!',
        'G20G21', 'G21G20', 'G90G91', 'G91G90', 'G1 X1Y2F3',
        'G1 X1Y2F0', 'G0 X-1Y+.2F-3', 'G1 X.1Y.2F3',
        'G2 X9Y4 I3J4', 'G3 X-4Y6R2', 'G4P2 G1X12', 'G4P-2',
        'G92X100Y100', 'G28G30G53', 'G53G1X4', 'G10G92X5',
        'M3M5M4', 'M280P0S1', 'M106S99', 'M107', 'G1Z2', 'G91Z-2',
        'G1 X1X2Y3Y4F5F6', 'G1.9X2', 'G-1X3', 'G+1X4',
        'g01 x１y٢f３', 'G1 X1e2Y2F3', 'G1 X1.Y2F3', 'M999 G999',
        'N1 G1X1Y1*7', 'G1X' + '9' * 400, 'G21G90G1X0Y0',
        'X1' + ' ' * 90, '?', '~', '!', '\x18', '中文',
    ])
    equivalent(text, keep_arrays=keep_arrays)
    equivalent('\n'.join(['$H', 'G28', 'M999'] * 230), keep_arrays=keep_arrays)


@pytest.mark.parametrize('keep_arrays', [False, True])
def test_random_streams(keep_arrays):
    rng = random.Random(51034)
    controls = ['G90', 'G91', 'G20', 'G21', 'G4', 'G10', 'G92', 'G28',
                'G30', 'G53', 'G2', 'G3', 'G17', 'G54', 'G94', 'G99',
                'M3', 'M4', 'M5', 'M8', 'M280', '$H', '%', 'M999']
    for _ in range(60):
        lines = []
        for _ in range(150):
            if rng.random() < .45:
                line = 'G%d X%.3fY%.3fF%d' % (
                    rng.randrange(2), rng.uniform(-100, 100), rng.uniform(-100, 100),
                    rng.choice([-10, 0, 1, 1500, 2500]))
            else:
                line = ''.join(rng.choices(controls, k=rng.randrange(4)))
                line += ''.join(rng.choice('XYZFPSEM') + str(rng.randint(-20, 20))
                                for _ in range(rng.randrange(6)))
            line += rng.choice(['', '', ' ; ignored !中文', '(comment)', '!', '\tX3', ' 中文'])
            lines.append(line.lower() if rng.random() < .15 else line)
        equivalent('\r\n'.join(lines), rapid_rate=rng.choice([0, -1, 3000]), keep_arrays=keep_arrays)


@pytest.mark.parametrize('firmware', ['Grbl', 'Marlin', 'K_AT', 'Ebb'])
@pytest.mark.parametrize('keep_arrays', [False, True])
def test_generated_firmware(firmware, keep_arrays):
    machine = MachineConfig()
    machine.type = firmware
    path = Path()
    path.move_to(10, 20)
    path.line_to(30, 40)
    path.move_to(-5, 0)
    path.line_to(5, 10)
    equivalent(generate_gcode([path], machine, optimize=False), machine, keep_arrays=keep_arrays)
