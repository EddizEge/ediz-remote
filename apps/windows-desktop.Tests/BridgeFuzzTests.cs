using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using EdizRemote.Desktop;
using EdizRemote.Desktop.Input;
using EdizRemote.Host.WebRtc;

namespace EdizRemote.Desktop.Tests;

// WebView2 köprüsünün WPF tarafındaki ayrıştırıcıları için seed'li fuzz matrisi.
// Uzak eşin ürettiği değerler (SDP, ICE, tuş, kimlik) bu sınıra ulaşır; Try*
// ayrıştırıcıları hiçbir girdide istisna fırlatmamalı, kabul ettikleri değer de
// protokol sınırları içinde kalmalıdır.
public sealed class BridgeFuzzTests
{
    private const int Seed = 0x42524447;
    private const int RandomDocuments = 2_500;
    private const int MutationsPerSeed = 250;
    private const string SessionEpoch = "11111111-1111-4111-8111-111111111111";
    private const string NegotiationId = "22222222-2222-4222-8222-222222222222";
    private const string SessionId = "33333333-3333-4333-8333-333333333333";
    private const string LoneSurrogateToken = "__EDIZ_LONE_SURROGATE__";

    private static readonly JsonSerializerOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static readonly string[] SuspiciousKeys =
    [
        "__proto__", "constructor", "prototype", "toString", "", " type", "TYPE",
        "__unexpected",
    ];

    private static readonly string[] ProtocolKeys =
    [
        "type", "channel", "version", "sessionEpoch", "sessionId", "payload", "kind",
        "negotiationId", "description", "sdp", "candidate", "sdpMid", "sdpMLineIndex",
        "usernameFragment", "iceServers", "urls", "username", "credential", "enabled",
        "sequence", "event", "x", "y", "button", "down", "deltaX", "deltaY", "code",
        "key", "location", "repeat",
    ];

    private static readonly string[] ProtocolStrings =
    [
        "desktop.native-video.start", "desktop.native-video.stop",
        "desktop.native-video.signal", "desktop.control.set-enabled",
        "desktop.control.event", "native-video", "control", "control.event",
        "pointer.move", "pointer.button", "pointer.wheel", "keyboard.key",
        "session-description", "ice-candidate", "answer", "offer", "left", "right",
        SessionEpoch, NegotiationId, SessionId, "stun:stun.example.test",
        "turn:turn.example.test:3478",
    ];

    private static readonly string[] InterestingStrings =
    [
        "", " ", "null", "true", "0", "\0", "\u0007", "\u2028", "\uffff",
        "\U0001F600", "İıŞşĞğ", "\"", "\\", "\r\n", "<script>", "../..",
        LoneSurrogateToken, new string('x', 65), new string('y', 257),
        new string('z', 513), new string('w', 4_097),
    ];

    private static readonly double[] InterestingNumbers =
    [
        0, -0.0, 1, -1, 2, 3, 0.5, 1.0000001, -0.0001, 65_535, 65_536,
        int.MaxValue, (double)int.MaxValue + 1, 9_007_199_254_740_991,
        9_007_199_254_740_993, double.Epsilon, 1e308, -1e308, 10_000.5,
    ];

    private static readonly (string Name, string Json, Func<JsonElement, bool> Accepts)[] Seeds =
    [
        ("start", $$"""
            {"type":"desktop.native-video.start","channel":"native-video","version":2,
             "sessionEpoch":"{{SessionEpoch}}","iceServers":[
               {"urls":["stun:stun.example.test:3478"]},
               {"urls":["turn:turn.example.test:3478?transport=udp"],"username":"1:u","credential":"c"}]}
            """, AcceptsStart),
        ("stop", $$"""
            {"type":"desktop.native-video.stop","channel":"native-video","version":2,
             "sessionEpoch":"{{SessionEpoch}}"}
            """, root => NativeVideoBridgeProtocol.TryReadStopSessionEpoch(root, out _)),
        ("answer", $$$"""
            {"type":"desktop.native-video.signal","channel":"native-video","version":2,
             "sessionEpoch":"{{{SessionEpoch}}}","payload":{"kind":"session-description",
             "negotiationId":"{{{NegotiationId}}}","description":{"type":"answer","sdp":"v=0\r\n"} }}
            """, AcceptsSignal),
        ("candidate", $$$"""
            {"type":"desktop.native-video.signal","channel":"native-video","version":2,
             "sessionEpoch":"{{{SessionEpoch}}}","payload":{"kind":"ice-candidate",
             "negotiationId":"{{{NegotiationId}}}","candidate":{"candidate":"candidate:1 1 udp 1 192.0.2.1 9 typ host",
             "sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"abcd"} }}
            """, AcceptsSignal),
        ("candidate-nulls", $$$"""
            {"type":"desktop.native-video.signal","channel":"native-video","version":2,
             "sessionEpoch":"{{{SessionEpoch}}}","payload":{"kind":"ice-candidate",
             "negotiationId":"{{{NegotiationId}}}","candidate":{"candidate":"","sdpMid":null,
             "sdpMLineIndex":null,"usernameFragment":null} }}
            """, AcceptsSignal),
        ("set-enabled", $$"""
            {"type":"desktop.control.set-enabled","channel":"control","version":1,
             "sessionId":"{{SessionId}}","enabled":true}
            """, root => ControlBridgeProtocol.TryParseSetEnabled(root, out _, out _)),
        ("pointer-move", ControlEventJson("""{"kind":"pointer.move","x":0.25,"y":0.75}"""), AcceptsControlEvent),
        ("pointer-button", ControlEventJson("""{"kind":"pointer.button","button":"left","down":true,"x":0.5,"y":0.5}"""), AcceptsControlEvent),
        ("pointer-button-bare", ControlEventJson("""{"kind":"pointer.button","button":"right","down":false}"""), AcceptsControlEvent),
        ("pointer-wheel", ControlEventJson("""{"kind":"pointer.wheel","deltaX":0,"deltaY":-120}"""), AcceptsControlEvent),
        ("keyboard-key", ControlEventJson("""{"kind":"keyboard.key","code":"KeyI","key":"ı","location":0,"down":true,"repeat":false}"""), AcceptsControlEvent),
    ];

    [Fact]
    public void AcceptsEveryValidSeed()
    {
        foreach (var (name, json, accepts) in Seeds)
        {
            using var document = JsonDocument.Parse(json);
            Assert.True(accepts(document.RootElement), name);
        }
    }

    [Fact]
    public void ParsersNeverThrowOnArbitraryJsonDocuments()
    {
        var random = new Random(Seed);
        var failures = new List<string>();
        for (var iteration = 0; iteration < RandomDocuments; iteration++)
        {
            var json = RandomJson(random, 0);
            using var document = JsonDocument.Parse(json);
            InvokeAllParsers(document.RootElement, $"seed={Seed} iteration={iteration}", failures);
            // Gerçek akışta zarflar yük alanında da taşınır; aynı değeri iç içe dene.
            using var wrapped = JsonDocument.Parse(
                $$"""{"type":"desktop.control.event","channel":"control","version":1,"sessionId":"{{SessionId}}","payload":{{json}}}""");
            InvokeAllParsers(wrapped.RootElement, $"seed={Seed} iteration={iteration} wrapped", failures);
        }
        Assert.True(failures.Count == 0, string.Join(Environment.NewLine, failures.Take(20)));
    }

    [Fact]
    public void ParsersNeverThrowOnMutationsAndAcceptOnlyBoundedValues()
    {
        var random = new Random(Seed ^ 0x5eed);
        var failures = new List<string>();
        foreach (var (name, json, _) in Seeds)
        {
            for (var iteration = 0; iteration < MutationsPerSeed; iteration++)
            {
                var mutated = Mutate(random, json);
                using var document = JsonDocument.Parse(mutated);
                InvokeAllParsers(document.RootElement, $"seed={Seed ^ 0x5eed} {name} iteration={iteration}", failures);
            }
        }
        Assert.True(failures.Count == 0, string.Join(Environment.NewLine, failures.Take(20)));
    }

    [Fact]
    public void RejectsSuspiciousKeysAtEveryObjectDepth()
    {
        foreach (var (name, json, accepts) in Seeds)
        {
            var root = JsonNode.Parse(json)!;
            var objectSlots = CollectSlots(root).Where(slot => slot.Node is JsonObject).ToArray();
            for (var slotIndex = 0; slotIndex < objectSlots.Length; slotIndex++)
            {
                foreach (var key in SuspiciousKeys)
                {
                    var copy = JsonNode.Parse(json)!;
                    var target = (JsonObject)CollectSlots(copy)
                        .Where(slot => slot.Node is JsonObject)
                        .ElementAt(slotIndex)
                        .Node!;
                    if (target.ContainsKey(key)) continue;
                    target[key] = true;
                    using var document = JsonDocument.Parse(Serialize(copy));
                    Assert.False(accepts(document.RootElement), $"{name} slot={slotIndex} key={key}");
                }
            }
        }
    }

    [Fact]
    public void RejectsUnpairedSurrogatesInEveryStringAndPropertyName()
    {
        foreach (var (name, json, accepts) in Seeds)
        {
            var stringSlots = CollectSlots(JsonNode.Parse(json)!)
                .Select((slot, index) => (slot, index))
                .Where(entry => entry.slot.Node is JsonValue value &&
                                value.GetValueKind() == JsonValueKind.String)
                .Select(entry => entry.index)
                .ToArray();
            foreach (var slotIndex in stringSlots)
            {
                var copy = JsonNode.Parse(json)!;
                var slot = CollectSlots(copy)[slotIndex];
                var mutated = Replace(copy, slot, JsonValue.Create(LoneSurrogateToken));
                using var document = JsonDocument.Parse(mutated);
                var accepted = true;
                var exception = Record.Exception(() => accepted = accepts(document.RootElement));
                Assert.Null(exception);
                Assert.False(accepted, $"{name} string slot={slotIndex}");
            }

            // Eşlenmemiş surrogate'lı özellik adı da istisnasız reddedilir.
            var trimmed = json.TrimEnd();
            var withBadName = trimmed[..^1] + ",\"\\ud800\":1}";
            using var badNameDocument = JsonDocument.Parse(withBadName);
            var badNameAccepted = true;
            Assert.Null(Record.Exception(() => badNameAccepted = accepts(badNameDocument.RootElement)));
            Assert.False(badNameAccepted, $"{name} property name");
        }
    }

    [Fact]
    public void DuplicateKeysCannotStandInForMissingOrConflictingFields()
    {
        var cases = new (string Json, Func<JsonElement, bool> Accepts)[]
        {
            ($$"""{"type":"desktop.native-video.stop","channel":"native-video","version":2,"version":2}""",
                root => NativeVideoBridgeProtocol.TryReadStopSessionEpoch(root, out _)),
            ($$"""{"type":"desktop.native-video.stop","channel":"other","channel":"native-video","version":2,"sessionEpoch":"{{SessionEpoch}}"}""",
                root => NativeVideoBridgeProtocol.TryReadStopSessionEpoch(root, out _)),
            ($$"""{"type":"desktop.control.set-enabled","channel":"control","version":1,"sessionId":"{{SessionId}}","sessionId":"{{SessionId}}"}""",
                root => ControlBridgeProtocol.TryParseSetEnabled(root, out _, out _)),
            ($$$"""{"type":"desktop.native-video.signal","channel":"native-video","version":2,"sessionEpoch":"{{{SessionEpoch}}}","payload":{"kind":"ice-candidate","negotiationId":"{{{NegotiationId}}}","candidate":{"candidate":"a","candidate":"b"} }}""",
                AcceptsSignal),
            (ControlEventJson("""{"kind":"pointer.move","x":0.5,"x":0.5}"""), AcceptsControlEvent),
            ($$"""{"iceServers":[{"urls":["stun:a.example.test"],"urls":["stun:b.example.test"]}]}""",
                AcceptsIceServers),
        };
        foreach (var (json, accepts) in cases)
        {
            using var document = JsonDocument.Parse(json);
            var accepted = true;
            Assert.Null(Record.Exception(() => accepted = accepts(document.RootElement)));
            Assert.False(accepted, json);
        }
    }

    [Fact]
    public void IceServersRejectFieldsOutsideTheProtocolShape()
    {
        using var extra = JsonDocument.Parse(
            """{"iceServers":[{"urls":["stun:stun.example.test"],"credentialType":"password"}]}""");
        Assert.Throws<InvalidOperationException>(() => MainWindow.ParseIceServers(extra.RootElement));
        using var nonObject = JsonDocument.Parse("""{"iceServers":["stun:stun.example.test"]}""");
        Assert.Throws<InvalidOperationException>(() => MainWindow.ParseIceServers(nonObject.RootElement));
    }

    private static string ControlEventJson(string eventJson) =>
        $$$"""
        {"type":"desktop.control.event","channel":"control","version":1,"sessionId":"{{{SessionId}}}",
         "payload":{"channel":"control","version":1,"type":"control.event","sequence":7,"event":{{{eventJson}}}}}
        """;

    private static bool AcceptsStart(JsonElement root) =>
        NativeVideoBridgeProtocol.TryReadStartSessionEpoch(root, out _) && AcceptsIceServers(root);

    private static bool AcceptsIceServers(JsonElement root)
    {
        try
        {
            MainWindow.ParseIceServers(root);
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static bool AcceptsSignal(JsonElement root) =>
        NativeVideoBridgeProtocol.TryParseSignal(root, out _, out _);

    private static bool AcceptsControlEvent(JsonElement root) =>
        ControlBridgeProtocol.TryParseEvent(root, out _, out _);

    private static void InvokeAllParsers(JsonElement root, string context, List<string> failures)
    {
        void Run(string parser, Action action)
        {
            try
            {
                action();
            }
            catch (Exception exception)
            {
                failures.Add($"{context} parser={parser} {exception.GetType().Name}: {exception.Message}");
            }
        }

        Run("start", () => NativeVideoBridgeProtocol.TryReadStartSessionEpoch(root, out _));
        Run("stop", () => NativeVideoBridgeProtocol.TryReadStopSessionEpoch(root, out _));
        Run("signal", () =>
        {
            if (NativeVideoBridgeProtocol.TryParseSignal(root, out var epoch, out var signal))
            {
                AssertAcceptedSignal(epoch, signal);
            }
        });
        Run("set-enabled", () =>
        {
            if (ControlBridgeProtocol.TryParseSetEnabled(root, out var sessionId, out _))
            {
                AssertUuid(sessionId);
            }
        });
        Run("control-event", () =>
        {
            if (ControlBridgeProtocol.TryParseEvent(root, out var sessionId, out var controlEvent))
            {
                AssertUuid(sessionId);
                AssertAcceptedControlEvent(controlEvent);
            }
        });
        Run("event-parser", () =>
        {
            if (ControlEventParser.TryParse(root, out var controlEvent))
            {
                AssertAcceptedControlEvent(controlEvent);
            }
        });
        Run("ice-servers", () =>
        {
            if (root.ValueKind != JsonValueKind.Object) return;
            try
            {
                AssertAcceptedIceServers(MainWindow.ParseIceServers(root));
            }
            catch (InvalidOperationException)
            {
                // Sözleşme: geçersiz ICE listesi yalnız InvalidOperationException verir.
            }
        });
    }

    private static void AssertUuid(string value) =>
        Assert.True(value.Length == 36 && Guid.TryParseExact(value, "D", out _), value);

    private static void AssertAcceptedSignal(string epoch, NativeVideoBridgeSignal? signal)
    {
        AssertUuid(epoch);
        Assert.NotNull(signal);
        AssertUuid(signal!.NegotiationId);
        if (signal.Description is { } description)
        {
            Assert.Null(signal.Candidate);
            Assert.Equal("answer", description.Type);
            Assert.InRange(Encoding.UTF8.GetByteCount(description.Sdp), 1, 60 * 1024);
            Assert.False(HasUnpairedSurrogate(description.Sdp));
            return;
        }
        var candidate = Assert.IsType<NativeVideoIceCandidate>(signal.Candidate);
        Assert.InRange(candidate.Candidate.Length, 0, 4_096);
        Assert.InRange(candidate.SdpMid?.Length ?? 0, 0, 256);
        Assert.InRange(candidate.UsernameFragment?.Length ?? 0, 0, 256);
    }

    private static void AssertAcceptedControlEvent(RemoteControlEvent? controlEvent)
    {
        Assert.NotNull(controlEvent);
        Assert.InRange(controlEvent!.Sequence, 0, 9_007_199_254_740_991);
        switch (controlEvent)
        {
            case RemotePointerMoveEvent move:
                AssertUnit(move.X);
                AssertUnit(move.Y);
                break;
            case RemotePointerButtonEvent button:
                Assert.Equal(button.X is null, button.Y is null);
                if (button.X is { } x) AssertUnit(x);
                if (button.Y is { } y) AssertUnit(y);
                break;
            case RemotePointerWheelEvent wheel:
                Assert.True(double.IsFinite(wheel.DeltaX) && Math.Abs(wheel.DeltaX) <= 10_000);
                Assert.True(double.IsFinite(wheel.DeltaY) && Math.Abs(wheel.DeltaY) <= 10_000);
                break;
            case RemoteKeyboardKeyEvent key:
                Assert.InRange(key.Code.Length, 1, 64);
                Assert.InRange(key.Key.Length, 1, 64);
                Assert.InRange(key.Location, 0, 3);
                Assert.False(HasUnpairedSurrogate(key.Code) || HasUnpairedSurrogate(key.Key));
                break;
            default:
                Assert.Fail($"Beklenmeyen olay türü: {controlEvent.GetType().Name}");
                break;
        }
    }

    private static void AssertAcceptedIceServers(IReadOnlyList<NativeVideoIceServer> servers)
    {
        Assert.InRange(servers.Count, 1, 16);
        foreach (var server in servers)
        {
            Assert.InRange(server.Url.Length, 1, 512);
            Assert.True(
                server.Url.StartsWith("stun:", StringComparison.OrdinalIgnoreCase) ||
                server.Url.StartsWith("stuns:", StringComparison.OrdinalIgnoreCase) ||
                server.Url.StartsWith("turn:", StringComparison.OrdinalIgnoreCase) ||
                server.Url.StartsWith("turns:", StringComparison.OrdinalIgnoreCase),
                server.Url);
            Assert.Equal(server.Username is null, server.Credential is null);
        }
    }

    private static void AssertUnit(double value) =>
        Assert.True(double.IsFinite(value) && value is >= 0 and <= 1, value.ToString());

    private static bool HasUnpairedSurrogate(string value)
    {
        for (var index = 0; index < value.Length; index++)
        {
            if (char.IsHighSurrogate(value[index]))
            {
                if (index + 1 >= value.Length || !char.IsLowSurrogate(value[index + 1])) return true;
                index++;
            }
            else if (char.IsLowSurrogate(value[index]))
            {
                return true;
            }
        }
        return false;
    }

    private sealed record Slot(JsonNode? Parent, string? Key, int? Index, JsonNode? Node);

    private static List<Slot> CollectSlots(JsonNode root)
    {
        var slots = new List<Slot> { new(null, null, null, root) };
        for (var position = 0; position < slots.Count; position++)
        {
            switch (slots[position].Node)
            {
                case JsonObject obj:
                    foreach (var property in obj)
                    {
                        slots.Add(new Slot(obj, property.Key, null, property.Value));
                    }
                    break;
                case JsonArray array:
                    for (var index = 0; index < array.Count; index++)
                    {
                        slots.Add(new Slot(array, null, index, array[index]));
                    }
                    break;
            }
        }
        return slots;
    }

    private static string Replace(JsonNode root, Slot slot, JsonNode? replacement)
    {
        switch (slot.Parent)
        {
            case null:
                return Serialize(replacement);
            case JsonObject obj:
                obj[slot.Key!] = replacement;
                break;
            case JsonArray array:
                array[slot.Index!.Value] = replacement;
                break;
        }
        return Serialize(root);
    }

    // JsonNode eşlenmemiş surrogate yazamaz; işaret değeri metinde kaçışlı tek
    // surrogate'a çevrilir. Böylece köprünün gördüğü JSON ile aynı girdi oluşur.
    private static string Serialize(JsonNode? node) =>
        (node?.ToJsonString(WriterOptions) ?? "null")
            .Replace($"\"{LoneSurrogateToken}\"", "\"\\ud800\"", StringComparison.Ordinal);

    private static string Mutate(Random random, string seedJson)
    {
        var root = JsonNode.Parse(seedJson)!;
        var slots = CollectSlots(root);
        var slot = slots[random.Next(slots.Count)];
        switch (random.Next(6))
        {
            case 0:
                return Replace(root, slot, RandomNode(random, 1));
            case 1 when slot.Parent is JsonObject parent && slot.Key is not null:
                parent.Remove(slot.Key);
                return Serialize(root);
            case 2:
            {
                var objects = slots.Where(candidate => candidate.Node is JsonObject).ToArray();
                if (objects.Length == 0) return Replace(root, slot, RandomNode(random, 1));
                var target = (JsonObject)objects[random.Next(objects.Length)].Node!;
                var key = random.Next(2) == 0
                    ? SuspiciousKeys[random.Next(SuspiciousKeys.Length)]
                    : RandomKey(random);
                if (!target.ContainsKey(key)) target[key] = RandomNode(random, 2);
                return Serialize(root);
            }
            case 3:
                return Replace(root, slot, JsonValue.Create(LoneSurrogateToken));
            case 4:
            {
                var clone = slot.Node?.DeepClone();
                return Replace(
                    root,
                    slot,
                    random.Next(2) == 0 ? new JsonArray(clone) : new JsonObject { ["value"] = clone });
            }
            default:
                return Replace(root, slot, RandomScalar(random));
        }
    }

    private static JsonNode? RandomNode(Random random, int depth)
    {
        switch (random.Next(depth >= 3 ? 4 : 6))
        {
            case 0:
                return null;
            case 1:
            case 2:
            case 3:
                return RandomScalar(random);
            case 4:
            {
                var array = new JsonArray();
                var length = random.Next(4);
                for (var index = 0; index < length; index++) array.Add(RandomNode(random, depth + 1));
                return array;
            }
            default:
            {
                var obj = new JsonObject();
                var size = random.Next(4);
                for (var index = 0; index < size; index++)
                {
                    var key = RandomKey(random);
                    if (!obj.ContainsKey(key)) obj[key] = RandomNode(random, depth + 1);
                }
                return obj;
            }
        }
    }

    private static JsonNode? RandomScalar(Random random) => random.Next(4) switch
    {
        0 => JsonValue.Create(random.Next(2) == 0),
        1 => JsonValue.Create(InterestingNumbers[random.Next(InterestingNumbers.Length)]),
        2 => JsonValue.Create((random.NextDouble() - 0.5) * Math.Pow(2, random.Next(64))),
        _ => JsonValue.Create(RandomText(random)),
    };

    private static string RandomKey(Random random) => random.Next(3) switch
    {
        0 => SuspiciousKeys[random.Next(SuspiciousKeys.Length)],
        1 => RandomText(random),
        _ => ProtocolKeys[random.Next(ProtocolKeys.Length)],
    };

    private static string RandomText(Random random)
    {
        var roll = random.Next(10);
        if (roll < 3) return InterestingStrings[random.Next(InterestingStrings.Length)];
        if (roll < 6) return ProtocolStrings[random.Next(ProtocolStrings.Length)];
        var builder = new StringBuilder();
        var length = random.Next(24);
        for (var index = 0; index < length; index++)
        {
            char value;
            do
            {
                value = random.Next(10) < 8
                    ? (char)(0x20 + random.Next(0x5f))
                    : (char)random.Next(0x1_0000);
            }
            while (char.IsSurrogate(value));
            builder.Append(value);
        }
        return builder.ToString();
    }

    // Metin tabanlı üretici: JsonNode'un yazamadığı kaçışlı tek surrogate'ları ve
    // gerçek köprü yükündeki her JSON biçimini doğrudan üretir.
    private static string RandomJson(Random random, int depth)
    {
        switch (random.Next(depth >= 4 ? 4 : 6))
        {
            case 0:
                return "null";
            case 1:
                return random.Next(2) == 0 ? "true" : "false";
            case 2:
                return JsonValue.Create(InterestingNumbers[random.Next(InterestingNumbers.Length)])!
                    .ToJsonString(WriterOptions);
            case 3:
                return random.Next(8) == 0 ? "\"\\ud800\"" : StringLiteral(RandomText(random));
            case 4:
            {
                var items = Enumerable.Range(0, random.Next(5)).Select(_ => RandomJson(random, depth + 1));
                return $"[{string.Join(',', items)}]";
            }
            default:
            {
                var members = Enumerable.Range(0, random.Next(5)).Select(_ =>
                    $"{(random.Next(10) == 0 ? "\"\\udc00\"" : StringLiteral(RandomKey(random)))}:{RandomJson(random, depth + 1)}");
                return $"{{{string.Join(',', members)}}}";
            }
        }
    }

    private static string StringLiteral(string value)
    {
        if (value == LoneSurrogateToken) return "\"\\ud800\"";
        var builder = new StringBuilder(value.Length + 2).Append('"');
        foreach (var character in value)
        {
            switch (character)
            {
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                default:
                    if (character < 0x20 || char.IsSurrogate(character) ||
                        character is '\u2028' or '\u2029')
                    {
                        builder.Append("\\u").Append(((int)character).ToString("x4"));
                    }
                    else
                    {
                        builder.Append(character);
                    }
                    break;
            }
        }
        return builder.Append('"').ToString();
    }
}
