"""Real default-entry delivery and learning; no injected model or evaluator.

The host oracle checks delivered values, separately from the model evaluator.
This is a development validation, not a statistical RSI study.
"""
import json
import argparse
from pathlib import Path
import time

from nexgent import Nexgent


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('root', type=Path)
parser.add_argument('--max-model-calls', type=int, default=32)
parser.add_argument('--max-completion-tokens', type=int, default=160000)
parser.add_argument('--single-task', action='store_true',
                    help='Check one default-entry delivery; does not claim adoption or RSI')
ARGS = parser.parse_args()
ROOT = ARGS.root.resolve()
MODEL_ROOT = Path(__file__).resolve().parents[1]
OBJECTIVE = """处理 inputs.orders 中的订单修订记录，交付名为 result 的 JSON 工件。
每个 id 只保留 revision 最大的记录，去掉 status 为 cancelled 的订单。
负 quantity 表示退款，保留其符号。每个 product 汇总 quantity 和
quantity * unit_price_cents，金额使用整数分，不用浮点数。
result 严格为 {"products": {产品名: {"quantity":整数,"net_cents":整数}},
"total_cents":整数,"kept_orders":整数}，产品名升序，保留合计为零的产品。
产品组只从去重且剔除 cancelled 后的保留订单产生；仅取消订单出现的产品不建组。
今后会反复处理不同订单数据，需要参数化的可复用订单工具。
优先使用当前已安装且满足上述规则的订单工具；若不存在，开发一个通用
local_compute 工具，真实调用并检查结果。不要把本题记录或答案写进工具源码。
不需要成员招募、联网、文件或额外文字工件。"""


def orders(offset):
    return [
        dict(id='a'+str(offset), revision=1, product='alpha', quantity=9,
             unit_price_cents=125+offset, status='paid'),
        dict(id='a'+str(offset), revision=2, product='alpha', quantity=3+offset,
             unit_price_cents=125+offset, status='paid'),
        dict(id='b'+str(offset), revision=1, product='beta', quantity=4,
             unit_price_cents=210+offset, status='paid'),
        dict(id='b'+str(offset), revision=2, product='beta', quantity=4,
             unit_price_cents=210+offset, status='cancelled'),
        dict(id='c'+str(offset), revision=1, product='alpha', quantity=-1,
             unit_price_cents=125+offset, status='refunded'),
        dict(id='d'+str(offset), revision=1, product='gamma', quantity=2,
             unit_price_cents=399-offset, status='paid'),
        dict(id='e'+str(offset), revision=1, product='gamma', quantity=-2,
             unit_price_cents=399-offset, status='refunded'),
    ]


def oracle(rows):
    latest = {}
    for row in rows:
        if row['id'] not in latest or row['revision'] > latest[row['id']]['revision']:
            latest[row['id']] = row
    kept = [row for row in latest.values() if row['status'] != 'cancelled']
    groups = {}
    for row in kept:
        group = groups.setdefault(row['product'], dict(quantity=0, net_cents=0))
        group['quantity'] += row['quantity']
        group['net_cents'] += row['quantity'] * row['unit_price_cents']
    return dict(products=dict(sorted(groups.items())),
                total_cents=sum(g['net_cents'] for g in groups.values()),
                kept_orders=len(kept))


def save(name, value):
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / (name+'.json')).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def run_task(runtime, label, offset):
    rows = orders(offset)
    previous = sorted(ROOT.glob(label+'*-summary.json'))
    for path in reversed(previous):
        saved = json.loads(path.read_text(encoding='utf-8'))
        if saved.get('accepted') is True and saved.get('oracle_passed') is True:
            state = runtime.get(saved['episode_id'])
            actual = runtime.store.read(state['output_refs']['result'], state['id'])['content']
            if actual == oracle(rows):
                emit({'phase': label, 'reused_completed_episode': state['id']})
                return saved
    if previous:
        label += '-attempt-'+str(len(previous)+1)
    task = runtime.create(OBJECTIVE, inputs={'orders': rows},
                          deliverables=[{'name': 'result', 'schema': {'type': 'object'}}],
                          budget={'max_model_calls': ARGS.max_model_calls,
                                  'max_completion_tokens': ARGS.max_completion_tokens})
    emit({'phase': label, 'episode_id': task['id']})
    last = None
    def update(state):
        nonlocal last
        now = (state['status'], state['usage']['model_calls'], state['usage']['tool_calls'])
        if now != last:
            emit({'phase': label, 'status': now[0], 'models': now[1], 'tools': now[2]})
            last = now
    result = runtime.run(task['id'], on_update=update)
    save(label, result)
    value = runtime.store.read(result['output_refs']['result'], result['id'])['content'] if result['output_refs'].get('result') else None
    verified = value == oracle(rows)
    summary = {'episode_id': result['id'], 'status': result['status'],
               'accepted': (result.get('evaluation') or {}).get('accepted'),
               'oracle_passed': verified, 'delivery': value, 'expected': oracle(rows),
               'usage': result['usage'], 'package_digest': result['package_digest'],
               'models': sorted({r.get('observed_provider_model') or
                                 r.get('configured_provider_model') or ''
                                 for r in result.get('calls', [])})}
    save(label+'-summary', summary)
    emit({'phase': label, 'summary': summary})
    if not verified or summary['accepted'] is not True:
        raise RuntimeError('Real task delivery or independent acceptance failed: '+label)
    return summary


def main():
    start = time.time()
    runtime = Nexgent(ROOT, model_root=MODEL_ROOT)
    runtime.set_auto_improve(False)
    if ARGS.single_task:
        result = run_task(runtime, 'bounded-delivery', 7)
        save('bounded-summary', {'scope': 'one task delivery, not persistent improvement',
                                'elapsed_seconds': time.time()-start, 'result': result})
        return
    guard = run_task(runtime, 'guard-development', 1)
    source = run_task(runtime, 'source-development', 4)
    runtime.feedback(source['episode_id'], '今后复用已经实际成功调用的参数化订单工具，避免每次重新开发同一算法；保持相同规则和交付质量。')
    runtime.set_auto_improve(True)
    emit({'phase': 'learning', 'status': 'started'})
    runtime.advance(source['episode_id'])
    learning = runtime.improvement_status()
    save('learning', learning)
    emit({'phase': 'learning', 'summary': learning})
    if learning['active_revision'] == 0:
        raise RuntimeError('Real delivery passed, but no persistent change was published; '
                           'inspect learning.json. Restart reuse has not been proved.')
    runtime = Nexgent(ROOT, model_root=MODEL_ROOT)
    runtime.set_auto_improve(False)
    future = run_task(runtime, 'future-unseen', 7)
    final = dict(model='mimo-v2.6-pro', elapsed_seconds=time.time()-start,
                 guard=guard, source=source, learning=runtime.improvement_status(), future=future)
    if not any(future['episode_id'] in item['reuse_episode_ids']
               for item in final['learning']['items']):
        raise RuntimeError('Published version delivered, but actual capability reuse was not observed')
    save('verified-summary', final)
    emit({'phase': 'complete', 'active_revision': final['learning']['active_revision'],
          'future_oracle_passed': future['oracle_passed']})


if __name__ == '__main__':
    main()
