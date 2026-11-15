"""Build and package the optional Rust core; mark native wheels by platform."""
import os
import shutil
import subprocess
import sys
from pathlib import Path
from setuptools import Distribution, setup
from setuptools.command.build_py import build_py


ROOT = Path(__file__).resolve().parent
PACKAGE = ROOT / 'penplot' / '_native_generated'
LIBRARY = ('penplot_generated.dll' if sys.platform == 'win32' else
           'libpenplot_generated.dylib' if sys.platform == 'darwin' else 'libpenplot_generated.so')


def build_native():
    requested = os.environ.get('PENPLOT_BUILD_NATIVE', 'auto')
    return requested == '1' or (requested == 'auto' and shutil.which('cargo') is not None)


class BuildPy(build_py):
    def run(self):
        super().run()
        if build_native():
            target = ROOT / 'build' / 'generated-native-wheel'
            subprocess.run(['cargo', 'build', '--release', '--offline', '--locked',
                '--manifest-path', str(PACKAGE / 'Cargo.toml'), '--target-dir', str(target)], check=True)
            destination = Path(self.build_lib) / 'penplot' / '_native_generated' / LIBRARY
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target / 'release' / LIBRARY, destination)


class NativeDistribution(Distribution):
    def has_ext_modules(self):
        return build_native() or (PACKAGE / LIBRARY).exists()


setup(distclass=NativeDistribution, cmdclass={'build_py': BuildPy})
