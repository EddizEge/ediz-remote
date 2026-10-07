using Microsoft.Web.WebView2.Core;

namespace EdizRemote.Desktop.Lifecycle;

internal enum WebViewProcessFailureAction
{
    Ignore,
    FailClosedReload,
    FailClosedRecreate,
}

internal static class WebViewFailurePolicy
{
    internal static WebViewProcessFailureAction Resolve(
        CoreWebView2ProcessFailedKind kind) =>
        kind switch
        {
            CoreWebView2ProcessFailedKind.RenderProcessExited or
            CoreWebView2ProcessFailedKind.FrameRenderProcessExited =>
                WebViewProcessFailureAction.FailClosedReload,
            CoreWebView2ProcessFailedKind.BrowserProcessExited or
            CoreWebView2ProcessFailedKind.RenderProcessUnresponsive or
            CoreWebView2ProcessFailedKind.UnknownProcessExited =>
                WebViewProcessFailureAction.FailClosedRecreate,
            CoreWebView2ProcessFailedKind.UtilityProcessExited or
            CoreWebView2ProcessFailedKind.SandboxHelperProcessExited or
            CoreWebView2ProcessFailedKind.GpuProcessExited or
            CoreWebView2ProcessFailedKind.PpapiPluginProcessExited or
            CoreWebView2ProcessFailedKind.PpapiBrokerProcessExited =>
                WebViewProcessFailureAction.Ignore,
            _ => WebViewProcessFailureAction.FailClosedRecreate,
        };
}
