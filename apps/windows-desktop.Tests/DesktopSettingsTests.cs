using EdizRemote.Desktop;

namespace EdizRemote.Desktop.Tests;

public sealed class DesktopSettingsTests
{
    [Fact]
    public void EnvironmentValueHasPriority()
    {
        var settings = DesktopSettings.FromSources(
            "ws://127.0.0.1:8788/ws",
            "{\"signalingUrl\":\"wss://example.test/ws\"}");

        Assert.Equal("ws://127.0.0.1:8788/ws", settings.SignalingUrl);
    }

    [Fact]
    public void ReadsSecureUrlFromJson()
    {
        var settings = DesktopSettings.FromSources(
            null,
            "{\"signalingUrl\":\"wss://remote.example.test/ws\"}");

        Assert.Equal("wss://remote.example.test/ws", settings.SignalingUrl);
    }

    [Theory]
    [InlineData("ws://127.0.0.1:8788/ws")]
    [InlineData("ws://localhost:8788/ws")]
    [InlineData("ws://[::1]:8788/ws")]
    public void AllowsPlaintextWebSocketOnlyForLoopback(string loopbackUrl)
    {
        var settings = DesktopSettings.FromSources(loopbackUrl, null);

        Assert.Equal(loopbackUrl, settings.SignalingUrl);
    }

    [Theory]
    [InlineData("not-json")]
    [InlineData("[]")]
    [InlineData("{\"signalingUrl\":42}")]
    [InlineData("{\"SignalingUrl\":\"wss://example.test/ws\"}")]
    [InlineData("{\"signalingUrl\":\"wss://example.test/ws\",\"extra\":true}")]
    [InlineData("{\"signalingUrl\":\"wss://first.test/ws\",\"signalingUrl\":\"wss://second.test/ws\"}")]
    [InlineData("{\"signalingUrl\":\"https://example.test\"}")]
    [InlineData(null)]
    public void InvalidConfigurationFallsBackToDefault(string? fileJson)
    {
        var settings = DesktopSettings.FromSources(null, fileJson);

        Assert.Equal(DesktopSettings.DefaultSignalingUrl, settings.SignalingUrl);
    }

    [Theory]
    [InlineData("wss://support:ER_SENTINEL_PASSWORD@example.test/ws")]
    [InlineData("wss://example.test/ws?token=ER_SENTINEL_TOKEN")]
    [InlineData("wss://example.test/ws#ER_SENTINEL_FRAGMENT")]
    [InlineData("wss://example.test/not-ws")]
    [InlineData("wss://example.test/ws/")]
    [InlineData("https://example.test/ws")]
    [InlineData("ws://example.test/ws")]
    [InlineData("ws://192.168.1.20:8788/ws")]
    public void RejectsWebSocketUrlsThatCanCarrySecretsOrTargetAnotherPath(string environmentUrl)
    {
        const string safeFileUrl = "wss://safe.example.test/ws";

        var settings = DesktopSettings.FromSources(
            environmentUrl,
            $"{{\"signalingUrl\":\"{safeFileUrl}\"}}");

        Assert.Equal(safeFileUrl, settings.SignalingUrl);
        Assert.DoesNotContain("ER_SENTINEL", settings.SignalingUrl, StringComparison.Ordinal);
    }

    [Fact]
    public void OversizedSettingsFallBackWithoutParsing()
    {
        var oversized = $"{{\"signalingUrl\":\"wss://example.test/ws\",\"padding\":\"{new string('x', DesktopSettings.MaximumSettingsBytes)}\"}}";

        var settings = DesktopSettings.FromSources(null, oversized);

        Assert.Equal(DesktopSettings.DefaultSignalingUrl, settings.SignalingUrl);
    }

    [Fact]
    public void OversizedEnvironmentUrlFallsBackToSafeFileValue()
    {
        const string safeFileUrl = "wss://safe.example.test/ws";
        var oversizedUrl = $"wss://example.test/{new string('x', 2_048)}/ws";

        var settings = DesktopSettings.FromSources(
            oversizedUrl,
            $"{{\"signalingUrl\":\"{safeFileUrl}\"}}");

        Assert.Equal(safeFileUrl, settings.SignalingUrl);
    }

    [Fact]
    public void SettingsFileReadIsBoundedAndRequiresValidUtf8()
    {
        var testDirectory = Path.Combine(
            Path.GetTempPath(),
            $"EdizRemote.SettingsTests.{Guid.NewGuid():N}");
        Directory.CreateDirectory(testDirectory);
        try
        {
            var validPath = Path.Combine(testDirectory, "valid.json");
            const string validJson = "{\"signalingUrl\":\"wss://safe.example.test/ws\"}";
            File.WriteAllText(validPath, validJson);
            Assert.Equal(validJson, DesktopSettings.ReadSettingsFile(validPath));

            var oversizedPath = Path.Combine(testDirectory, "oversized.json");
            File.WriteAllBytes(
                oversizedPath,
                new byte[DesktopSettings.MaximumSettingsBytes + 1]);
            Assert.Null(DesktopSettings.ReadSettingsFile(oversizedPath));

            var invalidUtf8Path = Path.Combine(testDirectory, "invalid-utf8.json");
            File.WriteAllBytes(invalidUtf8Path, [0xc3, 0x28]);
            Assert.Null(DesktopSettings.ReadSettingsFile(invalidUtf8Path));
        }
        finally
        {
            Directory.Delete(testDirectory, recursive: true);
        }
    }
}
