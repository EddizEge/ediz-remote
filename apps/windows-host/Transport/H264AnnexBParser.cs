namespace EdizRemote.Host.Transport;

internal sealed record H264NalUnit(ReadOnlyMemory<byte> Data)
{
    public int Type => Data.IsEmpty ? 0 : Data.Span[0] & 0x1F;
    public bool IsParameterSet => Type is 7 or 8;
    public bool IsKeyFrame => Type == 5;
    public bool IsVideoCodingLayer => Type is >= 1 and <= 5;
}

internal static class H264AnnexBParser
{
    public static IReadOnlyList<H264NalUnit> Parse(byte[] annexB)
    {
        ArgumentNullException.ThrowIfNull(annexB);
        var units = new List<H264NalUnit>();
        var searchOffset = 0;

        while (TryFindStartCode(annexB, searchOffset, out var start, out var prefixLength))
        {
            var nalStart = start + prefixLength;
            var hasNext = TryFindStartCode(
                annexB,
                nalStart,
                out var nextStart,
                out _);
            var nalEnd = hasNext ? nextStart : annexB.Length;
            while (nalEnd > nalStart && annexB[nalEnd - 1] == 0)
            {
                nalEnd--;
            }

            if (nalEnd > nalStart)
            {
                units.Add(new H264NalUnit(
                    new ReadOnlyMemory<byte>(annexB, nalStart, nalEnd - nalStart)));
            }
            if (!hasNext) break;
            searchOffset = nextStart;
        }

        return units;
    }

    private static bool TryFindStartCode(
        ReadOnlySpan<byte> data,
        int offset,
        out int start,
        out int prefixLength)
    {
        for (var index = Math.Max(0, offset); index + 2 < data.Length; index++)
        {
            if (data[index] != 0 || data[index + 1] != 0) continue;
            if (data[index + 2] == 1)
            {
                start = index;
                prefixLength = 3;
                return true;
            }
            if (index + 3 < data.Length && data[index + 2] == 0 && data[index + 3] == 1)
            {
                start = index;
                prefixLength = 4;
                return true;
            }
        }

        start = -1;
        prefixLength = 0;
        return false;
    }
}
