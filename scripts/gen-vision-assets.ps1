Add-Type -AssemblyName System.Drawing
$dir = "D:\projects\modeldock\assets\vision"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function Save-Bmp($bitmap, $path) {
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

# T1: solid colour blocks (red / green / blue)
$colors = @{
  "t1-red.png"   = [System.Drawing.Color]::FromArgb(255, 220, 0, 0)
  "t1-green.png" = [System.Drawing.Color]::FromArgb(255, 0, 170, 0)
  "t1-blue.png"  = [System.Drawing.Color]::FromArgb(255, 0, 0, 220)
}
foreach ($entry in $colors.GetEnumerator()) {
  $bmp = [System.Drawing.Bitmap]::new(320, 200)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear($entry.Value)
  $g.Dispose()
  Save-Bmp $bmp (Join-Path $dir $entry.Key)
}

# T2: counting - 3 red circles + 2 blue squares (circles = 3)
$bmp = [System.Drawing.Bitmap]::new(640, 200)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$red = [System.Drawing.Brushes]::Red
$blue = [System.Drawing.Brushes]::Blue
foreach ($x in @(40, 160, 280)) { $g.FillEllipse($red, $x, 50, 90, 90) }
foreach ($x in @(420, 540)) { $g.FillRectangle($blue, $x, 50, 90, 90) }
$g.Dispose()
Save-Bmp $bmp (Join-Path $dir "t2-shapes.png")

# T3: OCR - "HELLO VISION 42"
$bmp = [System.Drawing.Bitmap]::new(700, 160)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$font = [System.Drawing.Font]::new("Arial", 36, [System.Drawing.FontStyle]::Bold)
$g.DrawString("HELLO VISION 42", $font, [System.Drawing.Brushes]::Black, 20, 40)
$g.Dispose()
Save-Bmp $bmp (Join-Path $dir "t3-ocr.png")

# T4: bar chart - A=2 B=5 C=3 (tallest = B, value 5)
$bmp = [System.Drawing.Bitmap]::new(480, 320)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$bars = @{ "A" = 2; "B" = 5; "C" = 3 }
$i = 0
foreach ($entry in $bars.GetEnumerator()) {
  $h = $entry.Value * 50
  $x = 60 + $i * 130
  $g.FillRectangle([System.Drawing.Brushes]::SteelBlue, $x, 300 - $h, 100, $h)
  $g.DrawString($entry.Key, [System.Drawing.Font]::new("Arial", 24, [System.Drawing.FontStyle]::Bold), [System.Drawing.Brushes]::Black, $x + 35, 305)
  $g.DrawString([string]$entry.Value, [System.Drawing.Font]::new("Arial", 20), [System.Drawing.Brushes]::Black, $x + 40, 300 - $h - 28)
  $i++
}
$g.Dispose()
Save-Bmp $bmp (Join-Path $dir "t4-chart.png")

# T5: direction - a large red arrow pointing right (thick line + triangular head)
$bmp = [System.Drawing.Bitmap]::new(480, 200)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$pen = [System.Drawing.Pen]::new([System.Drawing.Color]::Red, 18)
$g.DrawLine($pen, 60, 100, 330, 100)
$pen.Dispose()
$tri = [System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(310, 50),
  [System.Drawing.PointF]::new(450, 100),
  [System.Drawing.PointF]::new(310, 150)
)
$g.FillPolygon([System.Drawing.Brushes]::Red, $tri)
$g.Dispose()
Save-Bmp $bmp (Join-Path $dir "t5-arrow.png")

Get-ChildItem $dir | Select-Object Name, Length
