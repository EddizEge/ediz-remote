using Vortice.DXGI;
using static Vortice.DXGI.DXGI;

namespace EdizRemote.Host.Capture;

internal sealed record DisplayOutput(
    int Index,
    int AdapterIndex,
    int OutputIndex,
    string AdapterName,
    string DeviceName,
    int Left,
    int Top,
    int Width,
    int Height,
    string Rotation,
    bool AttachedToDesktop);

internal static class DisplayCatalog
{
    public static IReadOnlyList<DisplayOutput> Enumerate()
    {
        var displays = new List<DisplayOutput>();
        using var factory = CreateDXGIFactory1<IDXGIFactory1>();

        for (uint adapterIndex = 0; ; adapterIndex++)
        {
            var adapterResult = factory.EnumAdapters1(adapterIndex, out var adapter);
            if (adapterResult.Code == ResultCode.NotFound.Code) break;
            ThrowIfFailed(adapterResult, "DXGI ekran kartı listelenemedi");
            using (adapter)
            {
                for (uint outputIndex = 0; ; outputIndex++)
                {
                    var outputResult = adapter.EnumOutputs(outputIndex, out var output);
                    if (outputResult.Code == ResultCode.NotFound.Code) break;
                    ThrowIfFailed(outputResult, "DXGI ekran çıkışı listelenemedi");
                    using (output)
                    {
                        var description = output.Description;
                        if (!description.AttachedToDesktop) continue;
                        var bounds = description.DesktopCoordinates;
                        displays.Add(new DisplayOutput(
                            displays.Count,
                            checked((int)adapterIndex),
                            checked((int)outputIndex),
                            adapter.Description1.Description.TrimEnd('\0'),
                            description.DeviceName.TrimEnd('\0'),
                            bounds.Left,
                            bounds.Top,
                            bounds.Right - bounds.Left,
                            bounds.Bottom - bounds.Top,
                            description.Rotation.ToString(),
                            description.AttachedToDesktop));
                    }
                }
            }
        }

        return displays;
    }

    internal static void ThrowIfFailed(SharpGen.Runtime.Result result, string message)
    {
        if (result.Failure)
        {
            throw new InvalidOperationException($"{message}: {result.Description} (0x{result.Code:X8})");
        }
    }
}
