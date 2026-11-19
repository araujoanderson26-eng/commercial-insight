using System.Globalization;
using System.Text.RegularExpressions;

namespace ComercialInsight.Preparador;

/// <summary>Analysis Services metadata clocks are UTC; an omitted DateTime.Kind must not apply the workstation offset.</summary>
internal static class TimestampPolicy
{
    private static readonly Regex IsoOffset = new(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$", RegexOptions.CultureInvariant);
    internal static DateTimeOffset FromTom(DateTime value) => new(value.Kind switch
    {
        DateTimeKind.Unspecified => DateTime.SpecifyKind(value, DateTimeKind.Utc),
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => value
    });
    internal static string FormatTom(DateTime value) => FromTom(value).ToString("O", CultureInfo.InvariantCulture);
    internal static DateTimeOffset ParseTimestamp(string text)
    {
        if (!IsoOffset.IsMatch(text) || !DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out var result))
            throw new InvalidDataException("Horário da origem/extração inválido; use ISO 8601 com fuso explícito.");
        return result;
    }
    internal static void ValidatePackage(string extractedAt, string? sourceUpdatedAt, string referenceDate, DateTimeOffset now)
    {
        var extracted = ParseTimestamp(extractedAt);
        if (sourceUpdatedAt != null && ParseTimestamp(sourceUpdatedAt).ToUnixTimeMilliseconds() > extracted.ToUnixTimeMilliseconds() + 300000)
            throw new InvalidDataException("Atualização da origem posterior à extração.");
        if (!DateOnly.TryParseExact(referenceDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _) ||
            string.CompareOrdinal(referenceDate, extractedAt[..10]) > 0)
            throw new InvalidDataException("Data de referência posterior à extração ou inválida.");
        if (extracted.ToUnixTimeMilliseconds() > now.ToUnixTimeMilliseconds() + 300000)
            throw new InvalidDataException("Horário de extração está no futuro.");
    }
    internal static void SelfTest()
    {
        var utc = new DateTime(2026,1,2,21,20,44,803,DateTimeKind.Utc).AddTicks(1234);
        var unspecified = DateTime.SpecifyKind(utc, DateTimeKind.Unspecified);
        if (FromTom(unspecified).UtcDateTime != utc || FromTom(utc).UtcDateTime != utc || FromTom(utc.ToLocalTime()).UtcDateTime != utc)
            throw new InvalidDataException("Normalização temporal TOM divergiu entre Unspecified, UTC e Local.");
        if (FromTom(unspecified).Ticks != utc.Ticks || FromTom(unspecified).Offset != TimeSpan.Zero ||
            ParseTimestamp(FormatTom(unspecified)).UtcTicks != utc.Ticks)
            throw new InvalidDataException("O horário TOM recebeu deslocamento ou perdeu precisão.");
        var now = new DateTimeOffset(2026,1,2,12,0,0,TimeSpan.Zero);
        void Check(string extraction, string? source, string day, bool valid)
        {
            bool passed;
            try { ValidatePackage(extraction,source,day,now); passed=true; }
            catch (InvalidDataException) { passed=false; }
            if (passed != valid) throw new InvalidDataException("Regressão da guarda temporal do pacote.");
        }
        Check("2026-01-02T12:00:00Z","2026-01-02T11:59:59Z","2026-01-02",true);
        Check("2026-01-02T12:00:00Z","2026-01-02T12:05:00Z","2026-01-02",true);
        Check("2026-01-02T12:00:00Z","2026-01-02T12:05:00.001Z","2026-01-02",false);
        Check("2026-01-02T12:00:00Z","2026-01-02T12:05:00.0000001Z","2026-01-02",true);
        Check("2026-01-02T12:05:00Z",null,"2026-01-02",true);
        Check("2026-01-02T12:05:00.001Z",null,"2026-01-02",false);
        Check("2026-01-02T12:00:00Z",null,"2026-01-03",false);
        Check("2026-01-02T12:00:00",null,"2026-01-02",false);
        Check("2026-01-02T12:00:00Z","2026-01-02T11:59:00","2026-01-02",false);
        // Worker compares referenceDate to the written ISO day, while instants use the explicit offset.
        ValidatePackage("2026-01-03T00:30:00+03:00","2026-01-02T21:29:00Z","2026-01-03",new(2026,1,2,21,30,0,TimeSpan.Zero));
    }
}
