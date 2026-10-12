using EdizRemote.Desktop.Lifecycle;
using Microsoft.Web.WebView2.Core;

namespace EdizRemote.Desktop.Tests;

public sealed class LifecycleTests
{
    [Theory]
    [InlineData(
        CoreWebView2ProcessFailedKind.BrowserProcessExited,
        2)]
    [InlineData(
        CoreWebView2ProcessFailedKind.RenderProcessExited,
        1)]
    [InlineData(
        CoreWebView2ProcessFailedKind.RenderProcessUnresponsive,
        2)]
    [InlineData(
        CoreWebView2ProcessFailedKind.FrameRenderProcessExited,
        1)]
    [InlineData(
        CoreWebView2ProcessFailedKind.GpuProcessExited,
        0)]
    [InlineData(
        CoreWebView2ProcessFailedKind.UtilityProcessExited,
        0)]
    [InlineData(
        CoreWebView2ProcessFailedKind.UnknownProcessExited,
        2)]
    [InlineData(
        (CoreWebView2ProcessFailedKind)999,
        2)]
    public void WebViewFailurePolicyFailsClosedOnlyForUiCriticalProcesses(
        CoreWebView2ProcessFailedKind kind,
        int expected)
    {
        Assert.Equal(
            (WebViewProcessFailureAction)expected,
            WebViewFailurePolicy.Resolve(kind));
    }

    [Theory]
    [InlineData(false, false, 0)]
    [InlineData(false, true, 1)]
    [InlineData(true, false, 2)]
    [InlineData(true, true, 2)]
    public void ClosePolicyKeepsActiveSessionsVisible(
        bool applicationExitRequested,
        bool activeSession,
        int expected)
    {
        Assert.Equal(
            (WindowCloseDisposition)expected,
            WindowClosePolicy.Decide(applicationExitRequested, activeSession));
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, true)]
    [InlineData(false, true, true)]
    [InlineData(true, true, true)]
    public void NativeVideoOrControlMarksTheSessionActive(
        bool nativeVideoActive,
        bool controlInputEnabled,
        bool expected)
    {
        Assert.Equal(
            expected,
            WindowClosePolicy.HasActiveSession(
                nativeVideoActive,
                controlInputEnabled));
    }

    [Fact]
    public void WebViewReplacementRunsEveryStepOnceInOrder()
    {
        var steps = new List<string>();

        WebViewControlReplacement.Replace(
            () => steps.Add("detach-core"),
            () => steps.Add("detach-previous"),
            () => steps.Add("dispose"),
            () => steps.Add("attach"));

        Assert.Equal(
            ["detach-core", "detach-previous", "dispose", "attach"],
            steps);
    }

    [Theory]
    [InlineData("detach-core")]
    [InlineData("dispose")]
    [InlineData("both")]
    public void WebViewReplacementCompletesWhenCrashedControlThrows(
        string throwingStep)
    {
        var steps = new List<string>();

        WebViewControlReplacement.Replace(
            () =>
            {
                steps.Add("detach-core");
                if (throwingStep is "detach-core" or "both") ThrowCrashed();
            },
            () => steps.Add("detach-previous"),
            () =>
            {
                steps.Add("dispose");
                if (throwingStep is "dispose" or "both") ThrowCrashed();
            },
            () => steps.Add("attach"));

        Assert.Equal(
            ["detach-core", "detach-previous", "dispose", "attach"],
            steps);
    }

    [Fact]
    public void WebViewReplacementSurfacesVisualTreeFailures()
    {
        var attached = false;

        Assert.Throws<InvalidOperationException>(() =>
            WebViewControlReplacement.Replace(
                () => { },
                () => throw new InvalidOperationException("tree"),
                () => { },
                () => attached = true));
        Assert.False(attached);
    }

    private static void ThrowCrashed() =>
        throw new InvalidOperationException("browser process crashed");

    [Fact]
    public void SecondInstanceSignalsPrimaryWithoutAcquiringMutex()
    {
        var instanceName = $"Local\\EdizRemote.Tests.{Guid.NewGuid():N}";
        using var activated = new ManualResetEventSlim();
        using var primary = new SingleInstanceCoordinator(
            instanceName,
            activated.Set);

        Assert.True(primary.IsPrimaryInstance);
        using var secondary = new SingleInstanceCoordinator(
            instanceName,
            () => { });

        Assert.False(secondary.IsPrimaryInstance);
        Assert.True(secondary.SignalPrimaryInstance());
        Assert.True(activated.Wait(TimeSpan.FromSeconds(2)));
    }

    [Fact]
    public void DisposedPrimaryReleasesInstanceOwnership()
    {
        var instanceName = $"Local\\EdizRemote.Tests.{Guid.NewGuid():N}";
        var primary = new SingleInstanceCoordinator(instanceName, () => { });

        Assert.True(primary.IsPrimaryInstance);
        primary.Dispose();

        using var replacement = new SingleInstanceCoordinator(
            instanceName,
            () => { });
        Assert.True(replacement.IsPrimaryInstance);
    }
}
