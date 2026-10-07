namespace EdizRemote.Host.Capture;

internal static class BmpWriter
{
    public static void Write(string path, CapturedFrame frame)
    {
        const int fileHeaderSize = 14;
        const int infoHeaderSize = 40;
        var packedRowSize = checked(frame.Width * 4);
        var imageSize = checked(packedRowSize * frame.Height);
        var fileSize = checked(fileHeaderSize + infoHeaderSize + imageSize);

        using var stream = File.Create(path);
        using var writer = new BinaryWriter(stream);

        writer.Write((ushort)0x4D42);
        writer.Write(fileSize);
        writer.Write((ushort)0);
        writer.Write((ushort)0);
        writer.Write(fileHeaderSize + infoHeaderSize);

        writer.Write(infoHeaderSize);
        writer.Write(frame.Width);
        writer.Write(frame.Height);
        writer.Write((ushort)1);
        writer.Write((ushort)32);
        writer.Write(0);
        writer.Write(imageSize);
        writer.Write(2_835);
        writer.Write(2_835);
        writer.Write(0);
        writer.Write(0);

        for (var row = frame.Height - 1; row >= 0; row--)
        {
            writer.Write(frame.Bgra, row * packedRowSize, packedRowSize);
        }
    }
}
