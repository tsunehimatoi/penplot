"""E2E-only backend entry point with test serial transport."""
import os
from pathlib import Path
import sys

repo = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(repo), str(repo / 'tests' / 'web')]
from serial_harness import simulated_serial
from penplot.web.__main__ import main

if __name__ == '__main__':
    os.environ['PENPLOT_SERIAL_PORT'] = 'test-serial'
    if os.name == 'nt':
        os.environ.setdefault('PENPLOT_TASK_MODE', 'thread')
    with simulated_serial(float(os.environ.get('E2E_TIME_SCALE', '0.05'))):
        main(['serve'])
