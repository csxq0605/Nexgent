from nexgent.gui.app import _build_parser


def test_gui_entry_accepts_project_and_smoke_mode():
    args = _build_parser().parse_args(["--project", ".", "--smoke-test"])
    assert args.project == "."
    assert args.smoke_test is True
