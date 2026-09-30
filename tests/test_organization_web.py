import socket
import threading

import pytest
import requests

from nexgent.organization_tools import WorkspaceTools


def fake_source(monkeypatch, body, media_type='text/html; charset=utf-8', *, redirect=None):
    calls = []
    def address(host, *args, **kwargs):
        ip = '127.0.0.1' if host == '127.0.0.1' else '93.184.216.34'
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 443))]
    monkeypatch.setattr(socket, 'getaddrinfo', address)
    def get(session, url, **kwargs):
        assert not session.trust_env
        assert not kwargs['allow_redirects']
        calls.append(url)
        response = requests.Response()
        response.url = url
        response.status_code = 302 if redirect else 200
        response.headers = {'Content-Type': media_type}
        if redirect:
            response.headers['Location'] = redirect
        response.encoding = 'utf-8'
        response._content = body
        response._content_consumed = True
        return response
    monkeypatch.setattr(requests.Session, 'get', get)
    return calls


def test_web_reader_extracts_html_and_paginates_source(monkeypatch, tmp_path):
    body = ('<html><title>Primary source</title><script>do not expose script</script><p>facts</p><p>' + 'x' * 32000 + '</p></html>').encode()
    fake_source(monkeypatch, body)
    tools = WorkspaceTools(tmp_path, tmp_path / 'output')
    first = tools.call('fetch_url', {'url': 'https://source.example/doc', 'start': 0})
    assert first['title'] == 'Primary source'
    assert 'do not expose script' not in first['text']
    assert 'facts' in first['text'] and first['next_start'] == 30000
    second = tools.call('fetch_url', {'url': first['url'], 'start': first['next_start']})
    assert not second['truncated'] and second['next_start'] is None
    assert len(first['text'] + second['text']) > 32000


def test_private_redirect_and_credentials_are_not_fetched(monkeypatch, tmp_path):
    calls = fake_source(monkeypatch, b'', redirect='http://127.0.0.1/config')
    tools = WorkspaceTools(tmp_path, tmp_path / 'output')
    for url in ['https://source.example/doc', 'http://user:password@source.example/', 'file:///private.txt']:
        with pytest.raises(ValueError):
            tools.call('fetch_url', {'url': url, 'start': 0})
    assert calls == ['https://source.example/doc']


@pytest.mark.parametrize('body,media_type', [(b'PDF', 'application/pdf'), (b'x' * 1000001, 'text/plain')], ids=['binary', 'oversized'])
def test_web_reader_rejects_binary_and_oversized_sources(monkeypatch, tmp_path, body, media_type):
    fake_source(monkeypatch, body, media_type)
    with pytest.raises(ValueError):
        WorkspaceTools(tmp_path, tmp_path / 'output').call('fetch_url', {'url': 'https://source.example/doc', 'start': 0})


def test_cancelled_web_read_makes_no_request(monkeypatch, tmp_path):
    calls = fake_source(monkeypatch, b'facts')
    stop = threading.Event()
    stop.set()
    with pytest.raises(InterruptedError):
        WorkspaceTools(tmp_path, tmp_path / 'output', stop_event=stop).call('fetch_url', {'url': 'https://source.example/doc', 'start': 0})
    assert not calls


def test_long_sources_remain_available_without_duplicating_model_context(monkeypatch, tmp_path):
    import json
    from nexgent.organization import OrganizationService
    from test_organization import Model

    fake_source(monkeypatch, b'x' * 90000, 'text/plain')

    class ReadSources(Model):
        def ask(self, role, prompt, payload, **kwargs):
            assert len(json.dumps(payload, ensure_ascii=False)) < 240000
            result = super().ask(role, prompt, payload, **kwargs)
            if 'Perform your assigned' in prompt:
                trace = payload['tool_results']
                if len(trace) < 3:
                    return {'tool': 'fetch_url', 'arguments': {'url': 'https://source.example/doc', 'start': len(trace) * 30000}}
            if 'Synthesize' in prompt or 'Read the shared findings' in prompt:
                assert all(set(f) == {'member', 'answer'} for f in payload['shared_findings'])
                assert len(payload['execution_evidence']) == 2
            if role == 'improver':
                assert 'result' not in payload['attempts'][0]
                return {'organization': None, 'reason': 'Keep distinct source verification'}
            return result

    run = OrganizationService(tmp_path, gateway_factory=ReadSources).run('Read and independently verify the long source')
    assert run['status'] == 'completed'
    for member in run['result']['execution_evidence']:
        assert ''.join(t['result']['text'] for t in member['tool_results']) == 'x' * 90000
