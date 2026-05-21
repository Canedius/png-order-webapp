# Trim transparent borders from a PNG (alpha == 0 rows/columns).
# Usage: powershell -ExecutionPolicy Bypass -File trim_transparent.ps1 <path>
# Overwrites the file in place. Skips JPEG / files without alpha channel.

param([Parameter(Mandatory=$true)][string]$Path)

if (-not (Test-Path -LiteralPath $Path)) { exit 0 }
$ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
if ($ext -ne '.png' -and $ext -ne '.tif' -and $ext -ne '.tiff') { exit 0 }

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class Trimmer {
    public static int Trim(string path) {
        // Load bytes ourselves and decode from MemoryStream so GDI+ never holds
        // a lock on the source file — required for the later File.Delete/Move.
        byte[] raw = File.ReadAllBytes(path);
        Bitmap bmp;
        float dpiX, dpiY;
        using (var ms = new MemoryStream(raw)) {
            using (var src = new Bitmap(ms)) {
                dpiX = src.HorizontalResolution;
                dpiY = src.VerticalResolution;
                if (src.PixelFormat == PixelFormat.Format32bppArgb) {
                    bmp = new Bitmap(src);
                } else {
                    bmp = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
                    using (var g = Graphics.FromImage(bmp)) { g.DrawImage(src, 0, 0, src.Width, src.Height); }
                }
            }
        }
        // GDI+ Bitmap constructor / DrawImage path drops DPI metadata back to 96.
        // Restore so CorelDRAW imports at the correct physical size.
        if (dpiX > 0 && dpiY > 0) bmp.SetResolution(dpiX, dpiY);
        try {
            int w = bmp.Width, h = bmp.Height;
            var rect = new Rectangle(0, 0, w, h);
            var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            int stride = data.Stride;
            byte[] bytes = new byte[stride * h];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            bmp.UnlockBits(data);

            int minX = w, minY = h, maxX = -1, maxY = -1;
            for (int y = 0; y < h; y++) {
                int row = y * stride;
                for (int x = 0; x < w; x++) {
                    // BGRA in memory: alpha at offset +3
                    if (bytes[row + x * 4 + 3] > 0) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            if (maxX < 0) return -1; // fully transparent
            if (minX == 0 && minY == 0 && maxX == w - 1 && maxY == h - 1) return 0; // nothing to trim
            using (var cropped = bmp.Clone(new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1), PixelFormat.Format32bppArgb)) {
                if (dpiX > 0 && dpiY > 0) cropped.SetResolution(dpiX, dpiY);
                string tmp = path + ".trim.tmp";
                cropped.Save(tmp, ImageFormat.Png);
                bmp.Dispose();
                bmp = null;
                if (File.Exists(path)) File.Delete(path);
                File.Move(tmp, path);
            }
            return 1;
        } finally {
            if (bmp != null) bmp.Dispose();
        }
    }
}
"@ -ErrorAction Stop

try {
    $res = [Trimmer]::Trim($Path)
    Write-Output "trim $Path = $res"
} catch {
    Write-Error "trim FAILED for $Path : $($_.Exception.Message)"
    exit 1
}
