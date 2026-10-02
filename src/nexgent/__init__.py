"""Nexgent: a general RSI agent framework with pluggable benchmarks."""

__version__ = "0.9.0"


def __getattr__(name):
    if name == 'Nexgent':
        from .application import Nexgent
        return Nexgent
    raise AttributeError(name)
