using EdizRemote.Host.Streaming;
using EdizRemote.Host.WebRtc;

namespace EdizRemote.Host.Tests;

public sealed class AdaptiveBitrateControllerTests
{
    [Fact]
    public void SevereLossImmediatelyReducesTargetBitrate()
    {
        var controller = new AdaptiveBitrateController(
            8_000_000,
            minimumAdjustmentInterval: TimeSpan.Zero);

        var observation = controller.Observe(51, DateTimeOffset.UnixEpoch);

        Assert.True(observation.TargetChanged);
        Assert.Equal(5_600_000, observation.TargetBitrate);
        Assert.Equal(19.92, observation.PacketLossPercent);
    }

    [Fact]
    public void ThreeGoodReportsIncreaseBitrateWithoutExceedingInitialMaximum()
    {
        var controller = new AdaptiveBitrateController(
            8_000_000,
            minimumAdjustmentInterval: TimeSpan.Zero);
        controller.Observe(51, DateTimeOffset.UnixEpoch);

        controller.Observe(0, DateTimeOffset.UnixEpoch.AddSeconds(1));
        controller.Observe(0, DateTimeOffset.UnixEpoch.AddSeconds(2));
        var recovery = controller.Observe(0, DateTimeOffset.UnixEpoch.AddSeconds(3));

        Assert.True(recovery.TargetChanged);
        Assert.Equal(6_160_000, recovery.TargetBitrate);
    }

    [Fact]
    public void StreamControlCoalescesKeyFrameRequestsAndBitrateChanges()
    {
        var control = new NativeStreamControl(8_000_000);
        control.RequestKeyFrame();
        control.RequestKeyFrame();
        control.SetTargetBitrate(5_600_000);

        var directive = control.Consume(8_000_000);
        var nextDirective = control.Consume(5_600_000);

        Assert.True(directive.RestartEncoder);
        Assert.True(directive.KeyFrameRequested);
        Assert.Equal(5_600_000, directive.TargetBitrate);
        Assert.Equal(2, control.KeyFrameRequests);
        Assert.False(nextDirective.RestartEncoder);
    }
}
