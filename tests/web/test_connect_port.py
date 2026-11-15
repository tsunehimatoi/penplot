"""Quick-connect uses discovered devices just like onboarding."""
from types import SimpleNamespace

import pytest
from unittest.mock import Mock
from penplot.web.machine.service import MachineService
from penplot.web.profiles import DEFAULT_CONNECTION


def device(path, vid=None, by_id=None):
    return dict(path=path, by_id=by_id, vid=vid, description='USB Serial',
                pid=None, busy_pid=None)


@pytest.mark.parametrize(('ports', 'expected'), [
    ([device('COM1'), device('COM37', '1a86')], 'COM37'),
    ([device('/dev/ttyS0'), device('/dev/ttyACM0')], '/dev/ttyACM0'),
    ([device('/dev/ttyUSB0', '1a86', '/dev/serial/by-id/actual')], '/dev/serial/by-id/actual'),
    ([], DEFAULT_CONNECTION['port']),
])
def test_quick_connect_discovers_port(monkeypatch, ports, expected):
    machine = MachineService.__new__(MachineService)
    machine.cfg = SimpleNamespace(serial_port=None)
    machine.profile = None
    machine.port = None
    machine._last_connection = None
    monkeypatch.setattr(machine, 'ports', lambda: ports)
    monkeypatch.setattr('penplot.web.machine.service.os.path.exists', lambda _: False)
    assert machine._resolve_port(None) == expected


def test_quick_connect_reuses_selected_port_and_honors_overrides(monkeypatch):
    machine = MachineService.__new__(MachineService)
    machine.cfg = SimpleNamespace(serial_port=None)
    machine.profile = None
    machine.port = 'COM38'
    machine._last_connection = ('COM38', 57600)
    monkeypatch.setattr(machine, 'ports', lambda: [device('COM37', '1a86'), device('COM38')])
    monkeypatch.setattr('penplot.web.machine.service.os.path.exists', lambda _: False)
    assert machine._resolve_port(None) == 'COM38'
    assert machine._resolve_port('missing-device') == 'missing-device'
    machine.cfg.serial_port = 'configured-device'
    assert machine._resolve_port(None) == 'configured-device'
    assert machine._resolve_port('COM37') == 'COM37'



def test_reconnect_preserves_baud_until_connection_profile_changes(monkeypatch):
    machine = MachineService(SimpleNamespace(cfg=SimpleNamespace(serial_port=''), bus=Mock()))
    profile = {'id': 'first', 'doc': {'connection': {'port': 'COM37', 'baud': 115200}}}
    machine.load_profile(profile)
    monkeypatch.setattr(machine, 'ports', lambda: [device('COM37', '1a86'), device('COM38')])
    monkeypatch.setattr(machine, '_close', Mock())
    monkeypatch.setattr(machine, '_take_lock', Mock())
    monkeypatch.setattr(machine, '_invalidate_origin', Mock())
    controller = Mock(firmware_version='1.1', query_status=Mock(return_value='Idle'))
    monkeypatch.setattr('penplot.web.machine.service.make_controller', lambda *a, **kw: controller)
    try:
        machine._connect_blocking('COM37', 57600, False)
        machine._connect_blocking(None, None, False)
        assert machine.baud == 57600
        machine.load_profile(profile)
        assert machine._last_connection == ('COM37', 57600)
        machine.load_profile({'id': 'second', 'doc': {'connection': {'port': 'COM38', 'baud': 9600}}})
        assert machine._last_connection is None
        assert machine._resolve_port(None) == 'COM38'
        machine._connect_blocking(None, None, False)
        assert machine.port == 'COM38'
        assert machine.baud == 9600
    finally:
        machine._exec.shutdown(wait=False)
