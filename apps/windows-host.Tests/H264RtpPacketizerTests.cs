using System.Buffers.Binary;
using EdizRemote.Host.Transport;

namespace EdizRemote.Host.Tests;

public sealed class H264RtpPacketizerTests
{
    [Fact]
    public void AnnexBParserRemovesStartCodesAndReportsNalTypes()
    {
        var annexB = new byte[]
        {
            0, 0, 0, 1, 0x67, 0x64,
            0, 0, 1, 0x68, 0xEE,
            0, 0, 0, 1, 0x65, 0x88, 0x99,
        };

        var units = H264AnnexBParser.Parse(annexB);

        Assert.Equal(new[] { 7, 8, 5 }, units.Select(unit => unit.Type));
        Assert.Equal(new byte[] { 0x65, 0x88, 0x99 }, units[2].Data.ToArray());
        Assert.True(units[2].IsKeyFrame);
    }

    [Fact]
    public void PacketizerAggregatesSpsAndPpsIntoStapA()
    {
        var units = H264AnnexBParser.Parse(
        [
            0, 0, 1, 0x67, 0x64,
            0, 0, 1, 0x68, 0xEE,
            0, 0, 1, 0x65, 0x88,
        ]);
        var packetizer = new H264RtpPacketizer(
            maximumPayloadLength: 1_200,
            payloadType: 96,
            synchronizationSource: 0x01020304,
            initialSequenceNumber: 10);

        var packets = packetizer.PacketizeAccessUnit(units, 90_000);

        Assert.Equal(2, packets.Count);
        Assert.Equal(24, packets[0].Payload[0] & 0x1F);
        Assert.Equal(2, BinaryPrimitives.ReadUInt16BigEndian(packets[0].Payload.AsSpan(1, 2)));
        Assert.Equal(7, packets[0].Payload[3] & 0x1F);
        Assert.False(packets[0].Marker);
        Assert.True(packets[1].Marker);
    }

    [Fact]
    public void PacketizerFragmentsLargeNalWithFuAAndWrapsSequenceNumber()
    {
        var nal = new byte[22];
        nal[0] = 0x65;
        for (var index = 1; index < nal.Length; index++) nal[index] = (byte)index;
        var packetizer = new H264RtpPacketizer(
            maximumPayloadLength: 10,
            payloadType: 102,
            synchronizationSource: 77,
            initialSequenceNumber: ushort.MaxValue);

        var packets = packetizer.PacketizeAccessUnit([new H264NalUnit(nal)], 1234);

        Assert.Equal(3, packets.Count);
        Assert.Equal(ushort.MaxValue, packets[0].SequenceNumber);
        Assert.Equal(0, packets[1].SequenceNumber);
        Assert.All(packets, packet => Assert.Equal(28, packet.Payload[0] & 0x1F));
        Assert.True((packets[0].Payload[1] & 0x80) != 0);
        Assert.True((packets[^1].Payload[1] & 0x40) != 0);
        Assert.True(packets[^1].Marker);

        var reconstructed = new List<byte> { (byte)((packets[0].Payload[0] & 0xE0) | 5) };
        foreach (var packet in packets) reconstructed.AddRange(packet.Payload[2..]);
        Assert.Equal(nal, reconstructed);
    }

    [Fact]
    public void SerializedRtpHeaderUsesNetworkByteOrder()
    {
        var packet = new RtpPacket(
            0x1234,
            0x01020304,
            0xAABBCCDD,
            96,
            true,
            [0x65, 0x99]);

        var bytes = packet.Serialize();

        Assert.Equal(0x80, bytes[0]);
        Assert.Equal(0xE0, bytes[1]);
        Assert.Equal(new byte[] { 0x12, 0x34 }, bytes[2..4]);
        Assert.Equal(new byte[] { 1, 2, 3, 4 }, bytes[4..8]);
        Assert.Equal(new byte[] { 0xAA, 0xBB, 0xCC, 0xDD }, bytes[8..12]);
        Assert.Equal(new byte[] { 0x65, 0x99 }, bytes[12..]);
    }

    [Fact]
    public void MediaFoundationTimeConvertsToNinetyKhzClock()
    {
        Assert.Equal(90_000u, H264RtpPacketizer.ToRtpTimestamp(10_000_000));
        Assert.Equal(46_000u, H264RtpPacketizer.ToRtpTimestamp(5_000_000, 1_000));
    }
}
