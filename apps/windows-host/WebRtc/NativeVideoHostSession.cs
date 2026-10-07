using EdizRemote.Host.Capture;
using EdizRemote.Host.Streaming;

namespace EdizRemote.Host.WebRtc;

internal sealed class NativeVideoHostSession : IAsyncDisposable
{
    internal const int MaximumStreamRecoveryAttempts = 3;

    private readonly object _sync = new();
    private readonly DisplayOutput _output;
    private readonly NativeStreamOptions _streamOptions;
    private readonly NativeVideoPeer _peer;
    private readonly NativeStreamControl _streamControl;
    private readonly CancellationTokenSource _streamCancellation = new();
    private Task<NativeStreamStatistics>? _streamTask;
    private bool _disposed;

    public NativeVideoHostSession(
        DisplayOutput output,
        NativeStreamOptions? streamOptions = null,
        IReadOnlyList<NativeVideoIceServer>? iceServers = null)
    {
        _output = output;
        _streamOptions = streamOptions ?? new NativeStreamOptions();
        _streamControl = new NativeStreamControl(_streamOptions.Bitrate);
        _peer = iceServers is null
            ? new NativeVideoPeer(initialBitrate: _streamOptions.Bitrate)
            : new NativeVideoPeer(iceServers, _streamOptions.Bitrate);
        _peer.IceCandidateReady += candidate => IceCandidateReady?.Invoke(candidate);
        _peer.StateChanged += OnPeerStateChanged;
        _peer.KeyFrameRequested += _streamControl.RequestKeyFrame;
        _peer.TargetBitrateChanged += _streamControl.SetTargetBitrate;
        _peer.NetworkMetricsChanged += metrics => NetworkMetricsChanged?.Invoke(metrics);
    }

    public event Action<NativeVideoIceCandidate>? IceCandidateReady;
    public event Action<NativeVideoPeerState>? StateChanged;
    public event Action<NativeStreamStatistics>? StreamCompleted;
    public event Action<Exception>? StreamFailed;
    public event Action<NativeStreamRecoveryStatus>? StreamRecovering;
    public event Action<int>? StreamRecovered;
    public event Action<NativeVideoNetworkMetrics>? NetworkMetricsChanged;
    public event Action<NativeCursorState>? CursorStateReady;

    public Task<NativeVideoSessionDescription> CreateOfferAsync()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return _peer.CreateOfferAsync();
    }

    public void SetRemoteDescription(NativeVideoSessionDescription description)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        _peer.SetRemoteDescription(description);
    }

    public void AddIceCandidate(NativeVideoIceCandidate candidate)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        _peer.AddIceCandidate(candidate);
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        _streamCancellation.Cancel();
        Task<NativeStreamStatistics>? streamTask;
        lock (_sync)
        {
            streamTask = _streamTask;
        }
        if (streamTask is not null)
        {
            try
            {
                await streamTask;
            }
            catch (OperationCanceledException)
            {
                // Expected during an approved session shutdown.
            }
            catch
            {
                // The failure was already published through StreamFailed.
            }
        }
        _peer.Dispose();
        _streamCancellation.Dispose();
    }

    private void OnPeerStateChanged(NativeVideoPeerState state)
    {
        StateChanged?.Invoke(state);
        if (state == NativeVideoPeerState.Connected)
        {
            StartStreamOnce();
        }
        else if (state is NativeVideoPeerState.Disconnected or
                 NativeVideoPeerState.Failed or
                 NativeVideoPeerState.Closed)
        {
            _streamCancellation.Cancel();
        }
    }

    private void StartStreamOnce()
    {
        lock (_sync)
        {
            if (_disposed || _streamTask is not null) return;
            _streamTask = Task.Run(
                () => RunStreamWithRecoveryAsync(_streamCancellation.Token),
                CancellationToken.None);
            _ = ObserveStreamAsync(_streamTask);
        }
    }

    private async Task<NativeStreamStatistics> RunStreamWithRecoveryAsync(
        CancellationToken cancellationToken)
    {
        var recoveryAttempts = 0;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                var currentOutput = ResolveCurrentOutput(_output);
                var stream = new NativeDesktopStreamSession(
                    currentOutput,
                    _streamOptions,
                    _streamControl,
                    state => CursorStateReady?.Invoke(state));
                var runTask = stream.RunAsync(_peer, cancellationToken);
                if (recoveryAttempts > 0)
                {
                    var stabilityDelay = Task.Delay(
                        TimeSpan.FromMilliseconds(500),
                        cancellationToken);
                    var completed = await Task.WhenAny(runTask, stabilityDelay);
                    if (completed == runTask)
                    {
                        return await runTask;
                    }
                    StreamRecovered?.Invoke(recoveryAttempts);
                }
                return await runTask;
            }
            catch (Exception exception) when (
                !cancellationToken.IsCancellationRequested &&
                NativeStreamRecoveryPolicy.IsRecoverable(exception) &&
                recoveryAttempts < MaximumStreamRecoveryAttempts)
            {
                recoveryAttempts++;
                var delay = NativeStreamRecoveryPolicy.GetDelay(recoveryAttempts);
                StreamRecovering?.Invoke(new NativeStreamRecoveryStatus(
                    recoveryAttempts,
                    MaximumStreamRecoveryAttempts,
                    delay));
                await Task.Delay(delay, cancellationToken);
            }
        }
    }

    internal static DisplayOutput ResolveCurrentOutput(
        DisplayOutput selectedOutput,
        IReadOnlyList<DisplayOutput>? currentOutputs = null)
    {
        currentOutputs ??= DisplayCatalog.Enumerate();
        return currentOutputs.FirstOrDefault(
                   output => output.DeviceName.Equals(
                       selectedOutput.DeviceName,
                       StringComparison.OrdinalIgnoreCase))
               ?? currentOutputs.FirstOrDefault(output => output.Index == selectedOutput.Index)
               ?? throw new InvalidOperationException(
                   "Seçilen ekran artık kullanılabilir değil. Ekranı yeniden bağlayıp tekrar deneyin.");
    }

    private async Task ObserveStreamAsync(Task<NativeStreamStatistics> streamTask)
    {
        try
        {
            StreamCompleted?.Invoke(await streamTask);
        }
        catch (OperationCanceledException) when (_streamCancellation.IsCancellationRequested)
        {
            // Normal session shutdown.
        }
        catch (Exception exception)
        {
            StreamFailed?.Invoke(exception);
        }
    }
}

internal sealed record NativeStreamRecoveryStatus(
    int Attempt,
    int MaximumAttempts,
    TimeSpan RetryDelay);

internal static class NativeStreamRecoveryPolicy
{
    public static bool IsRecoverable(Exception exception) =>
        exception is DesktopCaptureAccessLostException or InvalidOperationException;

    public static TimeSpan GetDelay(int attempt)
    {
        if (attempt < 1) throw new ArgumentOutOfRangeException(nameof(attempt));
        return TimeSpan.FromSeconds(Math.Min(4, 1 << Math.Min(attempt - 1, 2)));
    }
}
