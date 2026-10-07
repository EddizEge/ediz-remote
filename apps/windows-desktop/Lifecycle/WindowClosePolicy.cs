namespace EdizRemote.Desktop.Lifecycle;

internal enum WindowCloseDisposition
{
    HideToTray,
    ConfirmActiveSessionExit,
    Exit,
}

internal static class WindowClosePolicy
{
    public static bool HasActiveSession(
        bool nativeVideoActive,
        bool controlInputEnabled) =>
        nativeVideoActive || controlInputEnabled;

    public static WindowCloseDisposition Decide(
        bool applicationExitRequested,
        bool activeSession) =>
        applicationExitRequested
            ? WindowCloseDisposition.Exit
            : activeSession
                ? WindowCloseDisposition.ConfirmActiveSessionExit
                : WindowCloseDisposition.HideToTray;
}
