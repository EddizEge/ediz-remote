namespace EdizRemote.Host.Encoding;

// The NVIDIA asynchronous H.264 MFT runs its jobs on a Media Foundation
// serial work queue whose callbacks keep only a raw pointer to the encoder.
// A job that is still queued when the last COM reference goes away enters the
// encoder's deleted critical section: c0000005 at ntdll+0x1a12d under
// RTWorkQ -> nvEncMFTH264x, reproduced locally on 2026-10-12 even after a
// complete drain. The final release of every streamed encoder graph is
// therefore deferred past a grace period in which those trailing jobs finish.
internal static class DeferredTransformRelease
{
    internal static readonly TimeSpan GracePeriod = TimeSpan.FromSeconds(1);
    private static int _pending;

    public static int Pending => Volatile.Read(ref _pending);

    public static void Schedule(Action release) => Schedule(release, GracePeriod);

    internal static void Schedule(Action release, TimeSpan delay)
    {
        ArgumentNullException.ThrowIfNull(release);
        ArgumentOutOfRangeException.ThrowIfLessThan(delay, TimeSpan.Zero);
        Interlocked.Increment(ref _pending);
        _ = ReleaseLaterAsync(release, delay);
    }

    private static async Task ReleaseLaterAsync(Action release, TimeSpan delay)
    {
        try
        {
            await Task.Delay(delay).ConfigureAwait(false);
            release();
        }
        catch
        {
            // A failed COM release must not take the process down.
        }
        finally
        {
            Interlocked.Decrement(ref _pending);
        }
    }
}
