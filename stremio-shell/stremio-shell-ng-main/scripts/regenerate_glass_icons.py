"""Regenerate MyStremio glass icons and installer BMPs."""
from __future__ import annotations

import subprocess
from io import BytesIO
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[3]
IMG_DIR = Path(__file__).resolve().parents[1] / "images"
GIT_PATH = "stremio-shell/stremio-shell-ng-main/images/stremio.png"
GIT_REV = "147af01"
MASTER_SIZE = (512, 512)
# Liquid Glass `--background: rgb(20, 20, 20)` — also used by splash.rs BG_COLOR.
GLASS_BG = (20, 20, 20)
# Inno Setup WizardStyle=modern draws WizardImage* on a light/white panel.
# BMP has no alpha — white matches the installer chrome so no black square shows.
INSTALLER_BG = (255, 255, 255)
ICO_SIZES = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
HEADER_BMP_SIZE = (55, 55)
WIZARD_BMP_SIZE = (164, 314)


def load_git_colored_source() -> Image.Image:
    """Load the original colored Stremio diamond PNG from git history."""
    data = subprocess.check_output(
        ["git", "-C", str(REPO), "show", f"{GIT_REV}:{GIT_PATH}"]
    )
    return Image.open(BytesIO(data)).convert("RGBA")


def colored_to_glass_rgba(
    source: Image.Image,
    size: tuple[int, int],
    *,
    for_light_bg: bool = False,
) -> Image.Image:
    """Resize colored diamond and convert interior to grayscale while preserving alpha."""
    resized = source.resize(size, Image.Resampling.LANCZOS)
    r, g, b, a = resized.split()
    gray = Image.merge("RGB", (r, g, b)).convert("L")
    if for_light_bg:
        # Darker glass so the diamond stays visible on white installer panels.
        gray = gray.point(lambda p: max(0, min(255, int(p * 0.55 + 28))))
    else:
        # Slight lift so the diamond reads on dark UI backgrounds.
        gray = gray.point(lambda p: min(255, int(p * 1.08 + 12)))
    return Image.merge("RGBA", (gray, gray, gray, a))


def composite_on_bg(
    logo: Image.Image,
    canvas_size: tuple[int, int],
    bg: tuple[int, int, int],
) -> Image.Image:
    """Composite RGBA logo centered on a solid background (BMP has no alpha)."""
    canvas = Image.new("RGB", canvas_size, bg)
    logo_fit = logo.copy()
    max_w = int(canvas_size[0] * 0.82)
    max_h = int(canvas_size[1] * 0.62)
    logo_fit.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    x = (canvas_size[0] - logo_fit.width) // 2
    y = (canvas_size[1] - logo_fit.height) // 2
    canvas.paste(logo_fit, (x, y), logo_fit)
    return canvas


def main() -> None:
    source = load_git_colored_source()
    glass = colored_to_glass_rgba(source, MASTER_SIZE)
    glass_for_installer = colored_to_glass_rgba(source, MASTER_SIZE, for_light_bg=True)

    glass_path = IMG_DIR / "stremio-glass.png"
    splash_path = IMG_DIR / "stremio.png"
    ico_path = IMG_DIR / "stremio.ico"
    header_bmp_path = IMG_DIR / "windows-installer-header.bmp"
    wizard_bmp_path = IMG_DIR / "windows-installer.bmp"

    # Transparent master + ICO (Windows alpha).
    glass.save(glass_path, optimize=True)
    glass.save(ico_path, format="ICO", sizes=ICO_SIZES)

    # Splash: NWG Bitmap often treats missing alpha as black — bake Glass BG so no square shows.
    splash = Image.new("RGBA", MASTER_SIZE, (*GLASS_BG, 255))
    splash.alpha_composite(glass)
    splash.save(splash_path, optimize=True)

    # Installer BMPs: white canvas = same as modern wizard panel (no black box).
    header = composite_on_bg(glass_for_installer, HEADER_BMP_SIZE, INSTALLER_BG)
    wizard = composite_on_bg(glass_for_installer, WIZARD_BMP_SIZE, INSTALLER_BG)
    header.save(header_bmp_path)
    wizard.save(wizard_bmp_path)

    corner_glass = glass.getpixel((0, 0))
    corner_splash = splash.getpixel((0, 0))
    print(f"stremio-glass.png corner (0,0): RGBA{corner_glass}")
    print(f"stremio.png splash corner (0,0): RGBA{corner_splash}")
    assert corner_glass[3] == 0, "glass master must be transparent outside diamond"
    assert corner_splash[:3] == GLASS_BG, "splash must use glass background color"

    ico = Image.open(ico_path)
    print(f"stremio.ico sizes: {getattr(ico, 'info', {}).get('sizes', 'unknown')}")
    print(f"windows-installer-header.bmp: {header.size} corner RGB{header.getpixel((0, 0))}")
    print(f"windows-installer.bmp: {wizard.size} corner RGB{wizard.getpixel((0, 0))}")
    assert header.getpixel((0, 0)) == INSTALLER_BG
    assert wizard.getpixel((0, 0)) == INSTALLER_BG
    print("Done.")


if __name__ == "__main__":
    main()
