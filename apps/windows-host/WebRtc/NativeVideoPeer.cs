using EdizRemote.Host.Streaming;
using EdizRemote.Host.Transport;
using SIPSorcery.Net;

namespace EdizRemote.Host.WebRtc;

internal sealed class NativeVideoPeer : INativeVideoPacketSink, IDisposable
{
    internal const int PayloadType = 96;
    internal const string H264FormatParameters =
        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640033";
    private const int RetransmissionCacheCapacity = 4_096;

    private readonly RTCPeerConnection _peerConnection;
    private readonly AdaptiveBitrateController _bitrateController;
    private readonly object _packetSync = new();
    private readonly Dictionary<ushort, CachedPacket> _packetCache = [];
    private readonly Queue<(ushort SequenceNumber, long Generation)> _packetOrder = [];
    private long _packetGeneration;
    private long _nackRequests;
    private long _retransmittedPackets;
    private long _pliRequests;
    private bool _disposed;

    public NativeVideoPeer(
        string stunUrl = "stun:stun.cloudflare.com:3478",
        int initialBitrate = 8_000_000,
        int minimumBitrate = 1_000_000)
        : this(
            string.IsNullOrWhiteSpace(stunUrl)
                ? []
                : [new NativeVideoIceServer(stunUrl)],
            initialBitrate,
            minimumBitrate)
    {
    }

    internal NativeVideoPeer(
        IReadOnlyList<NativeVideoIceServer> iceServers,
        int initialBitrate = 8_000_000,
        int minimumBitrate = 1_000_000,
        RTCIceTransportPolicy iceTransportPolicy = RTCIceTransportPolicy.all)
    {
        _bitrateController = new AdaptiveBitrateController(
            initialBitrate,
            Math.Min(initialBitrate, minimumBitrate));
        var configuration = new RTCConfiguration
        {
            iceServers = CreateIceServers(iceServers),
            iceTransportPolicy = iceTransportPolicy,
        };
        _peerConnection = new RTCPeerConnection(configuration);
        var h264 = new SDPAudioVideoMediaFormat(
            SDPMediaTypesEnum.video,
            PayloadType,
            "H264",
            90_000,
            0,
            H264FormatParameters);
        _peerConnection.addTrack(new MediaStreamTrack(
            SDPMediaTypesEnum.video,
            false,
            [h264],
            MediaStreamStatusEnum.SendOnly));

        _peerConnection.onicecandidate += candidate =>
        {
            if (_disposed || string.IsNullOrWhiteSpace(candidate.candidate)) return;
            IceCandidateReady?.Invoke(new NativeVideoIceCandidate(
                NormalizeBrowserCandidate(candidate.candidate),
                candidate.sdpMid,
                candidate.sdpMLineIndex,
                candidate.usernameFragment));
        };
        _peerConnection.onconnectionstatechange += state =>
        {
            if (!_disposed) StateChanged?.Invoke(MapState(state));
        };
        _peerConnection.OnReceiveReport += (_, mediaType, report) =>
        {
            if (!_disposed && mediaType == SDPMediaTypesEnum.video)
                HandleReceiverReport(report);
        };
    }

    public event Action<NativeVideoIceCandidate>? IceCandidateReady;
    public event Action<NativeVideoPeerState>? StateChanged;
    public event Action? KeyFrameRequested;
    public event Action<int>? TargetBitrateChanged;
    public event Action<NativeVideoNetworkMetrics>? NetworkMetricsChanged;

    public NativeVideoPeerState State => MapState(_peerConnection.connectionState);
    internal uint VideoSynchronizationSource => _peerConnection.VideoLocalTrack?.Ssrc ?? 0;

    public async Task<NativeVideoSessionDescription> CreateOfferAsync()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var offer = _peerConnection.createOffer(null);
        offer.sdp = AdvertiseRtcpFeedback(offer.sdp);
        await _peerConnection.setLocalDescription(offer);
        return new NativeVideoSessionDescription("offer", offer.sdp);
    }

    public void SetRemoteDescription(NativeVideoSessionDescription description)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!Enum.TryParse<RTCSdpType>(description.Type, true, out var type) ||
            type is not RTCSdpType.answer)
        {
            throw new ArgumentException("Native video eş bağlantısı yalnızca SDP answer kabul eder.");
        }

        var result = _peerConnection.setRemoteDescription(new RTCSessionDescriptionInit
        {
            type = type,
            sdp = description.Sdp,
        });
        if (result != SetDescriptionResultEnum.OK)
        {
            throw new InvalidOperationException(
                $"Native video SDP answer uygulanamadı: {result}.");
        }
    }

    public void AddIceCandidate(NativeVideoIceCandidate candidate)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (string.IsNullOrWhiteSpace(candidate.Candidate)) return;
        _peerConnection.addIceCandidate(new RTCIceCandidateInit
        {
            candidate = candidate.Candidate,
            sdpMid = candidate.SdpMid,
            sdpMLineIndex = candidate.SdpMLineIndex ?? 0,
            usernameFragment = candidate.UsernameFragment,
        });
    }

    public ValueTask WriteAsync(
        NativeEncodedAccessUnit accessUnit,
        CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        cancellationToken.ThrowIfCancellationRequested();
        if (_peerConnection.connectionState != RTCPeerConnectionState.connected)
        {
            return ValueTask.CompletedTask;
        }

        foreach (var packet in accessUnit.Packets)
        {
            _peerConnection.SendRtpRaw(
                SDPMediaTypesEnum.video,
                packet.Payload,
                packet.Timestamp,
                packet.Marker ? 1 : 0,
                packet.PayloadType,
                packet.SequenceNumber);
            CachePacket(packet);
        }
        return ValueTask.CompletedTask;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _peerConnection.Close("native video session closed");
        _peerConnection.Dispose();
    }

    private static NativeVideoPeerState MapState(RTCPeerConnectionState state) => state switch
    {
        RTCPeerConnectionState.@new => NativeVideoPeerState.New,
        RTCPeerConnectionState.connecting => NativeVideoPeerState.Connecting,
        RTCPeerConnectionState.connected => NativeVideoPeerState.Connected,
        RTCPeerConnectionState.disconnected => NativeVideoPeerState.Disconnected,
        RTCPeerConnectionState.failed => NativeVideoPeerState.Failed,
        RTCPeerConnectionState.closed => NativeVideoPeerState.Closed,
        _ => NativeVideoPeerState.Failed,
    };

    internal static string NormalizeBrowserCandidate(string candidate)
    {
        var trimmed = candidate.Trim();
        return trimmed.StartsWith("candidate:", StringComparison.OrdinalIgnoreCase)
            ? trimmed
            : $"candidate:{trimmed}";
    }

    internal static List<RTCIceServer> CreateIceServers(
        IReadOnlyList<NativeVideoIceServer> iceServers)
    {
        return iceServers.Select(server => new RTCIceServer
        {
            urls = server.Url,
            username = server.Username,
            credential = server.Credential,
        }).ToList();
    }

    internal static string AdvertiseRtcpFeedback(string sdp)
    {
        if (sdp.Contains($"a=rtcp-fb:{PayloadType} nack pli", StringComparison.OrdinalIgnoreCase))
            return sdp;

        var lineEnding = sdp.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        var lines = sdp.Split(lineEnding, StringSplitOptions.None).ToList();
        var insertAt = lines.FindIndex(line =>
            line.StartsWith($"a=fmtp:{PayloadType} ", StringComparison.OrdinalIgnoreCase));
        if (insertAt < 0)
        {
            insertAt = lines.FindIndex(line =>
                line.StartsWith($"a=rtpmap:{PayloadType} ", StringComparison.OrdinalIgnoreCase));
        }
        if (insertAt < 0) return sdp;

        lines.Insert(insertAt + 1, $"a=rtcp-fb:{PayloadType} nack");
        lines.Insert(insertAt + 2, $"a=rtcp-fb:{PayloadType} nack pli");
        return string.Join(lineEnding, lines);
    }

    internal static IReadOnlyList<ushort> ExpandNack(ushort packetId, ushort bitmask)
    {
        var sequenceNumbers = new List<ushort>(17) { packetId };
        for (var offset = 0; offset < 16; offset++)
        {
            if ((bitmask & (1 << offset)) != 0)
                sequenceNumbers.Add(unchecked((ushort)(packetId + offset + 1)));
        }
        return sequenceNumbers;
    }

    internal void HandleReceiverReport(RTCPCompoundPacket report)
    {
        var feedback = report.Feedback;
        if (feedback is not null)
        {
            if (feedback.Header.PayloadFeedbackMessageType == PSFBFeedbackTypesEnum.PLI)
            {
                Interlocked.Increment(ref _pliRequests);
                KeyFrameRequested?.Invoke();
            }
            else if (feedback.Header.FeedbackMessageType == RTCPFeedbackTypesEnum.NACK)
            {
                Interlocked.Increment(ref _nackRequests);
                Retransmit(ExpandNack(feedback.PID, feedback.BLP));
            }
        }

        var samples = report.ReceiverReport?.ReceptionReports ??
                      report.SenderReport?.ReceptionReports;
        var sample = samples?.FirstOrDefault(item =>
            item.SSRC == (_peerConnection.VideoLocalTrack?.Ssrc ?? item.SSRC));
        if (sample is not null)
        {
            var observation = _bitrateController.Observe(
                sample.FractionLost,
                DateTimeOffset.UtcNow);
            if (observation.TargetChanged)
                TargetBitrateChanged?.Invoke(observation.TargetBitrate);
            PublishMetrics(observation.PacketLossPercent, sample.Jitter / 90d);
        }
        else if (feedback is not null)
        {
            PublishMetrics(null, null);
        }
    }

    private void CachePacket(RtpPacket packet)
    {
        lock (_packetSync)
        {
            var generation = ++_packetGeneration;
            _packetCache[packet.SequenceNumber] = new CachedPacket(packet, generation);
            _packetOrder.Enqueue((packet.SequenceNumber, generation));
            while (_packetOrder.Count > RetransmissionCacheCapacity)
            {
                var expired = _packetOrder.Dequeue();
                if (_packetCache.TryGetValue(expired.SequenceNumber, out var cached) &&
                    cached.Generation == expired.Generation)
                {
                    _packetCache.Remove(expired.SequenceNumber);
                }
            }
        }
    }

    private void Retransmit(IReadOnlyList<ushort> sequenceNumbers)
    {
        List<RtpPacket> packets = [];
        lock (_packetSync)
        {
            foreach (var sequenceNumber in sequenceNumbers)
            {
                if (_packetCache.TryGetValue(sequenceNumber, out var cached))
                    packets.Add(cached.Packet);
            }
        }

        foreach (var packet in packets)
        {
            _peerConnection.SendRtpRaw(
                SDPMediaTypesEnum.video,
                packet.Payload,
                packet.Timestamp,
                packet.Marker ? 1 : 0,
                packet.PayloadType,
                packet.SequenceNumber);
            Interlocked.Increment(ref _retransmittedPackets);
        }
        if (packets.Count < sequenceNumbers.Count)
        {
            Interlocked.Increment(ref _pliRequests);
            KeyFrameRequested?.Invoke();
        }
        PublishMetrics(null, null);
    }

    private void PublishMetrics(double? packetLossPercent, double? jitterMilliseconds)
    {
        NetworkMetricsChanged?.Invoke(new NativeVideoNetworkMetrics(
            packetLossPercent,
            jitterMilliseconds is null ? null : Math.Round(jitterMilliseconds.Value, 1),
            _bitrateController.TargetBitrate,
            Interlocked.Read(ref _nackRequests),
            Interlocked.Read(ref _retransmittedPackets),
            Interlocked.Read(ref _pliRequests)));
    }

    private sealed record CachedPacket(RtpPacket Packet, long Generation);
}

internal sealed record NativeVideoNetworkMetrics(
    double? PacketLossPercent,
    double? JitterMilliseconds,
    int TargetBitrate,
    long NackRequests,
    long RetransmittedPackets,
    long PliRequests);
