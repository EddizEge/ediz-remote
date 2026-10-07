using EdizRemote.Host.Encoding;

namespace EdizRemote.Host.Tests;

public sealed class HardwareEncoderCatalogTests
{
    [Fact]
    public void H264SubtypeMatchesMediaFoundationFourCcGuid()
    {
        Assert.Equal(
            new Guid("34363248-0000-0010-8000-00AA00389B71"),
            HardwareEncoderCatalog.H264Subtype);
    }

    [Fact]
    public void Nv12SubtypeMatchesMediaFoundationFourCcGuid()
    {
        Assert.Equal(
            new Guid("3231564E-0000-0010-8000-00AA00389B71"),
            MediaFoundationH264Encoder.Nv12Subtype);
    }

    [Theory]
    [InlineData(new byte[] { 0, 0, 1, 103 }, true)]
    [InlineData(new byte[] { 4, 0, 0, 0, 103 }, false)]
    [InlineData(new byte[] { 9, 0, 0, 0, 1, 101 }, true)]
    public void AnnexBStartCodeDetectionIsBounded(byte[] data, bool expected)
    {
        Assert.Equal(expected, MediaFoundationH264Encoder.ContainsAnnexBStartCode(data));
    }

    [Fact]
    public void AnnexBInspectorReadsAudSpsPpsAndIdrTypes()
    {
        var data = new byte[]
        {
            0, 0, 0, 1, 0x09, 0x10,
            0, 0, 0, 1, 0x67, 0x64,
            0, 0, 1, 0x68, 0xEE,
            0, 0, 0, 1, 0x65, 0x88,
        };

        Assert.Equal(
            new[] { 9, 7, 8, 5 },
            MediaFoundationH264Encoder.ReadAnnexBNalUnitTypes(data));
    }
}
