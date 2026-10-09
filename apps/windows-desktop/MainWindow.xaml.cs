using System.IO;
using System.ComponentModel;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using EdizRemote.Desktop.Input;
using EdizRemote.Desktop.Lifecycle;
using EdizRemote.Host.Capture;
using EdizRemote.Host.Encoding;
using EdizRemote.Host.Streaming;
using EdizRemote.Host.WebRtc;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace EdizRemote.Desktop;

public partial class MainWindow : Window
{
    private const string VirtualHost = "app.ediz-remote.local";
    private const string VirtualHostIndexUrl = "https://" + VirtualHost + "/index.html";
    private const int VirtualKeyControl = 0x11;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly ControlInputSession _controlInputSession;
    private readonly EmergencyStopHotKey _emergencyStopHotKey = new();
    private readonly SemaphoreSlim _nativeSessionMutationGate = new(1, 1);
    private readonly WebViewNavigationPolicy _webViewNavigationPolicy =
        new(VirtualHostIndexUrl);
    private NativeVideoHostSession? _nativeVideoSession;
    private IReadOnlyList<NativeVideoIceServer>? _nativeIceServers;
    private string? _nativeBridgeSessionEpoch;
    private string? _nativeNegotiationId;
    private NativeVideoNegotiationFatalLatch? _nativeNegotiationFatalLatch;
    private NativeIceCandidateBuffer? _pendingNativeRemoteCandidates;
    private bool _nativeRemoteDescriptionSet;
    private string? _selectedDisplayId;
    private string _qualityProfile = "auto";
    private long _cursorSequence;
    private bool _emergencyStopReady;
    private string? _emergencyStopErrorCode;
    private bool _closing;
    private bool _applicationExitRequested;
    private bool _cleanupCompleted;
    private bool _webViewConfigured;
    private bool _webViewInitializationInProgress;
    private bool _webViewOperational;
    private bool _webViewFailureInProgress;
    private bool _webViewRetryRequired;
    private bool _recreateWebViewOnRetry;
    private bool _nativeShutdownFailed;

    public event EventHandler? MinimizedToTray;

    public MainWindow()
    {
        InitializeComponent();
        _controlInputSession = new ControlInputSession(
            new WindowsInputInjector(),
            GetControlDisplayBounds);
        Loaded += OnLoaded;
        SourceInitialized += OnSourceInitialized;
        Closing += OnClosing;
        Closed += OnClosed;
    }

    public void RequestApplicationExit()
    {
        if (WindowClosePolicy.HasActiveSession(
                _nativeVideoSession is not null,
                _controlInputSession.Enabled) &&
            !ConfirmActiveSessionExit())
        {
            Show();
            Activate();
            return;
        }
        _applicationExitRequested = true;
        Close();
    }

    public void AllowSystemShutdown()
    {
        _applicationExitRequested = true;
    }

    private void OnSourceInitialized(object? sender, EventArgs eventArgs)
    {
        try
        {
            _emergencyStopHotKey.Triggered += OnEmergencyStop;
            _emergencyStopHotKey.Register(new WindowInteropHelper(this).Handle);
            _emergencyStopReady = true;
        }
        catch
        {
            _emergencyStopErrorCode = DesktopErrorCodes.ControlInputFailed;
            _controlInputSession.Disable();
        }
    }

    private async void OnLoaded(object sender, RoutedEventArgs eventArgs)
    {
        await TryInitializeWebViewAsync();
    }

    private async void RetryLoadingButton_Click(
        object sender,
        RoutedEventArgs eventArgs)
    {
        await TryInitializeWebViewAsync();
    }

    private async Task TryInitializeWebViewAsync()
    {
        if (_closing || _webViewInitializationInProgress) return;
        _webViewInitializationInProgress = true;
        ShowLoadingProgress();
        try
        {
            await StopActiveNativeSessionAsync();
            if (_recreateWebViewOnRetry)
            {
                RecreateWebViewControl();
                _recreateWebViewOnRetry = false;
            }
            _webViewRetryRequired = false;
            await InitializeWebViewAsync();
        }
        catch (FileNotFoundException)
        {
            ShowLoadingFailure(
                "Uygulama dosyaları eksik. Paketi yeniden çıkarın ve tekrar deneyin.");
        }
        catch
        {
            if (_nativeShutdownFailed)
            {
                ShowLoadingFailure(
                    "Güvenli oturum kaynakları kapatılamadı. Uygulamayı kapatıp " +
                    "yeniden açın.",
                    canRetry: false);
            }
            else
            {
                ShowLoadingFailure(
                    "Windows web bileşeni başlatılamadı. Microsoft Edge WebView2 Runtime'ı " +
                    "kurup veya güncelleyip tekrar deneyin.");
            }
        }
        finally
        {
            _webViewInitializationInProgress = false;
        }
    }

    private async Task InitializeWebViewAsync()
    {
        var webRoot = Path.Combine(AppContext.BaseDirectory, "Web");
        var indexPath = Path.Combine(webRoot, "index.html");
        if (!File.Exists(indexPath))
        {
            throw new FileNotFoundException("Paketlenmiş web arayüzü bulunamadı.", indexPath);
        }

        if (WebView.CoreWebView2 is null)
        {
            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Ediz Remote",
                "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(
                userDataFolder: userDataFolder);
            await WebView.EnsureCoreWebView2Async(environment);
        }

        var core = WebView.CoreWebView2
            ?? throw new InvalidOperationException("Windows web bileşeni hazır değil.");
        if (!_webViewConfigured)
        {
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.SetVirtualHostNameToFolderMapping(
                VirtualHost,
                webRoot,
                CoreWebView2HostResourceAccessKind.DenyCors);

            var settings = DesktopSettings.Load();
            var runtimeConfiguration = JsonSerializer.Serialize(new
            {
                desktop = true,
                signalingUrl = settings.SignalingUrl,
                version = GetVersion(),
            }, JsonOptions);
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                $"window.__EDIZ_REMOTE_CONFIG__ = {runtimeConfiguration};");

            core.WebMessageReceived += OnWebMessageReceived;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NavigationStarting += OnNavigationStarting;
            core.ProcessFailed += OnWebViewProcessFailed;
            core.NewWindowRequested += OnNewWindowRequested;
            WebView.PreviewKeyDown += OnWebViewPreviewKeyDown;
            _webViewConfigured = true;
        }

        _webViewNavigationPolicy.ExpectNextNavigation();
        try
        {
            core.Navigate(VirtualHostIndexUrl);
        }
        catch
        {
            _webViewNavigationPolicy.CancelExpectedNavigation();
            throw;
        }
    }

    private async void OnNavigationStarting(
        object? sender,
        CoreWebView2NavigationStartingEventArgs eventArgs)
    {
        if (_webViewNavigationPolicy.Evaluate(eventArgs.Uri) ==
            WebViewNavigationDecision.AllowExpected)
        {
            return;
        }

        eventArgs.Cancel = true;
        await EnterWebViewFailureAsync(
            "Beklenmeyen bir arayüz yenilemesi veya yönlendirmesi engellendi. " +
            "Oturum kapatıldı; yeniden deneyebilirsiniz.",
            recreateOnRetry: false);
    }

    private void OnWebViewPreviewKeyDown(
        object? sender,
        System.Windows.Input.KeyEventArgs eventArgs)
    {
        var key = eventArgs.Key == System.Windows.Input.Key.System
            ? eventArgs.SystemKey
            : eventArgs.Key;
        var controlPressed = (GetKeyState(VirtualKeyControl) & 0x8000) != 0;
        if (!WebViewNavigationPolicy.IsReloadAccelerator(
                (uint)System.Windows.Input.KeyInterop.VirtualKeyFromKey(key),
                controlPressed))
        {
            return;
        }

        eventArgs.Handled = true;
        if (eventArgs.IsRepeat)
        {
            return;
        }

        // AcceleratorKeyPressed is synchronous in windowed mode. Release input
        // immediately, then enter the normal deterministic native shutdown path
        // after the WebView2 callback has returned.
        _webViewOperational = false;
        _controlInputSession.Disable();
        _ = Dispatcher.InvokeAsync(() =>
        {
            _ = EnterWebViewFailureAsync(
                "Arayüz yenileme kısayolu engellendi. Oturum güvenli biçimde " +
                "kapatıldı; yeniden deneyebilirsiniz.",
                recreateOnRetry: false);
        });
    }

    private async void OnNavigationCompleted(
        object? sender,
        CoreWebView2NavigationCompletedEventArgs eventArgs)
    {
        if (!eventArgs.IsSuccess)
        {
            await EnterWebViewFailureAsync(
                "Uygulama arayüzü açılamadı. Güvenli erişim başlatılmadı; " +
                "yeniden deneyebilirsiniz.",
                recreateOnRetry: false);
            return;
        }
        if (_webViewRetryRequired || _webViewFailureInProgress) return;
        _webViewOperational = true;
        LoadingPanel.Visibility = Visibility.Collapsed;
        WebView.Visibility = Visibility.Visible;
    }

    private async void OnWebViewProcessFailed(
        object? sender,
        CoreWebView2ProcessFailedEventArgs eventArgs)
    {
        var action = WebViewFailurePolicy.Resolve(eventArgs.ProcessFailedKind);
        if (action == WebViewProcessFailureAction.Ignore) return;
        await EnterWebViewFailureAsync(
            "Uygulama arayüzü beklenmedik şekilde durdu. Güvenli erişim " +
            "kapatıldı; arayüzü yeniden başlatabilirsiniz.",
            recreateOnRetry: action == WebViewProcessFailureAction.FailClosedRecreate);
    }

    private static void OnNewWindowRequested(
        object? sender,
        CoreWebView2NewWindowRequestedEventArgs eventArgs) =>
        eventArgs.Handled = true;

    private void ShowLoadingProgress()
    {
        _webViewOperational = false;
        _controlInputSession.Disable();
        LoadingPanel.Visibility = Visibility.Visible;
        WebView.Visibility = Visibility.Hidden;
        LoadingText.Text = "Windows uygulaması hazırlanıyor...";
        LoadingProgress.Visibility = Visibility.Visible;
        RetryLoadingButton.Visibility = Visibility.Collapsed;
    }

    private void ShowLoadingFailure(string message, bool canRetry = true)
    {
        if (_closing) return;
        _webViewOperational = false;
        _webViewRetryRequired = true;
        LoadingPanel.Visibility = Visibility.Visible;
        WebView.Visibility = Visibility.Hidden;
        LoadingText.Text = message;
        LoadingProgress.Visibility = Visibility.Collapsed;
        RetryLoadingButton.Visibility = canRetry
            ? Visibility.Visible
            : Visibility.Collapsed;
    }

    private async Task EnterWebViewFailureAsync(
        string safeMessage,
        bool recreateOnRetry)
    {
        if (_closing) return;
        _webViewOperational = false;
        _webViewNavigationPolicy.CancelExpectedNavigation();
        _recreateWebViewOnRetry |= recreateOnRetry;
        _controlInputSession.Disable();
        WebView.Visibility = Visibility.Hidden;
        if (_webViewFailureInProgress) return;

        _webViewFailureInProgress = true;
        ShowLoadingProgress();
        try
        {
            await StopActiveNativeSessionAsync();
            ShowLoadingFailure(safeMessage);
        }
        catch
        {
            _nativeShutdownFailed = true;
            ShowLoadingFailure(
                "Güvenli oturum kaynakları kapatılamadı. Uygulamayı kapatıp " +
                "yeniden açın.",
                canRetry: false);
        }
        finally
        {
            _webViewFailureInProgress = false;
        }
    }

    private async Task StopActiveNativeSessionAsync()
    {
        _controlInputSession.Disable();
        _nativeIceServers = null;
        var gateAcquired = false;
        try
        {
            await _nativeSessionMutationGate.WaitAsync();
            gateAcquired = true;
            Interlocked.Exchange(ref _cursorSequence, 0);
            await StopNativeVideoAsync();
            _nativeBridgeSessionEpoch = null;
        }
        catch
        {
            _nativeShutdownFailed = true;
            throw;
        }
        finally
        {
            if (gateAcquired) _nativeSessionMutationGate.Release();
        }
    }

    private void RecreateWebViewControl()
    {
        var previous = WebView;
        if (previous.Parent is not System.Windows.Controls.Panel parent)
        {
            throw new InvalidOperationException("WebView container is unavailable.");
        }

        if (_webViewConfigured && previous.CoreWebView2 is { } core)
        {
            core.WebMessageReceived -= OnWebMessageReceived;
            core.NavigationCompleted -= OnNavigationCompleted;
            core.NavigationStarting -= OnNavigationStarting;
            core.ProcessFailed -= OnWebViewProcessFailed;
            core.NewWindowRequested -= OnNewWindowRequested;
            previous.PreviewKeyDown -= OnWebViewPreviewKeyDown;
        }

        var index = parent.Children.IndexOf(previous);
        parent.Children.Remove(previous);
        previous.Dispose();
        var replacement = new WebView2 { Visibility = Visibility.Hidden };
        parent.Children.Insert(Math.Max(0, index), replacement);
        WebView = replacement;
        _webViewConfigured = false;
        _webViewNavigationPolicy.CancelExpectedNavigation();
    }

    private async void OnWebMessageReceived(
        object? sender,
        CoreWebView2WebMessageReceivedEventArgs eventArgs)
    {
        string? messageType = null;
        try
        {
            if (!_webViewOperational) return;
            if (!IsTrustedWebViewSource(eventArgs.Source)) return;
            var messageJson = eventArgs.WebMessageAsJson;
            if (!NativeVideoBridgeProtocol.IsWithinMessageLimit(messageJson)) return;
            using var document = JsonDocument.Parse(messageJson);
            if (!document.RootElement.TryGetProperty("type", out var type))
            {
                return;
            }
            messageType = type.GetString();
            if (messageJson.Length > 8_192 &&
                messageType?.StartsWith(
                    "desktop.native-video.",
                    StringComparison.Ordinal) != true)
            {
                return;
            }
            switch (messageType)
            {
                case "desktop.initialize":
                    PostDesktopStatus();
                    break;
                case "desktop.native-video.start":
                    await StartNativeVideoFromWebAsync(document.RootElement);
                    break;
                case "desktop.native-video.signal":
                    ApplyNativeVideoSignal(document.RootElement);
                    break;
                case "desktop.native-video.stop":
                    await StopNativeVideoFromWebAsync(document.RootElement);
                    break;
                case "desktop.display.select":
                    await ApplyDisplaySelectionAsync(document.RootElement);
                    break;
                case "desktop.quality.select":
                    await ApplyQualitySelectionAsync(document.RootElement);
                    break;
                case "desktop.control.set-enabled":
                    ApplyControlEnabled(document.RootElement);
                    break;
                case "desktop.control.event":
                    ApplyControlEvent(document.RootElement);
                    break;
                case "desktop.control.release-all":
                    _controlInputSession.Disable();
                    PostControlState(false);
                    break;
            }
        }
        catch
        {
            if (messageType?.StartsWith("desktop.control.", StringComparison.Ordinal) == true)
            {
                _controlInputSession.Disable();
                PostControlState(false, DesktopErrorCodes.ControlInputFailed);
            }
            else if (messageType == "desktop.display.select")
            {
                PostDisplayState(false, DesktopErrorCodes.DisplaySwitchFailed);
            }
            else if (messageType == "desktop.quality.select")
            {
                PostQualityState(false, DesktopErrorCodes.QualitySwitchFailed);
            }
            else if (messageType?.StartsWith(
                         "desktop.native-video.",
                         StringComparison.Ordinal) == true)
            {
                _nativeNegotiationFatalLatch?.TryTrip();
                PostNativeVideoState(
                    NativeVideoPeerState.Failed,
                    DesktopErrorCodes.NativeVideoFailed);
                try
                {
                    await StopActiveNativeSessionAsync();
                }
                catch
                {
                    _nativeShutdownFailed = true;
                }
            }
            else
            {
                PostNativeVideoState(
                    NativeVideoPeerState.Failed,
                    DesktopErrorCodes.NativeVideoFailed);
            }
        }
    }

    private void PostDesktopStatus()
    {
        try
        {
            var displays = DisplayCatalog.Enumerate();
            var selectedDisplay = ResolveSelectedDisplay(displays, _selectedDisplayId);
            _selectedDisplayId = selectedDisplay?.DeviceName;
            var encoderReport = HardwareEncoderCatalog.DiscoverH264();
            var gpuEncoderReport = selectedDisplay is not null
                ? HardwareEncoderGpuProbe.Probe(selectedDisplay)
                : null;
            PostWebMessage(new
            {
                type = "desktop.status",
                payload = new
                {
                    version = GetVersion(),
                    captureAvailable = displays.Count > 0,
                    displayCount = displays.Count,
                    displays = displays.Select((display, index) => new
                    {
                        id = display.DeviceName,
                        label = $"Ekran {index + 1}" +
                                (display.Left == 0 && display.Top == 0 ? " (Ana ekran)" : ""),
                        display.Width,
                        display.Height,
                        isPrimary = display.Left == 0 && display.Top == 0,
                    }),
                    selectedDisplayId = selectedDisplay?.DeviceName,
                    qualityProfile = _qualityProfile,
                    encoderAvailable = encoderReport.Available,
                    encoderName = encoderReport.Preferred?.Name,
                    codec = encoderReport.Codec,
                    encoderErrorCode = encoderReport.Available
                        ? null
                        : DesktopErrorCodes.EncoderFailed,
                    gpuInputReady = gpuEncoderReport?.Ready == true,
                    gpuInputErrorCode = selectedDisplay is not null &&
                                        gpuEncoderReport?.Ready != true
                        ? DesktopErrorCodes.GpuInputFailed
                        : null,
                    controlInputAvailable = _emergencyStopReady,
                    controlInputErrorCode = _emergencyStopErrorCode,
                    emergencyStopShortcut = "Ctrl+Alt+Shift+F12",
                    errorCode = displays.Count == 0
                        ? DesktopErrorCodes.CaptureFailed
                        : null,
                },
            });
        }
        catch
        {
            PostWebMessage(new
            {
                type = "desktop.status",
                payload = new
                {
                    version = GetVersion(),
                    captureAvailable = false,
                    displayCount = 0,
                    errorCode = DesktopErrorCodes.CaptureFailed,
                },
            });
        }
    }

    private async Task StartNativeVideoFromWebAsync(JsonElement root)
    {
        if (!NativeVideoBridgeProtocol.TryReadStartSessionEpoch(
                root,
                out var sessionEpoch))
        {
            throw new InvalidOperationException("Native video köprü zarfı geçersiz.");
        }
        await _nativeSessionMutationGate.WaitAsync();
        try
        {
            if (!_webViewOperational) return;
            _nativeBridgeSessionEpoch = sessionEpoch;
            _nativeIceServers = ParseIceServers(root);
            await StartNativeVideoAsync(_nativeIceServers);
        }
        finally
        {
            _nativeSessionMutationGate.Release();
        }
    }

    private async Task StopNativeVideoFromWebAsync(JsonElement root)
    {
        if (!NativeVideoBridgeProtocol.TryReadStopSessionEpoch(
                root,
                out var sessionEpoch))
        {
            throw new InvalidOperationException("Native video durdurma zarfı geçersiz.");
        }
        await _nativeSessionMutationGate.WaitAsync();
        try
        {
            if (!string.Equals(
                    _nativeBridgeSessionEpoch,
                    sessionEpoch,
                    StringComparison.Ordinal)) return;
            _nativeIceServers = null;
            await StopNativeVideoAsync();
            _nativeBridgeSessionEpoch = null;
        }
        finally
        {
            _nativeSessionMutationGate.Release();
        }
    }

    private async Task StartNativeVideoAsync(
        IReadOnlyList<NativeVideoIceServer> iceServers)
    {
        var bridgeSessionEpoch = _nativeBridgeSessionEpoch
            ?? throw new InvalidOperationException("Native köprü oturumu bulunamadı.");
        await StopNativeVideoAsync();
        var negotiationId = Guid.NewGuid().ToString("D");
        var fatalLatch = new NativeVideoNegotiationFatalLatch();
        _nativeNegotiationId = negotiationId;
        _nativeNegotiationFatalLatch = fatalLatch;
        PostWebMessage(NativeVideoBridgeProtocol.CreateNegotiationEnvelope(
            bridgeSessionEpoch,
            negotiationId));
        var displays = DisplayCatalog.Enumerate();
        var output = ResolveSelectedDisplay(displays, _selectedDisplayId)
            ?? throw new InvalidOperationException("Native aktarım için ekran bulunamadı.");
        _selectedDisplayId = output.DeviceName;
        var session = new NativeVideoHostSession(
            output,
            ResolveQualityOptions(_qualityProfile),
            iceServers);
        var localCandidateBuffer = new NativeIceCandidateBuffer();
        var localCandidateGate = new object();
        var offerPublished = false;
        var localCandidateOverflow = false;
        var localCandidateOverflowSignal = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        _nativeVideoSession = session;
        _pendingNativeRemoteCandidates = new NativeIceCandidateBuffer();
        _nativeRemoteDescriptionSet = false;
        session.IceCandidateReady += candidate =>
        {
            if (!IsCurrentNativeGeneration(
                    session,
                    bridgeSessionEpoch,
                    negotiationId,
                    fatalLatch)) return;
            lock (localCandidateGate)
            {
                if (!IsCurrentNativeGeneration(
                        session,
                        bridgeSessionEpoch,
                        negotiationId,
                        fatalLatch)) return;
                if (!offerPublished)
                {
                    if (!localCandidateBuffer.TryEnqueue(candidate))
                    {
                        localCandidateOverflow = true;
                        fatalLatch.TryTrip();
                        localCandidateOverflowSignal.TrySetResult(true);
                    }
                    return;
                }
            }
            PostNativeVideoCandidate(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch,
                candidate);
        };
        session.StateChanged += state =>
        {
            PostNativeVideoState(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch,
                state);
        };
        session.StreamFailed += _ =>
        {
            PostNativeVideoState(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch,
                NativeVideoPeerState.Failed,
                DesktopErrorCodes.NativeVideoFailed);
        };
        session.StreamRecovering += recovery =>
        {
            PostNativeVideoState(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch,
                NativeVideoPeerState.Connecting,
                recoveryAttempt: recovery.Attempt,
                recoveryMaximumAttempts: recovery.MaximumAttempts);
        };
        session.StreamRecovered += _ =>
        {
            PostNativeVideoState(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch,
                NativeVideoPeerState.Connected);
        };
        session.NetworkMetricsChanged += metrics =>
        {
            PostCurrentNativeWebMessage(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch,
                NativeVideoBridgeProtocol.CreateMetricsEnvelope(
                    bridgeSessionEpoch,
                    negotiationId,
                    metrics));
        };
        session.CursorStateReady += cursor =>
        {
            PostCurrentNativeWebMessage(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch,
                new
                {
                    type = "desktop.cursor.state",
                    payload = new
                    {
                        sequence = Interlocked.Increment(ref _cursorSequence),
                        x = cursor.X,
                        y = cursor.Y,
                        visible = cursor.Visible,
                    },
                });
        };

        var offer = await NativeVideoOfferRace.AwaitOfferOrStopAsync(
            session.CreateOfferAsync(),
            localCandidateOverflowSignal.Task,
            () => StopNativeVideoAfterLocalCandidateOverflowAsync(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch));
        if (fatalLatch.IsTripped)
        {
            await StopNativeVideoAfterLocalCandidateOverflowAsync(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch);
            throw new InvalidOperationException("Native ICE aday kuyruğu sınırı aşıldı.");
        }
        if (!IsSameNativeGeneration(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch))
        {
            return;
        }
        IReadOnlyList<NativeVideoIceCandidate> pendingLocalCandidates;
        var overflowAfterOffer = false;
        lock (localCandidateGate)
        {
            if (localCandidateOverflow || fatalLatch.IsTripped)
            {
                overflowAfterOffer = true;
                pendingLocalCandidates = [];
            }
            else
            {
                PostCurrentNativeWebMessage(
                    session,
                    bridgeSessionEpoch,
                    negotiationId,
                    fatalLatch,
                    new
                    {
                        type = "desktop.native-video.signal",
                        channel = "native-video",
                        version = NativeVideoBridgeProtocol.Version,
                        sessionEpoch = bridgeSessionEpoch,
                        payload = new
                        {
                            kind = "session-description",
                            negotiationId,
                            description = new { type = offer.Type, sdp = offer.Sdp },
                        },
                    });
                offerPublished = true;
                pendingLocalCandidates = localCandidateBuffer.Drain();
            }
        }
        if (overflowAfterOffer)
        {
            await StopNativeVideoAfterLocalCandidateOverflowAsync(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch);
            throw new InvalidOperationException("Native ICE aday kuyruğu sınırı aşıldı.");
        }
        foreach (var candidate in pendingLocalCandidates)
        {
            PostNativeVideoCandidate(
                session,
                bridgeSessionEpoch,
                negotiationId,
                fatalLatch,
                candidate);
        }
    }

    private async Task ApplyDisplaySelectionAsync(JsonElement root)
    {
        if (!await _nativeSessionMutationGate.WaitAsync(0)) return;
        try
        {
            if (!TryGetBoundedString(root, "displayId", 1, 128, out var displayId))
            {
                throw new InvalidOperationException("Ekran seçimi geçersiz.");
            }
            var displays = DisplayCatalog.Enumerate();
            var selected = displays.FirstOrDefault(display =>
                display.DeviceName.Equals(displayId, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException(
                    "Seçilen ekran artık kullanılabilir değil.");
            if (selected.DeviceName.Equals(
                    _selectedDisplayId,
                    StringComparison.OrdinalIgnoreCase))
            {
                PostDisplayState(false);
                return;
            }

            _selectedDisplayId = selected.DeviceName;
            _controlInputSession.ReleasePressedInputs();
            PostDisplayState(true);
            if (_nativeVideoSession is not null && _nativeIceServers is not null)
            {
                await StartNativeVideoAsync(_nativeIceServers);
            }
            PostDesktopStatus();
            PostDisplayState(false);
        }
        finally
        {
            _nativeSessionMutationGate.Release();
        }
    }

    private async Task ApplyQualitySelectionAsync(JsonElement root)
    {
        if (!await _nativeSessionMutationGate.WaitAsync(0)) return;
        try
        {
            if (!TryGetBoundedString(root, "profile", 1, 16, out var profile) ||
                profile is not ("auto" or "speed" or "quality"))
            {
                throw new InvalidOperationException("Kalite profili geçersiz.");
            }
            if (profile == _qualityProfile)
            {
                PostQualityState(false);
                return;
            }

            _qualityProfile = profile;
            PostQualityState(true);
            if (_nativeVideoSession is not null && _nativeIceServers is not null)
            {
                await StartNativeVideoAsync(_nativeIceServers);
            }
            PostQualityState(false);
        }
        finally
        {
            _nativeSessionMutationGate.Release();
        }
    }

    private void ApplyNativeVideoSignal(JsonElement root)
    {
        var session = _nativeVideoSession
            ?? throw new InvalidOperationException("Native video oturumu başlatılmadı.");
        var fatalLatch = _nativeNegotiationFatalLatch
            ?? throw new InvalidOperationException("Native video nesli bulunamadı.");
        if (!NativeVideoBridgeProtocol.TryParseSignal(
                root,
                out var sessionEpoch,
                out var signal) ||
            signal is null)
        {
            throw new InvalidOperationException("Native video sinyali geçersiz.");
        }
        if (!string.Equals(
                _nativeBridgeSessionEpoch,
                sessionEpoch,
                StringComparison.Ordinal) ||
            !string.Equals(
                _nativeNegotiationId,
                signal.NegotiationId,
                StringComparison.Ordinal) ||
            fatalLatch.IsTripped)
        {
            return;
        }

        if (signal.Description is not null)
        {
            if (_nativeRemoteDescriptionSet) return;
            session.SetRemoteDescription(signal.Description);
            _nativeRemoteDescriptionSet = true;
            foreach (var candidate in
                     _pendingNativeRemoteCandidates?.Drain() ?? [])
            {
                session.AddIceCandidate(candidate);
            }
            return;
        }

        if (signal.Candidate is null) return;
        if (_nativeRemoteDescriptionSet)
        {
            session.AddIceCandidate(signal.Candidate);
            return;
        }
        if (_pendingNativeRemoteCandidates?.TryEnqueue(signal.Candidate) != true)
        {
            fatalLatch.TryTrip();
            _pendingNativeRemoteCandidates?.Drain();
            throw new InvalidOperationException("Native ICE aday kuyruğu sınırı aşıldı.");
        }
    }

    private void PostNativeVideoCandidate(
        NativeVideoHostSession session,
        string sessionEpoch,
        string negotiationId,
        NativeVideoNegotiationFatalLatch fatalLatch,
        NativeVideoIceCandidate candidate)
    {
        PostCurrentNativeWebMessage(
            session,
            sessionEpoch,
            negotiationId,
            fatalLatch,
            new
            {
                type = "desktop.native-video.signal",
                channel = "native-video",
                version = NativeVideoBridgeProtocol.Version,
                sessionEpoch,
                payload = new
                {
                    kind = "ice-candidate",
                    negotiationId,
                    candidate = new
                    {
                        candidate = candidate.Candidate,
                        sdpMid = candidate.SdpMid,
                        sdpMLineIndex = candidate.SdpMLineIndex,
                        usernameFragment = candidate.UsernameFragment,
                    },
                },
            });
    }

    private async Task StopNativeVideoAsync()
    {
        var session = _nativeVideoSession;
        _nativeNegotiationFatalLatch?.TryTrip();
        _nativeVideoSession = null;
        _nativeNegotiationId = null;
        _nativeNegotiationFatalLatch = null;
        _pendingNativeRemoteCandidates = null;
        _nativeRemoteDescriptionSet = false;
        if (session is not null) await session.DisposeAsync();
    }

    private async Task StopNativeVideoAfterLocalCandidateOverflowAsync(
        NativeVideoHostSession session,
        string sessionEpoch,
        string negotiationId,
        NativeVideoNegotiationFatalLatch fatalLatch)
    {
        if (!IsSameNativeGeneration(
                session,
                sessionEpoch,
                negotiationId,
                fatalLatch)) return;
        PostWebMessage(NativeVideoBridgeProtocol.CreateStateEnvelope(
            sessionEpoch,
            negotiationId,
            NativeVideoPeerState.Failed,
            DesktopErrorCodes.NativeVideoFailed,
            null,
            null));
        await StopNativeVideoAsync();
    }

    private void ApplyControlEnabled(JsonElement root)
    {
        if (!ControlBridgeProtocol.TryParseSetEnabled(
                root,
                out var sessionId,
                out var requestedEnabled))
        {
            throw new InvalidOperationException("Kontrol köprü zarfı geçersiz.");
        }

        var enabled = requestedEnabled && _emergencyStopReady;
        _controlInputSession.SetEnabled(sessionId, enabled);
        PostControlState(enabled);
    }

    private void ApplyControlEvent(JsonElement root)
    {
        if (!ControlBridgeProtocol.TryParseEvent(
                root,
                out var sessionId,
                out var controlEvent) ||
            controlEvent is null)
        {
            throw new InvalidOperationException("Kontrol olayı köprü zarfı geçersiz.");
        }

        if (!_controlInputSession.TryApply(sessionId, controlEvent) &&
            !_controlInputSession.Enabled)
        {
            PostControlState(false, DesktopErrorCodes.ControlInputFailed);
        }
    }

    private void OnEmergencyStop()
    {
        _controlInputSession.Disable();
        PostControlState(false);
        PostWebMessage(new
        {
            type = "desktop.control.emergency-stopped",
            payload = new
            {
                shortcut = "Ctrl+Alt+Shift+F12",
            },
        });
    }

    private void PostControlState(bool active, string? errorCode = null)
    {
        var safeErrorCode = DesktopErrorCodes.RequireAllowed(
            errorCode ?? _emergencyStopErrorCode);
        PostWebMessage(new
        {
            type = "desktop.control.state",
            payload = new
            {
                active,
                available = _emergencyStopReady,
                shortcut = "Ctrl+Alt+Shift+F12",
                errorCode = safeErrorCode,
            },
        });
    }

    private void PostNativeVideoState(
        NativeVideoPeerState state,
        string? errorCode = null,
        int? recoveryAttempt = null,
        int? recoveryMaximumAttempts = null)
    {
        var sessionEpoch = _nativeBridgeSessionEpoch;
        var negotiationId = _nativeNegotiationId;
        if (sessionEpoch is null || negotiationId is null) return;
        var safeErrorCode = DesktopErrorCodes.RequireAllowed(
            errorCode ??
            (state == NativeVideoPeerState.Failed
                ? DesktopErrorCodes.NativeVideoFailed
                : null));
        PostWebMessage(NativeVideoBridgeProtocol.CreateStateEnvelope(
            sessionEpoch,
            negotiationId,
            state,
            safeErrorCode,
            recoveryAttempt,
            recoveryMaximumAttempts));
    }

    private void PostNativeVideoState(
        NativeVideoHostSession session,
        string sessionEpoch,
        string negotiationId,
        NativeVideoNegotiationFatalLatch fatalLatch,
        NativeVideoPeerState state,
        string? errorCode = null,
        int? recoveryAttempt = null,
        int? recoveryMaximumAttempts = null)
    {
        var safeErrorCode = DesktopErrorCodes.RequireAllowed(
            errorCode ??
            (state == NativeVideoPeerState.Failed
                ? DesktopErrorCodes.NativeVideoFailed
                : null));
        PostCurrentNativeWebMessage(
            session,
            sessionEpoch,
            negotiationId,
            fatalLatch,
            NativeVideoBridgeProtocol.CreateStateEnvelope(
                sessionEpoch,
                negotiationId,
                state,
                safeErrorCode,
                recoveryAttempt,
                recoveryMaximumAttempts));
    }

    private void PostDisplayState(bool switching, string? errorCode = null)
    {
        var safeErrorCode = DesktopErrorCodes.RequireAllowed(errorCode);
        PostWebMessage(new
        {
            type = "desktop.display.state",
            payload = new
            {
                selectedDisplayId = _selectedDisplayId,
                switching,
                errorCode = safeErrorCode,
            },
        });
    }

    private void PostQualityState(bool switching, string? errorCode = null)
    {
        var safeErrorCode = DesktopErrorCodes.RequireAllowed(errorCode);
        PostWebMessage(new
        {
            type = "desktop.quality.state",
            payload = new
            {
                profile = _qualityProfile,
                switching,
                errorCode = safeErrorCode,
            },
        });
    }

    private void PostWebMessage(object message)
    {
        if (_closing || !_webViewOperational) return;
        _ = Dispatcher.InvokeAsync(() =>
        {
            PostWebMessageCore(message);
        });
    }

    private void PostCurrentNativeWebMessage(
        NativeVideoHostSession session,
        string sessionEpoch,
        string negotiationId,
        NativeVideoNegotiationFatalLatch fatalLatch,
        object message)
    {
        if (_closing ||
            !_webViewOperational ||
            !IsCurrentNativeGeneration(
                session,
                sessionEpoch,
                negotiationId,
                fatalLatch)) return;
        _ = Dispatcher.InvokeAsync(() =>
        {
            if (!IsCurrentNativeGeneration(
                    session,
                    sessionEpoch,
                    negotiationId,
                    fatalLatch)) return;
            PostWebMessageCore(message);
        });
    }

    private bool IsCurrentNativeGeneration(
        NativeVideoHostSession session,
        string sessionEpoch,
        string negotiationId,
        NativeVideoNegotiationFatalLatch fatalLatch) =>
        !fatalLatch.IsTripped &&
        IsSameNativeGeneration(session, sessionEpoch, negotiationId, fatalLatch);

    private bool IsSameNativeGeneration(
        NativeVideoHostSession session,
        string sessionEpoch,
        string negotiationId,
        NativeVideoNegotiationFatalLatch fatalLatch) =>
        ReferenceEquals(_nativeVideoSession, session) &&
        ReferenceEquals(_nativeNegotiationFatalLatch, fatalLatch) &&
        string.Equals(_nativeBridgeSessionEpoch, sessionEpoch, StringComparison.Ordinal) &&
        string.Equals(_nativeNegotiationId, negotiationId, StringComparison.Ordinal);

    private void PostWebMessageCore(object message)
    {
        if (_closing || !_webViewOperational || WebView.CoreWebView2 is null) return;
        WebView.CoreWebView2.PostWebMessageAsJson(
            JsonSerializer.Serialize(message, JsonOptions));
    }

    private void OnClosing(object? sender, CancelEventArgs eventArgs)
    {
        var disposition = WindowClosePolicy.Decide(
            _applicationExitRequested,
            WindowClosePolicy.HasActiveSession(
                _nativeVideoSession is not null,
                _controlInputSession.Enabled));
        if (disposition == WindowCloseDisposition.HideToTray)
        {
            eventArgs.Cancel = true;
            Hide();
            MinimizedToTray?.Invoke(this, EventArgs.Empty);
            return;
        }
        if (
            disposition == WindowCloseDisposition.ConfirmActiveSessionExit &&
            !ConfirmActiveSessionExit())
        {
            eventArgs.Cancel = true;
            return;
        }
        _applicationExitRequested = true;
        _closing = true;
        _controlInputSession.Disable();
    }

    private bool ConfirmActiveSessionExit() =>
        System.Windows.MessageBox.Show(
            this,
            "Aktif destek bağlantısı kapatılacak. Uygulamadan çıkmak istiyor musunuz?",
            "Ediz Remote",
            System.Windows.MessageBoxButton.YesNo,
            System.Windows.MessageBoxImage.Warning,
            System.Windows.MessageBoxResult.No) == System.Windows.MessageBoxResult.Yes;

    private void OnClosed(object? sender, EventArgs eventArgs)
    {
        if (_cleanupCompleted) return;
        _cleanupCompleted = true;
        _closing = true;
        _controlInputSession.Disable();
        _emergencyStopHotKey.Triggered -= OnEmergencyStop;
        _emergencyStopHotKey.Dispose();
        StopNativeVideoAsync().GetAwaiter().GetResult();
        _nativeSessionMutationGate.Dispose();
        WebView.Dispose();
    }

    internal static bool IsTrustedWebViewSource(string source)
    {
        return Uri.TryCreate(source, UriKind.Absolute, out var uri) &&
               uri.Scheme == Uri.UriSchemeHttps &&
               uri.Host == VirtualHost &&
               uri.Port == 443;
    }

    [DllImport("user32.dll")]
    private static extern short GetKeyState(int virtualKey);

    private ControlDisplayBounds? GetControlDisplayBounds()
    {
        var display = ResolveSelectedDisplay(DisplayCatalog.Enumerate(), _selectedDisplayId);
        return display is null
            ? null
            : new ControlDisplayBounds(
                display.Left,
                display.Top,
                display.Width,
                display.Height);
    }

    internal static DisplayOutput? ResolveSelectedDisplay(
        IReadOnlyList<DisplayOutput> displays,
        string? selectedDisplayId)
    {
        if (displays.Count == 0) return null;
        if (!string.IsNullOrWhiteSpace(selectedDisplayId))
        {
            var selected = displays.FirstOrDefault(display =>
                display.DeviceName.Equals(
                    selectedDisplayId,
                    StringComparison.OrdinalIgnoreCase));
            if (selected is not null) return selected;
        }
        return displays.FirstOrDefault(display => display.Left == 0 && display.Top == 0)
               ?? displays[0];
    }

    internal static NativeStreamOptions ResolveQualityOptions(string profile) =>
        profile switch
        {
            "speed" => new NativeStreamOptions(FrameRate: 24, Bitrate: 3_000_000),
            "quality" => new NativeStreamOptions(FrameRate: 30, Bitrate: 12_000_000),
            "auto" => new NativeStreamOptions(FrameRate: 30, Bitrate: 8_000_000),
            _ => throw new ArgumentOutOfRangeException(nameof(profile)),
        };

    private static bool TryGetBoundedString(
        JsonElement element,
        string propertyName,
        int minimumLength,
        int maximumLength,
        out string result)
    {
        result = string.Empty;
        if (!BridgeJson.TryGetProperty(element, propertyName, out var value) ||
            !BridgeJson.TryGetString(value, out result))
        {
            return false;
        }
        return result.Length >= minimumLength && result.Length <= maximumLength;
    }

    private static string? GetOptionalString(JsonElement element, string propertyName)
    {
        return BridgeJson.TryGetProperty(element, propertyName, out var value) &&
               BridgeJson.TryGetString(value, out var text)
            ? text
            : null;
    }

    private static ushort? GetOptionalUInt16(JsonElement element, string propertyName)
    {
        return BridgeJson.TryGetProperty(element, propertyName, out var value) &&
               value.ValueKind == JsonValueKind.Number &&
               value.TryGetUInt16(out var result)
            ? result
            : null;
    }

    internal static IReadOnlyList<NativeVideoIceServer> ParseIceServers(JsonElement root)
    {
        if (!BridgeJson.TryGetProperty(root, "iceServers", out var servers) ||
            servers.ValueKind != JsonValueKind.Array ||
            servers.GetArrayLength() is < 1 or > 8)
        {
            throw new InvalidOperationException("Native ICE sunucu listesi geçersiz.");
        }

        var result = new List<NativeVideoIceServer>();
        foreach (var server in servers.EnumerateArray())
        {
            // Protokoldeki strict iceServerSchema ile aynı: yalnız urls,
            // username ve credential; yinelenen veya okunamayan ad reddedilir.
            if (server.ValueKind != JsonValueKind.Object ||
                !HasOnlyIceServerProperties(server))
            {
                throw new InvalidOperationException("Native ICE sunucu alanları geçersiz.");
            }
            if (!BridgeJson.TryGetProperty(server, "urls", out var urls) ||
                urls.ValueKind != JsonValueKind.Array ||
                urls.GetArrayLength() is < 1 or > 4)
            {
                throw new InvalidOperationException("Native ICE URL listesi geçersiz.");
            }

            var username = GetOptionalBoundedString(server, "username", 512);
            var credential = GetOptionalBoundedString(server, "credential", 512);
            if ((username is null) != (credential is null))
            {
                throw new InvalidOperationException(
                    "Native ICE kullanıcı adı ve parolası birlikte verilmelidir.");
            }

            foreach (var value in urls.EnumerateArray())
            {
                var url = BridgeJson.TryGetString(value, out var text) ? text : null;
                if (string.IsNullOrWhiteSpace(url) ||
                    url.Length > 512 ||
                    !IsSupportedIceUrl(url))
                {
                    throw new InvalidOperationException("Native ICE URL değeri geçersiz.");
                }
                result.Add(new NativeVideoIceServer(url, username, credential));
            }
        }

        if (result.Count > 16)
        {
            throw new InvalidOperationException("Native ICE URL sınırı aşıldı.");
        }
        return result;
    }

    private static string? GetOptionalBoundedString(
        JsonElement element,
        string propertyName,
        int maximumLength)
    {
        if (!BridgeJson.TryGetProperty(element, propertyName, out var value))
        {
            return null;
        }
        if (!BridgeJson.TryGetString(value, out var result) ||
            string.IsNullOrWhiteSpace(result) ||
            result.Length > maximumLength)
        {
            throw new InvalidOperationException($"Native ICE {propertyName} değeri geçersiz.");
        }
        return result;
    }

    private static bool HasOnlyIceServerProperties(JsonElement server)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in server.EnumerateObject())
        {
            if (!BridgeJson.TryGetName(property, out var name) ||
                name is not ("urls" or "username" or "credential") ||
                !seen.Add(name))
            {
                return false;
            }
        }
        return true;
    }

    private static bool IsSupportedIceUrl(string url)
    {
        return url.StartsWith("stun:", StringComparison.OrdinalIgnoreCase) ||
               url.StartsWith("stuns:", StringComparison.OrdinalIgnoreCase) ||
               url.StartsWith("turn:", StringComparison.OrdinalIgnoreCase) ||
               url.StartsWith("turns:", StringComparison.OrdinalIgnoreCase);
    }

    private static string GetVersion()
    {
        return Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.1.0";
    }
}
