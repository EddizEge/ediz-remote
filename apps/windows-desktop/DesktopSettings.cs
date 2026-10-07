using System.IO;
using System.Text;
using System.Text.Json;

namespace EdizRemote.Desktop;

internal sealed record DesktopSettings(string SignalingUrl)
{
    internal const string DefaultSignalingUrl = "wss://remote.edizegemercan.com.tr/ws";
    internal const int MaximumSettingsBytes = 16 * 1024;
    private const int MaximumSignalingUrlLength = 2_048;

    public static DesktopSettings Load()
    {
        var settingsPath = Path.Combine(
            AppContext.BaseDirectory,
            "ediz-remote.settings.json");
        var fileJson = ReadSettingsFile(settingsPath);
        return FromSources(
            Environment.GetEnvironmentVariable("EDIZ_REMOTE_SIGNALING_URL"),
            fileJson);
    }

    internal static DesktopSettings FromSources(string? environmentUrl, string? fileJson)
    {
        if (IsValidWebSocketUrl(environmentUrl))
        {
            return new DesktopSettings(environmentUrl!);
        }

        if (!string.IsNullOrWhiteSpace(fileJson))
        {
            if (fileJson.Length > MaximumSettingsBytes ||
                Encoding.UTF8.GetByteCount(fileJson) > MaximumSettingsBytes)
            {
                return new DesktopSettings(DefaultSignalingUrl);
            }

            try
            {
                using var document = JsonDocument.Parse(
                    fileJson,
                    new JsonDocumentOptions
                    {
                        AllowTrailingCommas = false,
                        CommentHandling = JsonCommentHandling.Disallow,
                        MaxDepth = 8,
                    });
                if (document.RootElement.ValueKind != JsonValueKind.Object)
                {
                    return new DesktopSettings(DefaultSignalingUrl);
                }

                JsonElement configuredValue = default;
                var propertyCount = 0;
                foreach (var property in document.RootElement.EnumerateObject())
                {
                    propertyCount += 1;
                    if (propertyCount > 1 ||
                        !string.Equals(
                            property.Name,
                            "signalingUrl",
                            StringComparison.Ordinal) ||
                        property.Value.ValueKind != JsonValueKind.String)
                    {
                        return new DesktopSettings(DefaultSignalingUrl);
                    }
                    configuredValue = property.Value;
                }

                if (propertyCount == 1)
                {
                    var configuredUrl = configuredValue.GetString();
                    if (IsValidWebSocketUrl(configuredUrl))
                    {
                        return new DesktopSettings(configuredUrl!);
                    }
                }
            }
            catch (JsonException)
            {
                // Bozuk yerel ayar uygulamanın açılmasını engellememelidir.
            }
        }

        return new DesktopSettings(DefaultSignalingUrl);
    }

    private static bool IsValidWebSocketUrl(string? value)
    {
        return !string.IsNullOrWhiteSpace(value) &&
            value.Length <= MaximumSignalingUrlLength &&
            Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            (uri.Scheme == "wss" ||
                (uri.Scheme == "ws" && uri.IsLoopback)) &&
            !string.IsNullOrWhiteSpace(uri.Host) &&
            string.IsNullOrEmpty(uri.UserInfo) &&
            string.IsNullOrEmpty(uri.Query) &&
            string.IsNullOrEmpty(uri.Fragment) &&
            string.Equals(uri.AbsolutePath, "/ws", StringComparison.Ordinal);
    }

    internal static string? ReadSettingsFile(string settingsPath)
    {
        try
        {
            if (!File.Exists(settingsPath) ||
                (File.GetAttributes(settingsPath) & FileAttributes.ReparsePoint) != 0)
            {
                return null;
            }

            using var stream = new FileStream(
                settingsPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 4_096,
                FileOptions.SequentialScan);
            if (stream.Length > MaximumSettingsBytes)
            {
                return null;
            }

            var bytes = new byte[MaximumSettingsBytes + 1];
            try
            {
                var total = 0;
                while (total < bytes.Length)
                {
                    var read = stream.Read(bytes, total, bytes.Length - total);
                    if (read == 0)
                    {
                        break;
                    }
                    total += read;
                }

                return total <= MaximumSettingsBytes
                    ? new UTF8Encoding(
                        encoderShouldEmitUTF8Identifier: false,
                        throwOnInvalidBytes: true).GetString(bytes, 0, total)
                    : null;
            }
            finally
            {
                Array.Clear(bytes);
            }
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
        catch (System.Security.SecurityException)
        {
            return null;
        }
        catch (DecoderFallbackException)
        {
            return null;
        }
    }
}
