using EdizRemote.Host.Capture;

namespace EdizRemote.Host.Tests;

public sealed class BmpWriterTests
{
    [Fact]
    public void WritesAValidBottomUp32BitBitmap()
    {
        var path = Path.Combine(Path.GetTempPath(), $"ediz-remote-{Guid.NewGuid():N}.bmp");
        try
        {
            var topRow = new byte[] { 1, 2, 3, 255, 4, 5, 6, 255 };
            var bottomRow = new byte[] { 7, 8, 9, 255, 10, 11, 12, 255 };
            var pixels = topRow.Concat(bottomRow).ToArray();
            var frame = new CapturedFrame(2, 2, 8, pixels, 1, false);

            BmpWriter.Write(path, frame);
            var bytes = File.ReadAllBytes(path);

            Assert.Equal((byte)'B', bytes[0]);
            Assert.Equal((byte)'M', bytes[1]);
            Assert.Equal(70, bytes.Length);
            Assert.Equal(2, BitConverter.ToInt32(bytes, 18));
            Assert.Equal(2, BitConverter.ToInt32(bytes, 22));
            Assert.Equal((ushort)32, BitConverter.ToUInt16(bytes, 28));
            Assert.Equal(bottomRow, bytes[54..62]);
            Assert.Equal(topRow, bytes[62..70]);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
