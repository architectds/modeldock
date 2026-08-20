# Regenerate assets/icon.png and assets/icon.ico from the Lyncius mark.
#
# The mark is the square-and-circle emblem from the Lyncius site
# (website/public/favicon.svg): a rounded square outline around a circle
# outline, no fill. There are two renderings of it on purpose:
#
#   assets/icon.svg  the original, theme-aware (black on light, white on dark).
#                    The browser tab uses this one, because a tab bar follows
#                    the OS theme and a single-colour raster cannot.
#   assets/icon.png  this script's output, one flat colour. It is an <img> in
#                    the dashboard rail, sitting directly above the nav icons,
#                    so it takes their exact rest colour (--muted, #89a0af,
#                    reached via `stroke: currentColor` on .rail-link svg). A
#                    white mark there read as a highlighted item next to
#                    permanently dimmer neighbours.
#
# assets/icon.ico is built from the same PNG, so the Windows shortcut and the
# dashboard never drift apart. #89a0af is a mid-tone and stays legible on both
# a dark and a light taskbar, which white would not.
#
# Re-run after changing the mark or the token:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icon.ps1

param(
    # Keep in step with --muted in public/styles.css.
    [string]$Color = "#89a0af"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$pngPath = Join-Path $root "assets/icon.png"
$icoPath = Join-Path $root "assets/icon.ico"

# The source viewBox is 64x64; every measurement below is that geometry scaled.
$size = 1024
$scale = $size / 64.0
$stroke = 4.5 * $scale

$bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $pen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml($Color), $stroke)
    try {
        # rect x=12 y=12 w=40 h=40 rx=10
        $x = 12 * $scale; $y = 12 * $scale; $w = 40 * $scale; $h = 40 * $scale; $d = 2 * 10 * $scale
        $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
        $path.AddArc($x, $y, $d, $d, 180, 90)
        $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
        $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
        $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
        $path.CloseFigure()
        $g.DrawPath($pen, $path)
        $path.Dispose()

        # circle cx=32 cy=32 r=14
        $r = 14 * $scale
        $g.DrawEllipse($pen, (32 * $scale) - $r, (32 * $scale) - $r, 2 * $r, 2 * $r)
    } finally { $pen.Dispose() }
    $bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $g.Dispose()
    $bmp.Dispose()
}
Write-Host "PNG written to $pngPath ($Color)"

# Same multi-size ICO writer create-shortcut.ps1 uses, so the shortcut and the
# committed icon never drift apart.
& (Join-Path $PSScriptRoot "create-shortcut.ps1") -IconSource $pngPath | Out-Null
Write-Host "ICO written to $icoPath"
