from nexgent import token_counter


def test_encoder_falls_back_when_vocabulary_download_fails(monkeypatch):
    import tiktoken

    token_counter._encoder_cache.clear()
    monkeypatch.setattr(tiktoken, "get_encoding", lambda _name: (_ for _ in ()).throw(OSError("offline")))
    encoder = token_counter._get_encoder()
    assert len(encoder.encode("Hello 世界")) >= 3
    token_counter._encoder_cache.clear()
