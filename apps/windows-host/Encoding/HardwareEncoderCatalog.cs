using Vortice.MediaFoundation;

namespace EdizRemote.Host.Encoding;

internal sealed record HardwareEncoderCapability(
    string Name,
    string Codec,
    Guid? TransformId,
    bool IsAsync,
    bool IsD3D11Aware,
    bool CanActivate,
    string? VendorId,
    string? HardwareUrl,
    string? ActivationError);

internal sealed record HardwareEncoderReport(
    bool Available,
    string Codec,
    IReadOnlyList<HardwareEncoderCapability> Encoders,
    string? Error)
{
    public HardwareEncoderCapability? Preferred => Encoders.FirstOrDefault();
}

internal static class HardwareEncoderCatalog
{
    // MFVideoFormat_H264 (FourCC "H264"). Keeping the GUID local makes the
    // signaling-facing codec contract independent from a wrapper-specific name.
    internal static readonly Guid H264Subtype =
        new("34363248-0000-0010-8000-00AA00389B71");

    public static HardwareEncoderReport DiscoverH264()
    {
        if (!OperatingSystem.IsWindows())
        {
            return Unavailable("Media Foundation yalnızca Windows üzerinde kullanılabilir.");
        }

        var startupResult = MediaFactory.MFStartup();
        if (startupResult.Failure)
        {
            return Unavailable(
                $"Media Foundation başlatılamadı: {startupResult.Description} (0x{startupResult.Code:X8})");
        }

        try
        {
            var outputType = new RegisterTypeInfo
            {
                GuidMajorType = MediaTypeGuids.Video,
                GuidSubtype = H264Subtype,
            };
            var flags = (uint)(EnumFlag.EnumFlagHardware | EnumFlag.EnumFlagSortandfilter);
            using var activations = MediaFactory.MFTEnumEx(
                TransformCategoryGuids.VideoEncoder,
                flags,
                inputType: null,
                outputType);

            var encoders = new List<HardwareEncoderCapability>();
            foreach (var activation in activations)
            {
                using (activation)
                {
                    var activationProbe = ProbeActivation(activation);
                    encoders.Add(new HardwareEncoderCapability(
                        ReadString(activation, TransformAttributeKeys.MftFriendlyNameAttribute)
                            ?? "Adsız Media Foundation encoder",
                        "H.264",
                        ReadGuid(activation, TransformAttributeKeys.MftTransformClsidAttribute),
                        ReadBoolean(activation, TransformAttributeKeys.TransformAsync),
                        activationProbe.IsD3D11Aware ||
                            ReadBoolean(activation, TransformAttributeKeys.D3D11Aware),
                        activationProbe.CanActivate,
                        ReadString(activation, TransformAttributeKeys.MftEnumHardwareVendorIdAttribute),
                        ReadString(activation, TransformAttributeKeys.MftEnumHardwareUrlAttribute),
                        activationProbe.Error));
                }
            }

            return new HardwareEncoderReport(
                encoders.Count > 0,
                "H.264",
                encoders,
                encoders.Count == 0
                    ? "Sistemde Media Foundation uyumlu donanım H.264 encoder bulunamadı."
                    : null);
        }
        catch (Exception)
        {
            return Unavailable("Donanım H.264 encoder keşfi tamamlanamadı.");
        }
        finally
        {
            MediaFactory.MFShutdown();
        }
    }

    private static string? ReadString(IMFActivate activation, Guid key)
    {
        try
        {
            return activation.GetString(key);
        }
        catch
        {
            return null;
        }
    }

    private static Guid? ReadGuid(IMFActivate activation, Guid key)
    {
        var result = activation.GetGUID(key, out var value);
        return result.Success ? value : null;
    }

    private static bool ReadBoolean(IMFActivate activation, Guid key)
    {
        var result = activation.GetUInt32(key, out var value);
        return result.Success && value != 0;
    }

    private static (bool CanActivate, bool IsD3D11Aware, string? Error) ProbeActivation(
        IMFActivate activation)
    {
        try
        {
            using var transform = activation.ActivateObject<IMFTransform>();
            using var attributes = transform.Attributes;
            var d3d11Aware = attributes.GetUInt32(
                TransformAttributeKeys.D3D11Aware,
                out var value).Success && value != 0;
            return (true, d3d11Aware, null);
        }
        catch (Exception)
        {
            return (false, false, "Encoder etkinleştirilemedi.");
        }
    }

    private static HardwareEncoderReport Unavailable(string error)
    {
        return new HardwareEncoderReport(false, "H.264", [], error);
    }
}
