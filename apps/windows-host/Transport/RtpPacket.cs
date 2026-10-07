using System.Buffers.Binary;

namespace EdizRemote.Host.Transport;

internal sealed record RtpPacket(
    ushort SequenceNumber,
    uint Timestamp,
    uint SynchronizationSource,
    byte PayloadType,
    bool Marker,
    byte[] Payload)
{
    public const int FixedHeaderLength = 12;

    public byte[] Serialize()
    {
        if (PayloadType > 127)
        {
            throw new InvalidOperationException("RTP payload type 7 bit olmalıdır.");
        }

        var packet = new byte[checked(FixedHeaderLength + Payload.Length)];
        packet[0] = 0x80; // RTP version 2, no padding/extension/CSRC.
        packet[1] = (byte)((Marker ? 0x80 : 0) | PayloadType);
        BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(2, 2), SequenceNumber);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(4, 4), Timestamp);
        BinaryPrimitives.WriteUInt32BigEndian(packet.AsSpan(8, 4), SynchronizationSource);
        Payload.CopyTo(packet, FixedHeaderLength);
        return packet;
    }
}
