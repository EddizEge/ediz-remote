namespace EdizRemote.Host.WebRtc;

internal sealed record NativeVideoSessionDescription(string Type, string Sdp);

internal sealed record NativeVideoIceCandidate(
    string Candidate,
    string? SdpMid,
    ushort? SdpMLineIndex,
    string? UsernameFragment);

internal sealed record NativeVideoIceServer(
    string Url,
    string? Username = null,
    string? Credential = null);

internal enum NativeVideoPeerState
{
    New,
    Connecting,
    Connected,
    Disconnected,
    Failed,
    Closed,
}
