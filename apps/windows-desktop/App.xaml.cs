using System.Windows;
using EdizRemote.Desktop.Lifecycle;
using WinForms = System.Windows.Forms;

namespace EdizRemote.Desktop;

public partial class App : System.Windows.Application
{
    private const string InstanceName = "Local\\EdizRemote.Desktop.V1";
    private SingleInstanceCoordinator? _singleInstance;
    private WinForms.NotifyIcon? _trayIcon;
    private WinForms.ContextMenuStrip? _trayMenu;
    private MainWindow? _mainWindow;
    private bool _trayHintShown;

    protected override void OnStartup(StartupEventArgs eventArgs)
    {
        base.OnStartup(eventArgs);
        ShutdownMode = ShutdownMode.OnMainWindowClose;
        _singleInstance = new SingleInstanceCoordinator(
            InstanceName,
            () => Dispatcher.BeginInvoke(ShowMainWindow));
        if (!_singleInstance.IsPrimaryInstance)
        {
            _singleInstance.SignalPrimaryInstance();
            Shutdown(0);
            return;
        }

        _mainWindow = new MainWindow();
        _mainWindow.MinimizedToTray += OnMinimizedToTray;
        MainWindow = _mainWindow;
        CreateTrayIcon();
        _mainWindow.Show();
    }

    protected override void OnSessionEnding(SessionEndingCancelEventArgs eventArgs)
    {
        _mainWindow?.AllowSystemShutdown();
        base.OnSessionEnding(eventArgs);
    }

    protected override void OnExit(ExitEventArgs eventArgs)
    {
        if (_mainWindow is not null)
        {
            _mainWindow.MinimizedToTray -= OnMinimizedToTray;
        }
        _trayIcon?.Dispose();
        _trayIcon = null;
        _trayMenu?.Dispose();
        _trayMenu = null;
        _singleInstance?.Dispose();
        _singleInstance = null;
        base.OnExit(eventArgs);
    }

    private void CreateTrayIcon()
    {
        var menu = new WinForms.ContextMenuStrip();
        menu.Items.Add("Ediz Remote'u Aç", null, (_, _) =>
            Dispatcher.BeginInvoke(ShowMainWindow));
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add("Çıkış", null, (_, _) =>
            Dispatcher.BeginInvoke(RequestApplicationExit));

        _trayIcon = new WinForms.NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Application,
            Text = "Ediz Remote - Güvenli uzaktan destek",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _trayMenu = menu;
        _trayIcon.DoubleClick += (_, _) => Dispatcher.BeginInvoke(ShowMainWindow);
    }

    private void OnMinimizedToTray(object? sender, EventArgs eventArgs)
    {
        if (_trayHintShown || _trayIcon is null) return;
        _trayHintShown = true;
        _trayIcon.ShowBalloonTip(
            3_000,
            "Ediz Remote çalışıyor",
            "Uygulamayı sistem tepsisindeki simgeden yeniden açabilirsiniz.",
            WinForms.ToolTipIcon.Info);
    }

    private void ShowMainWindow()
    {
        var window = _mainWindow;
        if (window is null) return;
        if (!window.IsVisible) window.Show();
        if (window.WindowState == WindowState.Minimized)
        {
            window.WindowState = WindowState.Normal;
        }
        window.Activate();
        window.Topmost = true;
        window.Topmost = false;
        window.Focus();
    }

    private void RequestApplicationExit()
    {
        _mainWindow?.RequestApplicationExit();
    }
}
