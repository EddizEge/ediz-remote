using EdizRemote.Desktop;
using EdizRemote.Desktop.Input;
using EdizRemote.Host.Capture;

namespace EdizRemote.Desktop.Tests;

public sealed class DisplaySelectionTests
{
    [Fact]
    public void ResolvesRequestedDisplayAndFallsBackToPrimary()
    {
        DisplayOutput[] displays =
        [
            Output(0, "\\\\.\\DISPLAY1", 0, 0, 1920, 1080),
            Output(1, "\\\\.\\DISPLAY2", -2560, 0, 2560, 1440),
        ];

        Assert.Equal(
            "\\\\.\\DISPLAY2",
            MainWindow.ResolveSelectedDisplay(displays, "\\\\.\\DISPLAY2")?.DeviceName);
        Assert.Equal(
            "\\\\.\\DISPLAY1",
            MainWindow.ResolveSelectedDisplay(displays, "missing")?.DeviceName);
    }

    [Fact]
    public void ReleasingPressedInputsKeepsGrantedSessionEnabled()
    {
        var injector = new RecordingInputInjector();
        var session = new ControlInputSession(
            injector,
            () => new ControlDisplayBounds(0, 0, 1920, 1080));
        var sessionId = Guid.NewGuid().ToString();
        session.SetEnabled(sessionId, true);

        session.ReleasePressedInputs();

        Assert.True(session.Enabled);
        Assert.True(injector.ReleaseAllCount > 0);
        Assert.True(session.TryApply(sessionId, new RemotePointerMoveEvent(0, 0.5, 0.5)));
    }

    [Theory]
    [InlineData("speed", 24, 3_000_000)]
    [InlineData("auto", 30, 8_000_000)]
    [InlineData("quality", 30, 12_000_000)]
    public void QualityProfilesMapToBoundedNativeOptions(
        string profile,
        int expectedFrameRate,
        int expectedBitrate)
    {
        var options = MainWindow.ResolveQualityOptions(profile);

        Assert.Equal(expectedFrameRate, options.FrameRate);
        Assert.Equal(expectedBitrate, options.Bitrate);
        options.Validate();
    }

    [Fact]
    public void RejectsUnknownQualityProfile()
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => MainWindow.ResolveQualityOptions("unbounded"));
    }

    private static DisplayOutput Output(
        int index,
        string deviceName,
        int left,
        int top,
        int width,
        int height) =>
        new(index, 0, index, "GPU", deviceName, left, top, width, height, "Identity", true);

    private sealed class RecordingInputInjector : IInputInjector
    {
        public int ReleaseAllCount { get; private set; }
        public void MovePointer(int x, int y) { }
        public void SetPointerButton(RemotePointerButton button, bool down) { }
        public void Scroll(int deltaX, int deltaY) { }
        public void SetKey(string code, string key, int location, bool down, bool repeat) { }
        public void ReleaseAll() => ReleaseAllCount++;
    }
}
