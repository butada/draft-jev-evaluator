"""Small, local SQLite store. One uvicorn process owns the background jobs."""
import json
import math
from decimal import Decimal
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

DB_PATH = Path(os.getenv('DATA_DIR', '/app/data')) / 'runs.sqlite3'
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


@contextmanager
def database():
    connection = sqlite3.connect(DB_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize():
    with database() as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, created TEXT NOT NULL, name TEXT NOT NULL,
                source TEXT NOT NULL, prompts TEXT NOT NULL, model TEXT NOT NULL,
                questions TEXT NOT NULL, status TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS candidates (
                run_id TEXT NOT NULL, id INTEGER NOT NULL, prompt_id INTEGER NOT NULL,
                prompt TEXT NOT NULL, status TEXT NOT NULL, text TEXT,
                model TEXT, evaluation TEXT, error TEXT, best INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (run_id, id)
            );
        ''')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS api_costs (
                origin_run_id TEXT, origin_candidate_id INTEGER, stage TEXT,
                amount REAL, PRIMARY KEY(origin_run_id, origin_candidate_id, stage)
            );
            CREATE TABLE IF NOT EXISTS run_cost_links (
                run_id TEXT, origin_run_id TEXT, origin_candidate_id INTEGER,
                PRIMARY KEY(run_id, origin_run_id, origin_candidate_id)
            );
        ''')
        db.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        run_columns = {row['name'] for row in db.execute('PRAGMA table_info(runs)')}
        for name in ['next_candidate_id', 'next_batch']:
            if name not in run_columns:
                db.execute(f'ALTER TABLE runs ADD COLUMN {name} INTEGER NOT NULL DEFAULT 1')
        if 'prompt_enabled' not in run_columns:
            db.execute('ALTER TABLE runs ADD COLUMN prompt_enabled TEXT')
        columns = {row['name'] for row in db.execute('PRAGMA table_info(candidates)')}
        for name, definition in [('requested_model', 'TEXT'), ('created', 'TEXT'), ('batch', 'INTEGER NOT NULL DEFAULT 1'), ('requested_effort', 'TEXT'), ('generation_metadata', 'TEXT'), ('origin_run_id', 'TEXT'), ('origin_candidate_id', 'INTEGER')]:
            if name not in columns:
                db.execute(f'ALTER TABLE candidates ADD COLUMN {name} {definition}')
        db.execute('UPDATE candidates SET requested_model=(SELECT model FROM runs WHERE runs.id=candidates.run_id) WHERE requested_model IS NULL')
        db.execute('UPDATE candidates SET created=(SELECT created FROM runs WHERE runs.id=candidates.run_id) WHERE created IS NULL')
        db.execute("UPDATE candidates SET status='中断', error='サーバーの再起動により処理が中断しました。' WHERE status IN ('待機中','生成中','評価待ち','評価中')")
        db.execute("UPDATE runs SET status='中断' WHERE status='実行中'")
        db.execute('UPDATE runs SET next_candidate_id=MAX(next_candidate_id, COALESCE((SELECT MAX(id)+1 FROM candidates WHERE run_id=runs.id),1)), next_batch=MAX(next_batch, COALESCE((SELECT MAX(batch)+1 FROM candidates WHERE run_id=runs.id),1))')
        for candidate in db.execute('SELECT * FROM candidates').fetchall():
            origin = (candidate['origin_run_id'] or candidate['run_id'], candidate['origin_candidate_id'] or candidate['id'])
            db.execute('INSERT OR IGNORE INTO run_cost_links VALUES (?,?,?)', (candidate['run_id'], *origin))
            generation = json.loads(candidate['generation_metadata']) if candidate['generation_metadata'] else {}
            evaluation = json.loads(candidate['evaluation']) if candidate['evaluation'] else {}
            amounts = {'generation': usage_cost(generation.get('usage')), 'evaluation': usage_cost(evaluation.get('raw', {}).get('usage'))}
            if not candidate['text'] and not evaluation:
                amounts['evaluation'] = 0.0
            for stage, amount in amounts.items():
                db.execute('INSERT INTO api_costs VALUES (?,?,?,?) ON CONFLICT(origin_run_id,origin_candidate_id,stage) DO UPDATE SET amount=excluded.amount WHERE api_costs.amount IS NULL', (*origin, stage, amount))


        if not db.execute("SELECT 1 FROM settings WHERE key='cost_migration_done'").fetchone():
            for run in db.execute('SELECT id,next_candidate_id FROM runs').fetchall():
                present = {row[0] for row in db.execute('SELECT id FROM candidates WHERE run_id=?', (run['id'],))}
                for number in range(1, run['next_candidate_id']):
                    if number not in present:
                        db.execute('INSERT OR IGNORE INTO run_cost_links VALUES (?,?,?)', (run['id'],run['id'],number))
                        for stage in ['generation','evaluation']:
                            db.execute('INSERT OR IGNORE INTO api_costs VALUES (?,?,?,NULL)', (run['id'],number,stage))
            db.execute("INSERT INTO settings VALUES ('cost_migration_done','true')")


def create_run(body, questions):
    run_id = uuid4().hex
    created = datetime.now(timezone.utc).isoformat()
    with database() as db:
        db.execute('INSERT INTO runs (id,created,name,source,prompts,model,questions,status,next_candidate_id,next_batch,prompt_enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?)', (
            run_id, created, body.name.strip() or body.source[:40],
            body.source, json.dumps(body.prompts, ensure_ascii=False), body.model,
            json.dumps(questions, ensure_ascii=False), '実行中', body.count * sum(body.prompt_enabled) + 1, 2, json.dumps(body.prompt_enabled),
        ))
        number = 0
        for index, prompt in enumerate(body.prompts):
            if not body.prompt_enabled[index]:
                continue
            for _ in range(body.count):
                number += 1
                db.execute('INSERT INTO candidates (run_id,id,prompt_id,prompt,status,requested_model,created,batch,requested_effort) VALUES (?,?,?,?,?,?,?,?,?)',
                           (run_id, number, index + 1, prompt, '待機中', body.model, created, 1, body.effort))
                initialize_cost(db, run_id, number)
    return run_id


def get_run(run_id):
    with database() as db:
        row = db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
        if row is None:
            return None
        result = dict(row)
        result['prompts'] = json.loads(result['prompts'])
        result['prompt_enabled'] = json.loads(result['prompt_enabled']) if result['prompt_enabled'] else [True] * len(result['prompts'])
        result['questions'] = json.loads(result['questions'])
        result['results'] = []
        for row in db.execute('SELECT * FROM candidates WHERE run_id=? ORDER BY id', (run_id,)):
            item = dict(row)
            item['promptId'] = item.pop('prompt_id')
            item['evaluation'] = json.loads(item['evaluation']) if item['evaluation'] else None
            item['favorite'] = bool(item.pop('best'))
            item['generation_metadata'] = json.loads(item['generation_metadata']) if item['generation_metadata'] else None
            item['costs'] = cost_summary(db, origin=(item['origin_run_id'] or run_id, item['origin_candidate_id'] or item['id']))
            result['results'].append(item)
        eligible = [c for c in result['results'] if c['evaluation'] and not c['evaluation']['ng']]
        top = max((c['evaluation']['total'] for c in eligible), default=None)
        for item in result['results']:
            item['auto_best'] = bool(item['evaluation'] and not item['evaluation']['ng'] and item['evaluation']['total'] == top)
        result['costs'] = cost_summary(db, run_id=run_id)
        return result


def update_candidate(run_id, candidate_id, **fields):
    allowed = {'status', 'text', 'model', 'evaluation', 'error', 'best', 'generation_metadata'}
    if not fields or not fields.keys() <= allowed:
        raise ValueError('Invalid candidate fields')
    for key in ['evaluation', 'generation_metadata']:
        if key in fields:
            fields[key] = json.dumps(fields[key], ensure_ascii=False)
    with database() as db:
        cursor = db.execute('UPDATE candidates SET ' + ','.join(f'{key}=?' for key in fields) + ' WHERE run_id=? AND id=?',
                            (*fields.values(), run_id, candidate_id))
        return cursor.rowcount > 0


def finish_run(run_id, status):
    with database() as db:
        db.execute('UPDATE runs SET status=? WHERE id=?', (status, run_id))


def list_runs(favorite_only=False):
    with database() as db:
        rows = db.execute('''SELECT r.id,r.created,r.name,r.model,r.status,
            COUNT(c.id) AS count,COALESCE(SUM(c.best),0) AS favorite_count,
            MAX(json_extract(c.evaluation, '$.total')) AS top_score,
            GROUP_CONCAT(DISTINCT c.requested_model) AS models
            FROM runs r LEFT JOIN candidates c ON c.run_id=r.id GROUP BY r.id
            HAVING (?=0 OR SUM(c.best)>0) ORDER BY r.created DESC''', (int(favorite_only),))
        result = [dict(row) for row in rows]
        for row in result:
            row['costs'] = cost_summary(db, run_id=row['id'])
        return result


def append_candidates(run_id, model, count, effort):
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        run = db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
        if run is None:
            raise LookupError('実行結果が見つかりません。')
        if run['status'] == '実行中':
            raise ValueError('この結果は実行中です。完了後に追加してください。')
        prompts = json.loads(run['prompts'])
        enabled = json.loads(run['prompt_enabled']) if run['prompt_enabled'] else [True] * len(prompts)
        number, batch = run['next_candidate_id'] - 1, run['next_batch']
        created = datetime.now(timezone.utc).isoformat()
        ids = []
        for index, prompt in enumerate(prompts):
            if not enabled[index]:
                continue
            for _ in range(count):
                number += 1
                ids.append(number)
                db.execute('INSERT INTO candidates (run_id,id,prompt_id,prompt,status,requested_model,created,batch,requested_effort) VALUES (?,?,?,?,?,?,?,?,?)',
                           (run_id, number, index + 1, prompt, '待機中', model, created, batch, effort))
                initialize_cost(db, run_id, number)
        db.execute("UPDATE runs SET status='実行中',next_candidate_id=?,next_batch=? WHERE id=?", (number + 1, batch + 1, run_id))
        return ids


def delete_candidates(run_id, candidate_ids):
    ids = list(set(candidate_ids))
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        run = db.execute('SELECT status FROM runs WHERE id=?', (run_id,)).fetchone()
        if run is None:
            raise LookupError('実行結果が見つかりません。')
        if run['status'] == '実行中':
            raise ValueError('実行中の結果は削除できません。完了後に削除してください。')
        placeholders = ','.join('?' for _ in ids)
        found = db.execute(f'SELECT COUNT(*) FROM candidates WHERE run_id=? AND id IN ({placeholders})', (run_id, *ids)).fetchone()[0]
        if found != len(ids):
            raise LookupError('選択した結果の一部が見つかりません。履歴を開き直してください。')
        db.execute(f'DELETE FROM candidates WHERE run_id=? AND id IN ({placeholders})', (run_id, *ids))
        remaining_errors = db.execute('SELECT COUNT(*) FROM candidates WHERE run_id=? AND error IS NOT NULL', (run_id,)).fetchone()[0]
        db.execute('UPDATE runs SET status=? WHERE id=?', ('一部失敗' if remaining_errors else '完了', run_id))
    return len(ids)


def get_questions(default):
    with database() as db:
        row = db.execute("SELECT value FROM settings WHERE key='questions'").fetchone()
        return json.loads(row['value']) if row else default


def save_questions(questions):
    with database() as db:
        db.execute("INSERT INTO settings (key,value) VALUES ('questions',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (json.dumps(questions, ensure_ascii=False),))


def rename_run(run_id, name):
    with database() as db:
        if not db.execute('UPDATE runs SET name=? WHERE id=?', (name, run_id)).rowcount:
            raise LookupError('実行結果が見つかりません。')


def merge_runs(run_ids):
    if len(set(run_ids)) != len(run_ids):
        raise ValueError('同じ履歴が重複して選ばれています。')
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        runs = []
        for run_id in run_ids:
            row = db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
            if row is None:
                raise LookupError('選択した履歴が見つかりません。更新して選び直してください。')
            run = dict(row)
            run['candidates'] = [dict(c) for c in db.execute('SELECT * FROM candidates WHERE run_id=? ORDER BY id', (run_id,))]
            runs.append(run)
        base = runs[0]

        def conditions(run):
            prompts = json.loads(run['prompts'])
            return {
                '元情報': run['source'],
                '評価基準': json.loads(run['questions']),
                '評価モデル': sorted({json.loads(c['evaluation'])['raw'].get('model', '未記録') for c in run['candidates'] if c['evaluation']}),
            }
        baseline = conditions(base)
        errors = []
        for run in runs:
            if run['status'] == '実行中':
                errors.append(f'「{run["name"]}」({run["id"][:8]})は実行中です。')
            if run is not base:
                for field, value in conditions(run).items():
                    if value != baseline[field]:
                        errors.append(f'「{run["name"]}」({run["id"][:8]}): {field}が「{base["name"]}」({base["id"][:8]})と異なります。')
        if errors:
            raise ValueError('マージできません。\n' + '\n'.join(errors))
        merged_prompts = []
        for run in runs:
            prompts = json.loads(run['prompts'])
            enabled = json.loads(run['prompt_enabled']) if run['prompt_enabled'] else [True] * len(prompts)
            for prompt in [p for p,e in zip(prompts,enabled) if e] + [c['prompt'] for c in run['candidates']]:
                if prompt not in merged_prompts:
                    merged_prompts.append(prompt)
        if len(merged_prompts) > 10:
            raise ValueError('マージ後のプロンプトが上限の10種類を超えます。選択する履歴を減らしてください。')
        merged_id = uuid4().hex
        created = datetime.now(timezone.utc).isoformat()
        name = ('マージ: ' + base['name'])[:120]
        copies = {}
        batches = {}
        for run in runs:
            for candidate in run['candidates']:
                origin = (candidate['origin_run_id'] or run['id'], candidate['origin_candidate_id'] or candidate['id'])
                if origin in copies:
                    copies[origin]['best'] = int(bool(copies[origin]['best'] or candidate['best']))
                    continue
                batch_key = (run['id'], candidate['batch'])
                if batch_key not in batches:
                    batches[batch_key] = len(batches) + 1
                copy = dict(candidate)
                copy.update(run_id=merged_id, prompt_id=merged_prompts.index(candidate['prompt'])+1, id=len(copies)+1, batch=batches[batch_key], origin_run_id=origin[0], origin_candidate_id=origin[1])
                copies[origin] = copy
        status = '一部失敗' if any(c['error'] for c in copies.values()) else '完了'
        db.execute('INSERT INTO runs (id,created,name,source,prompts,model,questions,status,next_candidate_id,next_batch,prompt_enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                   (merged_id, created, name, base['source'], json.dumps(merged_prompts,ensure_ascii=False), base['model'], base['questions'], status, len(copies)+1, len(batches)+1, json.dumps([True]*len(merged_prompts))))
        for copy in copies.values():
            columns = list(copy)
            db.execute('INSERT INTO candidates (' + ','.join(columns) + ') VALUES (' + ','.join('?' for _ in columns) + ')', tuple(copy.values()))
        for run_id in run_ids:
            db.execute('INSERT OR IGNORE INTO run_cost_links SELECT ?,origin_run_id,origin_candidate_id FROM run_cost_links WHERE run_id=?', (merged_id,run_id))
        return merged_id


def usage_cost(usage):
    amount = usage.get('cost') if isinstance(usage, dict) else None
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount) or amount < 0:
        return None
    return amount


def initialize_cost(db, run_id, candidate_id):
    db.execute('INSERT INTO run_cost_links VALUES (?,?,?)', (run_id,run_id,candidate_id))
    for stage in ['generation', 'evaluation']:
        db.execute('INSERT INTO api_costs VALUES (?,?,?,0)', (run_id,candidate_id,stage))


def record_cost(run_id, candidate_id, stage, amount):
    with database() as db:
        db.execute('UPDATE api_costs SET amount=? WHERE origin_run_id=? AND origin_candidate_id=? AND stage=?', (amount,run_id,candidate_id,stage))


def cost_summary(db, run_id=None, origin=None):
    if origin:
        rows = db.execute('SELECT stage,amount FROM api_costs WHERE origin_run_id=? AND origin_candidate_id=?', origin).fetchall()
    else:
        rows = db.execute('SELECT c.stage,c.amount FROM api_costs c JOIN run_cost_links l ON c.origin_run_id=l.origin_run_id AND c.origin_candidate_id=l.origin_candidate_id WHERE l.run_id=?', (run_id,)).fetchall()
    result = {'currency': 'USD', 'generation': 0.0, 'evaluation': 0.0, 'unknown': sum(row['amount'] is None for row in rows)}
    for stage in ['generation', 'evaluation']:
        result[stage] = float(sum((Decimal(str(row['amount'])) for row in rows if row['stage'] == stage and row['amount'] is not None), Decimal(0)))
    result['known_total'] = float(Decimal(str(result['generation'])) + Decimal(str(result['evaluation'])))
    result['total'] = None if result['unknown'] else result['known_total']
    return result
