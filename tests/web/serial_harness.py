"""Serial emulation installed only by tests; never imported by the application."""
from contextlib import contextmanager, asynccontextmanager
from unittest.mock import patch

from penplot.web.machine import service
from fake_serial import FakeGrbl, FakeMarlin


@contextmanager
def simulated_serial(time_scale=0.02):
    factory = service.make_controller
    exists = service.MachineService._port_exists

    def make_controller(mc, **kwargs):
        ctrl = factory(mc, **kwargs)
        open_port = ctrl.open

        def open_test_port(port, *args, **kw):
            if port == 'test-serial':
                kw['ser'] = FakeMarlin() if mc.type in ('Marlin', 'K_AT') else FakeGrbl(time_scale=time_scale)
            return open_port(port, *args, **kw)

        ctrl.open = open_test_port
        return ctrl

    def port_exists(self, port):
        return port == 'test-serial' or exists(self, port)

    def ports(self):
        return [{'path': 'test-serial', 'by_id': None, 'description': 'Test serial transport',
                 'vid': None, 'pid': None, 'busy_pid': None}]

    with patch.object(service, 'make_controller', make_controller), \
            patch.object(service.MachineService, '_port_exists', port_exists), \
            patch.object(service.MachineService, 'ports', ports):
        yield


def with_simulated_serial(app, time_scale=0.02):
    lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def test_lifespan(app):
        with simulated_serial(time_scale):
            async with lifespan(app):
                yield

    app.router.lifespan_context = test_lifespan
    return app
