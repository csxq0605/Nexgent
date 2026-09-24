"""Trusted plugin toolbox loading, performed before the source audit boundary."""

from importlib import import_module


class EmptyToolbox:
    def __init__(self, max_work_units=20_000_000):
        self.work_units = 0

    def receipts(self):
        return []


def toolbox_class(factory=None):
    if factory is None:
        return EmptyToolbox
    if not isinstance(factory, str) or factory.count(":") != 1:
        raise ValueError("Registered toolbox factory must be module:Class")
    module, name = factory.split(":")
    if not module or not name.isidentifier() or name.startswith("_"):
        raise ValueError("Invalid registered toolbox factory")
    return getattr(import_module(module), name)


def tool_methods(factory=None):
    cls = toolbox_class(factory)
    return [name for name in dir(cls) if not name.startswith("_") and callable(getattr(cls, name))]
