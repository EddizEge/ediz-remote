using EdizRemote.Host.Capture;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.MediaFoundation;
using Vortice.DXGI;
using static Vortice.Direct3D11.D3D11;
using static Vortice.DXGI.DXGI;

namespace EdizRemote.Host.Encoding;

internal sealed record HardwareEncoderGpuReport(
    bool Ready,
    string Codec,
    string? EncoderName,
    string AdapterName,
    bool DeviceManagerCreated,
    bool DeviceManagerAttached,
    bool GpuSurfaceWrapped,
    string? Error);

internal static class HardwareEncoderGpuProbe
{
    public static HardwareEncoderGpuReport Probe(DisplayOutput output)
    {
        var startup = MediaFoundationPlatform.EnsureStarted();
        if (startup.Failure)
        {
            return Failed(output, $"Media Foundation başlatılamadı: {startup.Description}");
        }

        var managerCreated = false;
        try
        {
            using var factory = CreateDXGIFactory1<Vortice.DXGI.IDXGIFactory1>();
            var adapterResult = factory.EnumAdapters1((uint)output.AdapterIndex, out var adapter);
            DisplayCatalog.ThrowIfFailed(adapterResult, "Encoder ekran kartı açılamadı");
            using (adapter)
            {
                var deviceResult = D3D11CreateDevice(
                    adapter,
                    DriverType.Unknown,
                    DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport,
                    null!,
                    out ID3D11Device device,
                    out ID3D11DeviceContext context);
                DisplayCatalog.ThrowIfFailed(deviceResult, "Encoder Direct3D 11 cihazı oluşturulamadı");
                using (device)
                using (context)
                using (var manager = MediaFactory.MFCreateDXGIDeviceManager())
                {
                    Direct3DMultithread.Enable(device);
                    managerCreated = true;
                    var resetResult = manager.ResetDevice(device);
                    DisplayCatalog.ThrowIfFailed(resetResult, "Media Foundation DXGI cihaz yöneticisi ayarlanamadı");

                    var outputType = new RegisterTypeInfo
                    {
                        GuidMajorType = MediaTypeGuids.Video,
                        GuidSubtype = HardwareEncoderCatalog.H264Subtype,
                    };
                    var flags = (uint)(EnumFlag.EnumFlagHardware | EnumFlag.EnumFlagSortandfilter);
                    using var activations = MediaFactory.MFTEnumEx(
                        TransformCategoryGuids.VideoEncoder,
                        flags,
                        inputType: null,
                        outputType);
                    using var activation = activations.FirstOrDefault();
                    if (activation is null)
                    {
                        return Failed(output, "Donanım H.264 encoder bulunamadı.", managerCreated);
                    }

                    var encoderName = ReadEncoderName(activation);
                    using var transform = activation.ActivateObject<IMFTransform>();
                    try
                    {
                        using var attributes = transform.Attributes;
                        var unlockResult = attributes.Set(
                            TransformAttributeKeys.TransformAsyncUnlock,
                            true);
                        DisplayCatalog.ThrowIfFailed(unlockResult, "Asenkron encoder kilidi açılamadı");

                        transform.ProcessMessage(
                            TMessageType.MessageSetD3DManager,
                            new UIntPtr(unchecked((ulong)manager.NativePointer.ToInt64())));
                    }
                    finally
                    {
                        HardwareEncoderCatalog.ShutdownActivatedObject(activation);
                    }

                    var surfaceDescription = new Texture2DDescription
                    {
                        Width = 1280,
                        Height = 720,
                        MipLevels = 1,
                        ArraySize = 1,
                        Format = Format.NV12,
                        SampleDescription = new SampleDescription(1, 0),
                        Usage = ResourceUsage.Default,
                        BindFlags = BindFlags.ShaderResource | BindFlags.RenderTarget,
                        CPUAccessFlags = CpuAccessFlags.None,
                        MiscFlags = ResourceOptionFlags.None,
                    };
                    using var surface = device.CreateTexture2D(surfaceDescription);
                    using var surfaceBuffer = MediaFactory.MFCreateDXGISurfaceBuffer(
                        typeof(ID3D11Texture2D).GUID,
                        surface,
                        0,
                        false);
                    using var sample = MediaFactory.MFCreateSample();
                    sample.AddBuffer(surfaceBuffer);
                    if (sample.BufferCount != 1)
                    {
                        throw new InvalidOperationException(
                            "NV12 GPU yüzeyi Media Foundation örneğine bağlanamadı.");
                    }

                    return new HardwareEncoderGpuReport(
                        true,
                        "H.264",
                        encoderName,
                        output.AdapterName,
                        true,
                        true,
                        true,
                        null);
                }
            }
        }
        catch (Exception)
        {
            return Failed(
                output,
                "GPU encoder probu tamamlanamadı.",
                managerCreated);
        }
    }

    private static string? ReadEncoderName(IMFActivate activation)
    {
        try
        {
            return activation.GetString(TransformAttributeKeys.MftFriendlyNameAttribute);
        }
        catch
        {
            return null;
        }
    }

    private static HardwareEncoderGpuReport Failed(
        DisplayOutput output,
        string error,
        bool managerCreated = false)
    {
        return new HardwareEncoderGpuReport(
            false,
            "H.264",
            null,
            output.AdapterName,
            managerCreated,
            false,
            false,
            error);
    }
}
