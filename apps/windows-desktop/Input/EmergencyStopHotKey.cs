using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows.Interop;

namespace EdizRemote.Desktop.Input;

internal sealed class EmergencyStopHotKey : IDisposable
{
    private const int HotKeyId = 0xED12;
    private const int WmHotKey = 0x0312;
    private const uint ModAlt = 0x0001;
    private const uint ModControl = 0x0002;
    private const uint ModShift = 0x0004;
    private const uint ModNoRepeat = 0x4000;
    private const uint VirtualKeyF12 = 0x7B;
    private HwndSource? _source;
    private nint _windowHandle;

    public event Action? Triggered;

    public void Register(nint windowHandle)
    {
        if (_source is not null) return;
        _windowHandle = windowHandle;
        _source = HwndSource.FromHwnd(windowHandle)
            ?? throw new InvalidOperationException("Windows mesaj kaynağı açılamadı.");
        _source.AddHook(WindowProcedure);
        if (!RegisterHotKey(
                windowHandle,
                HotKeyId,
                ModControl | ModAlt | ModShift | ModNoRepeat,
                VirtualKeyF12))
        {
            _source.RemoveHook(WindowProcedure);
            _source = null;
            _windowHandle = 0;
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public void Dispose()
    {
        if (_source is null) return;
        UnregisterHotKey(_windowHandle, HotKeyId);
        _source.RemoveHook(WindowProcedure);
        _source = null;
        _windowHandle = 0;
    }

    private nint WindowProcedure(
        nint windowHandle,
        int message,
        nint wordParameter,
        nint longParameter,
        ref bool handled)
    {
        if (message == WmHotKey && wordParameter == HotKeyId)
        {
            handled = true;
            Triggered?.Invoke();
        }
        return 0;
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RegisterHotKey(
        nint windowHandle,
        int identifier,
        uint modifiers,
        uint virtualKey);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnregisterHotKey(nint windowHandle, int identifier);
}
