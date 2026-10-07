using EdizRemote.Desktop;

namespace EdizRemote.Desktop.Tests;

public sealed class DesktopErrorCodeTests
{
    [Fact]
    public void NullBridgeErrorRemainsAbsent()
    {
        Assert.Null(DesktopErrorCodes.RequireAllowed(null));
    }

    [Theory]
    [InlineData(DesktopErrorCodes.InitializationFailed)]
    [InlineData(DesktopErrorCodes.NavigationFailed)]
    [InlineData(DesktopErrorCodes.CaptureFailed)]
    [InlineData(DesktopErrorCodes.EncoderFailed)]
    [InlineData(DesktopErrorCodes.GpuInputFailed)]
    [InlineData(DesktopErrorCodes.ControlInputFailed)]
    [InlineData(DesktopErrorCodes.DisplaySwitchFailed)]
    [InlineData(DesktopErrorCodes.QualitySwitchFailed)]
    [InlineData(DesktopErrorCodes.NativeVideoFailed)]
    public void AllowsOnlyStableBridgeErrorCodes(string errorCode)
    {
        Assert.True(DesktopErrorCodes.IsAllowed(errorCode));
        Assert.Equal(errorCode, DesktopErrorCodes.RequireAllowed(errorCode));
    }

    [Theory]
    [InlineData("driver=C:\\private token=secret")]
    [InlineData("DXGI failed: 0x887A0026")]
    [InlineData("C:\\Users\\Customer\\Desktop")]
    public void RejectsRawOrUnexpectedBridgeErrors(string error)
    {
        Assert.False(DesktopErrorCodes.IsAllowed(error));
        Assert.Throws<ArgumentOutOfRangeException>(
            () => DesktopErrorCodes.RequireAllowed(error));
    }
}
