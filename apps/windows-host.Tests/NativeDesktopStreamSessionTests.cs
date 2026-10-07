using EdizRemote.Host.Encoding;
using EdizRemote.Host.Streaming;
using EdizRemote.Host.Transport;

namespace EdizRemote.Host.Tests;

public sealed class NativeDesktopStreamSessionTests
{
    [Fact]
    public void StreamOptionsRejectUnsupportedFrameRate()
    {
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new NativeStreamOptions(FrameRate: 0).Validate());
        Assert.Throws<ArgumentOutOfRangeException>(
            () => new NativeStreamOptions(FrameRate: 61).Validate());
    }

    [Fact]
    public void AccessUnitFactoryProducesKeyFrameRtpPackets()
    {
        var frame = new H264EncodedFrame(
        [
            0, 0, 0, 1, 0x67, 0x64,
            0, 0, 0, 1, 0x68, 0xEE,
            0, 0, 0, 1, 0x65, 0x88, 0x99,
        ],
        10_000_000,
        333_333,
        true,
        [7, 8, 5]);
        var packetizer = new H264RtpPacketizer(
            synchronizationSource: 1,
            initialSequenceNumber: 1);

        var accessUnit = NativeDesktopStreamSession.CreateAccessUnit(
            frame,
            packetizer,
            1_000);

        Assert.True(accessUnit.IsKeyFrame);
        Assert.True(accessUnit.ContainsParameterSets);
        Assert.Same(frame.Data, accessUnit.EncodedData);
        Assert.Equal(91_000u, accessUnit.Packets[0].Timestamp);
        Assert.True(accessUnit.Packets[^1].Marker);
    }
}
