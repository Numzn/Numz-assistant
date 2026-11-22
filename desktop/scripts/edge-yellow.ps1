# Photographs the whole screen the plain way (GDI, not the capture code under test) and counts yellow-ish pixels in a 4-pixel band along
# the screen's edges: the colour Windows uses for its "something is capturing this" outline. Usage: edge-yellow.ps1 <out.png> <label>
param([string]$Out, [string]$Label)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$yellow = 0; $total = 0
for ($band = 0; $band -lt 4; $band++) {
  for ($x = 0; $x -lt $b.Width; $x++) { foreach ($y in @($band, ($b.Height - 1 - $band))) { $c = $bmp.GetPixel($x, $y); $total++; if ($c.R -gt 200 -and $c.G -gt 140 -and $c.B -lt 90) { $yellow++ } } }
  for ($y = 0; $y -lt $b.Height; $y++) { foreach ($x in @($band, ($b.Width - 1 - $band))) { $c = $bmp.GetPixel($x, $y); $total++; if ($c.R -gt 200 -and $c.G -gt 140 -and $c.B -lt 90) { $yellow++ } } }
}
"{0}: {1}x{2}, yellow-ish pixels in the 4px edge band: {3} of {4}" -f $Label, $b.Width, $b.Height, $yellow, $total
