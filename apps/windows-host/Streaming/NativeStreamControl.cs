namespace EdizRemote.Host.Streaming;

internal readonly record struct NativeEncoderDirective(
    int TargetBitrate,
    bool RestartEncoder,
    bool KeyFrameRequested);

internal sealed class NativeStreamControl
{
    private int _targetBitrate;
    private int _keyFramePending;
    private long _keyFrameRequests;

    public NativeStreamControl(int initialBitrate)
    {
        if (initialBitrate < 250_000)
            throw new ArgumentOutOfRangeException(nameof(initialBitrate));
        _targetBitrate = initialBitrate;
    }

    public int TargetBitrate => Volatile.Read(ref _targetBitrate);
    public long KeyFrameRequests => Interlocked.Read(ref _keyFrameRequests);

    public void SetTargetBitrate(int bitrate)
    {
        if (bitrate < 250_000)
            throw new ArgumentOutOfRangeException(nameof(bitrate));
        Volatile.Write(ref _targetBitrate, bitrate);
    }

    public void RequestKeyFrame()
    {
        Interlocked.Increment(ref _keyFrameRequests);
        Interlocked.Exchange(ref _keyFramePending, 1);
    }

    public NativeEncoderDirective Consume(int currentBitrate)
    {
        var targetBitrate = TargetBitrate;
        var keyFrameRequested = Interlocked.Exchange(ref _keyFramePending, 0) == 1;
        return new NativeEncoderDirective(
            targetBitrate,
            keyFrameRequested || targetBitrate != currentBitrate,
            keyFrameRequested);
    }
}
