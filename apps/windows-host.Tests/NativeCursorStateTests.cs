using EdizRemote.Host.Capture;
using EdizRemote.Host.Streaming;

namespace EdizRemote.Host.Tests;

public sealed class NativeCursorStateTests
{
    [Fact]
    public void CreateCursorStateNormalizesAgainstSelectedOutput()
    {
        var output = CreateOutput(width: 1920, height: 1080);

        var state = NativeDesktopStreamSession.CreateCursorState(
            new DesktopPointerState(960, 540, true),
            output);

        Assert.True(state.Visible);
        Assert.Equal(960d / 1919d, state.X, 8);
        Assert.Equal(540d / 1079d, state.Y, 8);
    }

    [Fact]
    public void CreateCursorStateClampsDriverCoordinatesToProtocolRange()
    {
        var output = CreateOutput(width: 2560, height: 1440);

        var state = NativeDesktopStreamSession.CreateCursorState(
            new DesktopPointerState(-20, 1600, false),
            output);

        Assert.False(state.Visible);
        Assert.Equal(0, state.X);
        Assert.Equal(1, state.Y);
    }

    private static DisplayOutput CreateOutput(int width, int height) => new(
        0,
        0,
        0,
        "Test Adapter",
        "DISPLAY1",
        -1920,
        0,
        width,
        height,
        "Identity",
        true);
}
