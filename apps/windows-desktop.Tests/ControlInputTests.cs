using System.Text.Json;
using EdizRemote.Desktop.Input;

namespace EdizRemote.Desktop.Tests;

public sealed class ControlInputTests
{
    [Fact]
    public void ParserAcceptsBoundedPointerAndTurkishKeyboardEvents()
    {
        using var pointerDocument = JsonDocument.Parse("""
            {
              "channel": "control",
              "version": 1,
              "type": "control.event",
              "sequence": 7,
              "event": { "kind": "pointer.move", "x": 0.25, "y": 0.75 }
            }
            """);
        using var keyboardDocument = JsonDocument.Parse("""
            {
              "channel": "control",
              "version": 1,
              "type": "control.event",
              "sequence": 8,
              "event": {
                "kind": "keyboard.key",
                "code": "BracketLeft",
                "key": "ğ",
                "location": 0,
                "down": true,
                "repeat": false
              }
            }
            """);

        Assert.True(ControlEventParser.TryParse(pointerDocument.RootElement, out var pointer));
        Assert.Equal(new RemotePointerMoveEvent(7, 0.25, 0.75), pointer);
        Assert.True(ControlEventParser.TryParse(keyboardDocument.RootElement, out var keyboard));
        Assert.Equal(
            new RemoteKeyboardKeyEvent(8, "BracketLeft", "ğ", 0, true, false),
            keyboard);
    }

    [Theory]
    [InlineData("""{"channel":"control","version":2,"type":"control.event","sequence":1,"event":{"kind":"pointer.move","x":0.5,"y":0.5}}""")]
    [InlineData("""{"channel":"control","version":1,"type":"control.event","sequence":1,"event":{"kind":"pointer.move","x":-0.1,"y":0.5}}""")]
    [InlineData("""{"channel":"control","version":1,"type":"control.event","sequence":1,"event":{"kind":"keyboard.key","code":"","key":"a","location":0,"down":true,"repeat":false}}""")]
    [InlineData("""{"channel":"control","version":1,"type":"control.event","sequence":1,"event":{"kind":"pointer.move","x":0.5,"y":0.5},"admin":true}""")]
    [InlineData("""{"channel":"control","version":1,"type":"control.event","sequence":1,"event":{"kind":"pointer.move","x":0.5,"y":0.5,"admin":true}}""")]
    [InlineData("""{"channel":"control","version":1,"type":"control.event","sequence":1,"event":{"kind":"pointer.button","button":"left","down":true,"x":0.5}}""")]
    public void ParserRejectsUnsupportedOrOutOfRangeEvents(string json)
    {
        using var document = JsonDocument.Parse(json);
        Assert.False(ControlEventParser.TryParse(document.RootElement, out _));
    }

    [Fact]
    public void ControlBridgeRequiresStrictVersionedRootEnvelope()
    {
        var sessionId = Guid.NewGuid().ToString("D");
        using var enabledDocument = JsonDocument.Parse($$"""
            {
              "type": "desktop.control.set-enabled",
              "channel": "control",
              "version": 1,
              "sessionId": "{{sessionId}}",
              "enabled": true
            }
            """);
        using var eventDocument = JsonDocument.Parse($$"""
            {
              "type": "desktop.control.event",
              "channel": "control",
              "version": 1,
              "sessionId": "{{sessionId}}",
              "payload": {
                "channel": "control",
                "version": 1,
                "type": "control.event",
                "sequence": 0,
                "event": { "kind": "pointer.move", "x": 0.5, "y": 0.5 }
              }
            }
            """);

        Assert.True(ControlBridgeProtocol.TryParseSetEnabled(
            enabledDocument.RootElement,
            out var parsedSessionId,
            out var enabled));
        Assert.Equal(sessionId, parsedSessionId);
        Assert.True(enabled);
        Assert.True(ControlBridgeProtocol.TryParseEvent(
            eventDocument.RootElement,
            out parsedSessionId,
            out var controlEvent));
        Assert.Equal(sessionId, parsedSessionId);
        Assert.IsType<RemotePointerMoveEvent>(controlEvent);

        foreach (var invalidJson in new[]
        {
            """{"type":"desktop.control.set-enabled","sessionId":"$SESSION$","enabled":true}""",
            """{"type":"desktop.control.set-enabled","channel":"control","version":2,"sessionId":"$SESSION$","enabled":true}""",
            """{"type":"desktop.control.set-enabled","channel":"control","version":1,"sessionId":"{$SESSION$}","enabled":true}""",
            """{"type":"desktop.control.set-enabled","channel":"control","version":1,"sessionId":"$SESSION$","enabled":true,"extra":true}""",
            """{"type":"desktop.control.event","channel":"control","version":1,"sessionId":"$SESSION$","payload":{"channel":"control","version":1,"type":"control.event","sequence":0,"event":{"kind":"pointer.move","x":0.5,"y":0.5,"extra":true}}}""",
        })
        {
            using var invalid = JsonDocument.Parse(
                invalidJson.Replace("$SESSION$", sessionId.ToString(), StringComparison.Ordinal));
            Assert.False(ControlBridgeProtocol.TryParseSetEnabled(
                invalid.RootElement,
                out _,
                out _));
            Assert.False(ControlBridgeProtocol.TryParseEvent(
                invalid.RootElement,
                out _,
                out _));
        }
    }

    [Fact]
    public void SessionRequiresGrantMapsNegativeDisplayCoordinatesAndRejectsReplay()
    {
        var injector = new RecordingInputInjector();
        var session = new ControlInputSession(
            injector,
            () => new ControlDisplayBounds(-1920, 100, 1920, 1080));
        var sessionId = Guid.NewGuid().ToString();
        var move = new RemotePointerMoveEvent(0, 1, 0);

        Assert.False(session.TryApply(sessionId, move));
        session.SetEnabled(sessionId, true);
        Assert.True(session.TryApply(sessionId, move));
        Assert.Equal((-1, 100), injector.PointerPosition);
        Assert.False(session.TryApply(sessionId, move));
        Assert.False(session.TryApply(Guid.NewGuid().ToString(), new RemotePointerMoveEvent(1, 0, 0)));
    }

    [Fact]
    public void PointerRateViolationDisablesInputAndReleasesEverything()
    {
        var now = DateTimeOffset.UnixEpoch;
        var injector = new RecordingInputInjector();
        var session = new ControlInputSession(
            injector,
            () => new ControlDisplayBounds(0, 0, 1920, 1080),
            () => now,
            maxEventsPerSecond: 2);
        var sessionId = Guid.NewGuid().ToString();
        session.SetEnabled(sessionId, true);

        Assert.True(session.TryApply(sessionId, new RemotePointerMoveEvent(0, 0, 0)));
        Assert.True(session.TryApply(sessionId, new RemotePointerMoveEvent(1, 0.5, 0.5)));
        Assert.True(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(0, "KeyA", "a", 0, true, false)));
        Assert.False(session.TryApply(
            sessionId,
            new RemotePointerMoveEvent(9_007_199_254_740_991, 1, 1)));
        Assert.False(session.Enabled);
        Assert.True(injector.ReleaseAllCount >= 2);
        Assert.False(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(1, "KeyB", "b", 0, true, false)));

        now += TimeSpan.FromSeconds(1);
        session.SetEnabled(sessionId, true);
        Assert.True(session.TryApply(sessionId, new RemotePointerMoveEvent(2, 1, 1)));
    }

    [Fact]
    public void ReliableRateViolationDisablesInputAndReleasesEverything()
    {
        var injector = new RecordingInputInjector();
        var session = new ControlInputSession(
            injector,
            () => new ControlDisplayBounds(0, 0, 1920, 1080),
            maxEventsPerSecond: 2);
        var sessionId = Guid.NewGuid().ToString();
        session.SetEnabled(sessionId, true);

        Assert.True(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(0, "ControlLeft", "Control", 1, true, false)));
        Assert.True(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(1, "KeyA", "a", 0, true, false)));
        Assert.False(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(2, "KeyA", "a", 0, false, false)));
        Assert.False(session.Enabled);
        Assert.True(injector.ReleaseAllCount >= 2);
    }

    [Fact]
    public void SessionBlocksSecureAttentionSequence()
    {
        var injector = new RecordingInputInjector();
        var session = new ControlInputSession(
            injector,
            () => new ControlDisplayBounds(0, 0, 1920, 1080));
        var sessionId = Guid.NewGuid().ToString();
        session.SetEnabled(sessionId, true);

        Assert.True(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(0, "ControlLeft", "Control", 1, true, false)));
        Assert.True(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(1, "AltLeft", "Alt", 1, true, false)));
        Assert.False(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(2, "Delete", "Delete", 0, true, false)));
        Assert.DoesNotContain(injector.Keys, item => item.Code == "Delete");
        Assert.False(session.Enabled);
        Assert.True(injector.ReleaseAllCount >= 2);
        Assert.False(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(3, "AltLeft", "Alt", 1, false, false)));
    }

    [Fact]
    public void RejectedDisplayEventDoesNotAdvancePointerWatermark()
    {
        ControlDisplayBounds? display = null;
        var injector = new RecordingInputInjector();
        var session = new ControlInputSession(injector, () => display);
        var sessionId = Guid.NewGuid().ToString();
        session.SetEnabled(sessionId, true);

        Assert.False(session.TryApply(
            sessionId,
            new RemotePointerMoveEvent(9_007_199_254_740_991, 0.5, 0.5)));
        display = new ControlDisplayBounds(0, 0, 1920, 1080);
        Assert.True(session.TryApply(
            sessionId,
            new RemotePointerMoveEvent(0, 0.5, 0.5)));
        Assert.Equal((960, 540), injector.PointerPosition);
    }

    [Fact]
    public void AbsoluteCoordinateAndPrintableKeyHelpersCoverVirtualDesktopAndTurkishText()
    {
        Assert.Equal(0, WindowsInputInjector.NormalizeAbsoluteCoordinate(-1920, -1920, 3840));
        Assert.Equal(65_535, WindowsInputInjector.NormalizeAbsoluteCoordinate(1919, -1920, 3840));
        Assert.True(WindowsInputInjector.IsPrintableKey("ş"));
        Assert.False(WindowsInputInjector.IsPrintableKey("Enter"));
        Assert.Equal((ushort)'C', WindowsInputInjector.MapBrowserCode("KeyC", "c"));
        Assert.Equal((ushort)0x11, WindowsInputInjector.MapBrowserCode("ControlLeft", "Control"));
        Assert.Equal((ushort)0x28, WindowsInputInjector.MapBrowserCode("ArrowDown", "ArrowDown"));
    }

    [Fact]
    public void SessionAppliesClickDragWheelAndKeyboardShortcutSequence()
    {
        var injector = new RecordingInputInjector();
        var session = new ControlInputSession(
            injector,
            () => new ControlDisplayBounds(100, -1080, 1920, 1080));
        var sessionId = Guid.NewGuid().ToString();
        session.SetEnabled(sessionId, true);

        Assert.True(session.TryApply(
            sessionId,
            new RemotePointerButtonEvent(0, RemotePointerButton.Left, true, 0.25, 0.5)));
        Assert.True(session.TryApply(
            sessionId,
            new RemotePointerMoveEvent(0, 0.75, 0.5)));
        Assert.True(session.TryApply(
            sessionId,
            new RemotePointerButtonEvent(1, RemotePointerButton.Left, false, 0.75, 0.5)));
        Assert.True(session.TryApply(
            sessionId,
            new RemotePointerWheelEvent(2, 0, 120)));
        Assert.True(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(3, "ControlLeft", "Control", 1, true, false)));
        Assert.True(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(4, "KeyC", "c", 0, true, false)));
        Assert.True(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(5, "KeyC", "c", 0, false, false)));
        Assert.True(session.TryApply(
            sessionId,
            new RemoteKeyboardKeyEvent(6, "ControlLeft", "Control", 1, false, false)));

        Assert.Equal(
            [
                (RemotePointerButton.Left, true),
                (RemotePointerButton.Left, false),
            ],
            injector.Buttons);
        Assert.Equal((0, 120), injector.LastScroll);
        Assert.Equal(
            [
                ("ControlLeft", true),
                ("KeyC", true),
                ("KeyC", false),
                ("ControlLeft", false),
            ],
            injector.Keys);
    }

    [Theory]
    [InlineData("https://app.ediz-remote.local/index.html", true)]
    [InlineData("https://app.ediz-remote.local/", true)]
    [InlineData("http://app.ediz-remote.local/index.html", false)]
    [InlineData("https://evil.example/index.html", false)]
    public void WebViewSourceMustMatchThePackagedVirtualHost(string source, bool expected)
    {
        Assert.Equal(expected, MainWindow.IsTrustedWebViewSource(source));
    }

    private sealed class RecordingInputInjector : IInputInjector
    {
        public (int X, int Y)? PointerPosition { get; private set; }
        public int ReleaseAllCount { get; private set; }
        public List<(string Code, bool Down)> Keys { get; } = [];
        public List<(RemotePointerButton Button, bool Down)> Buttons { get; } = [];
        public (int DeltaX, int DeltaY)? LastScroll { get; private set; }

        public void MovePointer(int x, int y) => PointerPosition = (x, y);

        public void SetPointerButton(RemotePointerButton button, bool down)
        {
            Buttons.Add((button, down));
        }

        public void Scroll(int deltaX, int deltaY)
        {
            LastScroll = (deltaX, deltaY);
        }

        public void SetKey(
            string code,
            string key,
            int location,
            bool down,
            bool repeat) => Keys.Add((code, down));

        public void ReleaseAll() => ReleaseAllCount++;
    }
}
