using EdizRemote.Host.Streaming;

namespace EdizRemote.Host.Tests;

public sealed class NativeStreamControlTests
{
    [Fact]
    public void KeyFrameRequestRightAfterEncoderStartWaitsForMinimumInterval()
    {
        var now = TimeSpan.Zero;
        var control = new NativeStreamControl(8_000_000, TimeSpan.FromSeconds(1), () => now);
        control.EncoderStarted();
        now = TimeSpan.FromMilliseconds(200);
        control.RequestKeyFrame();

        Assert.False(control.Consume(8_000_000).RestartEncoder);
        now = TimeSpan.FromMilliseconds(999);
        Assert.False(control.Consume(8_000_000).RestartEncoder);

        now = TimeSpan.FromSeconds(1);
        var due = control.Consume(8_000_000);
        Assert.True(due.RestartEncoder);
        Assert.True(due.KeyFrameRequested);

        control.EncoderStarted();
        now = TimeSpan.FromSeconds(5);
        Assert.False(control.Consume(8_000_000).RestartEncoder);
    }

    [Fact]
    public void PliStormRebuildsTheEncoderAtMostOncePerInterval()
    {
        // Ten seconds at 30 FPS while the receiver asks for a keyframe on
        // every RTCP report: the old behaviour rebuilt the encoder on all 300
        // frames, so a fresh asynchronous MFT never produced its first IDR.
        var now = TimeSpan.Zero;
        var control = new NativeStreamControl(8_000_000, TimeSpan.FromSeconds(1), () => now);
        control.EncoderStarted();
        var restarts = 0;
        for (var frame = 1; frame <= 300; frame++)
        {
            now = TimeSpan.FromSeconds(frame / 30d);
            for (var request = 0; request < 6; request++)
            {
                control.RequestKeyFrame();
            }
            var directive = control.Consume(8_000_000);
            if (directive.RestartEncoder)
            {
                restarts++;
                control.EncoderStarted();
            }
        }

        Assert.InRange(restarts, 9, 10);
        Assert.Equal(1_800, control.KeyFrameRequests);
    }

    [Fact]
    public void BitrateChangeRebuildsImmediatelyAndServesPendingKeyFrame()
    {
        var now = TimeSpan.Zero;
        var control = new NativeStreamControl(8_000_000, TimeSpan.FromSeconds(1), () => now);
        control.EncoderStarted();
        control.RequestKeyFrame();
        control.SetTargetBitrate(5_600_000);
        now = TimeSpan.FromMilliseconds(100);

        var directive = control.Consume(8_000_000);
        control.EncoderStarted();
        now = TimeSpan.FromSeconds(5);

        Assert.True(directive.RestartEncoder);
        Assert.True(directive.KeyFrameRequested);
        Assert.Equal(5_600_000, directive.TargetBitrate);
        Assert.False(control.Consume(5_600_000).RestartEncoder);
    }

    [Fact]
    public void RejectsNegativeKeyFrameRestartInterval()
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new NativeStreamControl(8_000_000, TimeSpan.FromMilliseconds(-1)));
    }
}
