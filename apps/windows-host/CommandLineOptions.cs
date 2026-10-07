namespace EdizRemote.Host;

internal enum HostCommand
{
    List,
    Encoders,
    EncoderProbe,
    EncodeProbe,
    StreamProbe,
    Probe,
    Snapshot,
}

internal sealed record CommandLineOptions(
    HostCommand Command,
    int OutputIndex,
    int DurationSeconds,
    string? FilePath,
    bool ShowHelp)
{
    public const string HelpText = """
        Ediz Remote Windows Host

        Kullanım:
          EdizRemote.Host list
          EdizRemote.Host encoders
          EdizRemote.Host encoder-probe [--output 0]
          EdizRemote.Host encode-probe --file <dosya.h264> [--output 0] [--duration 10]
          EdizRemote.Host stream-probe [--output 0] [--duration 5]
          EdizRemote.Host probe [--output 0] [--duration 5]
          EdizRemote.Host snapshot --file <dosya.bmp> [--output 0] [--duration 5]

        Komutlar:
          list       DXGI tarafından görülen masaüstü ekranlarını JSON olarak listeler.
          encoders   Media Foundation donanım H.264 encoder'larını JSON olarak listeler.
          encoder-probe  Seçilen GPU ile encoder cihaz yöneticisi bağlantısını doğrular.
          encode-probe   Bir masaüstü karesini GPU üzerinde H.264 bitstream'e dönüştürür.
          stream-probe   Kesintisiz GPU encode ve RTP paketleme hattını bellekte ölçer.
          probe      Kareleri bellekte yakalar ve içerik kaydetmeden performansı ölçer.
          snapshot   Tek kareyi 32-bit BMP olarak kaydeder.
        """;

    public static CommandLineOptions Parse(string[] args)
    {
        if (args.Length == 0 || args[0] is "--help" or "-h" or "help")
        {
            return new(HostCommand.List, 0, 5, null, true);
        }

        var command = args[0].ToLowerInvariant() switch
        {
            "list" => HostCommand.List,
            "encoders" => HostCommand.Encoders,
            "encoder-probe" => HostCommand.EncoderProbe,
            "encode-probe" => HostCommand.EncodeProbe,
            "stream-probe" => HostCommand.StreamProbe,
            "probe" => HostCommand.Probe,
            "snapshot" => HostCommand.Snapshot,
            _ => throw new CommandLineException($"Bilinmeyen komut: {args[0]}"),
        };

        var output = 0;
        var duration = 5;
        string? file = null;
        for (var index = 1; index < args.Length; index++)
        {
            var argument = args[index];
            switch (argument)
            {
                case "--output":
                    output = ParseInteger(ReadValue(args, ref index, argument), argument, 0, 32);
                    break;
                case "--duration":
                    duration = ParseInteger(ReadValue(args, ref index, argument), argument, 1, 300);
                    break;
                case "--file":
                    file = ReadValue(args, ref index, argument);
                    break;
                default:
                    throw new CommandLineException($"Bilinmeyen seçenek: {argument}");
            }
        }

        if (command is HostCommand.Snapshot or HostCommand.EncodeProbe &&
            string.IsNullOrWhiteSpace(file))
        {
            throw new CommandLineException(
                $"{args[0]} komutu için --file zorunludur.");
        }
        if (command is not HostCommand.Snapshot and not HostCommand.EncodeProbe &&
            file is not null)
        {
            throw new CommandLineException(
                "--file yalnızca snapshot ve encode-probe komutlarıyla kullanılabilir.");
        }

        return new(command, output, duration, file, false);
    }

    private static string ReadValue(string[] args, ref int index, string argument)
    {
        index++;
        if (index >= args.Length || args[index].StartsWith('-'))
        {
            throw new CommandLineException($"{argument} için bir değer gerekli.");
        }
        return args[index];
    }

    private static int ParseInteger(string value, string argument, int minimum, int maximum)
    {
        if (!int.TryParse(value, out var parsed) || parsed < minimum || parsed > maximum)
        {
            throw new CommandLineException(
                $"{argument} {minimum} ile {maximum} arasında bir tam sayı olmalıdır.");
        }
        return parsed;
    }
}

internal sealed class CommandLineException(string message) : Exception(message);
