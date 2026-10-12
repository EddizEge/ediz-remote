namespace EdizRemote.Desktop.Lifecycle;

// After a WebView2 browser process crash the old WPF control throws
// InvalidOperationException from CoreWebView2, and its controller and COM
// objects are already dead. Detaching events from and disposing that instance
// is best-effort; removing it from the visual tree and attaching the
// replacement are not, so a structural failure still reaches the retry UI.
internal static class WebViewControlReplacement
{
    internal static void Replace(
        Action detachCoreEvents,
        Action detachPrevious,
        Action disposePrevious,
        Action attachReplacement)
    {
        RunBestEffort(detachCoreEvents);
        detachPrevious();
        RunBestEffort(disposePrevious);
        attachReplacement();
    }

    private static void RunBestEffort(Action action)
    {
        try
        {
            action();
        }
        catch
        {
            // The previous WebView2 instance is discarded either way.
        }
    }
}
