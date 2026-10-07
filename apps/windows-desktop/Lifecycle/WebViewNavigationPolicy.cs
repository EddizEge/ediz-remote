namespace EdizRemote.Desktop.Lifecycle;

internal enum WebViewNavigationDecision
{
    AllowExpected,
    FailClosed,
}

internal sealed class WebViewNavigationPolicy
{
    internal const uint VirtualKeyF5 = 0x74;
    internal const uint VirtualKeyR = 0x52;

    private readonly Uri _expectedNavigationUri;
    private bool _expectedNavigationArmed;

    internal WebViewNavigationPolicy(string expectedNavigationUri)
    {
        if (!Uri.TryCreate(expectedNavigationUri, UriKind.Absolute, out var uri))
        {
            throw new ArgumentException(
                "Expected WebView navigation URI must be absolute.",
                nameof(expectedNavigationUri));
        }

        _expectedNavigationUri = uri;
    }

    internal void ExpectNextNavigation()
    {
        if (_expectedNavigationArmed)
        {
            throw new InvalidOperationException(
                "An expected WebView navigation is already pending.");
        }

        _expectedNavigationArmed = true;
    }

    internal void CancelExpectedNavigation() => _expectedNavigationArmed = false;

    internal WebViewNavigationDecision Evaluate(string navigationUri)
    {
        var wasExpected = _expectedNavigationArmed;
        _expectedNavigationArmed = false;

        if (!wasExpected ||
            !Uri.TryCreate(navigationUri, UriKind.Absolute, out var uri) ||
            Uri.Compare(
                uri,
                _expectedNavigationUri,
                UriComponents.AbsoluteUri,
                UriFormat.UriEscaped,
                StringComparison.Ordinal) != 0)
        {
            return WebViewNavigationDecision.FailClosed;
        }

        return WebViewNavigationDecision.AllowExpected;
    }

    internal static bool IsReloadAccelerator(uint virtualKey, bool controlPressed) =>
        virtualKey == VirtualKeyF5 ||
        (controlPressed && virtualKey == VirtualKeyR);
}
