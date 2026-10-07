using EdizRemote.Host.Capture;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace EdizRemote.Host.Encoding;

internal sealed class GpuNv12Converter : IDisposable
{
    private readonly ID3D11VideoDevice _videoDevice;
    private readonly ID3D11VideoContext _videoContext;
    private readonly ID3D11VideoProcessorEnumerator _enumerator;
    private readonly ID3D11VideoProcessor _processor;
    private readonly ID3D11Texture2D _outputTexture;
    private readonly ID3D11VideoProcessorOutputView _outputView;
    private bool _disposed;

    public GpuNv12Converter(
        ID3D11Device device,
        ID3D11DeviceContext context,
        int width,
        int height)
    {
        if (width <= 0 || height <= 0 || width % 2 != 0 || height % 2 != 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(width),
                "NV12 dönüşümü için pozitif ve çift boyutlar gereklidir.");
        }

        Width = width;
        Height = height;
        _videoDevice = device.QueryInterface<ID3D11VideoDevice>();
        _videoContext = context.QueryInterface<ID3D11VideoContext>();

        var contentDescription = new VideoProcessorContentDescription
        {
            InputFrameFormat = VideoFrameFormat.Progressive,
            InputFrameRate = new Rational(30, 1),
            InputWidth = checked((uint)width),
            InputHeight = checked((uint)height),
            OutputFrameRate = new Rational(30, 1),
            OutputWidth = checked((uint)width),
            OutputHeight = checked((uint)height),
            Usage = VideoUsage.OptimalSpeed,
        };
        _enumerator = _videoDevice.CreateVideoProcessorEnumerator(contentDescription);
        EnsureFormatSupport(Format.B8G8R8A8_UNorm, VideoProcessorFormatSupport.Input);
        EnsureFormatSupport(Format.NV12, VideoProcessorFormatSupport.Output);
        _processor = _videoDevice.CreateVideoProcessor(_enumerator, 0);

        _outputTexture = device.CreateTexture2D(new Texture2DDescription
        {
            Width = checked((uint)width),
            Height = checked((uint)height),
            MipLevels = 1,
            ArraySize = 1,
            Format = Format.NV12,
            SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default,
            BindFlags = BindFlags.RenderTarget | BindFlags.ShaderResource,
            CPUAccessFlags = CpuAccessFlags.None,
            MiscFlags = ResourceOptionFlags.None,
        });
        _outputView = _videoDevice.CreateVideoProcessorOutputView(
            _outputTexture,
            _enumerator,
            new VideoProcessorOutputViewDescription
            {
                ViewDimension = VideoProcessorOutputViewDimension.Texture2D,
                Texture2D = new Texture2DVideoProcessorOutputView { MipSlice = 0 },
            });

        _videoContext.VideoProcessorSetStreamFrameFormat(
            _processor,
            0,
            VideoFrameFormat.Progressive);
        _videoContext.VideoProcessorSetStreamAutoProcessingMode(_processor, 0, false);
    }

    public int Width { get; }
    public int Height { get; }
    public ID3D11Texture2D OutputTexture => _outputTexture;

    public void Convert(ID3D11Texture2D bgraTexture)
    {
        var description = bgraTexture.Description;
        if (description.Width != Width || description.Height != Height)
        {
            throw new InvalidOperationException(
                $"Kaynak kare boyutu {description.Width}x{description.Height}; " +
                $"dönüştürücü {Width}x{Height} bekliyor.");
        }
        if (description.Format != Format.B8G8R8A8_UNorm)
        {
            throw new InvalidOperationException(
                $"Kaynak piksel biçimi {description.Format}; B8G8R8A8_UNorm bekleniyor.");
        }

        using var inputView = _videoDevice.CreateVideoProcessorInputView(
            bgraTexture,
            _enumerator,
            new VideoProcessorInputViewDescription
            {
                FourCC = 0,
                ViewDimension = VideoProcessorInputViewDimension.Texture2D,
                Texture2D = new Texture2DVideoProcessorInputView
                {
                    MipSlice = 0,
                    ArraySlice = 0,
                },
            });
        var stream = new VideoProcessorStream
        {
            Enable = true,
            OutputIndex = 0,
            InputFrameOrField = 0,
            InputSurface = inputView,
        };
        var result = _videoContext.VideoProcessorBlt(
            _processor,
            _outputView,
            0,
            [stream]);
        DisplayCatalog.ThrowIfFailed(result, "BGRA kare NV12 yüzeye dönüştürülemedi");
    }

    private void EnsureFormatSupport(Format format, VideoProcessorFormatSupport required)
    {
        var support = _enumerator.CheckVideoProcessorFormat(format);
        if (!support.HasFlag(required))
        {
            throw new NotSupportedException(
                $"GPU video processor {format} için {required} desteği sunmuyor.");
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _outputView.Dispose();
        _outputTexture.Dispose();
        _processor.Dispose();
        _enumerator.Dispose();
        _videoContext.Dispose();
        _videoDevice.Dispose();
    }
}
