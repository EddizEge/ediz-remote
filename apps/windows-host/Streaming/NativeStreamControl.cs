using System.Diagnostics;

namespace EdizRemote.Host.Streaming;

internal readonly record struct NativeEncoderDirective(
    int TargetBitrate,
    bool RestartEncoder,
    bool KeyFrameRequested);

internal sealed class NativeStreamControl
{
    // A keyframe is produced by rebuilding the hardware encoder graph. Remote
    // PLI/NACK storms on lossy relay paths must not rebuild it on every frame:
    // a fresh asynchronous MFT needs time before its first IDR, so unbounded
    // restarts starve the stream and churn native encoder sessions.
    internal static readonly TimeSpan DefaultMinimumKeyFrameRestartInterval =
        TimeSpan.FromSeconds(1);

    private static readonly long ClockOrigin = Stopwatch.GetTimestamp();
    private readonly Func<TimeSpan> _clock;
    private readonly TimeSpan _minimumKeyFrameRestartInterval;
    private int _targetBitrate;
    private int _keyFramePending;
    private long _keyFrameRequests;
    private TimeSpan? _lastEncoderStartedAt;

    public NativeStreamControl(
        int initialBitrate,
        TimeSpan? minimumKeyFrameRestartInterval = null,
        Func<TimeSpan>? clock = null)
    {
        if (initialBitrate < 250_000)
            throw new ArgumentOutOfRangeException(nameof(initialBitrate));
        var interval = minimumKeyFrameRestartInterval ?? DefaultMinimumKeyFrameRestartInterval;
        if (interval < TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(minimumKeyFrameRestartInterval));
        _targetBitrate = initialBitrate;
        _minimumKeyFrameRestartInterval = interval;
        _clock = clock ?? (() => Stopwatch.GetElapsedTime(ClockOrigin));
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

    // EncoderStarted and Consume are called only by the single stream loop
    // that owns the encoder; RequestKeyFrame/SetTargetBitrate may arrive from
    // any RTCP thread.
    public void EncoderStarted() => _lastEncoderStartedAt = _clock();

    public NativeEncoderDirective Consume(int currentBitrate)
    {
        var targetBitrate = TargetBitrate;
        var bitrateChanged = targetBitrate != currentBitrate;
        var keyFrameDue = Volatile.Read(ref _keyFramePending) == 1 &&
                          (_lastEncoderStartedAt is not { } startedAt ||
                           _clock() - startedAt >= _minimumKeyFrameRestartInterval);
        if (!bitrateChanged && !keyFrameDue)
        {
            // A throttled keyframe request stays pending until it is due.
            return new NativeEncoderDirective(targetBitrate, false, false);
        }

        var keyFrameRequested = Interlocked.Exchange(ref _keyFramePending, 0) == 1;
        return new NativeEncoderDirective(targetBitrate, true, keyFrameRequested);
    }
}
