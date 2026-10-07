using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace EdizRemote.Desktop.Input;

internal enum RemotePointerButton
{
    Left,
    Middle,
    Right,
}

internal sealed record ControlDisplayBounds(
    int Left,
    int Top,
    int Width,
    int Height);

internal abstract record RemoteControlEvent(long Sequence);

internal sealed record RemotePointerMoveEvent(
    long Sequence,
    double X,
    double Y) : RemoteControlEvent(Sequence);

internal sealed record RemotePointerButtonEvent(
    long Sequence,
    RemotePointerButton Button,
    bool Down,
    double? X = null,
    double? Y = null) : RemoteControlEvent(Sequence);

internal sealed record RemotePointerWheelEvent(
    long Sequence,
    double DeltaX,
    double DeltaY) : RemoteControlEvent(Sequence);

internal sealed record RemoteKeyboardKeyEvent(
    long Sequence,
    string Code,
    string Key,
    int Location,
    bool Down,
    bool Repeat) : RemoteControlEvent(Sequence);

internal interface IInputInjector
{
    void MovePointer(int x, int y);
    void SetPointerButton(RemotePointerButton button, bool down);
    void Scroll(int deltaX, int deltaY);
    void SetKey(string code, string key, int location, bool down, bool repeat);
    void ReleaseAll();
}

internal sealed class ControlInputSession(
    IInputInjector inputInjector,
    Func<ControlDisplayBounds?> displayProvider,
    Func<DateTimeOffset>? clock = null,
    int maxEventsPerSecond = 240)
{
    private const long MaximumSequence = 9_007_199_254_740_991;
    private readonly ControlEventRateLimiter _pointerRateLimiter =
        new(maxEventsPerSecond, TimeSpan.FromSeconds(1), clock);
    private readonly ControlEventRateLimiter _reliableRateLimiter =
        new(maxEventsPerSecond, TimeSpan.FromSeconds(1), clock);
    private readonly HashSet<string> _pressedModifiers = new(StringComparer.Ordinal);
    private string? _sessionId;
    private bool _enabled;
    private long _lastReliableSequence = -1;
    private long _lastPointerSequence = -1;

    public bool Enabled => _enabled;

    public void SetEnabled(string sessionId, bool enabled)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || sessionId.Length > 64)
        {
            Disable();
            return;
        }

        if (!string.Equals(_sessionId, sessionId, StringComparison.Ordinal))
        {
            inputInjector.ReleaseAll();
            _pressedModifiers.Clear();
            _pointerRateLimiter.Reset();
            _reliableRateLimiter.Reset();
            _lastReliableSequence = -1;
            _lastPointerSequence = -1;
            _sessionId = sessionId;
        }

        _enabled = enabled;
        if (!enabled)
        {
            inputInjector.ReleaseAll();
            _pressedModifiers.Clear();
            _pointerRateLimiter.Reset();
            _reliableRateLimiter.Reset();
        }
    }

    public bool TryApply(string sessionId, RemoteControlEvent controlEvent)
    {
        if (!_enabled ||
            !string.Equals(_sessionId, sessionId, StringComparison.Ordinal) ||
            controlEvent.Sequence < 0 ||
            controlEvent.Sequence > MaximumSequence)
        {
            return false;
        }

        if (controlEvent is RemotePointerMoveEvent)
        {
            if (controlEvent.Sequence <= _lastPointerSequence) return false;
            if (!_pointerRateLimiter.TryConsume())
            {
                Disable();
                return false;
            }
        }
        else
        {
            if (controlEvent.Sequence <= _lastReliableSequence) return false;
            if (!_reliableRateLimiter.TryConsume())
            {
                Disable();
                return false;
            }
        }

        switch (controlEvent)
        {
            case RemotePointerMoveEvent pointerMove:
                var display = displayProvider();
                if (display is null || display.Width <= 0 || display.Height <= 0)
                    return false;
                inputInjector.MovePointer(
                    MapCoordinate(pointerMove.X, display.Left, display.Width),
                    MapCoordinate(pointerMove.Y, display.Top, display.Height));
                break;
            case RemotePointerButtonEvent pointerButton:
                if (pointerButton.X is not null && pointerButton.Y is not null)
                {
                    var buttonDisplay = displayProvider();
                    if (buttonDisplay is null ||
                        buttonDisplay.Width <= 0 ||
                        buttonDisplay.Height <= 0)
                        return false;
                    inputInjector.MovePointer(
                        MapCoordinate(
                            pointerButton.X.Value,
                            buttonDisplay.Left,
                            buttonDisplay.Width),
                        MapCoordinate(
                            pointerButton.Y.Value,
                            buttonDisplay.Top,
                            buttonDisplay.Height));
                }
                inputInjector.SetPointerButton(pointerButton.Button, pointerButton.Down);
                break;
            case RemotePointerWheelEvent wheel:
                inputInjector.Scroll(
                    checked((int)Math.Round(wheel.DeltaX)),
                    checked((int)Math.Round(wheel.DeltaY)));
                break;
            case RemoteKeyboardKeyEvent key:
                if (IsSecureAttentionSequence(key))
                {
                    Disable();
                    return false;
                }
                inputInjector.SetKey(
                    key.Code,
                    key.Key,
                    key.Location,
                    key.Down,
                    key.Repeat);
                TrackModifier(key);
                break;
            default:
                return false;
        }

        if (controlEvent is RemotePointerMoveEvent)
            _lastPointerSequence = controlEvent.Sequence;
        else
            _lastReliableSequence = controlEvent.Sequence;
        return true;
    }

    public void Disable()
    {
        _enabled = false;
        inputInjector.ReleaseAll();
        _pressedModifiers.Clear();
        _pointerRateLimiter.Reset();
        _reliableRateLimiter.Reset();
    }

    public void ReleasePressedInputs()
    {
        inputInjector.ReleaseAll();
        _pressedModifiers.Clear();
        _pointerRateLimiter.Reset();
        _reliableRateLimiter.Reset();
    }

    internal static int MapCoordinate(double normalized, int origin, int length)
    {
        if (!double.IsFinite(normalized) || normalized is < 0 or > 1 || length <= 0)
            throw new ArgumentOutOfRangeException(nameof(normalized));
        return origin + (int)Math.Round(
            normalized * (length - 1),
            MidpointRounding.AwayFromZero);
    }

    private bool IsSecureAttentionSequence(RemoteKeyboardKeyEvent key)
    {
        return key.Down &&
               key.Code == "Delete" &&
               _pressedModifiers.Any(IsControlCode) &&
               _pressedModifiers.Any(IsAltCode);
    }

    private void TrackModifier(RemoteKeyboardKeyEvent key)
    {
        if (!IsModifierCode(key.Code)) return;
        if (key.Down) _pressedModifiers.Add(key.Code);
        else _pressedModifiers.Remove(key.Code);
    }

    private static bool IsModifierCode(string code) =>
        IsControlCode(code) || IsAltCode(code) ||
        code is "ShiftLeft" or "ShiftRight" or "MetaLeft" or "MetaRight";

    private static bool IsControlCode(string code) =>
        code is "ControlLeft" or "ControlRight";

    private static bool IsAltCode(string code) =>
        code is "AltLeft" or "AltRight";
}

internal sealed class ControlEventRateLimiter(
    int maxEvents,
    TimeSpan window,
    Func<DateTimeOffset>? clock = null)
{
    private readonly Queue<DateTimeOffset> _events = new(maxEvents);
    private readonly Func<DateTimeOffset> _clock = clock ?? (() => DateTimeOffset.UtcNow);

    public bool TryConsume()
    {
        var now = _clock();
        var cutoff = now - window;
        while (_events.TryPeek(out var timestamp) && timestamp <= cutoff)
            _events.Dequeue();
        if (_events.Count >= maxEvents) return false;
        _events.Enqueue(now);
        return true;
    }

    public void Reset() => _events.Clear();
}

internal static class ControlBridgeProtocol
{
    internal const int Version = 1;

    internal static bool TryParseSetEnabled(
        JsonElement root,
        out string sessionId,
        out bool enabled)
    {
        sessionId = string.Empty;
        enabled = false;
        return HasExactHeader(
                   root,
                   "desktop.control.set-enabled",
                   ["type", "channel", "version", "sessionId", "enabled"]) &&
               TryReadSessionId(root, out sessionId) &&
               root.TryGetProperty("enabled", out var enabledValue) &&
               enabledValue.ValueKind is JsonValueKind.True or JsonValueKind.False &&
               SetBoolean(enabledValue.GetBoolean(), out enabled);
    }

    internal static bool TryParseEvent(
        JsonElement root,
        out string sessionId,
        out RemoteControlEvent? controlEvent)
    {
        sessionId = string.Empty;
        controlEvent = null;
        return HasExactHeader(
                   root,
                   "desktop.control.event",
                   ["type", "channel", "version", "sessionId", "payload"]) &&
               TryReadSessionId(root, out sessionId) &&
               root.TryGetProperty("payload", out var payload) &&
               ControlEventParser.TryParse(payload, out controlEvent) &&
               controlEvent is not null;
    }

    private static bool HasExactHeader(
        JsonElement root,
        string expectedType,
        IReadOnlyCollection<string> expectedProperties)
    {
        if (root.ValueKind != JsonValueKind.Object) return false;
        var count = 0;
        foreach (var property in root.EnumerateObject())
        {
            if (!expectedProperties.Contains(property.Name)) return false;
            count++;
        }
        return count == expectedProperties.Count &&
               root.TryGetProperty("type", out var type) &&
               type.ValueKind == JsonValueKind.String &&
               type.GetString() == expectedType &&
               root.TryGetProperty("channel", out var channel) &&
               channel.ValueKind == JsonValueKind.String &&
               channel.GetString() == "control" &&
               root.TryGetProperty("version", out var version) &&
               version.ValueKind == JsonValueKind.Number &&
               version.TryGetInt32(out var parsedVersion) &&
               parsedVersion == Version;
    }

    private static bool TryReadSessionId(JsonElement root, out string sessionId)
    {
        sessionId = string.Empty;
        if (!root.TryGetProperty("sessionId", out var value) ||
            value.ValueKind != JsonValueKind.String)
        {
            return false;
        }
        sessionId = value.GetString() ?? string.Empty;
        return sessionId.Length == 36 && Guid.TryParseExact(sessionId, "D", out _);
    }

    private static bool SetBoolean(bool value, out bool result)
    {
        result = value;
        return true;
    }
}

internal static class ControlEventParser
{
    public static bool TryParse(JsonElement value, out RemoteControlEvent? controlEvent)
    {
        controlEvent = null;
        if (value.ValueKind != JsonValueKind.Object ||
            !HasExactlyProperties(
                value,
                "channel",
                "version",
                "type",
                "sequence",
                "event") ||
            !HasString(value, "channel", "control") ||
            !HasInt32(value, "version", 1) ||
            !HasString(value, "type", "control.event") ||
            !TryGetSequence(value, out var sequence) ||
            !value.TryGetProperty("event", out var eventValue) ||
            eventValue.ValueKind != JsonValueKind.Object ||
            !eventValue.TryGetProperty("kind", out var kindValue) ||
            kindValue.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        switch (kindValue.GetString())
        {
            case "pointer.move":
                if (!HasExactlyProperties(eventValue, "kind", "x", "y") ||
                    !TryGetBoundedDouble(eventValue, "x", 0, 1, out var x) ||
                    !TryGetBoundedDouble(eventValue, "y", 0, 1, out var y))
                    return false;
                controlEvent = new RemotePointerMoveEvent(sequence, x, y);
                return true;
            case "pointer.button":
                var hasButtonPoint =
                    eventValue.TryGetProperty("x", out _) ||
                    eventValue.TryGetProperty("y", out _);
                if (!(hasButtonPoint
                        ? HasExactlyProperties(
                            eventValue,
                            "kind",
                            "button",
                            "down",
                            "x",
                            "y")
                        : HasExactlyProperties(
                            eventValue,
                            "kind",
                            "button",
                            "down")) ||
                    !TryGetButton(eventValue, out var button) ||
                    !TryGetBoolean(eventValue, "down", out var buttonDown) ||
                    !TryGetOptionalPoint(eventValue, out var buttonX, out var buttonY))
                    return false;
                controlEvent = new RemotePointerButtonEvent(
                    sequence,
                    button,
                    buttonDown,
                    buttonX,
                    buttonY);
                return true;
            case "pointer.wheel":
                if (!HasExactlyProperties(eventValue, "kind", "deltaX", "deltaY") ||
                    !TryGetBoundedDouble(eventValue, "deltaX", -10_000, 10_000, out var deltaX) ||
                    !TryGetBoundedDouble(eventValue, "deltaY", -10_000, 10_000, out var deltaY))
                    return false;
                controlEvent = new RemotePointerWheelEvent(sequence, deltaX, deltaY);
                return true;
            case "keyboard.key":
                if (!HasExactlyProperties(
                        eventValue,
                        "kind",
                        "code",
                        "key",
                        "location",
                        "down",
                        "repeat") ||
                    !TryGetBoundedString(eventValue, "code", 1, 64, out var code) ||
                    !TryGetBoundedString(eventValue, "key", 1, 64, out var key) ||
                    !TryGetBoundedInt32(eventValue, "location", 0, 3, out var location) ||
                    !TryGetBoolean(eventValue, "down", out var keyDown) ||
                    !TryGetBoolean(eventValue, "repeat", out var repeat))
                    return false;
                controlEvent = new RemoteKeyboardKeyEvent(
                    sequence,
                    code,
                    key,
                    location,
                    keyDown,
                    repeat);
                return true;
            default:
                return false;
        }
    }

    private static bool HasExactlyProperties(
        JsonElement value,
        params string[] expectedPropertyNames)
    {
        if (value.ValueKind != JsonValueKind.Object) return false;
        var remaining = new HashSet<string>(
            expectedPropertyNames,
            StringComparer.Ordinal);
        var count = 0;
        foreach (var property in value.EnumerateObject())
        {
            count++;
            if (!remaining.Remove(property.Name)) return false;
        }
        return count == expectedPropertyNames.Length && remaining.Count == 0;
    }

    private static bool TryGetSequence(JsonElement value, out long sequence)
    {
        sequence = 0;
        return value.TryGetProperty("sequence", out var property) &&
               property.ValueKind == JsonValueKind.Number &&
               property.TryGetInt64(out sequence) &&
               sequence is >= 0 and <= 9_007_199_254_740_991;
    }

    private static bool TryGetButton(
        JsonElement value,
        out RemotePointerButton button)
    {
        button = default;
        if (!value.TryGetProperty("button", out var property) ||
            property.ValueKind != JsonValueKind.String)
            return false;
        return property.GetString() switch
        {
            "left" => SetButton(RemotePointerButton.Left, out button),
            "middle" => SetButton(RemotePointerButton.Middle, out button),
            "right" => SetButton(RemotePointerButton.Right, out button),
            _ => false,
        };
    }

    private static bool TryGetOptionalPoint(
        JsonElement value,
        out double? x,
        out double? y)
    {
        x = null;
        y = null;
        var hasX = value.TryGetProperty("x", out _);
        var hasY = value.TryGetProperty("y", out _);
        if (!hasX && !hasY) return true;
        if (!hasX || !hasY ||
            !TryGetBoundedDouble(value, "x", 0, 1, out var parsedX) ||
            !TryGetBoundedDouble(value, "y", 0, 1, out var parsedY))
            return false;
        x = parsedX;
        y = parsedY;
        return true;
    }

    private static bool SetButton(
        RemotePointerButton value,
        out RemotePointerButton button)
    {
        button = value;
        return true;
    }

    private static bool TryGetBoolean(
        JsonElement value,
        string propertyName,
        out bool result)
    {
        result = false;
        if (!value.TryGetProperty(propertyName, out var property) ||
            property.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return false;
        result = property.GetBoolean();
        return true;
    }

    private static bool TryGetBoundedString(
        JsonElement value,
        string propertyName,
        int minimumLength,
        int maximumLength,
        out string result)
    {
        result = string.Empty;
        if (!value.TryGetProperty(propertyName, out var property) ||
            property.ValueKind != JsonValueKind.String)
            return false;
        result = property.GetString() ?? string.Empty;
        return result.Length >= minimumLength && result.Length <= maximumLength;
    }

    private static bool TryGetBoundedDouble(
        JsonElement value,
        string propertyName,
        double minimum,
        double maximum,
        out double result)
    {
        result = 0;
        return value.TryGetProperty(propertyName, out var property) &&
               property.ValueKind == JsonValueKind.Number &&
               property.TryGetDouble(out result) &&
               double.IsFinite(result) &&
               result >= minimum &&
               result <= maximum;
    }

    private static bool TryGetBoundedInt32(
        JsonElement value,
        string propertyName,
        int minimum,
        int maximum,
        out int result)
    {
        result = 0;
        return value.TryGetProperty(propertyName, out var property) &&
               property.ValueKind == JsonValueKind.Number &&
               property.TryGetInt32(out result) &&
               result >= minimum &&
               result <= maximum;
    }

    private static bool HasString(
        JsonElement value,
        string propertyName,
        string expected) =>
        value.TryGetProperty(propertyName, out var property) &&
        property.ValueKind == JsonValueKind.String &&
        property.GetString() == expected;

    private static bool HasInt32(
        JsonElement value,
        string propertyName,
        int expected) =>
        value.TryGetProperty(propertyName, out var property) &&
        property.ValueKind == JsonValueKind.Number &&
        property.TryGetInt32(out var result) &&
        result == expected;
}

internal sealed class WindowsInputInjector : IInputInjector
{
    private const int SmXVirtualScreen = 76;
    private const int SmYVirtualScreen = 77;
    private const int SmCxVirtualScreen = 78;
    private const int SmCyVirtualScreen = 79;
    private const uint InputMouse = 0;
    private const uint InputKeyboard = 1;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventUnicode = 0x0004;
    private const uint KeyEventExtendedKey = 0x0001;
    private const uint MouseMove = 0x0001;
    private const uint MouseLeftDown = 0x0002;
    private const uint MouseLeftUp = 0x0004;
    private const uint MouseRightDown = 0x0008;
    private const uint MouseRightUp = 0x0010;
    private const uint MouseMiddleDown = 0x0020;
    private const uint MouseMiddleUp = 0x0040;
    private const uint MouseWheel = 0x0800;
    private const uint MouseHorizontalWheel = 0x1000;
    private const uint MouseVirtualDesk = 0x4000;
    private const uint MouseAbsolute = 0x8000;
    private readonly HashSet<string> _pressedCodes = new(StringComparer.Ordinal);
    private readonly HashSet<string> _unicodeCodes = new(StringComparer.Ordinal);
    private readonly HashSet<RemotePointerButton> _pressedButtons = [];

    public void MovePointer(int x, int y)
    {
        var left = GetSystemMetrics(SmXVirtualScreen);
        var top = GetSystemMetrics(SmYVirtualScreen);
        var width = Math.Max(1, GetSystemMetrics(SmCxVirtualScreen));
        var height = Math.Max(1, GetSystemMetrics(SmCyVirtualScreen));
        SendMouse(
            NormalizeAbsoluteCoordinate(x, left, width),
            NormalizeAbsoluteCoordinate(y, top, height),
            0,
            MouseMove | MouseAbsolute | MouseVirtualDesk);
    }

    public void SetPointerButton(RemotePointerButton button, bool down)
    {
        var flags = (button, down) switch
        {
            (RemotePointerButton.Left, true) => MouseLeftDown,
            (RemotePointerButton.Left, false) => MouseLeftUp,
            (RemotePointerButton.Middle, true) => MouseMiddleDown,
            (RemotePointerButton.Middle, false) => MouseMiddleUp,
            (RemotePointerButton.Right, true) => MouseRightDown,
            (RemotePointerButton.Right, false) => MouseRightUp,
            _ => 0u,
        };
        SendMouse(0, 0, 0, flags);
        if (down) _pressedButtons.Add(button);
        else _pressedButtons.Remove(button);
    }

    public void Scroll(int deltaX, int deltaY)
    {
        if (deltaY != 0) SendMouse(0, 0, unchecked((uint)-deltaY), MouseWheel);
        if (deltaX != 0)
            SendMouse(0, 0, unchecked((uint)deltaX), MouseHorizontalWheel);
    }

    public void SetKey(
        string code,
        string key,
        int location,
        bool down,
        bool repeat)
    {
        if (!down && _unicodeCodes.Remove(code)) return;
        if (down && IsPrintableKey(key) && !HasShortcutModifier())
        {
            SendUnicode(key[0]);
            _unicodeCodes.Add(code);
            return;
        }

        var virtualKey = MapBrowserCode(code, key);
        if (virtualKey == 0) return;
        SendVirtualKey(virtualKey, down, IsExtendedKey(code));
        if (down) _pressedCodes.Add(code);
        else _pressedCodes.Remove(code);
    }

    public void ReleaseAll()
    {
        foreach (var button in _pressedButtons.ToArray())
            SetPointerButton(button, false);
        foreach (var code in _pressedCodes.ToArray())
        {
            var virtualKey = MapBrowserCode(code, string.Empty);
            if (virtualKey != 0) SendVirtualKey(virtualKey, false, IsExtendedKey(code));
        }
        _pressedButtons.Clear();
        _pressedCodes.Clear();
        _unicodeCodes.Clear();
    }

    internal static int NormalizeAbsoluteCoordinate(int value, int origin, int length)
    {
        if (length <= 1) return 0;
        return Math.Clamp(
            (int)Math.Round(
                (value - origin) * 65_535d / (length - 1),
                MidpointRounding.AwayFromZero),
            0,
            65_535);
    }

    internal static bool IsPrintableKey(string key) =>
        key.Length == 1 && !char.IsControl(key[0]);

    private bool HasShortcutModifier() =>
        _pressedCodes.Any(code =>
            code is "ControlLeft" or "ControlRight" or
                    "AltLeft" or "AltRight" or
                    "MetaLeft" or "MetaRight");

    internal static ushort MapBrowserCode(string code, string key)
    {
        if (code.Length == 4 && code.StartsWith("Key", StringComparison.Ordinal) &&
            code[3] is >= 'A' and <= 'Z')
            return code[3];
        if (code.Length == 6 && code.StartsWith("Digit", StringComparison.Ordinal) &&
            code[5] is >= '0' and <= '9')
            return code[5];
        if (code.StartsWith('F') && int.TryParse(code.AsSpan(1), out var function) &&
            function is >= 1 and <= 24)
            return checked((ushort)(0x70 + function - 1));
        if (code.StartsWith("Numpad", StringComparison.Ordinal) &&
            code.Length == 7 && code[6] is >= '0' and <= '9')
            return checked((ushort)(0x60 + code[6] - '0'));

        return code switch
        {
            "Backspace" => 0x08,
            "Tab" => 0x09,
            "Enter" or "NumpadEnter" => 0x0D,
            "ShiftLeft" or "ShiftRight" => 0x10,
            "ControlLeft" or "ControlRight" => 0x11,
            "AltLeft" or "AltRight" => 0x12,
            "Pause" => 0x13,
            "CapsLock" => 0x14,
            "Escape" => 0x1B,
            "Space" => 0x20,
            "PageUp" => 0x21,
            "PageDown" => 0x22,
            "End" => 0x23,
            "Home" => 0x24,
            "ArrowLeft" => 0x25,
            "ArrowUp" => 0x26,
            "ArrowRight" => 0x27,
            "ArrowDown" => 0x28,
            "PrintScreen" => 0x2C,
            "Insert" => 0x2D,
            "Delete" => 0x2E,
            "MetaLeft" => 0x5B,
            "MetaRight" => 0x5C,
            "ContextMenu" => 0x5D,
            "NumpadMultiply" => 0x6A,
            "NumpadAdd" => 0x6B,
            "NumpadSubtract" => 0x6D,
            "NumpadDecimal" => 0x6E,
            "NumpadDivide" => 0x6F,
            "NumLock" => 0x90,
            "ScrollLock" => 0x91,
            "Semicolon" => 0xBA,
            "Equal" => 0xBB,
            "Comma" => 0xBC,
            "Minus" => 0xBD,
            "Period" => 0xBE,
            "Slash" => 0xBF,
            "Backquote" => 0xC0,
            "BracketLeft" => 0xDB,
            "Backslash" => 0xDC,
            "BracketRight" => 0xDD,
            "Quote" => 0xDE,
            _ => key switch
            {
                "Enter" => 0x0D,
                "Escape" => 0x1B,
                "Delete" => 0x2E,
                _ => 0,
            },
        };
    }

    private static bool IsExtendedKey(string code) =>
        code is "ControlRight" or "AltRight" or "NumpadEnter" or
                "Insert" or "Delete" or "Home" or "End" or
                "PageUp" or "PageDown" or "ArrowLeft" or
                "ArrowRight" or "ArrowUp" or "ArrowDown" or
                "MetaLeft" or "MetaRight";

    private static void SendUnicode(char character)
    {
        SendInputOrThrow(new NativeInput
        {
            Type = InputKeyboard,
            Data = new InputData
            {
                Keyboard = new KeyboardInput
                {
                    Scan = character,
                    Flags = KeyEventUnicode,
                },
            },
        });
        SendInputOrThrow(new NativeInput
        {
            Type = InputKeyboard,
            Data = new InputData
            {
                Keyboard = new KeyboardInput
                {
                    Scan = character,
                    Flags = KeyEventUnicode | KeyEventKeyUp,
                },
            },
        });
    }

    private static void SendVirtualKey(ushort virtualKey, bool down, bool extended)
    {
        SendInputOrThrow(new NativeInput
        {
            Type = InputKeyboard,
            Data = new InputData
            {
                Keyboard = new KeyboardInput
                {
                    VirtualKey = virtualKey,
                    Flags = (down ? 0u : KeyEventKeyUp) |
                            (extended ? KeyEventExtendedKey : 0u),
                },
            },
        });
    }

    private static void SendMouse(int x, int y, uint mouseData, uint flags)
    {
        SendInputOrThrow(new NativeInput
        {
            Type = InputMouse,
            Data = new InputData
            {
                Mouse = new MouseInput
                {
                    X = x,
                    Y = y,
                    MouseData = mouseData,
                    Flags = flags,
                },
            },
        });
    }

    private static void SendInputOrThrow(NativeInput input)
    {
        var inputs = new[] { input };
        if (SendInput(1, inputs, Marshal.SizeOf<NativeInput>()) != 1)
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(
        uint inputCount,
        [In] NativeInput[] inputs,
        int inputSize);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeInput
    {
        public uint Type;
        public InputData Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputData
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X;
        public int Y;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort VirtualKey;
        public ushort Scan;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }
}
