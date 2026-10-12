using System.Diagnostics;
using EdizRemote.Host.Encoding;

namespace EdizRemote.Host.Tests;

public sealed class DeferredTransformReleaseTests
{
    private static readonly TimeSpan TestTimeout = TimeSpan.FromSeconds(10);

    [Fact]
    public void GracePeriodCoversTrailingEncoderJobs()
    {
        Assert.True(DeferredTransformRelease.GracePeriod >= TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task ReleaseRunsOnlyAfterTheDelay()
    {
        var released = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var stopwatch = Stopwatch.StartNew();

        DeferredTransformRelease.Schedule(
            () => released.TrySetResult(),
            TimeSpan.FromMilliseconds(300));

        Assert.False(released.Task.IsCompleted);
        await released.Task.WaitAsync(TestTimeout);
        Assert.True(stopwatch.Elapsed >= TimeSpan.FromMilliseconds(250));
    }

    [Fact]
    public async Task FailingReleaseIsContained()
    {
        var released = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);

        DeferredTransformRelease.Schedule(
            () => throw new InvalidOperationException("release failed"),
            TimeSpan.Zero);
        DeferredTransformRelease.Schedule(
            () => released.TrySetResult(),
            TimeSpan.FromMilliseconds(50));

        await released.Task.WaitAsync(TestTimeout);
    }

    [Fact]
    public void RejectsNegativeDelay()
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => DeferredTransformRelease.Schedule(() => { }, TimeSpan.FromMilliseconds(-1)));
    }
}
