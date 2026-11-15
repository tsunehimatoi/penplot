"""Production device discovery never supplies a simulated connection."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from penplot.web.app import create_app
from penplot.web.config import Config
from penplot.web.machine.service import MachineService
from conftest import H


@pytest.mark.parametrize('dev', ['0', '1'])
def test_no_device_stays_disconnected(tmp_path, monkeypatch, dev):
    monkeypatch.setattr('serial.tools.list_ports.comports', lambda: [])
    monkeypatch.setattr('penplot.web.machine.service.glob.glob', lambda _: [])
    open_serial = Mock(side_effect=AssertionError('must not open a missing device'))
    monkeypatch.setattr('serial.Serial', open_serial)
    cfg = Config.from_env(env={
        'PENPLOT_DEV': dev,
        'PENPLOT_TASK_MODE': 'thread',
        'PENPLOT_DATA_DIR': str(tmp_path / 'data'),
        'PENPLOT_CACHE_DIR': str(tmp_path / 'cache'),
        'PENPLOT_FONT_DIR': str(tmp_path / 'fonts'),
        # Old saved launch settings must not enable emulation either.
        'PENPLOT_SERIAL_PORT': 'fake',
    })
    app = create_app(cfg)
    with TestClient(app) as client:
        assert client.get('/api/v1/machine/ports').json() == []
        for port in [None, 'fake', 'missing-serial-device']:
            response = client.post('/api/v1/machine/connect', json={'port': port}, headers=H)
            assert response.status_code == 503
            assert response.json()['error']['code'] == 'port_not_found'
            status = client.get('/api/v1/machine/status').json()
            assert not status['connected'] and not status['connecting']
            assert status['state_text'] == '未连接'
            assert status['wpos'] is None and not status['origin_valid']
            assert 'fake' not in status
            assert not app.state.ctx.machine._last_pub['connecting']
        assert client.post('/api/v1/machine/fake/fault', json={'kind': 'unplug'}, headers=H).status_code in (404, 405)
        assert '/api/v1/machine/fake/fault' not in app.openapi()['paths']
    open_serial.assert_not_called()


def test_windows_port_is_discovered_without_a_filesystem_entry(monkeypatch):
    device = SimpleNamespace(device='COM37', description='USB Serial', vid=0x1a86, pid=0x7523)
    monkeypatch.setattr('serial.tools.list_ports.comports', lambda: [device])
    monkeypatch.setattr('penplot.web.machine.service.glob.glob', lambda _: [])
    machine = MachineService.__new__(MachineService)
    assert machine.ports()[0]['path'] == 'COM37'
    assert machine._port_exists('COM37')
    assert machine._port_exists('com37')
    assert not machine._port_exists('missing-serial-device')
