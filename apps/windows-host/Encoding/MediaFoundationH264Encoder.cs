using System.Diagnostics;
using System.Runtime.InteropServices;
using EdizRemote.Host.Capture;
using SharpGen.Runtime;
using Vortice.Direct3D11;
using Vortice.MediaFoundation;

namespace EdizRemote.Host.Encoding;

internal sealed record H264EncodedFrame(
    byte[] Data,
    long SampleTime,
    long SampleDuration,
    bool ContainsAnnexBStartCode,
    IReadOnlyList<int> NalUnitTypes);

internal sealed class MediaFoundationH264Encoder : IDisposable
{
    internal static readonly Guid Nv12Subtype =
        new("3231564E-0000-0010-8000-00AA00389B71");

    private readonly IMFActivate _activation;
    private readonly IMFTransform _transform;
    private readonly IMFMediaEventGenerator _eventGenerator;
    private readonly IMFDXGIDeviceManager _deviceManager;
    private readonly int _width;
    private readonly int _height;
    private readonly int _frameRate;
    private readonly Queue<H264EncodedFrame> _outputFrames = new();
    private int _inputCredits;
    private bool _streaming;
    private bool _ended;
    private bool _drainComplete;
    private bool _disposed;

    public MediaFoundationH264Encoder(
        ID3D11Device device,
        int width,
        int height,
        int frameRate = 30,
        int bitrate = 8_000_000)
    {
        if (width <= 0 || height <= 0 || width % 2 != 0 || height % 2 != 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(width),
                "H.264 NV12 encoder için pozitif ve çift boyutlar gereklidir.");
        }

        _width = width;
        _height = height;
        _frameRate = frameRate;
        var startup = MediaFactory.MFStartup();
        DisplayCatalog.ThrowIfFailed(startup, "Media Foundation başlatılamadı");
        try
        {
            _deviceManager = MediaFactory.MFCreateDXGIDeviceManager();
            DisplayCatalog.ThrowIfFailed(
                _deviceManager.ResetDevice(device),
                "Encoder DXGI cihaz yöneticisi ayarlanamadı");

            var outputRegistration = new RegisterTypeInfo
            {
                GuidMajorType = MediaTypeGuids.Video,
                GuidSubtype = HardwareEncoderCatalog.H264Subtype,
            };
            var flags = (uint)(EnumFlag.EnumFlagHardware | EnumFlag.EnumFlagSortandfilter);
            using var activations = MediaFactory.MFTEnumEx(
                TransformCategoryGuids.VideoEncoder,
                flags,
                inputType: null,
                outputRegistration);
            _activation = activations.FirstOrDefault()
                ?? throw new NotSupportedException("Donanım H.264 encoder bulunamadı.");
            _transform = _activation.ActivateObject<IMFTransform>();

            using (var attributes = _transform.Attributes)
            {
                DisplayCatalog.ThrowIfFailed(
                    attributes.Set(TransformAttributeKeys.TransformAsyncUnlock, true),
                    "Asenkron encoder kilidi açılamadı");
            }
            _transform.ProcessMessage(
                TMessageType.MessageSetD3DManager,
                new UIntPtr(unchecked((ulong)_deviceManager.NativePointer.ToInt64())));

            using var outputType = CreateOutputType(width, height, frameRate, bitrate);
            _transform.SetOutputType(0, outputType, 0);
            using var inputType = CreateInputType(width, height, frameRate);
            _transform.SetInputType(0, inputType, 0);
            _eventGenerator = _transform.QueryInterface<IMFMediaEventGenerator>();
        }
        catch
        {
            DisposePartiallyConstructed();
            throw;
        }
    }

    public H264EncodedFrame EncodeSingleFrame(
        ID3D11Texture2D nv12Texture,
        TimeSpan timeout)
    {
        var sampleDuration = 10_000_000L / _frameRate;
        var frames = new List<H264EncodedFrame>();
        frames.AddRange(SubmitFrame(nv12Texture, 0, sampleDuration, timeout));
        frames.AddRange(Drain(timeout));
        return frames.LastOrDefault() ?? throw new TimeoutException(
            "Donanım encoder drain tamamladı ancak H.264 çıktı üretmedi.");
    }

    public IReadOnlyList<H264EncodedFrame> SubmitFrame(
        ID3D11Texture2D nv12Texture,
        long sampleTime,
        long sampleDuration,
        TimeSpan timeout)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_ended)
        {
            throw new InvalidOperationException("Drain edilmiş encoder'a yeni kare verilemez.");
        }
        ValidateTexture(nv12Texture);
        EnsureStreaming();

        var stopwatch = Stopwatch.StartNew();
        while (_inputCredits == 0)
        {
            PumpNextEvent(stopwatch, timeout, sampleTime, sampleDuration);
        }
        _inputCredits--;

        using (var surfaceBuffer = MediaFactory.MFCreateDXGISurfaceBuffer(
                   typeof(ID3D11Texture2D).GUID,
                   nv12Texture,
                   0,
                   false))
        using (var sample = MediaFactory.MFCreateSample())
        {
            sample.SampleTime = sampleTime;
            sample.SampleDuration = sampleDuration;
            sample.AddBuffer(surfaceBuffer);
            _transform.ProcessInput(0, sample, 0);
        }

        PumpAvailableEvents(sampleTime, sampleDuration);
        return TakeOutputFrames();
    }

    public IReadOnlyList<H264EncodedFrame> Drain(TimeSpan timeout)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!_streaming || _ended) return TakeOutputFrames();

        _transform.ProcessMessage(TMessageType.MessageNotifyEndOfStream, UIntPtr.Zero);
        _transform.ProcessMessage(TMessageType.MessageCommandDrain, UIntPtr.Zero);
        _ended = true;
        _drainComplete = false;

        var stopwatch = Stopwatch.StartNew();
        while (!_drainComplete)
        {
            PumpNextEvent(stopwatch, timeout, 0, 10_000_000L / _frameRate);
        }
        return TakeOutputFrames();
    }

    private void ValidateTexture(ID3D11Texture2D nv12Texture)
    {
        var description = nv12Texture.Description;
        if (description.Format != Vortice.DXGI.Format.NV12 ||
            description.Width != _width ||
            description.Height != _height)
        {
            throw new ArgumentException(
                $"Encoder {_width}x{_height} NV12 yüzey bekliyor.",
                nameof(nv12Texture));
        }
    }

    private void EnsureStreaming()
    {
        if (_streaming) return;
        _transform.ProcessMessage(TMessageType.MessageNotifyBeginStreaming, UIntPtr.Zero);
        _transform.ProcessMessage(TMessageType.MessageNotifyStartOfStream, UIntPtr.Zero);
        _streaming = true;
    }

    private H264EncodedFrame ReadOutput(long sampleTime, long sampleDuration)
    {
        var streamInfo = _transform.GetOutputStreamInfo(0);
        var flags = (OutputStreamInfoFlags)streamInfo.Flags;
        IMFSample? allocatedSample = null;
        if (!flags.HasFlag(OutputStreamInfoFlags.OutputStreamProvidesSamples))
        {
            allocatedSample = MediaFactory.MFCreateSample();
            using var buffer = MediaFactory.MFCreateMemoryBuffer(streamInfo.Size);
            allocatedSample.AddBuffer(buffer);
        }

        var output = new OutputDataBuffer
        {
            StreamID = 0,
            Sample = allocatedSample!,
            Status = 0,
            Events = null!,
        };
        var result = _transform.ProcessOutput(
            ProcessOutputFlags.None,
            1,
            ref output,
            out _);
        DisplayCatalog.ThrowIfFailed(result, "H.264 encoder çıktısı alınamadı");

        var producedSample = output.Sample ?? allocatedSample
            ?? throw new InvalidOperationException("Encoder boş bir output sample döndürdü.");
        try
        {
            using var contiguous = producedSample.ConvertToContiguousBuffer();
            contiguous.Lock(out var pointer, out _, out var currentLength);
            try
            {
                var data = new byte[currentLength];
                Marshal.Copy(pointer, data, 0, currentLength);
                var outputTime = ReadSampleTime(producedSample, sampleTime);
                var outputDuration = ReadSampleDuration(producedSample, sampleDuration);
                return new H264EncodedFrame(
                    data,
                    outputTime,
                    outputDuration,
                    ContainsAnnexBStartCode(data),
                    ReadAnnexBNalUnitTypes(data));
            }
            finally
            {
                contiguous.Unlock();
            }
        }
        finally
        {
            output.Events?.Dispose();
            if (output.Sample is not null &&
                output.Sample.NativePointer != allocatedSample?.NativePointer)
            {
                output.Sample.Dispose();
            }
            allocatedSample?.Dispose();
        }
    }

    private void PumpNextEvent(
        Stopwatch stopwatch,
        TimeSpan timeout,
        long fallbackTime,
        long fallbackDuration)
    {
        using var mediaEvent = WaitForNextEvent(stopwatch, timeout);
        HandleEvent(mediaEvent, fallbackTime, fallbackDuration);
    }

    private void PumpAvailableEvents(long fallbackTime, long fallbackDuration)
    {
        while (TryGetNextEvent(out var mediaEvent))
        {
            using (mediaEvent)
            {
                HandleEvent(mediaEvent, fallbackTime, fallbackDuration);
            }
        }
    }

    private bool TryGetNextEvent(out IMFMediaEvent mediaEvent)
    {
        try
        {
            mediaEvent = _eventGenerator.GetEvent(1); // MF_EVENT_FLAG_NO_WAIT
            return true;
        }
        catch (SharpGenException exception)
            when (exception.ResultCode.Code ==
                  Vortice.MediaFoundation.ResultCode.NoEventsAvailable.Code)
        {
            mediaEvent = null!;
            return false;
        }
    }

    private void HandleEvent(
        IMFMediaEvent mediaEvent,
        long fallbackTime,
        long fallbackDuration)
    {
        if (mediaEvent.Status.Failure)
        {
            throw new InvalidOperationException(
                $"Encoder olayı başarısız: {mediaEvent.Status.Description}");
        }

        switch (mediaEvent.EventType)
        {
            case MediaEventTypes.TransformNeedInput:
                _inputCredits++;
                break;
            case MediaEventTypes.TransformHaveOutput:
                _outputFrames.Enqueue(ReadOutput(fallbackTime, fallbackDuration));
                break;
            case MediaEventTypes.TransformDrainComplete:
                _drainComplete = true;
                break;
            case MediaEventTypes.Error:
                throw new InvalidOperationException("Donanım encoder hata olayı gönderdi.");
        }
    }

    private IReadOnlyList<H264EncodedFrame> TakeOutputFrames()
    {
        if (_outputFrames.Count == 0) return [];
        var frames = _outputFrames.ToArray();
        _outputFrames.Clear();
        return frames;
    }

    private IMFMediaEvent WaitForNextEvent(Stopwatch stopwatch, TimeSpan timeout)
    {
        while (stopwatch.Elapsed < timeout)
        {
            try
            {
                return _eventGenerator.GetEvent(1); // MF_EVENT_FLAG_NO_WAIT
            }
            catch (SharpGenException exception)
                when (exception.ResultCode.Code ==
                      Vortice.MediaFoundation.ResultCode.NoEventsAvailable.Code)
            {
                Thread.Sleep(1);
            }
        }
        throw new TimeoutException("Encoder olayı bekleme süresi doldu.");
    }

    private static long ReadSampleTime(IMFSample sample, long fallback)
    {
        try
        {
            return sample.SampleTime;
        }
        catch
        {
            return fallback;
        }
    }

    private static long ReadSampleDuration(IMFSample sample, long fallback)
    {
        try
        {
            return sample.SampleDuration;
        }
        catch
        {
            return fallback;
        }
    }

    private static IMFMediaType CreateOutputType(
        int width,
        int height,
        int frameRate,
        int bitrate)
    {
        var type = MediaFactory.MFCreateMediaType();
        Set(type, MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video);
        Set(type, MediaTypeAttributeKeys.Subtype, HardwareEncoderCatalog.H264Subtype);
        Set(type, MediaTypeAttributeKeys.FrameSize, Pack(width, height));
        Set(type, MediaTypeAttributeKeys.FrameRate, Pack(frameRate, 1));
        Set(type, MediaTypeAttributeKeys.PixelAspectRatio, Pack(1, 1));
        Set(type, MediaTypeAttributeKeys.InterlaceMode, (uint)VideoInterlaceMode.Progressive);
        Set(type, MediaTypeAttributeKeys.AvgBitrate, checked((uint)bitrate));
        Set(type, MediaTypeAttributeKeys.Mpeg2Profile, 100u); // H.264 High profile
        return type;
    }

    private static IMFMediaType CreateInputType(int width, int height, int frameRate)
    {
        var type = MediaFactory.MFCreateMediaType();
        Set(type, MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video);
        Set(type, MediaTypeAttributeKeys.Subtype, Nv12Subtype);
        Set(type, MediaTypeAttributeKeys.FrameSize, Pack(width, height));
        Set(type, MediaTypeAttributeKeys.FrameRate, Pack(frameRate, 1));
        Set(type, MediaTypeAttributeKeys.PixelAspectRatio, Pack(1, 1));
        Set(type, MediaTypeAttributeKeys.InterlaceMode, (uint)VideoInterlaceMode.Progressive);
        return type;
    }

    private static ulong Pack(int high, int low)
    {
        return ((ulong)checked((uint)high) << 32) | checked((uint)low);
    }

    private static void Set(IMFAttributes attributes, Guid key, Guid value)
    {
        DisplayCatalog.ThrowIfFailed(attributes.Set(key, value), "Media type GUID ayarlanamadı");
    }

    private static void Set(IMFAttributes attributes, Guid key, uint value)
    {
        DisplayCatalog.ThrowIfFailed(attributes.Set(key, value), "Media type UINT32 ayarlanamadı");
    }

    private static void Set(IMFAttributes attributes, Guid key, ulong value)
    {
        DisplayCatalog.ThrowIfFailed(attributes.Set(key, value), "Media type UINT64 ayarlanamadı");
    }

    internal static bool ContainsAnnexBStartCode(ReadOnlySpan<byte> data)
    {
        for (var index = 0; index + 3 < data.Length; index++)
        {
            if (data[index] == 0 && data[index + 1] == 0 &&
                (data[index + 2] == 1 ||
                 data[index + 2] == 0 && data[index + 3] == 1))
            {
                return true;
            }
        }
        return false;
    }

    internal static IReadOnlyList<int> ReadAnnexBNalUnitTypes(ReadOnlySpan<byte> data)
    {
        var types = new List<int>();
        for (var index = 0; index + 3 < data.Length; index++)
        {
            var prefixLength = data[index] == 0 && data[index + 1] == 0 &&
                               data[index + 2] == 1
                ? 3
                : data[index] == 0 && data[index + 1] == 0 &&
                  data[index + 2] == 0 && data[index + 3] == 1
                    ? 4
                    : 0;
            if (prefixLength == 0) continue;

            var headerIndex = index + prefixLength;
            if (headerIndex < data.Length)
            {
                types.Add(data[headerIndex] & 0x1F);
            }
            index = headerIndex;
        }
        return types;
    }

    private void DisposePartiallyConstructed()
    {
        _eventGenerator?.Dispose();
        _transform?.Dispose();
        _activation?.Dispose();
        _deviceManager?.Dispose();
        MediaFactory.MFShutdown();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_streaming)
        {
            try
            {
                if (!_ended)
                {
                    _transform.ProcessMessage(TMessageType.MessageNotifyEndOfStream, UIntPtr.Zero);
                }
                _transform.ProcessMessage(TMessageType.MessageCommandFlush, UIntPtr.Zero);
                _transform.ProcessMessage(TMessageType.MessageNotifyEndStreaming, UIntPtr.Zero);
            }
            catch
            {
                // Dispose must still release the COM graph after a device loss.
            }
        }
        _eventGenerator.Dispose();
        _transform.Dispose();
        _activation.Dispose();
        _deviceManager.Dispose();
        MediaFactory.MFShutdown();
    }
}
