using System.Diagnostics;
using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using static Vortice.Direct3D11.D3D11;
using static Vortice.DXGI.DXGI;

namespace EdizRemote.Host.Capture;

internal sealed record DesktopPointerState(int X, int Y, bool Visible);

internal sealed class DesktopCaptureAccessLostException()
    : InvalidOperationException(
        "Ekran modu veya grafik oturumu değiştiği için masaüstü yakalama erişimi kayboldu.");

internal sealed class DesktopDuplicator : IDisposable
{
    private readonly DisplayOutput _output;
    private readonly IDXGIFactory1 _factory;
    private readonly IDXGIAdapter1 _adapter;
    private readonly IDXGIOutput _dxgiOutput;
    private readonly IDXGIOutput1 _output1;
    private readonly ID3D11Device _device;
    private readonly ID3D11DeviceContext _context;
    private readonly IDXGIOutputDuplication _duplication;
    private ID3D11Texture2D? _stagingTexture;
    private bool _disposed;

    internal ID3D11Device Device => _device;
    internal ID3D11DeviceContext Context => _context;

    public DesktopDuplicator(DisplayOutput output)
    {
        _output = output;
        _factory = CreateDXGIFactory1<IDXGIFactory1>();

        var adapterResult = _factory.EnumAdapters1((uint)output.AdapterIndex, out _adapter);
        DisplayCatalog.ThrowIfFailed(adapterResult, "Seçilen ekran kartı açılamadı");
        var outputResult = _adapter.EnumOutputs((uint)output.OutputIndex, out _dxgiOutput);
        DisplayCatalog.ThrowIfFailed(outputResult, "Seçilen ekran çıkışı açılamadı");
        _output1 = _dxgiOutput.QueryInterface<IDXGIOutput1>();

        var deviceResult = D3D11CreateDevice(
            _adapter,
            DriverType.Unknown,
            DeviceCreationFlags.BgraSupport,
            null!,
            out _device,
            out _context);
        DisplayCatalog.ThrowIfFailed(deviceResult, "Direct3D 11 cihazı oluşturulamadı");
        _duplication = _output1.DuplicateOutput(_device);
    }

    public async Task<CaptureProbeResult> ProbeAsync(CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var frames = 0;
        long desktopUpdates = 0;
        var pointerObserved = false;

        while (!cancellationToken.IsCancellationRequested)
        {
            var frame = TryAcquireFrame(copyPixels: frames == 0);
            if (frame is null)
            {
                await Task.Yield();
                continue;
            }

            frames++;
            desktopUpdates += frame.AccumulatedFrames;
            pointerObserved |= frame.PointerVisible;
            await Task.Yield();
        }

        stopwatch.Stop();
        return new CaptureProbeResult(
            _output.Index,
            _output.Width,
            _output.Height,
            "B8G8R8A8_UNorm",
            frames,
            desktopUpdates,
            stopwatch.ElapsedMilliseconds,
            stopwatch.Elapsed.TotalSeconds > 0
                ? Math.Round(frames / stopwatch.Elapsed.TotalSeconds, 2)
                : 0,
            pointerObserved);
    }

    public async Task<CapturedFrame> CaptureFrameAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var frame = TryAcquireFrame(copyPixels: true);
            if (frame is not null) return frame;
            await Task.Yield();
        }
        throw new OperationCanceledException("Ekrandan kare alınamadı.", cancellationToken);
    }

    internal async Task ProcessGpuFrameAsync(
        Action<ID3D11Texture2D, uint, DesktopPointerState> processor,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            if (TryProcessGpuFrame(processor)) return;
            await Task.Yield();
        }
        throw new OperationCanceledException("GPU masaüstü karesi alınamadı.", cancellationToken);
    }

    private bool TryProcessGpuFrame(
        Action<ID3D11Texture2D, uint, DesktopPointerState> processor)
    {
        var result = _duplication.AcquireNextFrame(100, out var frameInfo, out var resource);
        if (result.Code == Vortice.DXGI.ResultCode.WaitTimeout.Code) return false;
        if (result.Code == Vortice.DXGI.ResultCode.AccessLost.Code)
        {
            throw new DesktopCaptureAccessLostException();
        }
        DisplayCatalog.ThrowIfFailed(result, "GPU masaüstü karesi alınamadı");

        using (resource)
        {
            try
            {
                using var texture = resource.QueryInterface<ID3D11Texture2D>();
                processor(
                    texture,
                    frameInfo.AccumulatedFrames,
                    new DesktopPointerState(
                        frameInfo.PointerPosition.Position.X,
                        frameInfo.PointerPosition.Position.Y,
                        frameInfo.PointerPosition.Visible));
                return true;
            }
            finally
            {
                _duplication.ReleaseFrame();
            }
        }
    }

    private CapturedFrame? TryAcquireFrame(bool copyPixels)
    {
        var result = _duplication.AcquireNextFrame(100, out var frameInfo, out var resource);
        if (result.Code == Vortice.DXGI.ResultCode.WaitTimeout.Code) return null;
        if (result.Code == Vortice.DXGI.ResultCode.AccessLost.Code)
        {
            throw new DesktopCaptureAccessLostException();
        }
        DisplayCatalog.ThrowIfFailed(result, "Masaüstü karesi alınamadı");

        using (resource)
        {
            try
            {
                using var texture = resource.QueryInterface<ID3D11Texture2D>();
                var description = texture.Description;
                if (!copyPixels)
                {
                    return new CapturedFrame(
                        checked((int)description.Width),
                        checked((int)description.Height),
                        0,
                        [],
                        frameInfo.AccumulatedFrames,
                        frameInfo.PointerPosition.Visible);
                }

                EnsureStagingTexture(description);
                _context.CopyResource(_stagingTexture!, texture);
                var mapped = _context.Map(
                    _stagingTexture!,
                    0,
                    MapMode.Read,
                    Vortice.Direct3D11.MapFlags.None);
                try
                {
                    var width = checked((int)description.Width);
                    var height = checked((int)description.Height);
                    var packedRowSize = checked(width * 4);
                    var pixels = new byte[checked(packedRowSize * height)];
                    for (var row = 0; row < height; row++)
                    {
                        Marshal.Copy(
                            IntPtr.Add(mapped.DataPointer, checked(row * (int)mapped.RowPitch)),
                            pixels,
                            row * packedRowSize,
                            packedRowSize);
                    }

                    return new CapturedFrame(
                        width,
                        height,
                        packedRowSize,
                        pixels,
                        frameInfo.AccumulatedFrames,
                        frameInfo.PointerPosition.Visible);
                }
                finally
                {
                    _context.Unmap(_stagingTexture!, 0);
                }
            }
            finally
            {
                _duplication.ReleaseFrame();
            }
        }
    }

    private void EnsureStagingTexture(Texture2DDescription source)
    {
        if (_stagingTexture is not null)
        {
            var current = _stagingTexture.Description;
            if (current.Width == source.Width &&
                current.Height == source.Height &&
                current.Format == source.Format)
            {
                return;
            }
            _stagingTexture.Dispose();
        }

        var stagingDescription = new Texture2DDescription
        {
            Width = source.Width,
            Height = source.Height,
            MipLevels = 1,
            ArraySize = 1,
            Format = source.Format,
            SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Staging,
            BindFlags = BindFlags.None,
            CPUAccessFlags = CpuAccessFlags.Read,
            MiscFlags = ResourceOptionFlags.None,
        };
        _stagingTexture = _device.CreateTexture2D(stagingDescription);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _stagingTexture?.Dispose();
        _duplication.Dispose();
        _context.Dispose();
        _device.Dispose();
        _output1.Dispose();
        _dxgiOutput.Dispose();
        _adapter.Dispose();
        _factory.Dispose();
    }
}
