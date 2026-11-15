"""Profile a local Markdown import without storing its text in the repository.
Usage: .venv/Scripts/python scripts/bench_letter_pipeline.py INPUT.md OUTPUT_DIR
"""
import json
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'tests' / 'web'), str(ROOT)]
from conftest import H, make_app
from fastapi.testclient import TestClient
import penplot.compose as compose
from penplot.web.tasks.kinds import _render_project, _render_preview

source, output = Path(sys.argv[1]), Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory() as temporary:
    app = make_app(Path(temporary), PENPLOT_FONT_DIR=str(ROOT / 'fonts'))
    with TestClient(app) as client:
        start = time.perf_counter()
        imported = client.post('/api/v1/import/document', files={'file': (source.name, source.read_bytes(), 'text/markdown')}, headers=H)
        imported.raise_for_status()
        import_s = time.perf_counter() - start
        body = imported.json()
        doc = {'name': 'benchmark', 'print': {'optimize': False}, 'pages': [{'id': 'p', 'elements': [{
            'id': 'body', 'type': 'flow_text', 'props': {'text': body['content'], 'format': body['format'],
            'font_id': 'open-wenkai-stroke', 'seed': 7, 'text_size': 1,
            'paragraph': {'spe_type': 1, 'spe_value': 8, 'left': 0, 'right': 0}}
        }]}]}
        project = client.post('/api/v1/projects', json={'name': 'benchmark', 'doc': doc}, headers=H)
        project.raise_for_status()
        normalized = project.json()['doc']
        stages = {}
        def measured(name, fn):
            def run(*args, **kwargs):
                start = time.perf_counter()
                try: return fn(*args, **kwargs)
                finally: stages[name] = stages.get(name, 0) + time.perf_counter() - start
            return run
        for name in ('compose_pages', 'finish_page', 'encode_paths'):
            setattr(compose, name, measured(name, getattr(compose, name)))
        results = []
        for iteration in range(4):
            stages.clear()
            rid, args = app.state.ctx.render._args(normalized)
            progress = []
            start = time.perf_counter()
            result = (_render_project if iteration < 2 else _render_preview)(args, lambda fraction, message='': progress.append({'ms': round((time.perf_counter()-start)*1000), 'fraction':fraction}))
            total = time.perf_counter()-start
            results.append({'iteration': iteration, 'mode':'full' if iteration < 2 else 'canvas', 'import_ms': round(import_s*1000,1), 'render_ms':round(total*1000,1),
                'stages_ms':{k:round(v*1000,1) for k,v in stages.items()}, 'pages':len(result['pages']), 'progress':progress})
        data = []
        for page in result['pages']:
            blob = app.state.ctx.render.paths_bin(rid, page['index'])
            (output / ('%d.bin' % page['index'])).write_bytes(blob)
            data.append(len(blob))
        meta = {'pages':len(data), 'characters':len(body['content']), 'format':body['format'], 'bytes':sum(data)}
        (output/'meta.json').write_text(json.dumps(meta), encoding='utf-8')
        (output/'pipeline.json').write_text(json.dumps(results,indent=2), encoding='utf-8')
        print(json.dumps({'fixture':meta,'runs':[{k:v for k,v in r.items() if k!='progress'} for r in results]},indent=2))
