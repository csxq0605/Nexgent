from PyQt6.QtGui import QImage

from nexgent.branding import APP_ICON_PATH, PALETTE, PRODUCT_NAME, TAGLINE


def test_identity_contract():
    assert PRODUCT_NAME == "Nexgent"
    assert TAGLINE == "Agents in motion."
    assert PALETTE == ("#171D3B", "#080B1D", "#4B63FF", "#8D43FF", "#22D3EE", "#E3E7FF")


def test_packaged_icon_is_1024_square():
    image = QImage(str(APP_ICON_PATH))
    assert not image.isNull()
    assert image.width() == image.height() == 1024
