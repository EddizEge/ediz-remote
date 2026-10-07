namespace EdizRemote.Desktop.Lifecycle;

internal sealed class SingleInstanceCoordinator : IDisposable
{
    private readonly Mutex _mutex;
    private readonly EventWaitHandle? _activationEvent;
    private readonly CancellationTokenSource? _waitCancellation;
    private readonly Task? _waitTask;
    private readonly string _activationEventName;
    private bool _ownsMutex;
    private bool _disposed;

    public SingleInstanceCoordinator(string instanceName, Action activationRequested)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceName);
        ArgumentNullException.ThrowIfNull(activationRequested);

        _activationEventName = $"{instanceName}.Activate";
        _mutex = new Mutex(true, instanceName, out var createdNew);
        _ownsMutex = createdNew;
        IsPrimaryInstance = _ownsMutex;
        if (!IsPrimaryInstance) return;

        _activationEvent = new EventWaitHandle(
            false,
            EventResetMode.AutoReset,
            _activationEventName);
        _waitCancellation = new CancellationTokenSource();
        _waitTask = Task.Run(() => WaitForActivation(
            _activationEvent,
            _waitCancellation.Token,
            activationRequested));
    }

    public bool IsPrimaryInstance { get; }

    public bool SignalPrimaryInstance()
    {
        if (IsPrimaryInstance || _disposed) return false;
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try
            {
                using var activationEvent = EventWaitHandle.OpenExisting(
                    _activationEventName);
                return activationEvent.Set();
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                Thread.Sleep(50);
            }
        }
        return false;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _waitCancellation?.Cancel();
        _activationEvent?.Set();
        _waitTask?.Wait(TimeSpan.FromSeconds(1));
        _waitCancellation?.Dispose();
        _activationEvent?.Dispose();
        if (_ownsMutex)
        {
            _mutex.ReleaseMutex();
            _ownsMutex = false;
        }
        _mutex.Dispose();
    }

    private static void WaitForActivation(
        EventWaitHandle activationEvent,
        CancellationToken cancellationToken,
        Action activationRequested)
    {
        var handles = new[] { activationEvent, cancellationToken.WaitHandle };
        while (WaitHandle.WaitAny(handles) == 0)
        {
            if (cancellationToken.IsCancellationRequested) return;
            activationRequested();
        }
    }
}
