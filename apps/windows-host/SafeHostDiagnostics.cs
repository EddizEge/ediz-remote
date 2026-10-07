using System.Text.Json;

namespace EdizRemote.Host;

internal enum SafeHostErrorCode
{
    InvalidArguments,
    NativeOperationFailed,
}

internal static class SafeHostDiagnostics
{
    private static readonly JsonSerializerOptions JsonOptions =
        new(JsonSerializerDefaults.Web);

    internal static string SerializeError(
        SafeHostErrorCode errorCode,
        DateTimeOffset timestamp)
    {
        var (code, message) = errorCode switch
        {
            SafeHostErrorCode.InvalidArguments => (
                "invalid_arguments",
                "Komut satırı seçenekleri geçersiz."),
            SafeHostErrorCode.NativeOperationFailed => (
                "native_operation_failed",
                "Native işlem güvenli biçimde tamamlanamadı."),
            _ => throw new ArgumentOutOfRangeException(nameof(errorCode)),
        };

        return JsonSerializer.Serialize(new
        {
            type = "host.error",
            timestamp,
            payload = new { code, message },
        }, JsonOptions);
    }
}
