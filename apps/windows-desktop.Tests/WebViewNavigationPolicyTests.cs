using EdizRemote.Desktop.Lifecycle;

namespace EdizRemote.Desktop.Tests;

public sealed class WebViewNavigationPolicyTests
{
    private const string IndexUrl =
        "https://app.ediz-remote.local/index.html";

    [Fact]
    public void ExpectedNavigationIsAllowedExactlyOnce()
    {
        var policy = new WebViewNavigationPolicy(IndexUrl);

        policy.ExpectNextNavigation();

        Assert.Equal(
            WebViewNavigationDecision.AllowExpected,
            policy.Evaluate(IndexUrl));
        Assert.Equal(
            WebViewNavigationDecision.FailClosed,
            policy.Evaluate(IndexUrl));
    }

    [Theory]
    [InlineData("https://app.ediz-remote.local/other.html")]
    [InlineData("https://example.com/index.html")]
    [InlineData("not-a-uri")]
    public void ArmedNavigationRejectsUnexpectedTargetAndConsumesLatch(
        string unexpectedUrl)
    {
        var policy = new WebViewNavigationPolicy(IndexUrl);
        policy.ExpectNextNavigation();

        Assert.Equal(
            WebViewNavigationDecision.FailClosed,
            policy.Evaluate(unexpectedUrl));
        Assert.Equal(
            WebViewNavigationDecision.FailClosed,
            policy.Evaluate(IndexUrl));
    }

    [Fact]
    public void CancelledExpectedNavigationCannotAuthorizeLaterReload()
    {
        var policy = new WebViewNavigationPolicy(IndexUrl);
        policy.ExpectNextNavigation();

        policy.CancelExpectedNavigation();

        Assert.Equal(
            WebViewNavigationDecision.FailClosed,
            policy.Evaluate(IndexUrl));
    }

    [Theory]
    [InlineData(WebViewNavigationPolicy.VirtualKeyF5, false, true)]
    [InlineData(WebViewNavigationPolicy.VirtualKeyF5, true, true)]
    [InlineData(WebViewNavigationPolicy.VirtualKeyR, true, true)]
    [InlineData(WebViewNavigationPolicy.VirtualKeyR, false, false)]
    [InlineData(0x4C, true, false)]
    public void ReloadAcceleratorPolicyIsBounded(
        uint virtualKey,
        bool controlPressed,
        bool expected)
    {
        Assert.Equal(
            expected,
            WebViewNavigationPolicy.IsReloadAccelerator(
                virtualKey,
                controlPressed));
    }
}
