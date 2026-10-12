using System.Diagnostics;
using System.Security.Cryptography;
using EdizRemote.Host.Capture;
using EdizRemote.Host.Encoding;
using EdizRemote.Host.Transport;

namespace EdizRemote.Host.Streaming;

internal sealed record NativeStreamOptions(
    int FrameRate = 30,
    int Bitrate = 8_000_000,
    int MaximumRtpPayloadLength = 1_200,
    byte PayloadType = 96,
    TimeSpan? EncoderTimeout = null)
{
    public TimeSpan EffectiveEncoderTimeout => EncoderTimeout ?? TimeSpan.FromSeconds(5);

    public void Validate()
    {
        if (FrameRate is < 1 or > 60)
            throw new ArgumentOutOfRangeException(nameof(FrameRate));
        if (Bitrate is < 250_000 or > 100_000_000)
            throw new ArgumentOutOfRangeException(nameof(Bitrate));
        if (MaximumRtpPayloadLength is < 3 or > ushort.MaxValue)
            throw new ArgumentOutOfRangeException(nameof(MaximumRtpPayloadLength));
        if (PayloadType > 127)
            throw new ArgumentOutOfRangeException(nameof(PayloadType));
        if (EffectiveEncoderTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(EncoderTimeout));
    }
}

internal sealed record NativeEncodedAccessUnit(
    long SampleTime,
    long SampleDuration,
    bool IsKeyFrame,
    bool ContainsParameterSets,
    byte[] EncodedData,
    int EncodedBytes,
    IReadOnlyList<RtpPacket> Packets);

internal sealed record NativeCursorState(double X, double Y, bool Visible);

internal sealed record NativeStreamStatistics(
    int DisplayIndex,
    int Width,
    int Height,
    int TargetFrameRate,
    long CapturedFrames,
    long EncodedFrames,
    long DesktopUpdates,
    long CoalescedDesktopUpdates,
    long RtpPackets,
    long EncodedBytes,
    long RtpPayloadBytes,
    int FinalBitrate,
    long EncoderRestarts,
    long KeyFrameRequests,
    long DurationMilliseconds,
    double AverageEncodedFramesPerSecond);

internal interface INativeVideoPacketSink
{
    ValueTask WriteAsync(
        NativeEncodedAccessUnit accessUnit,
        CancellationToken cancellationToken);
}

internal sealed class NativeDesktopStreamSession(
    DisplayOutput output,
    NativeStreamOptions options,
    NativeStreamControl? streamControl = null,
    Action<NativeCursorState>? cursorStateSink = null)
{
    public async Task<NativeStreamStatistics> RunAsync(
        INativeVideoPacketSink sink,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(sink);
        options.Validate();

        using var capture = new DesktopDuplicator(output);
        using var converter = new GpuNv12Converter(
            capture.Device,
            capture.Context,
            output.Width,
            output.Height);
        streamControl ??= new NativeStreamControl(options.Bitrate);
        var currentBitrate = streamControl.TargetBitrate;
        using var encoderLifetime = new EncoderLifetime(new MediaFoundationH264Encoder(
            capture.Device,
            output.Width,
            output.Height,
            options.FrameRate,
            currentBitrate));
        streamControl.EncoderStarted();
        var packetizer = new H264RtpPacketizer(
            options.MaximumRtpPayloadLength,
            options.PayloadType);
        var rtpTimestampBase = BitConverter.ToUInt32(
            RandomNumberGenerator.GetBytes(sizeof(uint)));
        var frameDuration = 10_000_000L / options.FrameRate;
        var frameInterval = TimeSpan.FromSeconds(1d / options.FrameRate);
        var stopwatch = Stopwatch.StartNew();
        var nextCaptureAt = TimeSpan.Zero;
        long capturedFrames = 0;
        long encodedFrames = 0;
        long desktopUpdates = 0;
        long coalescedUpdates = 0;
        long rtpPackets = 0;
        long encodedBytes = 0;
        long rtpPayloadBytes = 0;
        long encoderRestarts = 0;
        NativeCursorState? lastCursorState = null;
        var lastCursorEmission = TimeSpan.MinValue;

        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var delay = nextCaptureAt - stopwatch.Elapsed;
                if (delay > TimeSpan.Zero)
                {
                    await Task.Delay(delay, cancellationToken);
                }

                var sampleTime = stopwatch.Elapsed.Ticks;
                IReadOnlyList<H264EncodedFrame> producedFrames = [];
                uint accumulatedFrames = 0;
                var directive = streamControl.Consume(currentBitrate);
                if (directive.RestartEncoder)
                {
                    encoderLifetime.Replace(new MediaFoundationH264Encoder(
                        capture.Device,
                        output.Width,
                        output.Height,
                        options.FrameRate,
                        directive.TargetBitrate));
                    streamControl.EncoderStarted();
                    currentBitrate = directive.TargetBitrate;
                    encoderRestarts++;
                }
                await capture.ProcessGpuFrameAsync(
                    (texture, accumulated, pointer) =>
                    {
                        accumulatedFrames = accumulated;
                        var cursorState = CreateCursorState(pointer, output);
                        if (
                            cursorStateSink is not null &&
                            (cursorState != lastCursorState ||
                             stopwatch.Elapsed - lastCursorEmission >= TimeSpan.FromSeconds(1)))
                        {
                            cursorStateSink(cursorState);
                            lastCursorState = cursorState;
                            lastCursorEmission = stopwatch.Elapsed;
                        }
                        converter.Convert(texture);
                        producedFrames = encoderLifetime.Encoder.SubmitFrame(
                            converter.OutputTexture,
                            sampleTime,
                            frameDuration,
                            options.EffectiveEncoderTimeout);
                    },
                    cancellationToken);

                capturedFrames++;
                desktopUpdates += accumulatedFrames;
                coalescedUpdates += accumulatedFrames > 1
                    ? accumulatedFrames - 1
                    : 0;
                await WriteFramesAsync(
                    producedFrames,
                    sink,
                    packetizer,
                    rtpTimestampBase,
                    cancellationToken,
                    counters =>
                    {
                        encodedFrames += counters.Frames;
                        rtpPackets += counters.Packets;
                        encodedBytes += counters.EncodedBytes;
                        rtpPayloadBytes += counters.PayloadBytes;
                    });

                nextCaptureAt += frameInterval;
                if (nextCaptureAt < stopwatch.Elapsed - frameInterval)
                {
                    nextCaptureAt = stopwatch.Elapsed + frameInterval;
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Normal stream shutdown.
        }
        finally
        {
            if (cursorStateSink is not null && lastCursorState?.Visible == true)
            {
                cursorStateSink(new NativeCursorState(0, 0, false));
            }
            var drainedFrames = encoderLifetime.Encoder.Drain(options.EffectiveEncoderTimeout);
            await WriteFramesAsync(
                drainedFrames,
                sink,
                packetizer,
                rtpTimestampBase,
                CancellationToken.None,
                counters =>
                {
                    encodedFrames += counters.Frames;
                    rtpPackets += counters.Packets;
                    encodedBytes += counters.EncodedBytes;
                    rtpPayloadBytes += counters.PayloadBytes;
                });
        }

        stopwatch.Stop();
        return new NativeStreamStatistics(
            output.Index,
            output.Width,
            output.Height,
            options.FrameRate,
            capturedFrames,
            encodedFrames,
            desktopUpdates,
            coalescedUpdates,
            rtpPackets,
            encodedBytes,
            rtpPayloadBytes,
            currentBitrate,
            encoderRestarts,
            streamControl.KeyFrameRequests,
            stopwatch.ElapsedMilliseconds,
            stopwatch.Elapsed.TotalSeconds > 0
                ? Math.Round(encodedFrames / stopwatch.Elapsed.TotalSeconds, 2)
                : 0);
    }

    internal static NativeCursorState CreateCursorState(
        DesktopPointerState pointer,
        DisplayOutput output)
    {
        var maximumX = Math.Max(1, output.Width - 1);
        var maximumY = Math.Max(1, output.Height - 1);
        return new NativeCursorState(
            Math.Clamp(pointer.X / (double)maximumX, 0, 1),
            Math.Clamp(pointer.Y / (double)maximumY, 0, 1),
            pointer.Visible);
    }

    private sealed class EncoderLifetime(MediaFoundationH264Encoder encoder) : IDisposable
    {
        public MediaFoundationH264Encoder Encoder { get; private set; } = encoder;

        public void Replace(MediaFoundationH264Encoder replacement)
        {
            var previous = Encoder;
            Encoder = replacement;
            previous.Dispose();
        }

        public void Dispose() => Encoder.Dispose();
    }

    internal static NativeEncodedAccessUnit CreateAccessUnit(
        H264EncodedFrame frame,
        H264RtpPacketizer packetizer,
        uint rtpTimestampBase)
    {
        var nalUnits = H264AnnexBParser.Parse(frame.Data);
        if (nalUnits.Count == 0)
        {
            throw new InvalidOperationException("Encoder çıktısında Annex B NAL bulunamadı.");
        }

        var timestamp = H264RtpPacketizer.ToRtpTimestamp(
            frame.SampleTime,
            rtpTimestampBase);
        var packets = packetizer.PacketizeAccessUnit(nalUnits, timestamp);
        return new NativeEncodedAccessUnit(
            frame.SampleTime,
            frame.SampleDuration,
            nalUnits.Any(unit => unit.IsKeyFrame),
            nalUnits.Any(unit => unit.IsParameterSet),
            frame.Data,
            frame.Data.Length,
            packets);
    }

    private static async Task WriteFramesAsync(
        IReadOnlyList<H264EncodedFrame> frames,
        INativeVideoPacketSink sink,
        H264RtpPacketizer packetizer,
        uint rtpTimestampBase,
        CancellationToken cancellationToken,
        Action<(long Frames, long Packets, long EncodedBytes, long PayloadBytes)> update)
    {
        foreach (var frame in frames)
        {
            var accessUnit = CreateAccessUnit(frame, packetizer, rtpTimestampBase);
            await sink.WriteAsync(accessUnit, cancellationToken);
            update((
                1,
                accessUnit.Packets.Count,
                accessUnit.EncodedBytes,
                accessUnit.Packets.Sum(packet => (long)packet.Payload.Length)));
        }
    }
}
