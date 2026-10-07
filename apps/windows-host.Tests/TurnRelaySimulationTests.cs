using EdizRemote.Host.Streaming;
using EdizRemote.Host.Transport;
using EdizRemote.Host.WebRtc;
using SIPSorcery.Net;

namespace EdizRemote.Host.Tests;

public sealed class TurnRelaySimulationTests
{
    [TurnSimulationFact]
    public async Task ForcedTurnRelayDeliversEncryptedVideoRtp()
    {
        var turnUrl = GetRequiredEnvironmentVariable("EDIZ_TURN_URL");
        var username = GetRequiredEnvironmentVariable("EDIZ_TURN_USERNAME");
        var credential = GetRequiredEnvironmentVariable("EDIZ_TURN_CREDENTIAL");
        var iceServers = new[]
        {
            new NativeVideoIceServer(turnUrl, username, credential),
        };

        using var sender = new NativeVideoPeer(
            iceServers,
            iceTransportPolicy: RTCIceTransportPolicy.relay);
        using var receiver = CreateRelayOnlyReceiver(iceServers);
        var senderConnected = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var receiverConnected = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var packetReceived = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var senderCandidates = new List<string>();
        var receiverCandidates = new List<string>();

        sender.StateChanged += state =>
        {
            if (state == NativeVideoPeerState.Connected) senderConnected.TrySetResult();
        };
        receiver.onconnectionstatechange += state =>
        {
            if (state == RTCPeerConnectionState.connected) receiverConnected.TrySetResult();
        };
        receiver.OnRtpPacketReceived += (_, media, _) =>
        {
            if (media == SDPMediaTypesEnum.video) packetReceived.TrySetResult();
        };
        sender.IceCandidateReady += candidate =>
        {
            senderCandidates.Add(candidate.Candidate);
            receiver.addIceCandidate(new RTCIceCandidateInit
            {
                candidate = candidate.Candidate,
                sdpMid = candidate.SdpMid,
                sdpMLineIndex = candidate.SdpMLineIndex ?? 0,
                usernameFragment = candidate.UsernameFragment,
            });
        };
        receiver.onicecandidate += candidate =>
        {
            if (string.IsNullOrWhiteSpace(candidate.candidate)) return;
            receiverCandidates.Add(candidate.candidate);
            sender.AddIceCandidate(new NativeVideoIceCandidate(
                candidate.candidate,
                candidate.sdpMid,
                candidate.sdpMLineIndex,
                candidate.usernameFragment));
        };

        var offer = await sender.CreateOfferAsync();
        Assert.Equal(SetDescriptionResultEnum.OK, receiver.setRemoteDescription(
            new RTCSessionDescriptionInit { type = RTCSdpType.offer, sdp = offer.Sdp }));
        var answer = receiver.createAnswer(null);
        await receiver.setLocalDescription(answer);
        sender.SetRemoteDescription(new NativeVideoSessionDescription("answer", answer.sdp));

        await senderConnected.Task.WaitAsync(TimeSpan.FromSeconds(20));
        await receiverConnected.Task.WaitAsync(TimeSpan.FromSeconds(20));
        await sender.WriteAsync(CreateAccessUnit(), CancellationToken.None);
        await packetReceived.Task.WaitAsync(TimeSpan.FromSeconds(10));

        AssertRelayOnly(senderCandidates);
        AssertRelayOnly(receiverCandidates);
    }

    private static RTCPeerConnection CreateRelayOnlyReceiver(
        IReadOnlyList<NativeVideoIceServer> iceServers)
    {
        var receiver = new RTCPeerConnection(new RTCConfiguration
        {
            iceServers = NativeVideoPeer.CreateIceServers(iceServers),
            iceTransportPolicy = RTCIceTransportPolicy.relay,
        });
        var h264 = new SDPAudioVideoMediaFormat(
            SDPMediaTypesEnum.video,
            NativeVideoPeer.PayloadType,
            "H264",
            90_000,
            0,
            NativeVideoPeer.H264FormatParameters);
        receiver.addTrack(new MediaStreamTrack(
            SDPMediaTypesEnum.video,
            false,
            [h264],
            MediaStreamStatusEnum.RecvOnly));
        return receiver;
    }

    private static void AssertRelayOnly(IReadOnlyList<string> candidates)
    {
        Assert.NotEmpty(candidates);
        Assert.All(candidates, candidate =>
            Assert.Contains(" typ relay ", $" {candidate} ", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(candidates, candidate =>
            candidate.Contains(" typ host ", StringComparison.OrdinalIgnoreCase) ||
            candidate.Contains(" typ srflx ", StringComparison.OrdinalIgnoreCase));
    }

    private static string GetRequiredEnvironmentVariable(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException($"{name} TURN simülasyonu için zorunludur.");
        }
        return value;
    }

    private static NativeEncodedAccessUnit CreateAccessUnit()
    {
        byte[] encodedData =
        [
            0, 0, 0, 1, 0x67, 0x64, 0, 0x33, 0xAC, 0xD9, 0x40,
            0, 0, 0, 1, 0x68, 0xEE, 0x3C, 0x80,
            0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21,
        ];
        var packetizer = new H264RtpPacketizer(
            payloadType: NativeVideoPeer.PayloadType,
            initialSequenceNumber: 42);
        var packets = packetizer.PacketizeAccessUnit(
            H264AnnexBParser.Parse(encodedData),
            90_000);
        return new NativeEncodedAccessUnit(
            SampleTime: 0,
            SampleDuration: 333_333,
            IsKeyFrame: true,
            ContainsParameterSets: true,
            EncodedData: encodedData,
            EncodedBytes: encodedData.Length,
            Packets: packets);
    }
}
