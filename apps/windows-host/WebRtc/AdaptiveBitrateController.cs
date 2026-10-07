namespace EdizRemote.Host.WebRtc;

internal sealed record AdaptiveBitrateObservation(
    double PacketLossPercent,
    int TargetBitrate,
    bool TargetChanged);

internal sealed class AdaptiveBitrateController
{
    private const double SevereLossThreshold = 8;
    private const double ModerateLossThreshold = 3;
    private const double GoodLossThreshold = 1;
    private readonly int _minimumBitrate;
    private readonly int _maximumBitrate;
    private readonly TimeSpan _minimumAdjustmentInterval;
    private int _consecutiveGoodReports;
    private DateTimeOffset? _lastAdjustmentAt;

    public AdaptiveBitrateController(
        int initialBitrate,
        int minimumBitrate = 1_000_000,
        TimeSpan? minimumAdjustmentInterval = null)
    {
        if (initialBitrate < 250_000)
            throw new ArgumentOutOfRangeException(nameof(initialBitrate));
        if (minimumBitrate < 250_000 || minimumBitrate > initialBitrate)
            throw new ArgumentOutOfRangeException(nameof(minimumBitrate));

        TargetBitrate = initialBitrate;
        _minimumBitrate = minimumBitrate;
        _maximumBitrate = initialBitrate;
        _minimumAdjustmentInterval = minimumAdjustmentInterval ?? TimeSpan.FromSeconds(2);
    }

    public int TargetBitrate { get; private set; }

    public AdaptiveBitrateObservation Observe(
        byte fractionLost,
        DateTimeOffset observedAt)
    {
        var packetLossPercent = Math.Round(fractionLost * 100d / 256d, 2);
        var canAdjust = _lastAdjustmentAt is null ||
                        observedAt - _lastAdjustmentAt >= _minimumAdjustmentInterval;
        var nextTarget = TargetBitrate;

        if (packetLossPercent >= SevereLossThreshold)
        {
            _consecutiveGoodReports = 0;
            if (canAdjust)
                nextTarget = Math.Max(_minimumBitrate, (int)(TargetBitrate * 0.70));
        }
        else if (packetLossPercent >= ModerateLossThreshold)
        {
            _consecutiveGoodReports = 0;
            if (canAdjust)
                nextTarget = Math.Max(_minimumBitrate, (int)(TargetBitrate * 0.85));
        }
        else if (packetLossPercent <= GoodLossThreshold)
        {
            _consecutiveGoodReports++;
            if (canAdjust && _consecutiveGoodReports >= 3)
            {
                var additiveIncrease = Math.Max(250_000, TargetBitrate / 10);
                nextTarget = Math.Min(_maximumBitrate, TargetBitrate + additiveIncrease);
                _consecutiveGoodReports = 0;
            }
        }
        else
        {
            _consecutiveGoodReports = 0;
        }

        var changed = nextTarget != TargetBitrate;
        if (changed)
        {
            TargetBitrate = nextTarget;
            _lastAdjustmentAt = observedAt;
        }

        return new AdaptiveBitrateObservation(packetLossPercent, TargetBitrate, changed);
    }
}
