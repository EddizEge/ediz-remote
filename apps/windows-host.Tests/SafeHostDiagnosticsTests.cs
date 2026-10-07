using System.Text.Json;
using EdizRemote.Host;

namespace EdizRemote.Host.Tests;

public sealed class SafeHostDiagnosticsTests
{
    [Theory]
    [InlineData((int)SafeHostErrorCode.InvalidArguments, "invalid_arguments")]
    [InlineData((int)SafeHostErrorCode.NativeOperationFailed, "native_operation_failed")]
    public void ErrorEventContainsOnlyAllowlistedFields(
        int errorCodeValue,
        string expectedCode)
    {
        const string sentinel = "ER_SENTINEL_TOKEN_SDP_ICE_CREDENTIAL";
        var json = SafeHostDiagnostics.SerializeError(
            (SafeHostErrorCode)errorCodeValue,
            DateTimeOffset.Parse("2026-09-02T12:00:00Z"));

        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        Assert.Equal(new[] { "type", "timestamp", "payload" },
            root.EnumerateObject().Select(property => property.Name));
        Assert.Equal(new[] { "code", "message" },
            root.GetProperty("payload").EnumerateObject().Select(property => property.Name));
        Assert.Equal("host.error", root.GetProperty("type").GetString());
        Assert.Equal(expectedCode, root.GetProperty("payload").GetProperty("code").GetString());
        Assert.DoesNotContain("detail", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("exception", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(sentinel, json, StringComparison.Ordinal);
    }
}
