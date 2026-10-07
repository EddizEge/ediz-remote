using System.Text.Json;
using System.Text;
using EdizRemote.Desktop;
using EdizRemote.Host.WebRtc;

namespace EdizRemote.Desktop.Tests;

public sealed class NativeVideoBridgeProtocolTests
{
    private const string SessionEpoch = "11111111-1111-4111-8111-111111111111";
    private const string NegotiationId = "22222222-2222-4222-8222-222222222222";

    [Fact]
    public void ParsesStrictVersionedAnswerForTheCurrentBridgeSession()
    {
        using var document = JsonDocument.Parse(
            $$"""
            {
              "type": "desktop.native-video.signal",
              "channel": "native-video",
              "version": 2,
              "sessionEpoch": "{{SessionEpoch}}",
              "payload": {
                "kind": "session-description",
                "negotiationId": "{{NegotiationId}}",
                "description": { "type": "answer", "sdp": "v=0" }
              }
            }
            """);

        Assert.True(NativeVideoBridgeProtocol.TryParseSignal(
            document.RootElement,
            out var sessionEpoch,
            out var signal));
        Assert.Equal(SessionEpoch, sessionEpoch);
        Assert.Equal(NegotiationId, signal?.NegotiationId);
        Assert.Equal("answer", signal?.Description?.Type);
    }

    [Theory]
    [InlineData(1, "11111111-1111-4111-8111-111111111111", false)]
    [InlineData(2, "not-a-uuid", false)]
    [InlineData(2, "11111111-1111-4111-8111-111111111111", true)]
    public void RequiresCurrentBridgeVersionAndUuid(
        int version,
        string sessionEpoch,
        bool expected)
    {
        using var document = JsonDocument.Parse(
            $$"""
            {
              "type": "desktop.native-video.start",
              "channel": "native-video",
              "version": {{version}},
              "sessionEpoch": "{{sessionEpoch}}",
              "iceServers": [{ "urls": ["stun:stun.example.test"] }]
            }
            """);

        Assert.Equal(
            expected,
            NativeVideoBridgeProtocol.TryReadStartSessionEpoch(
                document.RootElement,
                out _));
    }

    [Fact]
    public void RejectsUnknownBridgeAndSignalFields()
    {
        using var document = JsonDocument.Parse(
            $$"""
            {
              "type": "desktop.native-video.signal",
              "channel": "native-video",
              "version": 2,
              "sessionEpoch": "{{SessionEpoch}}",
              "privileged": true,
              "payload": {
                "kind": "ice-candidate",
                "negotiationId": "{{NegotiationId}}",
                "candidate": { "candidate": "candidate:test" }
              }
            }
            """);

        Assert.False(NativeVideoBridgeProtocol.TryParseSignal(
            document.RootElement,
            out _,
            out _));
    }

    [Fact]
    public void CandidateBufferIsBoundedAndPreservesOrder()
    {
        var buffer = new NativeIceCandidateBuffer();
        for (var index = 0; index < NativeIceCandidateBuffer.MaximumCandidates; index++)
        {
            Assert.True(buffer.TryEnqueue(new NativeVideoIceCandidate(
                $"candidate:{index}",
                null,
                null,
                null)));
        }
        Assert.False(buffer.TryEnqueue(new NativeVideoIceCandidate(
            "candidate:overflow",
            null,
            null,
            null)));

        var drained = buffer.Drain();
        Assert.Equal("candidate:0", drained[0].Candidate);
        Assert.Equal("candidate:63", drained[^1].Candidate);
        Assert.Equal(0, buffer.Count);
        Assert.Equal(0, buffer.ByteCount);
    }

    [Fact]
    public void BridgeLimitAcceptsEscapedSixtyKibSdpAndRejects128KibPlusOne()
    {
        var sdp = string.Concat(Enumerable.Repeat("\r\n", 30 * 1024));
        var json = JsonSerializer.Serialize(new
        {
            type = "desktop.native-video.signal",
            channel = "native-video",
            version = 2,
            sessionEpoch = SessionEpoch,
            payload = new
            {
                kind = "session-description",
                negotiationId = NegotiationId,
                description = new { type = "answer", sdp },
            },
        });

        Assert.Equal(60 * 1024, Encoding.UTF8.GetByteCount(sdp));
        Assert.True(Encoding.UTF8.GetByteCount(json) > 64 * 1024);
        Assert.True(NativeVideoBridgeProtocol.IsWithinMessageLimit(json));
        using var document = JsonDocument.Parse(json);
        Assert.True(NativeVideoBridgeProtocol.TryParseSignal(
            document.RootElement,
            out _,
            out _));
        Assert.False(NativeVideoBridgeProtocol.IsWithinMessageLimit(
            new string('x', NativeVideoBridgeProtocol.MaximumMessageBytes + 1)));
    }

    [Fact]
    public void StateAndMetricsEnvelopesCarryTheCapturedNegotiationId()
    {
        var stateJson = JsonSerializer.Serialize(
            NativeVideoBridgeProtocol.CreateStateEnvelope(
                SessionEpoch,
                NegotiationId,
                NativeVideoPeerState.Connected,
                null,
                null,
                null));
        using var state = JsonDocument.Parse(stateJson);
        Assert.Equal(NegotiationId, state.RootElement.GetProperty("negotiationId").GetString());
        Assert.Equal(6, state.RootElement.EnumerateObject().Count());

        var metricsJson = JsonSerializer.Serialize(
            NativeVideoBridgeProtocol.CreateMetricsEnvelope(
                SessionEpoch,
                NegotiationId,
                new NativeVideoNetworkMetrics(null, null, 5_000_000, 1, 2, 3)));
        using var metrics = JsonDocument.Parse(metricsJson);
        Assert.Equal(NegotiationId, metrics.RootElement.GetProperty("negotiationId").GetString());
        Assert.Equal(6, metrics.RootElement.EnumerateObject().Count());
    }

    [Fact]
    public void NegotiationEnvelopeIsStrictVersionTwoWithAnEmptyPayload()
    {
        var json = JsonSerializer.Serialize(
            NativeVideoBridgeProtocol.CreateNegotiationEnvelope(
                SessionEpoch,
                NegotiationId));
        using var message = JsonDocument.Parse(json);

        Assert.Equal("desktop.native-video.negotiation",
            message.RootElement.GetProperty("type").GetString());
        Assert.Equal("native-video", message.RootElement.GetProperty("channel").GetString());
        Assert.Equal(2, message.RootElement.GetProperty("version").GetInt32());
        Assert.Equal(SessionEpoch,
            message.RootElement.GetProperty("sessionEpoch").GetString());
        Assert.Equal(NegotiationId,
            message.RootElement.GetProperty("negotiationId").GetString());
        Assert.Empty(message.RootElement.GetProperty("payload").EnumerateObject());
        Assert.Equal(6, message.RootElement.EnumerateObject().Count());
    }

    [Fact]
    public async Task OfferRaceStopsImmediatelyWhenOverflowWins()
    {
        var offer = new TaskCompletionSource<string>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var overflow = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var stopCalls = 0;
        var race = NativeVideoOfferRace.AwaitOfferOrStopAsync(
            offer.Task,
            overflow.Task,
            () =>
            {
                Interlocked.Increment(ref stopCalls);
                return Task.CompletedTask;
            });

        overflow.SetResult(true);
        await Assert.ThrowsAsync<InvalidOperationException>(() => race);

        Assert.Equal(1, Volatile.Read(ref stopCalls));
        Assert.False(offer.Task.IsCompleted);
        offer.SetResult("late-offer");
    }

    [Fact]
    public void FatalLatchTripsOnlyOnce()
    {
        var latch = new NativeVideoNegotiationFatalLatch();
        Assert.False(latch.IsTripped);
        Assert.True(latch.TryTrip());
        Assert.True(latch.IsTripped);
        Assert.False(latch.TryTrip());
    }
}
