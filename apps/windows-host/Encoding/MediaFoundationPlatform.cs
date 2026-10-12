using SharpGen.Runtime;
using Vortice.MediaFoundation;

namespace EdizRemote.Host.Encoding;

// Media Foundation is started once and kept for the process lifetime.
// Hardware MFTs (for example the NVIDIA asynchronous H.264 encoder) own worker
// threads and event queues that may still be unwinding after the last public
// reference is released. Pairing every encoder with MFStartup/MFShutdown let
// the platform reference count reach zero between encoder generations and
// tore down platform work queues underneath those threads.
internal static class MediaFoundationPlatform
{
    private static readonly object Sync = new();
    private static bool _started;

    public static bool IsStarted
    {
        get
        {
            lock (Sync)
            {
                return _started;
            }
        }
    }

    public static Result EnsureStarted()
    {
        lock (Sync)
        {
            if (_started) return Result.Ok;
            var result = MediaFactory.MFStartup();
            if (result.Success) _started = true;
            return result;
        }
    }
}
