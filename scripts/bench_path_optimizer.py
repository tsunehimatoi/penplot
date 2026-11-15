"""Reproducible optimizer benchmark; no machine I/O or private input needed."""
import argparse
import json
import random
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from penplot.geometry import Path as Stroke
from penplot.path_optimizer import optimize_paths, _optimize_paths_scan


def fixture(n, kind):
    if kind == 'text':
        from penplot.builtin_font import load_builtin
        from penplot.layout import FontsSet, PageInfo, TextDocument, page_presets
        from penplot.gcode import split_paths
        from penplot.settings import Settings
        doc = TextDocument(PageInfo(**page_presets()[0]), load_builtin(), FontsSet(),
                           settings=Settings(), rng=random.Random(231))
        text = ('THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 0123456789\n' * (n // 40 + 10))
        result = []
        for page in range(len(doc.layout(text))):
            result.extend(split_paths(doc.entities(text, page_index=page)))
            if len(result) >= n:
                return result[:n]
        raise ValueError('text fixture has insufficient strokes')
    rng = random.Random(231)
    result = []
    for i in range(n):
        if kind == 'duplicates':
            x, y = float(i % 8), 0.0
        elif kind == 'grid':
            x, y = float(i % 80), float(i // 80)
        else:
            x, y = rng.random() * 200, rng.random() * 280
        dx, dy = (0.0, 0.0) if kind == 'duplicates' else (0.2, 0.4)
        result.append(Stroke([x, y, x + dx, y + dy], [0, 1]))
    return result


def signature(paths):
    return [(p.coords, p.ops) for p in paths]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sizes', nargs='+', type=int, default=[16, 64, 256, 1024, 4400, 10000])
    parser.add_argument('--kinds', nargs='+', default=['random', 'grid', 'duplicates', 'text'])
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    # Exclude optional module import from steady-state comparison.
    _optimize_paths_scan(fixture(64, 'random'), 0.1)
    for kind in args.kinds:
        for n in args.sizes:
            paths = fixture(n, kind)
            times = {}
            expected = None
            for name, fn in [('legacy', _optimize_paths_scan), ('indexed', optimize_paths)]:
                samples = []
                for _ in range(args.repeats):
                    work = [p.clone() for p in paths]
                    start = time.perf_counter()
                    result = fn(work, 0.1)
                    samples.append(time.perf_counter() - start)
                    value = (signature(result), signature(work))
                    if expected is None:
                        expected = value
                    assert value == expected, (kind, n, name)
                times[name] = statistics.median(samples)
            print(json.dumps(dict(kind=kind, n=n, **times, speedup=times['legacy']/times['indexed'])), flush=True)


if __name__ == '__main__':
    main()

