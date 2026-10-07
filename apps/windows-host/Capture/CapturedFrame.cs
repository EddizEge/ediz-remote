namespace EdizRemote.Host.Capture;

internal sealed record CapturedFrame(
    int Width,
    int Height,
    int RowPitch,
    byte[] Bgra,
    uint AccumulatedFrames,
    bool PointerVisible);

internal sealed record CaptureProbeResult(
    int OutputIndex,
    int Width,
    int Height,
    string PixelFormat,
    int FramesCaptured,
    long DesktopUpdates,
    long DurationMilliseconds,
    double AcquiredFramesPerSecond,
    bool SeparatePointerObserved);
