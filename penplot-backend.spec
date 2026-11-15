# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules
from pathlib import Path
import subprocess
import sys

# Release builds must include the native generator. Build-time Rust is needed;
# the desktop user only receives the resulting DLL/shared library.
subprocess.run([sys.executable, '-m', 'penplot._native_generated.build'], check=True)
native_dir = Path('penplot/_native_generated')
native_libraries = [(str(path), 'penplot/_native_generated')
                    for pattern in ('*.dll', '*.so', '*.dylib') for path in native_dir.glob(pattern)]
if not native_libraries:
    raise RuntimeError('native generation core was not built')

hiddenimports = []
hiddenimports += collect_submodules('penplot')
hiddenimports += collect_submodules('uvicorn')
hiddenimports += collect_submodules('mcp.server')
hiddenimports += collect_submodules('mcp.shared')
hiddenimports += collect_submodules('mcp.types')
hiddenimports += collect_submodules('serial')


a = Analysis(
    ['scripts/pyinstaller_backend.py'],
    pathex=['.'],
    binaries=native_libraries,
    datas=[('penplot/web/migrations', 'penplot/web/migrations')],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='penplot-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='desktop/assets/icon.ico',
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='penplot-backend',
)
