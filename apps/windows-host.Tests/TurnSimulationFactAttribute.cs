using Xunit;

namespace EdizRemote.Host.Tests;

internal sealed class TurnSimulationFactAttribute : FactAttribute
{
    public TurnSimulationFactAttribute()
    {
        if (!string.Equals(
                Environment.GetEnvironmentVariable("EDIZ_TURN_SIMULATION"),
                "1",
                StringComparison.Ordinal))
        {
            Skip = "Yerel coturn gerektiren TURN simülasyonu isteğe bağlıdır.";
        }
    }
}
