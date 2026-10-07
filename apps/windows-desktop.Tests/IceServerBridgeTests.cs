using System.Text.Json;
using EdizRemote.Desktop;

namespace EdizRemote.Desktop.Tests;

public sealed class IceServerBridgeTests
{
    [Fact]
    public void ParsesBoundedStunAndTurnConfiguration()
    {
        using var document = JsonDocument.Parse(
            """
            {
              "type": "desktop.native-video.start",
              "iceServers": [
                { "urls": ["stun:stun.example.test:3478"] },
                {
                  "urls": [
                    "turn:turn.example.test:3478?transport=udp",
                    "turns:turn.example.test:5349?transport=tcp"
                  ],
                  "username": "123:client",
                  "credential": "credential"
                }
              ]
            }
            """);

        var servers = MainWindow.ParseIceServers(document.RootElement);

        Assert.Equal(3, servers.Count);
        Assert.Equal("stun:stun.example.test:3478", servers[0].Url);
        Assert.Equal("123:client", servers[1].Username);
        Assert.Equal("credential", servers[2].Credential);
    }

    [Fact]
    public void RejectsCredentialWithoutUsername()
    {
        using var document = JsonDocument.Parse(
            """
            {
              "iceServers": [
                {
                  "urls": ["turn:turn.example.test:3478"],
                  "credential": "credential"
                }
              ]
            }
            """);

        Assert.Throws<InvalidOperationException>(
            () => MainWindow.ParseIceServers(document.RootElement));
    }
}
