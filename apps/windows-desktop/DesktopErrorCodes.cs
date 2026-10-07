namespace EdizRemote.Desktop;

internal static class DesktopErrorCodes
{
    internal const string InitializationFailed = "initialization_failed";
    internal const string NavigationFailed = "navigation_failed";
    internal const string CaptureFailed = "capture_failed";
    internal const string EncoderFailed = "encoder_failed";
    internal const string GpuInputFailed = "gpu_input_failed";
    internal const string ControlInputFailed = "control_input_failed";
    internal const string DisplaySwitchFailed = "display_switch_failed";
    internal const string QualitySwitchFailed = "quality_switch_failed";
    internal const string NativeVideoFailed = "native_video_failed";

    internal static bool IsAllowed(string? errorCode) =>
        errorCode is
            InitializationFailed or
            NavigationFailed or
            CaptureFailed or
            EncoderFailed or
            GpuInputFailed or
            ControlInputFailed or
            DisplaySwitchFailed or
            QualitySwitchFailed or
            NativeVideoFailed;

    internal static string? RequireAllowed(string? errorCode)
    {
        if (errorCode is null || IsAllowed(errorCode)) return errorCode;
        throw new ArgumentOutOfRangeException(
            nameof(errorCode),
            "Desktop bridge error code is not allowlisted.");
    }
}
