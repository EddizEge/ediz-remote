using EdizRemote.Host.Capture;
using EdizRemote.Host.Streaming;
using EdizRemote.Host.WebRtc;

namespace EdizRemote.Host.Tests;

public sealed class NativeVideoHostSessionLifecycleTests
{
    private static readonly TimeSpan TestTimeout = TimeSpan.FromSeconds(10);

    [Fact]
    public async Task ConcurrentDisposeCallersShareOneTeardown()
    {
        var streamStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var session = CreateSession(async cancellationToken =>
        {
            streamStarted.TrySetResult();
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return Statistics();
        });
        session.OnPeerStateChanged(NativeVideoPeerState.Connected);
        await streamStarted.Task.WaitAsync(TestTimeout);

        var first = session.DisposeAsync().AsTask();
        var second = session.DisposeAsync().AsTask();

        Assert.Same(first, second);
        await first.WaitAsync(TestTimeout);
        Assert.Throws<ObjectDisposedException>(() => session.AddIceCandidate(
            new NativeVideoIceCandidate("candidate:1 1 udp 1 127.0.0.1 9 typ host", "0", 0, null)));
    }

    [Fact]
    public async Task DisposeCompletesWhileTheCallerContextIsBlocked()
    {
        // The WPF window blocks its dispatcher on native teardown during
        // close. Disposal must finish without resuming on that context, even
        // when the stream loop is busy in a blocking capture/encode call.
        var streamStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var session = CreateSession(cancellationToken =>
        {
            streamStarted.TrySetResult();
            while (!cancellationToken.IsCancellationRequested)
            {
                Thread.Sleep(10);
            }
            throw new OperationCanceledException(cancellationToken);
        });
        session.OnPeerStateChanged(NativeVideoPeerState.Connected);
        await streamStarted.Task.WaitAsync(TestTimeout);

        var completed = RunWithBlockedContext(
            () => session.DisposeAsync().AsTask().Wait(TestTimeout));

        Assert.True(completed);
    }

    [Fact]
    public async Task PeerFailureCancelsTheRunningStream()
    {
        var streamStarted = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var streamStopped = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var session = CreateSession(async cancellationToken =>
        {
            try
            {
                streamStarted.TrySetResult();
                await Task.Delay(Timeout.Infinite, cancellationToken);
            }
            finally
            {
                streamStopped.TrySetResult();
            }
            return Statistics();
        });
        session.OnPeerStateChanged(NativeVideoPeerState.Connected);
        await streamStarted.Task.WaitAsync(TestTimeout);

        session.OnPeerStateChanged(NativeVideoPeerState.Failed);

        await streamStopped.Task.WaitAsync(TestTimeout);
        await session.DisposeAsync().AsTask().WaitAsync(TestTimeout);
    }

    [Fact]
    public async Task PeerStateCallbackRacingDisposalIsIgnored()
    {
        var streamRuns = 0;
        var session = CreateSession(_ =>
        {
            Interlocked.Increment(ref streamRuns);
            return Task.FromResult(Statistics());
        });
        var stateEvents = 0;
        session.StateChanged += _ => Interlocked.Increment(ref stateEvents);

        await session.DisposeAsync().AsTask().WaitAsync(TestTimeout);

        Assert.Null(Record.Exception(
            () => session.OnPeerStateChanged(NativeVideoPeerState.Failed)));
        Assert.Null(Record.Exception(
            () => session.OnPeerStateChanged(NativeVideoPeerState.Connected)));
        Assert.Equal(0, Volatile.Read(ref streamRuns));
        Assert.Equal(0, Volatile.Read(ref stateEvents));
    }

    private static NativeVideoHostSession CreateSession(
        Func<CancellationToken, Task<NativeStreamStatistics>> runStream) =>
        new(
            new DisplayOutput(
                0,
                0,
                0,
                "Test GPU",
                "\\\\.\\DISPLAY1",
                0,
                0,
                1920,
                1080,
                "Identity",
                true),
            streamOptions: null,
            iceServers: [],
            runStream);

    private static NativeStreamStatistics Statistics() =>
        new(0, 1920, 1080, 30, 0, 0, 0, 0, 0, 0, 0, 8_000_000, 0, 0, 0, 0);

    private static bool RunWithBlockedContext(Func<bool> action)
    {
        var result = false;
        var thread = new Thread(() =>
        {
            SynchronizationContext.SetSynchronizationContext(
                new NeverPumpedSynchronizationContext());
            result = action();
        });
        thread.Start();
        thread.Join();
        return result;
    }

    // Accepts posted continuations but never runs them, like a dispatcher
    // whose thread is blocked waiting for the result.
    private sealed class NeverPumpedSynchronizationContext : SynchronizationContext
    {
        public override void Post(SendOrPostCallback callback, object? state)
        {
        }

        public override void Send(SendOrPostCallback callback, object? state) =>
            throw new InvalidOperationException("Blocked context.");
    }
}
