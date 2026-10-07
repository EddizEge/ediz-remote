using System.Text.Json;
using EdizRemote.Host.Capture;
using EdizRemote.Host.Encoding;
using EdizRemote.Host.Streaming;

namespace EdizRemote.Host;

internal static class HostApplication
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task<int> RunAsync(string[] args)
    {
        try
        {
            var options = CommandLineOptions.Parse(args);
            if (options.ShowHelp)
            {
                Console.WriteLine(CommandLineOptions.HelpText);
                return 0;
            }

            return options.Command switch
            {
                HostCommand.Encoders => WriteEncoders(),
                HostCommand.EncoderProbe => WriteEncoderProbe(
                    DisplayCatalog.Enumerate(), options.OutputIndex),
                HostCommand.EncodeProbe => await EncodeProbeAsync(
                    DisplayCatalog.Enumerate(), options),
                HostCommand.StreamProbe => await StreamProbeAsync(
                    DisplayCatalog.Enumerate(), options),
                HostCommand.List => WriteOutputs(DisplayCatalog.Enumerate()),
                HostCommand.Probe => await ProbeAsync(DisplayCatalog.Enumerate(), options),
                HostCommand.Snapshot => await SnapshotAsync(DisplayCatalog.Enumerate(), options),
                _ => throw new InvalidOperationException("Desteklenmeyen komut."),
            };
        }
        catch (CommandLineException)
        {
            WriteSafeError(SafeHostErrorCode.InvalidArguments);
            return 2;
        }
        catch (Exception)
        {
            WriteSafeError(SafeHostErrorCode.NativeOperationFailed);
            return 1;
        }
    }

    private static int WriteOutputs(IReadOnlyList<DisplayOutput> outputs)
    {
        WriteEvent("display.list", new { count = outputs.Count, outputs });
        return outputs.Count > 0 ? 0 : 1;
    }

    private static int WriteEncoders()
    {
        var report = HardwareEncoderCatalog.DiscoverH264();
        WriteEvent("encoder.list", report);
        return report.Available ? 0 : 1;
    }

    private static int WriteEncoderProbe(
        IReadOnlyList<DisplayOutput> outputs,
        int outputIndex)
    {
        var output = SelectOutput(outputs, outputIndex);
        var report = HardwareEncoderGpuProbe.Probe(output);
        WriteEvent("encoder.gpu-probe", report);
        return report.Ready ? 0 : 1;
    }

    private static async Task<int> EncodeProbeAsync(
        IReadOnlyList<DisplayOutput> outputs,
        CommandLineOptions options)
    {
        var output = SelectOutput(outputs, options.OutputIndex);
        using var capture = new DesktopDuplicator(output);
        using var converter = new GpuNv12Converter(
            capture.Device,
            capture.Context,
            output.Width,
            output.Height);
        using var encoder = new MediaFoundationH264Encoder(
            capture.Device,
            output.Width,
            output.Height);
        using var cancellation = CreateCancellation(options.DurationSeconds);

        H264EncodedFrame? encodedFrame = null;
        await capture.ProcessGpuFrameAsync(
            (texture, _, _) =>
            {
                converter.Convert(texture);
                encodedFrame = encoder.EncodeSingleFrame(
                    converter.OutputTexture,
                    TimeSpan.FromSeconds(options.DurationSeconds));
            },
            cancellation.Token);

        var frame = encodedFrame
            ?? throw new InvalidOperationException("H.264 encoder çıktı üretmedi.");
        var path = Path.GetFullPath(options.FilePath!);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllBytesAsync(path, frame.Data, cancellation.Token);
        WriteEvent("encoder.frame", new
        {
            artifactSaved = true,
            output.Index,
            output.Width,
            output.Height,
            codec = "H.264",
            bytes = frame.Data.Length,
            frame.SampleTime,
            frame.SampleDuration,
            frame.ContainsAnnexBStartCode,
            frame.NalUnitTypes,
        });
        return frame.Data.Length > 0 ? 0 : 1;
    }

    private static async Task<int> StreamProbeAsync(
        IReadOnlyList<DisplayOutput> outputs,
        CommandLineOptions options)
    {
        var output = SelectOutput(outputs, options.OutputIndex);
        var session = new NativeDesktopStreamSession(output, new NativeStreamOptions());
        using var cancellation = CreateCancellation(options.DurationSeconds);
        WriteEvent("stream.started", new
        {
            output,
            durationSeconds = options.DurationSeconds,
            codec = "H.264",
            clockRate = 90_000,
        });
        var statistics = await session.RunAsync(
            DiscardVideoPacketSink.Instance,
            cancellation.Token);
        WriteEvent("stream.completed", statistics);
        return statistics.EncodedFrames > 0 && statistics.RtpPackets > 0 ? 0 : 1;
    }

    private static async Task<int> ProbeAsync(
        IReadOnlyList<DisplayOutput> outputs,
        CommandLineOptions options)
    {
        var output = SelectOutput(outputs, options.OutputIndex);
        using var capture = new DesktopDuplicator(output);
        using var cancellation = CreateCancellation(options.DurationSeconds);

        WriteEvent("capture.started", new
        {
            mode = "probe",
            output,
            durationSeconds = options.DurationSeconds,
        });

        var result = await capture.ProbeAsync(cancellation.Token);
        WriteEvent("capture.completed", result);
        return result.FramesCaptured > 0 ? 0 : 1;
    }

    private static async Task<int> SnapshotAsync(
        IReadOnlyList<DisplayOutput> outputs,
        CommandLineOptions options)
    {
        var output = SelectOutput(outputs, options.OutputIndex);
        using var capture = new DesktopDuplicator(output);
        using var cancellation = CreateCancellation(options.DurationSeconds);
        var frame = await capture.CaptureFrameAsync(cancellation.Token);

        var path = Path.GetFullPath(options.FilePath!);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        BmpWriter.Write(path, frame);
        WriteEvent("snapshot.saved", new
        {
            artifactSaved = true,
            frame.Width,
            frame.Height,
            frame.RowPitch,
        });
        return 0;
    }

    private static DisplayOutput SelectOutput(
        IReadOnlyList<DisplayOutput> outputs,
        int outputIndex)
    {
        return outputs.FirstOrDefault(output => output.Index == outputIndex)
            ?? throw new CommandLineException(
                $"{outputIndex} numaralı ekran bulunamadı. Geçerli ekranları görmek için 'list' kullanın.");
    }

    private static CancellationTokenSource CreateCancellation(int durationSeconds)
    {
        var cancellation = new CancellationTokenSource();
        cancellation.CancelAfter(TimeSpan.FromSeconds(durationSeconds));
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        return cancellation;
    }

    private static void WriteEvent(string type, object payload)
    {
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            type,
            timestamp = DateTimeOffset.UtcNow,
            payload,
        }, JsonOptions));
    }

    private static void WriteSafeError(SafeHostErrorCode errorCode)
    {
        Console.WriteLine(SafeHostDiagnostics.SerializeError(
            errorCode,
            DateTimeOffset.UtcNow));
    }

    private sealed class DiscardVideoPacketSink : INativeVideoPacketSink
    {
        public static readonly DiscardVideoPacketSink Instance = new();

        public ValueTask WriteAsync(
            NativeEncodedAccessUnit accessUnit,
            CancellationToken cancellationToken)
        {
            return ValueTask.CompletedTask;
        }
    }
}
