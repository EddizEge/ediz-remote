using System.Buffers.Binary;
using System.Security.Cryptography;

namespace EdizRemote.Host.Transport;

internal sealed class H264RtpPacketizer
{
    private const int StapAType = 24;
    private const int FuAType = 28;
    private readonly int _maximumPayloadLength;
    private readonly byte _payloadType;
    private readonly uint _synchronizationSource;
    private ushort _nextSequenceNumber;

    public H264RtpPacketizer(
        int maximumPayloadLength = 1_200,
        byte payloadType = 96,
        uint? synchronizationSource = null,
        ushort? initialSequenceNumber = null)
    {
        if (maximumPayloadLength < 3 || maximumPayloadLength > ushort.MaxValue)
        {
            throw new ArgumentOutOfRangeException(
                nameof(maximumPayloadLength),
                "RTP H.264 payload sınırı 3 ile 65535 arasında olmalıdır.");
        }
        if (payloadType > 127)
        {
            throw new ArgumentOutOfRangeException(
                nameof(payloadType),
                "RTP payload type 7 bit olmalıdır.");
        }

        _maximumPayloadLength = maximumPayloadLength;
        _payloadType = payloadType;
        _synchronizationSource = synchronizationSource ?? RandomUInt32();
        _nextSequenceNumber = initialSequenceNumber ?? RandomUInt16();
    }

    public IReadOnlyList<RtpPacket> PacketizeAccessUnit(
        IReadOnlyList<H264NalUnit> nalUnits,
        uint timestamp)
    {
        ArgumentNullException.ThrowIfNull(nalUnits);
        var packets = new List<RtpPacket>();
        var parameterSets = nalUnits.Where(unit => unit.IsParameterSet).ToArray();
        var parameterSetIndexes = new HashSet<H264NalUnit>(parameterSets);

        if (parameterSets.Length > 1 && CanAggregate(parameterSets))
        {
            packets.Add(CreatePacket(timestamp, false, BuildStapA(parameterSets)));
        }
        else
        {
            parameterSetIndexes.Clear();
        }

        foreach (var unit in nalUnits)
        {
            if (parameterSetIndexes.Contains(unit)) continue;
            PacketizeNalUnit(unit, timestamp, packets);
        }

        if (packets.Count > 0)
        {
            packets[^1] = packets[^1] with { Marker = true };
        }
        return packets;
    }

    public static uint ToRtpTimestamp(long mediaFoundationTime, uint baseTimestamp = 0)
    {
        if (mediaFoundationTime < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(mediaFoundationTime));
        }

        var ticks = checked((ulong)mediaFoundationTime);
        return unchecked(baseTimestamp + (uint)(ticks * 90_000UL / 10_000_000UL));
    }

    private void PacketizeNalUnit(
        H264NalUnit unit,
        uint timestamp,
        List<RtpPacket> packets)
    {
        if (unit.Data.IsEmpty) return;
        if (unit.Data.Length <= _maximumPayloadLength)
        {
            packets.Add(CreatePacket(timestamp, false, unit.Data.ToArray()));
            return;
        }

        var nal = unit.Data.Span;
        var nalHeader = nal[0];
        var fuIndicator = (byte)((nalHeader & 0xE0) | FuAType);
        var nalType = (byte)(nalHeader & 0x1F);
        var maximumFragmentLength = _maximumPayloadLength - 2;
        var offset = 1;
        var first = true;

        while (offset < nal.Length)
        {
            var fragmentLength = Math.Min(maximumFragmentLength, nal.Length - offset);
            var last = offset + fragmentLength >= nal.Length;
            var payload = new byte[fragmentLength + 2];
            payload[0] = fuIndicator;
            payload[1] = (byte)(nalType | (first ? 0x80 : 0) | (last ? 0x40 : 0));
            nal.Slice(offset, fragmentLength).CopyTo(payload.AsSpan(2));
            packets.Add(CreatePacket(timestamp, false, payload));
            offset += fragmentLength;
            first = false;
        }
    }

    private bool CanAggregate(IReadOnlyList<H264NalUnit> units)
    {
        var length = 1;
        foreach (var unit in units)
        {
            if (unit.Data.IsEmpty || unit.Data.Length > ushort.MaxValue) return false;
            length = checked(length + 2 + unit.Data.Length);
        }
        return length <= _maximumPayloadLength;
    }

    private byte[] BuildStapA(IReadOnlyList<H264NalUnit> units)
    {
        var maximumNalRefIdc = units.Max(unit => unit.Data.Span[0] & 0x60);
        var payloadLength = 1 + units.Sum(unit => 2 + unit.Data.Length);
        var payload = new byte[payloadLength];
        payload[0] = (byte)(maximumNalRefIdc | StapAType);
        var offset = 1;

        foreach (var unit in units)
        {
            BinaryPrimitives.WriteUInt16BigEndian(
                payload.AsSpan(offset, 2),
                checked((ushort)unit.Data.Length));
            offset += 2;
            unit.Data.Span.CopyTo(payload.AsSpan(offset));
            offset += unit.Data.Length;
        }
        return payload;
    }

    private RtpPacket CreatePacket(uint timestamp, bool marker, byte[] payload)
    {
        var packet = new RtpPacket(
            _nextSequenceNumber,
            timestamp,
            _synchronizationSource,
            _payloadType,
            marker,
            payload);
        _nextSequenceNumber++;
        return packet;
    }

    private static uint RandomUInt32()
    {
        return BitConverter.ToUInt32(RandomNumberGenerator.GetBytes(sizeof(uint)));
    }

    private static ushort RandomUInt16()
    {
        return BitConverter.ToUInt16(RandomNumberGenerator.GetBytes(sizeof(ushort)));
    }
}
