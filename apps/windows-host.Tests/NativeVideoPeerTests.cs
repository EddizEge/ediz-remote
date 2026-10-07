using EdizRemote.Host.WebRtc;
using EdizRemote.Host.Streaming;
using EdizRemote.Host.Transport;
using SIPSorcery.Net;

namespace EdizRemote.Host.Tests;

public sealed class NativeVideoPeerTests
{
    [Theory]
    [InlineData("1 1 udp 123 127.0.0.1 5000 typ host", "candidate:1 1 udp 123 127.0.0.1 5000 typ host")]
    [InlineData("candidate:2 1 udp 456 127.0.0.1 5001 typ host", "candidate:2 1 udp 456 127.0.0.1 5001 typ host")]
    public void BrowserCandidateAlwaysIncludesRequiredPrefix(
        string candidate,
        string expected)
    {
        Assert.Equal(expected, NativeVideoPeer.NormalizeBrowserCandidate(candidate));
    }

    [Fact]
    public void NackBitmaskExpandsAcrossSequenceNumberWrap()
    {
        var packets = NativeVideoPeer.ExpandNack(ushort.MaxValue, 0b0000_0000_0000_0101);

        Assert.Equal(new ushort[] { ushort.MaxValue, 0, 2 }, packets);
    }

    [Fact]
    public void MapsVersionedTurnCredentialsToSipsorceryConfiguration()
    {
        var servers = NativeVideoPeer.CreateIceServers(
        [
            new NativeVideoIceServer("stun:stun.example.test:3478"),
            new NativeVideoIceServer(
                "turn:turn.example.test:3478?transport=udp",
                "123:client",
                "credential"),
        ]);

        Assert.Equal(2, servers.Count);
        Assert.Equal("stun:stun.example.test:3478", servers[0].urls);
        Assert.Equal("turn:turn.example.test:3478?transport=udp", servers[1].urls);
        Assert.Equal("123:client", servers[1].username);
        Assert.Equal("credential", servers[1].credential);
    }

    [Fact]
    public async Task OfferAdvertisesSendOnlyH264OverDtlsSrtp()
    {
        using var peer = new NativeVideoPeer(stunUrl: string.Empty);

        var offer = await peer.CreateOfferAsync();

        Assert.Equal("offer", offer.Type);
        Assert.Contains("m=video", offer.Sdp);
        Assert.Contains("UDP/TLS/RTP/SAVP", offer.Sdp);
        Assert.Contains("a=sendonly", offer.Sdp);
        Assert.Contains("H264/90000", offer.Sdp, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(
            NativeVideoPeer.H264FormatParameters,
            offer.Sdp,
            StringComparison.OrdinalIgnoreCase);
        Assert.Contains("a=rtcp-fb:96 nack", offer.Sdp, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("a=rtcp-fb:96 nack pli", offer.Sdp, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task LocalPeersCompleteIceDtlsAndDeliverEncryptedVideoRtp()
    {
        using var sender = new NativeVideoPeer(stunUrl: string.Empty);
        using var receiver = CreateReceiver();
        var senderConnected = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var receiverConnected = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var packetReceived = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);

        sender.StateChanged += state =>
        {
            if (state == NativeVideoPeerState.Connected) senderConnected.TrySetResult();
        };
        receiver.OnRtpPacketReceived += (_, media, _) =>
        {
            if (media == SDPMediaTypesEnum.video) packetReceived.TrySetResult();
        };
        receiver.onconnectionstatechange += state =>
        {
            if (state == RTCPeerConnectionState.connected) receiverConnected.TrySetResult();
        };
        sender.IceCandidateReady += candidate => receiver.addIceCandidate(
            new RTCIceCandidateInit
            {
                candidate = candidate.Candidate,
                sdpMid = candidate.SdpMid,
                sdpMLineIndex = candidate.SdpMLineIndex ?? 0,
                usernameFragment = candidate.UsernameFragment,
            });
        receiver.onicecandidate += candidate => sender.AddIceCandidate(
            new NativeVideoIceCandidate(
                candidate.candidate,
                candidate.sdpMid,
                candidate.sdpMLineIndex,
                candidate.usernameFragment));

        var offer = await sender.CreateOfferAsync();
        var setOfferResult = receiver.setRemoteDescription(new RTCSessionDescriptionInit
        {
            type = RTCSdpType.offer,
            sdp = offer.Sdp,
        });
        Assert.Equal(SetDescriptionResultEnum.OK, setOfferResult);
        var answer = receiver.createAnswer(null);
        await receiver.setLocalDescription(answer);
        sender.SetRemoteDescription(new NativeVideoSessionDescription("answer", answer.sdp));

        await senderConnected.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await receiverConnected.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await sender.WriteAsync(CreateAccessUnit(), CancellationToken.None);

        await packetReceived.Task.WaitAsync(TimeSpan.FromSeconds(10));
    }

    [Fact]
    public async Task LocalPeerPliRequestsKeyFrameAndNackRetransmitsCachedPacket()
    {
        using var sender = new NativeVideoPeer(stunUrl: string.Empty);
        using var receiver = CreateReceiver();
        var senderConnected = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var receiverConnected = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var firstPacket = new TaskCompletionSource<ushort>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var retransmission = new TaskCompletionSource<NativeVideoNetworkMetrics>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var keyFrameRequested = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);

        sender.StateChanged += state =>
        {
            if (state == NativeVideoPeerState.Connected) senderConnected.TrySetResult();
        };
        receiver.onconnectionstatechange += state =>
        {
            if (state == RTCPeerConnectionState.connected) receiverConnected.TrySetResult();
        };
        sender.KeyFrameRequested += () => keyFrameRequested.TrySetResult();
        sender.NetworkMetricsChanged += metrics =>
        {
            if (metrics.RetransmittedPackets > 0) retransmission.TrySetResult(metrics);
        };
        receiver.OnRtpPacketReceived += (_, media, packet) =>
        {
            if (media != SDPMediaTypesEnum.video) return;
            firstPacket.TrySetResult(packet.Header.SequenceNumber);
        };
        sender.IceCandidateReady += candidate => receiver.addIceCandidate(
            new RTCIceCandidateInit
            {
                candidate = candidate.Candidate,
                sdpMid = candidate.SdpMid,
                sdpMLineIndex = candidate.SdpMLineIndex ?? 0,
                usernameFragment = candidate.UsernameFragment,
            });
        receiver.onicecandidate += candidate => sender.AddIceCandidate(
            new NativeVideoIceCandidate(
                candidate.candidate,
                candidate.sdpMid,
                candidate.sdpMLineIndex,
                candidate.usernameFragment));

        var offer = await sender.CreateOfferAsync();
        Assert.Equal(SetDescriptionResultEnum.OK, receiver.setRemoteDescription(
            new RTCSessionDescriptionInit { type = RTCSdpType.offer, sdp = offer.Sdp }));
        var answer = receiver.createAnswer(null);
        await receiver.setLocalDescription(answer);
        sender.SetRemoteDescription(new NativeVideoSessionDescription("answer", answer.sdp));
        await senderConnected.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await receiverConnected.Task.WaitAsync(TimeSpan.FromSeconds(10));

        await sender.WriteAsync(CreateAccessUnit(), CancellationToken.None);
        var sequenceNumber = await firstPacket.Task.WaitAsync(TimeSpan.FromSeconds(10));
        sender.HandleReceiverReport(new RTCPCompoundPacket(
            new RTCPFeedback(
                receiver.VideoLocalTrack?.Ssrc ?? 0,
                sender.VideoSynchronizationSource,
                RTCPFeedbackTypesEnum.NACK,
                sequenceNumber,
                0).GetBytes()));
        var metrics = await retransmission.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(1, metrics.NackRequests);
        Assert.Equal(1, metrics.RetransmittedPackets);

        sender.HandleReceiverReport(new RTCPCompoundPacket(
            new RTCPFeedback(
                receiver.VideoLocalTrack?.Ssrc ?? 0,
                sender.VideoSynchronizationSource,
                PSFBFeedbackTypesEnum.PLI).GetBytes()));
        await keyFrameRequested.Task.WaitAsync(TimeSpan.FromSeconds(10));
    }

    private static RTCPeerConnection CreateReceiver()
    {
        var receiver = new RTCPeerConnection(new RTCConfiguration { iceServers = [] });
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
