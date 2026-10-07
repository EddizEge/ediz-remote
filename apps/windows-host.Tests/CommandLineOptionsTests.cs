using EdizRemote.Host;

namespace EdizRemote.Host.Tests;

public sealed class CommandLineOptionsTests
{
    [Fact]
    public void EmptyArgumentsShowHelp()
    {
        var options = CommandLineOptions.Parse([]);

        Assert.True(options.ShowHelp);
    }

    [Fact]
    public void ProbeParsesOutputAndDuration()
    {
        var options = CommandLineOptions.Parse(
            ["probe", "--output", "2", "--duration", "15"]);

        Assert.Equal(HostCommand.Probe, options.Command);
        Assert.Equal(2, options.OutputIndex);
        Assert.Equal(15, options.DurationSeconds);
        Assert.Null(options.FilePath);
    }

    [Fact]
    public void SnapshotRequiresAFile()
    {
        var exception = Assert.Throws<CommandLineException>(
            () => CommandLineOptions.Parse(["snapshot"]));

        Assert.Contains("--file zorunludur", exception.Message);
    }

    [Fact]
    public void EncodersCommandNeedsNoDisplayOptions()
    {
        var options = CommandLineOptions.Parse(["encoders"]);

        Assert.Equal(HostCommand.Encoders, options.Command);
        Assert.False(options.ShowHelp);
    }

    [Fact]
    public void EncoderProbeAcceptsAnOutput()
    {
        var options = CommandLineOptions.Parse(["encoder-probe", "--output", "1"]);

        Assert.Equal(HostCommand.EncoderProbe, options.Command);
        Assert.Equal(1, options.OutputIndex);
    }

    [Fact]
    public void EncodeProbeRequiresAnOutputFile()
    {
        var exception = Assert.Throws<CommandLineException>(
            () => CommandLineOptions.Parse(["encode-probe"]));

        Assert.Contains("encode-probe komutu için --file zorunludur", exception.Message);
    }

    [Fact]
    public void EncodeProbeParsesFileAndDisplay()
    {
        var options = CommandLineOptions.Parse(
            ["encode-probe", "--file", "frame.h264", "--output", "1"]);

        Assert.Equal(HostCommand.EncodeProbe, options.Command);
        Assert.Equal("frame.h264", options.FilePath);
        Assert.Equal(1, options.OutputIndex);
    }

    [Fact]
    public void StreamProbeParsesDurationWithoutAFile()
    {
        var options = CommandLineOptions.Parse(
            ["stream-probe", "--output", "1", "--duration", "7"]);

        Assert.Equal(HostCommand.StreamProbe, options.Command);
        Assert.Equal(1, options.OutputIndex);
        Assert.Equal(7, options.DurationSeconds);
        Assert.Null(options.FilePath);
    }

    [Theory]
    [InlineData("-1")]
    [InlineData("33")]
    [InlineData("monitor")]
    public void OutputMustBeInSupportedRange(string value)
    {
        Assert.Throws<CommandLineException>(
            () => CommandLineOptions.Parse(["probe", "--output", value]));
    }
}
