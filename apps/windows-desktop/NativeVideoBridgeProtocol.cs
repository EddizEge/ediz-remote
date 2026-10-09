using System.Text;
using System.Text.Json;
using EdizRemote.Host.WebRtc;

namespace EdizRemote.Desktop;

internal sealed record NativeVideoBridgeSignal(
    string NegotiationId,
    NativeVideoSessionDescription? Description,
    NativeVideoIceCandidate? Candidate);

internal static class NativeVideoBridgeProtocol
{
    internal const int Version = 2;
    internal const int MaximumMessageBytes = 128 * 1024;
    private const int MaximumSdpBytes = 60 * 1024;

    internal static bool IsWithinMessageLimit(string json) =>
        Encoding.UTF8.GetByteCount(json) <= MaximumMessageBytes;

    internal static object CreateNegotiationEnvelope(
        string sessionEpoch,
        string negotiationId)
    {
        RequireUuid(sessionEpoch, nameof(sessionEpoch));
        RequireUuid(negotiationId, nameof(negotiationId));
        return new
        {
            type = "desktop.native-video.negotiation",
            channel = "native-video",
            version = Version,
            sessionEpoch,
            negotiationId,
            payload = new { },
        };
    }

    internal static object CreateStateEnvelope(
        string sessionEpoch,
        string negotiationId,
        NativeVideoPeerState state,
        string? errorCode,
        int? recoveryAttempt,
        int? recoveryMaximumAttempts)
    {
        RequireUuid(sessionEpoch, nameof(sessionEpoch));
        RequireUuid(negotiationId, nameof(negotiationId));
        return new
        {
            type = "desktop.native-video.state",
            channel = "native-video",
            version = Version,
            sessionEpoch,
            negotiationId,
            payload = new
            {
                state = state.ToString().ToLowerInvariant(),
                errorCode,
                recoveryAttempt,
                recoveryMaximumAttempts,
            },
        };
    }

    internal static object CreateMetricsEnvelope(
        string sessionEpoch,
        string negotiationId,
        NativeVideoNetworkMetrics metrics)
    {
        RequireUuid(sessionEpoch, nameof(sessionEpoch));
        RequireUuid(negotiationId, nameof(negotiationId));
        return new
        {
            type = "desktop.native-video.metrics",
            channel = "native-video",
            version = Version,
            sessionEpoch,
            negotiationId,
            payload = new
            {
                packetLossPercent = metrics.PacketLossPercent,
                jitterMilliseconds = metrics.JitterMilliseconds,
                targetBitrate = metrics.TargetBitrate,
                nackRequests = metrics.NackRequests,
                retransmittedPackets = metrics.RetransmittedPackets,
                pliRequests = metrics.PliRequests,
            },
        };
    }

    internal static bool TryReadStartSessionEpoch(JsonElement root, out string sessionEpoch) =>
        TryReadHeader(
            root,
            "desktop.native-video.start",
            ["type", "channel", "version", "sessionEpoch", "iceServers"],
            out sessionEpoch);

    internal static bool TryReadStopSessionEpoch(JsonElement root, out string sessionEpoch) =>
        TryReadHeader(
            root,
            "desktop.native-video.stop",
            ["type", "channel", "version", "sessionEpoch"],
            out sessionEpoch);

    internal static bool TryParseSignal(
        JsonElement root,
        out string sessionEpoch,
        out NativeVideoBridgeSignal? signal)
    {
        signal = null;
        if (!TryReadHeader(
                root,
                "desktop.native-video.signal",
                ["type", "channel", "version", "sessionEpoch", "payload"],
                out sessionEpoch) ||
            !BridgeJson.TryGetProperty(root, "payload", out var payload) ||
            payload.ValueKind != JsonValueKind.Object ||
            !TryReadUuid(payload, "negotiationId", out var negotiationId) ||
            !BridgeJson.TryGetProperty(payload, "kind", out var kind) ||
            !BridgeJson.TryGetString(kind, out var kindValue))
        {
            return false;
        }

        if (kindValue == "session-description")
        {
            if (!HasExactlyProperties(payload, ["kind", "negotiationId", "description"]) ||
                !BridgeJson.TryGetProperty(payload, "description", out var description) ||
                description.ValueKind != JsonValueKind.Object ||
                !HasExactlyProperties(description, ["type", "sdp"]) ||
                !TryReadString(description, "type", 1, 16, out var type) ||
                type != "answer" ||
                !TryReadString(description, "sdp", 1, int.MaxValue, out var sdp) ||
                Encoding.UTF8.GetByteCount(sdp) > MaximumSdpBytes)
            {
                return false;
            }
            signal = new NativeVideoBridgeSignal(
                negotiationId,
                new NativeVideoSessionDescription(type, sdp),
                null);
            return true;
        }

        if (kindValue != "ice-candidate" ||
            !HasExactlyProperties(payload, ["kind", "negotiationId", "candidate"]) ||
            !BridgeJson.TryGetProperty(payload, "candidate", out var candidate) ||
            candidate.ValueKind != JsonValueKind.Object ||
            !HasOnlyProperties(
                candidate,
                ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"]) ||
            !TryReadString(candidate, "candidate", 0, 4_096, out var candidateValue) ||
            !TryReadOptionalString(candidate, "sdpMid", 256, out var sdpMid) ||
            !TryReadOptionalUInt16(candidate, "sdpMLineIndex", out var sdpMLineIndex) ||
            !TryReadOptionalString(
                candidate,
                "usernameFragment",
                256,
                out var usernameFragment))
        {
            return false;
        }

        signal = new NativeVideoBridgeSignal(
            negotiationId,
            null,
            new NativeVideoIceCandidate(
                candidateValue,
                sdpMid,
                sdpMLineIndex,
                usernameFragment));
        return true;
    }

    private static bool TryReadHeader(
        JsonElement root,
        string expectedType,
        IReadOnlyCollection<string> expectedProperties,
        out string sessionEpoch)
    {
        sessionEpoch = string.Empty;
        return root.ValueKind == JsonValueKind.Object &&
               HasExactlyProperties(root, expectedProperties) &&
               TryReadString(root, "type", 1, 64, out var type) &&
               type == expectedType &&
               TryReadString(root, "channel", 1, 32, out var channel) &&
               channel == "native-video" &&
               BridgeJson.TryGetProperty(root, "version", out var version) &&
               version.ValueKind == JsonValueKind.Number &&
               version.TryGetInt32(out var versionValue) &&
               versionValue == Version &&
               TryReadUuid(root, "sessionEpoch", out sessionEpoch);
    }

    private static bool TryReadUuid(
        JsonElement value,
        string propertyName,
        out string result)
    {
        result = string.Empty;
        return TryReadString(value, propertyName, 36, 36, out result) &&
               Guid.TryParseExact(result, "D", out _);
    }

    private static void RequireUuid(string value, string parameterName)
    {
        if (!Guid.TryParseExact(value, "D", out _))
        {
            throw new ArgumentException("Native video nesil kimliği geçersiz.", parameterName);
        }
    }

    private static bool TryReadString(
        JsonElement value,
        string propertyName,
        int minimumLength,
        int maximumLength,
        out string result)
    {
        result = string.Empty;
        if (!BridgeJson.TryGetProperty(value, propertyName, out var property) ||
            !BridgeJson.TryGetString(property, out result))
        {
            return false;
        }
        return result.Length >= minimumLength && result.Length <= maximumLength;
    }

    private static bool TryReadOptionalString(
        JsonElement value,
        string propertyName,
        int maximumLength,
        out string? result)
    {
        result = null;
        if (!BridgeJson.TryGetProperty(value, propertyName, out var property) ||
            property.ValueKind == JsonValueKind.Null)
        {
            return true;
        }
        if (!BridgeJson.TryGetString(property, out var text)) return false;
        result = text;
        return result.Length <= maximumLength;
    }

    private static bool TryReadOptionalUInt16(
        JsonElement value,
        string propertyName,
        out ushort? result)
    {
        result = null;
        if (!BridgeJson.TryGetProperty(value, propertyName, out var property) ||
            property.ValueKind == JsonValueKind.Null)
        {
            return true;
        }
        if (property.ValueKind != JsonValueKind.Number ||
            !property.TryGetUInt16(out var parsed))
        {
            return false;
        }
        result = parsed;
        return true;
    }

    private static bool HasExactlyProperties(
        JsonElement value,
        IReadOnlyCollection<string> expectedProperties)
    {
        // Yinelenen anahtar eksik bir anahtarın yerini tutamaz: her ad bir kez
        // görülmelidir.
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject())
        {
            if (!BridgeJson.TryGetName(property, out var name) ||
                !expectedProperties.Contains(name) ||
                !seen.Add(name))
            {
                return false;
            }
        }
        return seen.Count == expectedProperties.Count;
    }

    private static bool HasOnlyProperties(
        JsonElement value,
        IReadOnlyCollection<string> allowedProperties)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject())
        {
            if (!BridgeJson.TryGetName(property, out var name) ||
                !allowedProperties.Contains(name) ||
                !seen.Add(name))
            {
                return false;
            }
        }
        return true;
    }
}

internal sealed class NativeVideoNegotiationFatalLatch
{
    private int _tripped;

    internal bool IsTripped => Volatile.Read(ref _tripped) != 0;

    internal bool TryTrip() => Interlocked.Exchange(ref _tripped, 1) == 0;
}

internal static class NativeVideoOfferRace
{
    internal static async Task<T> AwaitOfferOrStopAsync<T>(
        Task<T> offerTask,
        Task overflowTask,
        Func<Task> stopAsync)
    {
        var completed = await Task.WhenAny(offerTask, overflowTask);
        if (ReferenceEquals(completed, offerTask)) return await offerTask;

        await overflowTask;
        ObserveFault(offerTask);
        await stopAsync();
        throw new InvalidOperationException("Native ICE aday kuyruğu sınırı aşıldı.");
    }

    private static void ObserveFault(Task task)
    {
        _ = task.ContinueWith(
            static completed => _ = completed.Exception,
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted |
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }
}

internal sealed class NativeIceCandidateBuffer
{
    internal const int MaximumCandidates = 64;
    internal const int MaximumBytes = 64 * 1024;
    private readonly List<NativeVideoIceCandidate> _candidates = [];
    private int _bytes;

    internal bool TryEnqueue(NativeVideoIceCandidate candidate)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(candidate).Length;
        if (_candidates.Count >= MaximumCandidates || _bytes + bytes > MaximumBytes)
        {
            return false;
        }
        _candidates.Add(candidate);
        _bytes += bytes;
        return true;
    }

    internal IReadOnlyList<NativeVideoIceCandidate> Drain()
    {
        var result = _candidates.ToArray();
        _candidates.Clear();
        _bytes = 0;
        return result;
    }

    internal int Count => _candidates.Count;
    internal int ByteCount => _bytes;
}
