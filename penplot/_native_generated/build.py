"""Explicit, offline-capable native build (Rust toolchain required).

Run: python -m penplot._native_generated.build
No runtime compilation or network dependency resolution is performed.
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def main():
    package = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target-dir', type=Path, default=package.parents[1] / 'build' / 'generated-native')
    args = parser.parse_args()
    subprocess.run(['cargo', 'build', '--release', '--offline', '--locked', '--manifest-path',
                    str(package / 'Cargo.toml'), '--target-dir', str(args.target_dir)], check=True)
    name = ('penplot_generated.dll' if sys.platform == 'win32' else
            'libpenplot_generated.dylib' if sys.platform == 'darwin' else 'libpenplot_generated.so')
    destination = package / name
    shutil.copy2(args.target_dir / 'release' / name, destination)
    print(destination)


if __name__ == '__main__':
    main()
