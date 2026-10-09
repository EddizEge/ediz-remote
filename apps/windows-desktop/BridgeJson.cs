using System.Text.Json;

namespace EdizRemote.Desktop;

/// <summary>
/// WebView2 köprüsünden gelen JSON için istisnasız okuma yardımcıları.
/// System.Text.Json eşlenmemiş surrogate kaçışını (ör. <c>"\ud800"</c>) metne
/// çevirirken <see cref="InvalidOperationException"/> fırlatır. Uzak eşin
/// ürettiği bu tür bir değer köprü ayrıştırıcılarında geçersiz girdi sayılır;
/// Try* sözleşmesi istisnayla delinmez.
/// </summary>
internal static class BridgeJson
{
    /// <summary>
    /// <see cref="JsonElement.TryGetProperty(string, out JsonElement)"/> aranan adı
    /// diğer anahtarlarla karşılaştırırken kaçışlı bir anahtardaki eşlenmemiş
    /// surrogate'ta istisna fırlatabilir; nesne olmayan değerde de fırlatır.
    /// </summary>
    internal static bool TryGetProperty(
        JsonElement element,
        string propertyName,
        out JsonElement value)
    {
        value = default;
        if (element.ValueKind != JsonValueKind.Object) return false;
        try
        {
            return element.TryGetProperty(propertyName, out value);
        }
        catch (InvalidOperationException)
        {
            value = default;
            return false;
        }
    }

    internal static bool TryGetString(JsonElement element, out string value)
    {
        value = string.Empty;
        if (element.ValueKind != JsonValueKind.String) return false;
        try
        {
            value = element.GetString() ?? string.Empty;
            return true;
        }
        catch (InvalidOperationException)
        {
            value = string.Empty;
            return false;
        }
    }

    internal static bool TryGetName(JsonProperty property, out string name)
    {
        try
        {
            name = property.Name;
            return true;
        }
        catch (InvalidOperationException)
        {
            name = string.Empty;
            return false;
        }
    }
}
