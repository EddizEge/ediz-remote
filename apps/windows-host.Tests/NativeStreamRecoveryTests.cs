using EdizRemote.Host.Capture;
using EdizRemote.Host.WebRtc;

namespace EdizRemote.Host.Tests;

public sealed class NativeStreamRecoveryTests
{
    [Fact]
    public void RecoveryPolicyRetriesAccessLostAndEncoderFailures()
    {
        Assert.True(NativeStreamRecoveryPolicy.IsRecoverable(
            new DesktopCaptureAccessLostException()));
        Assert.True(NativeStreamRecoveryPolicy.IsRecoverable(
            new InvalidOperationException("encoder failed")));
        Assert.False(NativeStreamRecoveryPolicy.IsRecoverable(
            new NotSupportedException("hardware encoder unavailable")));
    }

    [Fact]
    public void RecoveryPolicyUsesBoundedExponentialDelay()
    {
        Assert.Equal(TimeSpan.FromSeconds(1), NativeStreamRecoveryPolicy.GetDelay(1));
        Assert.Equal(TimeSpan.FromSeconds(2), NativeStreamRecoveryPolicy.GetDelay(2));
        Assert.Equal(TimeSpan.FromSeconds(4), NativeStreamRecoveryPolicy.GetDelay(3));
        Assert.Equal(TimeSpan.FromSeconds(4), NativeStreamRecoveryPolicy.GetDelay(8));
    }

    [Fact]
    public void CurrentOutputTracksDeviceAcrossResolutionAndAdapterChanges()
    {
        var selected = Output(0, 0, 0, "\\\\.\\DISPLAY2", 1920, 1080);
        var changed = Output(1, 2, 3, "\\\\.\\DISPLAY2", 2560, 1440);

        var resolved = NativeVideoHostSession.ResolveCurrentOutput(
            selected,
            [Output(0, 0, 0, "\\\\.\\DISPLAY1", 1920, 1080), changed]);

        Assert.Same(changed, resolved);
    }

    private static DisplayOutput Output(
        int index,
        int adapterIndex,
        int outputIndex,
        string deviceName,
        int width,
        int height) =>
        new(
            index,
            adapterIndex,
            outputIndex,
            "Test GPU",
            deviceName,
            0,
            0,
            width,
            height,
            "Identity",
            true);
}
