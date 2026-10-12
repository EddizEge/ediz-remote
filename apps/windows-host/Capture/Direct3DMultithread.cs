using Vortice.Direct3D11;

namespace EdizRemote.Host.Capture;

internal static class Direct3DMultithread
{
    // The capture/convert loop and asynchronous Media Foundation encoder
    // threads (through IMFDXGIDeviceManager) share one immediate context.
    // Media Foundation requires multithread protection on such a device;
    // without it the D3D11 runtime and driver state are mutated concurrently.
    public static void Enable(ID3D11Device device)
    {
        using var multithread = device.QueryInterface<ID3D11Multithread>();
        multithread.SetMultithreadProtected(true);
    }
}
