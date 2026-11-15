"""PyInstaller entrypoint for the bundled Penplot desktop backend."""
import multiprocessing
import sys

from penplot.web.__main__ import main

if __name__ == '__main__':
    multiprocessing.freeze_support()
    sys.exit(main())
