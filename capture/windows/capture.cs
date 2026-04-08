// Windows Screen Capture — GDI+ + Tile-based Delta Encoding
//
// Protocol (stdout, binary-safe):
//   READY:<screenW>:<screenH>:<tileSize>\n
//   CURSOR:<x>:<y>\n
//   FRAME:<totalLen>:<timestamp>:<type>\n<payload>
//     type 1 (keyframe): full JPEG
//     type 2 (delta):    [2B regionCount] + regions
//     type 3 (skip):     empty
//
// Protocol (stdin):
//   KEYFRAME\n       — force next frame as keyframe
//   QUALITY:<s>:<q>\n — hot-update scale and quality
//
// Args: capture.exe [fps] [scale] [quality]
//
// Compile: csc /optimize /out:capture.exe capture.cs /r:System.Drawing.dll /r:System.Windows.Forms.dll

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

class Program
{
    const int TILE_SIZE = 64;

    static double currentScale;
    static long currentQuality;
    static bool forceKeyframe = true;
    static int keyframeInterval = 30;

    // Previous frame tile hashes
    static ulong[] prevHashes;
    static int gridCols, gridRows;

    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT p);
    struct POINT { public int X, Y; }

    static void Main(string[] args)
    {
        double fps = args.Length > 0 ? double.Parse(args[0]) : 30;
        currentScale = args.Length > 1 ? double.Parse(args[1]) : 1;
        currentQuality = args.Length > 2 ? (long)(double.Parse(args[2]) * 100) : 80;

        var screen = Screen.PrimaryScreen.Bounds;
        int interval = (int)(1000.0 / fps);

        var stdout = Console.OpenStandardOutput();
        var stderr = Console.Error;

        // Stdin command reader thread
        var stdinThread = new Thread(() => ReadStdinCommands(screen));
        stdinThread.IsBackground = true;
        stdinThread.Start();

        WriteString(stdout, $"READY:{screen.Width}:{screen.Height}:{TILE_SIZE}\n");
        stderr.WriteLine($"Streaming {screen.Width}x{screen.Height} @ {fps}fps");

        int frameCounter = 0;

        // Reusable buffers
        using (var fullBmp = new Bitmap(screen.Width, screen.Height, PixelFormat.Format32bppArgb))
        using (var fullGfx = Graphics.FromImage(fullBmp))
        {
            while (true)
            {
                var start = Environment.TickCount;
                int sw = (int)(screen.Width * currentScale);
                int sh = (int)(screen.Height * currentScale);

                // Capture screen (no cursor — cursor sent separately)
                fullGfx.CopyFromScreen(screen.Left, screen.Top, 0, 0, screen.Size);

                // Scale if needed
                Bitmap workBmp;
                bool needsDispose = false;
                if (currentScale != 1.0)
                {
                    workBmp = new Bitmap(sw, sh, PixelFormat.Format32bppArgb);
                    needsDispose = true;
                    using (var g = Graphics.FromImage(workBmp))
                    {
                        g.InterpolationMode = InterpolationMode.Low;
                        g.CompositingQuality = CompositingQuality.HighSpeed;
                        g.DrawImage(fullBmp, 0, 0, sw, sh);
                    }
                }
                else
                {
                    workBmp = fullBmp;
                }

                // Send cursor position
                POINT cursorPos;
                GetCursorPos(out cursorPos);
                WriteString(stdout, $"CURSOR:{cursorPos.X}:{cursorPos.Y}\n");

                frameCounter++;
                long ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                // Tile hashing + delta detection
                int cols = (sw + TILE_SIZE - 1) / TILE_SIZE;
                int rows = (sh + TILE_SIZE - 1) / TILE_SIZE;

                if (prevHashes == null || gridCols != cols || gridRows != rows)
                {
                    gridCols = cols; gridRows = rows;
                    prevHashes = new ulong[cols * rows];
                    forceKeyframe = true;
                }

                var bmpData = workBmp.LockBits(new Rectangle(0, 0, sw, sh), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                var curHashes = new ulong[cols * rows];
                var dirtyTiles = new System.Collections.Generic.List<(int col, int row)>();

                unsafe
                {
                    byte* ptr = (byte*)bmpData.Scan0;
                    int stride = bmpData.Stride;

                    for (int r = 0; r < rows; r++)
                    {
                        for (int c = 0; c < cols; c++)
                        {
                            int tw = Math.Min(TILE_SIZE, sw - c * TILE_SIZE);
                            int th = Math.Min(TILE_SIZE, sh - r * TILE_SIZE);
                            ulong hash = TileHash(ptr, stride, c * TILE_SIZE, r * TILE_SIZE, tw, th);
                            curHashes[r * cols + c] = hash;
                            if (hash != prevHashes[r * cols + c])
                                dirtyTiles.Add((c, r));
                        }
                    }
                }
                workBmp.UnlockBits(bmpData);
                prevHashes = curHashes;

                bool isKeyframe = forceKeyframe || frameCounter % keyframeInterval == 0 || dirtyTiles.Count > cols * rows * 4 / 10;

                if (isKeyframe)
                {
                    forceKeyframe = false;
                    EmitKeyframe(stdout, workBmp, sw, sh, ts);
                }
                else if (dirtyTiles.Count == 0)
                {
                    WriteString(stdout, $"FRAME:0:{ts}:3\n");
                }
                else
                {
                    forceKeyframe = false;
                    EmitDelta(stdout, workBmp, dirtyTiles, sw, sh, ts);
                }

                if (needsDispose) workBmp.Dispose();

                var elapsed = Environment.TickCount - start;
                var sleep = interval - elapsed;
                if (sleep > 0) Thread.Sleep(sleep);
            }
        }
    }

    static unsafe ulong TileHash(byte* ptr, int stride, int tx, int ty, int tw, int th)
    {
        ulong h = 0xcbf29ce484222325;
        ulong p = 0x100000001b3;
        for (int row = 0; row < th; row += 4)
        {
            byte* rowBase = ptr + (ty + row) * stride + tx * 4;
            for (int col = 0; col < tw; col += 4)
            {
                uint v = *(uint*)(rowBase + col * 4);
                h ^= v;
                h *= p;
            }
        }
        return h;
    }

    static void EmitKeyframe(Stream stdout, Bitmap bmp, int w, int h, long ts)
    {
        var jpegCodec = GetJpegCodec();
        var ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(Encoder.Quality, currentQuality);
        using (var ms = new MemoryStream())
        {
            bmp.Save(ms, jpegCodec, ep);
            var jpeg = ms.ToArray();
            WriteString(stdout, $"FRAME:{jpeg.Length}:{ts}:1\n");
            stdout.Write(jpeg, 0, jpeg.Length);
            stdout.Flush();
        }
    }

    static void EmitDelta(Stream stdout, Bitmap bmp, System.Collections.Generic.List<(int col, int row)> dirtyTiles, int sw, int sh, long ts)
    {
        // Merge adjacent tiles in same row
        var byRow = new System.Collections.Generic.Dictionary<int, System.Collections.Generic.List<int>>();
        foreach (var (c, r) in dirtyTiles)
        {
            if (!byRow.ContainsKey(r)) byRow[r] = new System.Collections.Generic.List<int>();
            byRow[r].Add(c);
        }

        var regions = new System.Collections.Generic.List<(int x, int y, int w, int h)>();
        foreach (var kv in byRow)
        {
            var sorted = kv.Value;
            sorted.Sort();
            int i = 0;
            while (i < sorted.Count)
            {
                int sc = sorted[i], ec = sc;
                while (i + 1 < sorted.Count && sorted[i + 1] == ec + 1) { i++; ec = sorted[i]; }
                int rx = sc * TILE_SIZE, ry = kv.Key * TILE_SIZE;
                int rw = Math.Min((ec + 1) * TILE_SIZE, sw) - rx;
                int rh = Math.Min((kv.Key + 1) * TILE_SIZE, sh) - ry;
                regions.Add((rx, ry, rw, rh));
                i++;
            }
        }

        var jpegCodec = GetJpegCodec();
        var ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(Encoder.Quality, currentQuality);

        using (var payload = new MemoryStream())
        {
            WriteUInt16BE(payload, (ushort)regions.Count);

            foreach (var r in regions)
            {
                using (var tileBmp = bmp.Clone(new Rectangle(r.x, r.y, r.w, r.h), PixelFormat.Format32bppArgb))
                using (var tileMs = new MemoryStream())
                {
                    tileBmp.Save(tileMs, jpegCodec, ep);
                    var tileJpeg = tileMs.ToArray();

                    WriteUInt16BE(payload, (ushort)r.x);
                    WriteUInt16BE(payload, (ushort)r.y);
                    WriteUInt16BE(payload, (ushort)r.w);
                    WriteUInt16BE(payload, (ushort)r.h);
                    WriteUInt32BE(payload, (uint)tileJpeg.Length);
                    payload.Write(tileJpeg, 0, tileJpeg.Length);
                }
            }

            var data = payload.ToArray();
            WriteString(stdout, $"FRAME:{data.Length}:{ts}:2\n");
            stdout.Write(data, 0, data.Length);
            stdout.Flush();
        }
    }

    static void WriteString(Stream s, string str)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(str);
        s.Write(bytes, 0, bytes.Length);
        s.Flush();
    }

    static void WriteUInt16BE(MemoryStream ms, ushort v)
    {
        ms.WriteByte((byte)(v >> 8));
        ms.WriteByte((byte)(v & 0xFF));
    }

    static void WriteUInt32BE(MemoryStream ms, uint v)
    {
        ms.WriteByte((byte)(v >> 24));
        ms.WriteByte((byte)((v >> 16) & 0xFF));
        ms.WriteByte((byte)((v >> 8) & 0xFF));
        ms.WriteByte((byte)(v & 0xFF));
    }

    static ImageCodecInfo GetJpegCodec()
    {
        foreach (var c in ImageCodecInfo.GetImageEncoders())
            if (c.MimeType == "image/jpeg") return c;
        throw new Exception("JPEG codec not found");
    }

    static void ReadStdinCommands(Rectangle screen)
    {
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (line == "KEYFRAME")
                {
                    forceKeyframe = true;
                }
                else if (line.StartsWith("QUALITY:"))
                {
                    var parts = line.Split(':');
                    if (parts.Length >= 3)
                    {
                        double newScale;
                        double newQuality;
                        if (double.TryParse(parts[1], out newScale) && double.TryParse(parts[2], out newQuality))
                        {
                            currentScale = newScale;
                            currentQuality = (long)(newQuality * 100);
                            prevHashes = null; // reset delta state
                            forceKeyframe = true;
                            Console.Error.WriteLine($"Quality updated: scale={newScale} q={newQuality}");
                        }
                    }
                }
            }
        }
        catch { }
        Environment.Exit(0);
    }
}
