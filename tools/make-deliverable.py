"""Build the delivery ZIP for BeatGrid Studio.

Explicit inclusion list rather than "zip everything except": the repository
contains node_modules (400+ packages) and .git (51 MB of history) which must
never ship, and upstream's examples/ (17 MB of sample media) which is not part
of this derivative work's value. Anything not listed here is excluded by
construction, so a stray local artefact cannot leak into the deliverable.
"""

import os
import zipfile

# This script lives in tools/, so the project root is one level up.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(os.path.dirname(ROOT), 'deliver5')
OUT = os.path.join(OUT_DIR, 'beatgrid-studio-beat-layer.zip')

# Directories copied recursively.
DIRS = [
    'src',
    'demo',
    'scripts',
    'tools',
    'dist',
    'cypress',
    'shots',
]

# Individual files.
FILES = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.test.json',
    'jest.config.js',
    'rollup.config.js',
    'eslint.config.js',
    'LICENSE',
    'NOTICE',
    'README.md',
    'UPSTREAM-README.md',
    'TECHNICAL.md',
    'TEST-REPORT.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'AGENTS.md',
    'AI_OVERVIEW.md',
    'index.html',
    '.gitignore',
    'yarn.lock',
]

SKIP_DIR_NAMES = {'node_modules', '.git', 'coverage', '__pycache__', '.angular'}
SKIP_RELATIVE = {os.path.join('shots', 'verify')}
SKIP_SUFFIXES = ('.pyc', '.map')


def should_skip(relative_path: str) -> bool:
    parts = relative_path.replace('\\', '/').split('/')
    if any(part in SKIP_DIR_NAMES for part in parts):
        return True
    normalised = relative_path.replace('\\', '/')
    if any(normalised.startswith(s.replace('\\', '/')) for s in SKIP_RELATIVE):
        return True
    if normalised.endswith(SKIP_SUFFIXES):
        return True
    return False


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    count = 0
    total_bytes = 0

    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in FILES:
            path = os.path.join(ROOT, name)
            if not os.path.exists(path):
                print(f'  skip (missing): {name}')
                continue
            archive.write(path, name)
            count += 1
            total_bytes += os.path.getsize(path)

        for directory in DIRS:
            base = os.path.join(ROOT, directory)
            if not os.path.isdir(base):
                print(f'  skip (missing dir): {directory}')
                continue
            for current, dir_names, file_names in os.walk(base):
                dir_names[:] = [d for d in dir_names if d not in SKIP_DIR_NAMES]
                for file_name in file_names:
                    full = os.path.join(current, file_name)
                    relative = os.path.relpath(full, ROOT)
                    if should_skip(relative):
                        continue
                    archive.write(full, relative.replace('\\', '/'))
                    count += 1
                    total_bytes += os.path.getsize(full)

    size = os.path.getsize(OUT)
    print(f'\n{OUT}')
    print(f'  files: {count}')
    print(f'  raw:   {total_bytes / 1024 / 1024:.2f} MB')
    print(f'  zip:   {size / 1024 / 1024:.2f} MB')


if __name__ == '__main__':
    main()
