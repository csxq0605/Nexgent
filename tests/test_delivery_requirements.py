"""Evidence references and inline list markers are not numerical claims."""
from nexgent.delivery import _delivery_requirements


def test_known_reference_and_inline_list_do_not_require_computation():
    ref = 'artifact-c3e1b0c5308b4641'
    text = f'分析（{ref}）：1) 离线编辑；2) 联网同步；3) 冲突保留双方版本。'
    assert _delivery_requirements(text, {ref}) == {'computation': False, 'files': []}
    assert _delivery_requirements(text)['computation'] is True


def test_quantities_and_formulas_still_require_actual_computation():
    ref = 'artifact-c3e1b0c5308b4641'
    for text in (f'依据 {ref}，总价为 125.50 元。', '1) 总价 200 元；2) 退款 50 元。',
                 'Profit: 20. Next step: verify.', 'Check f(2) against the specification.'):
        assert _delivery_requirements(text, {ref})['computation'] is True
    assert _delivery_requirements({'total': 125.5}, {ref})['computation'] is True
    assert _delivery_requirements({'path': 'report2.txt', 'size': 123}) == {
        'computation': False, 'files': ['report2.txt']}
