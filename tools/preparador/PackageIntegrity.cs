using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ComercialInsight.Preparador;

internal sealed record PackageValidationSummary(string Format, int FormatVersion, string ModelName,
    int Tables, long RawRows, long ProjectionRows, int Parts, long Bytes, string Sha256);

/// <summary>Sequential validation of formats v1/v2; never buffers the whole package.</summary>
internal static class PackageIntegrity
{
    private const int MaximumLineBytes = 1024 * 1024;
    private static readonly Regex Hash = new("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex DecimalText = new(@"^-?(0|[1-9]\d*)(\.\d+)?$", RegexOptions.CultureInvariant);
    private static readonly string[] MetricIds = ["gross", "revenue", "margin", "buyers", "returns"];
    private static readonly string[] Dimensions = ["date", "region", "client", "product", "category", "state"];
    private sealed record Part(int Index, int Rows, int Bytes, string Sha256);
    private sealed record Table(string Id, string Name, string[] Types, string[] Columns, long Rows, Part[] Parts);

    internal static PackageValidationSummary Validate(string path)
    {
        try { return ValidateCore(path); }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or OverflowException)
        { throw Invalid("O pacote contém um campo ausente, inválido ou incompatível com o formato declarado."); }
    }
    private static PackageValidationSummary ValidateCore(string path)
    {
        using var reader = new Lines(path);
        byte[] header = reader.Next() ?? throw Invalid("Pacote vazio; manifesto ausente.");
        if (header.AsSpan().StartsWith(new byte[] { 0xef, 0xbb, 0xbf })) throw Invalid("O pacote deve ser UTF-8 sem BOM.");
        using var manifest = Parse(header);
        var m = manifest.RootElement;
        RequireObject(m, ["kind", "format", "formatVersion", "sourceId", "model", "extractedAt", "sourceUpdatedAt", "referenceDate", "synthetic", "stableExtraction", "inventory", "projection", "metrics", "controls", "nativeModel"], ["nativeModel"]);
        Equal(Text(m, "kind"), "manifest"); Equal(Text(m, "format"), "commercial-insight"); Equal(Text(m, "sourceId"), "commercial-main");
        int version = checked((int)Number(m, "formatVersion"));
        if (version is not (1 or 2) || m.GetProperty("stableExtraction").ValueKind != JsonValueKind.True) throw Invalid("Versão do formato ou extração estável inválida.");
        if (m.GetProperty("synthetic").ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw Invalid("Identificação de dados sintéticos ausente.");
        Timestamp(Text(m, "extractedAt", 100));
        if (m.GetProperty("sourceUpdatedAt").ValueKind != JsonValueKind.Null) Timestamp(Text(m, "sourceUpdatedAt", 100));
        Day(Text(m, "referenceDate", 10));
        TimestampPolicy.ValidatePackage(Text(m, "extractedAt", 100), m.GetProperty("sourceUpdatedAt").ValueKind == JsonValueKind.Null ? null : Text(m, "sourceUpdatedAt", 100), Text(m, "referenceDate", 10), DateTimeOffset.UtcNow);
        var model = m.GetProperty("model"); RequireObject(model, ["name", "id"]); string modelName = Text(model, "name"); _ = Text(model, "id");
        var inventory = m.GetProperty("inventory"); RequireObject(inventory, ["tables", "measures", "relationships", "dependencies", "excluded"]);
        foreach (string key in new[] { "measures", "relationships", "dependencies", "excluded" }) Array(inventory, key, 0, int.MaxValue);
        var ids = new HashSet<string>(StringComparer.Ordinal); var names = new HashSet<string>(StringComparer.Ordinal);
        var tables = new List<Table>();
        foreach (var t in Array(inventory, "tables", 1, 1000))
        {
            string id = Text(t, "id"), name = Text(t, "name");
            if (id == "__projection__" || !ids.Add(id) || !names.Add(name)) throw Invalid("Tabela duplicada ou identificador reservado no inventário.");
            long rows = Number(t, "rowCount");
            if (rows < 0 || Number(t, "sourceRowCount") != rows) throw Invalid($"Tabela {name}: contagem da origem ausente ou divergente.");
            bool emptyAllowed = t.GetProperty("allowEmpty").ValueKind == JsonValueKind.True;
            bool metadataOnly = version == 2 && t.TryGetProperty("metadataOnly", out var marker) && marker.ValueKind == JsonValueKind.True;
            if (metadataOnly && (rows != 0 || !Array(inventory, "measures", 0, int.MaxValue).Any(measure => Text(measure, "table") == name))) throw Invalid("Tabela declarada apenas metadados sem uma tabela de medidas realmente vazia.");
            if (t.GetProperty("allowEmpty").ValueKind is not (JsonValueKind.True or JsonValueKind.False) || (rows == 0 && !emptyAllowed && !metadataOnly)) throw Invalid($"Tabela {name}: condição vazia não autorizada.");
            _ = Text(t, "storageMode"); Array(t, "partitions", 0, int.MaxValue);
            var columns = Array(t, "columns", 1, 2000); var columnNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (var c in columns) if (!columnNames.Add(Text(c, "name"))) throw Invalid($"Tabela {name}: coluna duplicada.");
            tables.Add(new Table(id, name, columns.Select(c => Text(c, "type")).ToArray(), columns.Select(c => Text(c, "name")).ToArray(), rows, Parts(t, rows, version == 2 ? 1000 : 100)));
        }
        var projection = m.GetProperty("projection"); RequireObject(projection, ["rowCount", "from", "to", "grain", "dimensions", "parts"]);
        long factCount = Number(projection, "rowCount"); if (factCount < 1) throw Invalid("Projeção sem fatos.");
        string first = Text(projection, "from", 10), last = Text(projection, "to", 10); Day(first); Day(last);
        if (string.CompareOrdinal(first, last) > 0) throw Invalid("Período da projeção inválido.");
        _ = Text(projection, "grain", 2000);
        foreach (var dimension in Array(projection, "dimensions", 1, 6)) if (!Dimensions.Contains(dimension.GetString())) throw Invalid("Dimensão desconhecida.");
        var factParts = Parts(projection, version == 2 ? 0 : factCount); var scales = Metrics(m, version); Controls(m, version);
        var nativeData = version == 2 ? NativePackageData.Create(m) : null;
        int parts = 0; long rawRows = 0;
        foreach (var table in tables)
        {
            long cursor = 0;
            foreach (var part in table.Parts)
            {
                using var document = ReadPart(reader, part); var root = document.RootElement;
                RequireObject(root, ["kind", "table", "part", "rows"]); Equal(Text(root, "kind"), "rows"); Equal(Text(root, "table"), table.Id);
                if (Number(root, "part") != part.Index) throw Invalid($"Tabela {table.Name}: índice da parte divergente.");
                var rows = Array(root, "rows", part.Rows, part.Rows);
                foreach (var row in rows)
                {
                    RequireObject(row, ["row", "values"]); if (Number(row, "row") != ++cursor) throw Invalid($"Tabela {table.Name}: sequência inválida na linha {cursor}.");
                    var values = Array(row, "values", table.Columns.Length, table.Columns.Length);
                    for (int c = 0; c < values.Length; c++) Cell(values[c], table.Types[c], $"Tabela {table.Name}, linha {cursor}, coluna {table.Columns[c]}");
                    if (nativeData != null) nativeData.Add(table.Id, values);
                }
                parts++;
            }
            if (cursor != table.Rows) throw Invalid($"Tabela {table.Name}: contagem incompleta."); rawRows += cursor;
        }
        long factCursor = 0; string? observedFirst = null, observedLast = null;
        foreach (var part in factParts)
        {
            using var document = ReadPart(reader, part); var root = document.RootElement; RequireObject(root, ["kind", "part", "rows"]); Equal(Text(root, "kind"), "facts");
            if (Number(root, "part") != part.Index) throw Invalid("Projeção: índice de parte divergente.");
            foreach (var row in Array(root, "rows", part.Rows, part.Rows))
            {
                RequireObject(row, ["row", "date", "region", "client", "product", "category", "state", "values"]);
                if (Number(row, "row") != ++factCursor) throw Invalid("Projeção: sequência de linhas inválida.");
                string date = Text(row, "date", 10); Day(date);
                if (string.CompareOrdinal(date, first) < 0 || string.CompareOrdinal(date, last) > 0) throw Invalid($"Projeção, linha {factCursor}: data fora da cobertura.");
                observedFirst = observedFirst == null || string.CompareOrdinal(date, observedFirst) < 0 ? date : observedFirst;
                observedLast = observedLast == null || string.CompareOrdinal(date, observedLast) > 0 ? date : observedLast;
                foreach (string key in Dimensions.Where(x => x != "date")) _ = Text(row, key, 200, key is "category" or "state");
                var values = row.GetProperty("values"); if (values.ValueKind != JsonValueKind.Object) throw Invalid("Componentes monetários inválidos.");
                foreach (var value in values.EnumerateObject())
                    if (value.Name.Length is < 1 or > 200 || (value.Value.ValueKind != JsonValueKind.Null && (value.Value.ValueKind != JsonValueKind.String || value.Value.GetString()!.Length > 100))) throw Invalid("Componente inválido na projeção.");
                foreach (var (component, scale) in scales)
                {
                    if (!values.TryGetProperty(component, out var value)) throw Invalid($"Linha {factCursor}: componente {component} ausente.");
                    if (value.ValueKind != JsonValueKind.Null) ExactDecimal(value.GetString()!, scale);
                }
            }
            parts++;
        }
        if (nativeData != null) { nativeData.ValidateControls(m); factCursor = nativeData.Data.FactRows; observedFirst = nativeData.Data.From; observedLast = nativeData.Data.To; }
        if (factCursor != factCount || observedFirst != first || observedLast != last) throw Invalid("Contagem ou período observado da projeção não confere.");
        if (reader.Next() != null) throw Invalid("O pacote contém partes ou conteúdo adicionais após o final declarado.");
        return new PackageValidationSummary("commercial-insight", version, modelName, tables.Count, rawRows, factCursor, parts, reader.Bytes, reader.Digest());
    }

    private static Dictionary<string, int> Metrics(JsonElement manifest, int version)
    {
        var ids = new HashSet<string>(); var scales = new Dictionary<string, int>(StringComparer.Ordinal); bool revenue = false;
        foreach (var metric in Array(manifest, "metrics", 1, 100))
        {
            RequireObject(metric, ["id", "originalName", "dax", "unit", "kind", "component", "numerator", "denominator", "scale", "status", "reason", "supportedFilters"], ["component", "numerator", "denominator", "reason"]);
            string id = Text(metric, "id"), kind = Text(metric, "kind"), status = Text(metric, "status"), unit = Text(metric, "unit");
            if (!MetricIds.Contains(id) || !ids.Add(id) || !new[] { "sum", "distinctClient", "ratio", "native", "unavailable" }.Contains(kind) || !new[] { "validated", "pending", "unavailable" }.Contains(status)) throw Invalid("Catálogo de métricas inválido.");
            string expectedUnit = id == "buyers" ? "count" : id == "margin" ? "percent" : "money"; if (unit != expectedUnit) throw Invalid("Unidade de métrica incompatível.");
            _ = Text(metric, "originalName"); _ = Text(metric, "dax", 32000, true);
            int scale = checked((int)Number(metric, "scale")); if (scale is < 0 or > 6) throw Invalid("Escala de métrica inválida.");
            var filters = Array(metric, "supportedFilters", 0, version == 2 ? 8 : 6).Select(x => x.GetString()).ToArray(); if (filters.Any(f => !Dimensions.Contains(f) && !(version == 2 && f is "regional" or "manager"))) throw Invalid("Filtro de métrica desconhecido.");
            if (status != "validated" || kind == "unavailable") continue;
            if (Dimensions.Any(d => !filters.Contains(d))) throw Invalid("Métrica sem suporte aos seis filtros da projeção.");
            if (id == "revenue") revenue = true;
            if (version == 2 && kind != "native" || version == 1 && kind == "native") throw Invalid("Implementação incompatível com a versão do pacote.");
            foreach (string key in kind == "sum" ? new[] { "component" } : kind == "ratio" ? new[] { "numerator", "denominator" } : System.Array.Empty<string>())
            {
                string component = Text(metric, key); if (scales.TryGetValue(component, out int previous) && previous != scale) throw Invalid("Componente com escalas incompatíveis."); scales[component] = scale;
            }
            if (kind == "distinctClient" && id != "buyers") throw Invalid("Contagem distinta incompatível com a métrica.");
        }
        if (!revenue) throw Invalid("Faturamento essencial sem implementação validada.");
        return scales;
    }
    private static void Controls(JsonElement manifest, int version)
    {
        foreach (var control in Array(manifest, "controls", 6, 10000))
        {
            RequireObject(control, ["metric", "context", "filters", "expected", "dax", "referenceDate", "tolerance"]);
            if (!MetricIds.Contains(Text(control, "metric")) || !new[] { "total", "month", "region", "client", "product", "state", "category", "regional", "manager" }.Contains(Text(control, "context"))) throw Invalid("Controle DAX com métrica ou contexto inválido.");
            var filters = control.GetProperty("filters"); RequireObject(filters, ["from", "to", "region", "client", "product", "category", "state", "regional", "manager"], ["region", "client", "product", "category", "state", "regional", "manager"]);
            string from = Text(filters, "from", 10), to = Text(filters, "to", 10); Day(from); Day(to); if (string.CompareOrdinal(from, to) > 0) throw Invalid("Período do controle DAX inválido.");
            foreach (var filter in filters.EnumerateObject()) if (filter.Name is not ("from" or "to")) _ = Text(filters, filter.Name, 200, true);
            _ = Text(control, "dax", 32000); Day(Text(control, "referenceDate", 10));
            if (Text(control, "referenceDate", 10) != Text(manifest, "referenceDate", 10)) throw Invalid("Data de referência do controle divergente.");
            if (control.GetProperty("expected").ValueKind != JsonValueKind.Null && !DecimalText.IsMatch(Text(control, "expected", 100))) throw Invalid("Resultado esperado inválido.");
            string tolerance = Text(control, "tolerance", 30); if (!decimal.TryParse(tolerance, NumberStyles.AllowDecimalPoint | NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out decimal n) || n is < 0m or > 0.01m) throw Invalid("Tolerância do controle inválida.");
        }
    }
    private static Part[] Parts(JsonElement owner, long expected, int maximumRows = 100)
    {
        var result = new List<Part>(); long count = 0;
        foreach (var part in Array(owner, "parts", 0, int.MaxValue))
        {
            RequireObject(part, ["index", "rows", "bytes", "sha256"]); int index = checked((int)Number(part, "index")), rows = checked((int)Number(part, "rows")), bytes = checked((int)Number(part, "bytes")); string hash = Text(part, "sha256", 64);
            if (index != result.Count + 1 || (rows < 1 || rows > maximumRows) || bytes is < 1 or > MaximumLineBytes || !Hash.IsMatch(hash)) throw Invalid("Parte com índice, contagem, tamanho ou checksum inválido.");
            result.Add(new Part(index, rows, bytes, hash)); count += rows;
        }
        if (count != expected) throw Invalid("Contagem de partes não coincide com a tabela/projeção."); return result.ToArray();
    }
    private static JsonDocument ReadPart(Lines reader, Part part)
    {
        byte[] bytes = reader.Next() ?? throw Invalid("Pacote incompleto; parte declarada ausente.");
        if (bytes.Length != part.Bytes || Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != part.Sha256) throw Invalid("Checksum ou tamanho da parte divergente.");
        return Parse(bytes);
    }
    private static JsonDocument Parse(byte[] bytes)
    {
        try { return JsonDocument.Parse(new UTF8Encoding(false, true).GetString(bytes)); }
        catch (Exception ex) when (ex is JsonException or DecoderFallbackException) { throw Invalid("JSON/UTF-8 inválido no pacote."); }
    }
    private static void Cell(JsonElement value, string type, string location)
    {
        if (value.ValueKind == JsonValueKind.Null) return;
        bool valid = type.ToLowerInvariant() switch {
            "boolean" or "bool" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
            "int64" or "integer" or "whole number" => value.ValueKind == JsonValueKind.String && Regex.IsMatch(value.GetString()!, @"^-?\d+$"),
            "decimal" or "double" or "currency" or "decimalnumber" or "decimal number" => value.ValueKind == JsonValueKind.String && DecimalText.IsMatch(value.GetString()!),
            "datetime" or "date" => value.ValueKind == JsonValueKind.String && DateTime.TryParse(value.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _),
            _ => value.ValueKind == JsonValueKind.String,
        };
        if (!valid) throw Invalid(location + ": tipo incompatível com o inventário.");
    }
    private static void ExactDecimal(string text, int scale)
    {
        if (!DecimalText.IsMatch(text)) throw Invalid("Decimal não canônico na projeção."); string[] parts = text.TrimStart('-').Split('.'); string fraction = parts.Length == 2 ? parts[1] : "";
        if (fraction.Length > scale && fraction[scale..].Any(c => c != '0')) throw Invalid("Perda de precisão na projeção.");
        var integer = BigInteger.Parse(parts[0], CultureInfo.InvariantCulture) * BigInteger.Pow(10, scale) + BigInteger.Parse((fraction[..Math.Min(fraction.Length, scale)].PadRight(scale, '0')).Length == 0 ? "0" : fraction[..Math.Min(fraction.Length, scale)].PadRight(scale, '0'), CultureInfo.InvariantCulture);
        if (integer > 9007199254740991L) throw Invalid("Decimal fora da faixa inteira segura do importador.");
    }
    private static void RequireObject(JsonElement value, string[] keys, string[]? optional = null)
    {
        if (value.ValueKind != JsonValueKind.Object) throw Invalid("Objeto JSON obrigatório ausente.");
        var observed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject()) if (!keys.Contains(property.Name) || !observed.Add(property.Name)) throw Invalid("Campo desconhecido ou duplicado no pacote: " + property.Name);
        foreach (string key in keys) if (!(optional?.Contains(key) ?? false) && !observed.Contains(key)) throw Invalid("Campo obrigatório ausente: " + key);
    }
    private static JsonElement[] Array(JsonElement owner, string key, int minimum, int maximum)
    {
        var value = owner.GetProperty(key); if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() < minimum || value.GetArrayLength() > maximum) throw Invalid("Quantidade de elementos inválida em " + key + "."); return value.EnumerateArray().ToArray();
    }
    private static string Text(JsonElement owner, string key, int maximum = 200, bool empty = false)
    {
        var value = owner.GetProperty(key); if (value.ValueKind != JsonValueKind.String) throw Invalid("Texto obrigatório inválido: " + key); string text = value.GetString()!;
        if ((!empty && text.Length == 0) || text.Length > maximum) throw Invalid("Comprimento inválido: " + key); return text;
    }
    private static long Number(JsonElement owner, string key) { if (!owner.GetProperty(key).TryGetInt64(out long value) || Math.Abs((decimal)value) > 9007199254740991m) throw Invalid("Inteiro inválido: " + key); return value; }
    private static void Equal(string value, string expected) { if (value != expected) throw Invalid("Identificação do pacote incompatível: " + expected); }
    private static void Day(string text) { if (!DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) throw Invalid("Data inválida no pacote."); }
    private static void Timestamp(string text) => _ = TimestampPolicy.ParseTimestamp(text);
    private static InvalidDataException Invalid(string message) => new(message);

    internal static byte[] TestFixture(string name = "SINTÉTICO DE TESTE")
    {
        byte[] Line(object value) => Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value, PackageWriter.Json) + "\n");
        byte[] raw = Line(new { kind = "rows", table = "t-test", part = 1, rows = new[] { new { row = 1, values = new object?[] { "0001", "São João", null, "100.00" } } } });
        byte[] fact = Line(new { kind = "facts", part = 1, rows = new[] { new { row = 1, date = "2026-01-01", region = "Sul", client = "0001", product = "P", category = "C", state = "SP", values = new { revenue = "100.00" } } } });
        object PartOf(byte[] line) => new { index = 1, rows = 1, bytes = line.Length, sha256 = Convert.ToHexString(SHA256.HashData(line)).ToLowerInvariant() };
        var controls = new[] { "total", "month", "region", "client", "product", "state" }.Select(context => {
            var filters = new Dictionary<string, string> { ["from"] = "2026-01-01", ["to"] = "2026-01-01" };
            if (context is not ("total" or "month")) filters[context] = context == "region" ? "Sul" : context == "client" ? "0001" : context == "product" ? "P" : "SP";
            return new { metric = "revenue", context, filters, expected = "100.00", dax = "EVALUATE ROW(\"value\",[Receita]) /* TESTE SINTÉTICO */", referenceDate = "2026-11-18", tolerance = "0" };
        }).ToArray();
        byte[] header = Line(new {
            kind = "manifest", format = "commercial-insight", formatVersion = 1, sourceId = "commercial-main", model = new { name, id = "synthetic-integrity-test" },
            extractedAt = "2026-11-18T12:00:00Z", sourceUpdatedAt = (string?)null, referenceDate = "2026-11-18", synthetic = true, stableExtraction = true,
            inventory = new { tables = new[] { new { id = "t-test", name = "Tabela sintética", columns = new[] { new { name = "Código", type = "String" }, new { name = "Nome", type = "String" }, new { name = "Nulo", type = "String" }, new { name = "Valor", type = "Decimal" } }, rowCount = 1, sourceRowCount = 1, allowEmpty = false, storageMode = "Import", partitions = System.Array.Empty<object>(), parts = new[] { PartOf(raw) } } }, measures = System.Array.Empty<object>(), relationships = System.Array.Empty<object>(), dependencies = System.Array.Empty<object>(), excluded = System.Array.Empty<object>() },
            projection = new { rowCount = 1, from = "2026-01-01", to = "2026-01-01", grain = "Uma linha sintética", dimensions = Dimensions, parts = new[] { PartOf(fact) } },
            metrics = new[] { new { id = "revenue", originalName = "Receita", dax = "SUM(Fatos[Valor])", unit = "money", kind = "sum", component = "revenue", scale = 2, status = "validated", supportedFilters = Dimensions } }, controls
        });
        return header.Concat(raw).Concat(fact).ToArray();
    }
    internal static void SelfTest()
    {
        string path = Path.Combine(Path.GetTempPath(), "ci-integrity-test-" + Guid.NewGuid().ToString("N") + ".ci.ndjson"); byte[] valid = TestFixture();
        try
        {
            File.WriteAllBytes(path, valid); var summary = Validate(path);
            if (summary.RawRows != 1 || summary.ProjectionRows != 1 || summary.Parts != 2 || summary.Sha256 != Convert.ToHexString(SHA256.HashData(valid)).ToLowerInvariant()) throw Invalid("Validação de pacote íntegro divergiu.");
            void Reject(byte[] data)
            {
                File.WriteAllBytes(path, data); bool rejected = false;
                try { Validate(path); } catch (InvalidDataException) { rejected = true; }
                if (!rejected) throw Invalid("Pacote incompleto/corrompido foi aceito.");
            }
            Reject(valid[..^1]); Reject(valid[..^50]);
            byte[] changed = valid.ToArray(); changed[^10] ^= 1; Reject(changed);
            Reject(valid.Concat(Encoding.UTF8.GetBytes("{}\n")).ToArray());
            byte[] TemporalFixture(Action<System.Text.Json.Nodes.JsonObject> change)
            {
                int newline = System.Array.IndexOf(valid,(byte)10);
                var node = System.Text.Json.Nodes.JsonNode.Parse(Encoding.UTF8.GetString(valid,0,newline))!.AsObject();
                change(node);
                return Encoding.UTF8.GetBytes(node.ToJsonString(PackageWriter.Json)+"\n").Concat(valid[(newline+1)..]).ToArray();
            }
            Reject(TemporalFixture(node => node["sourceUpdatedAt"] = "2026-11-18T12:06:00Z"));
            Reject(TemporalFixture(node => node["extractedAt"] = DateTimeOffset.UtcNow.AddMinutes(6).ToString("O",CultureInfo.InvariantCulture)));
            Reject(TemporalFixture(node => node["referenceDate"] = "2026-11-19"));
            Reject(TemporalFixture(node => node["controls"]![0]!["referenceDate"] = "2026-11-17"));
        }
        finally { if (File.Exists(path)) File.Delete(path); }
    }

    private sealed class Lines : IDisposable
    {
        private readonly FileStream input; private readonly IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        private readonly byte[] buffer = new byte[65536]; private int offset, length; internal long Bytes { get; private set; }
        internal Lines(string path) => input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, buffer.Length, FileOptions.SequentialScan);
        internal byte[]? Next()
        {
            using var line = new MemoryStream();
            for (;;)
            {
                if (offset == length) { length = input.Read(buffer); offset = 0; if (length == 0) { if (line.Length != 0) throw Invalid("Pacote incompleto: última parte sem LF."); return null; } hash.AppendData(buffer, 0, length); Bytes += length; }
                byte value = buffer[offset++]; line.WriteByte(value); if (line.Length > MaximumLineBytes) throw Invalid("Manifesto ou parte excede 1 MiB."); if (value == 10) return line.ToArray();
            }
        }
        internal string Digest() => Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        public void Dispose() { hash.Dispose(); input.Dispose(); }
    }
}
