using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace ComercialInsight.Preparador;

internal enum ModelCommandKind { ReadOnly, Write, Unknown }
internal sealed record ModelCommandClassification(ModelCommandKind Kind, string Operation);
internal sealed record ModelCommand(int? Spid, string Text, DateTimeOffset? StartedAt, DateTimeOffset? EndedAt);
internal sealed record ConsistencySnapshot(string StructuralJson, string DataJson, string StructuralHash, string DataHash, string Fingerprint);

/// <summary>Classifies command syntax, not arbitrary string matches inside a query or completed session.</summary>
internal static class ConsistencyGuard
{
    private static readonly HashSet<string> WriteOperations = new(StringComparer.OrdinalIgnoreCase)
    { "Alter", "Create", "CreateOrReplace", "CreateOrReplaceDatabase", "Delete", "Process", "Refresh", "MergePartitions", "Merge", "Attach", "Detach", "Restore", "Synchronize", "CommitTransaction", "Insert", "Update", "Drop", "SetAuthContext" };
    private static readonly HashSet<string> ReadOperations = new(StringComparer.OrdinalIgnoreCase)
    { "Discover", "Subscribe", "Unsubscribe", "ClearCache", "Cancel", "GetSessionID", "GetSessionId", "Session", "BeginSession", "EndSession", "BeginTransaction", "RollbackTransaction" };
    private static readonly HashSet<string> XmlContainers = new(StringComparer.OrdinalIgnoreCase)
    { "Envelope", "Body", "Execute", "Command", "Batch", "Parallel", "Sequence", "Commands" };

    internal static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    internal static ModelCommandClassification Classify(string text)
    {
        string value = text.Trim();
        if (value.Length == 0) return new(ModelCommandKind.Unknown, "empty");
        try
        {
            if (value.StartsWith('<'))
            {
                using var reader = XmlReader.Create(new StringReader(value), new XmlReaderSettings
                { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 4 * 1024 * 1024 });
                var root = XDocument.Load(reader).Root;
                return root == null ? new(ModelCommandKind.Unknown, "empty-xml") : Xml(root);
            }
            if (value.StartsWith('{'))
            {
                using var json = JsonDocument.Parse(value, new JsonDocumentOptions { MaxDepth = 128 });
                return Tmsl(json.RootElement);
            }
        }
        catch (Exception ex) when (ex is XmlException or JsonException)
        { return new(ModelCommandKind.Unknown, "malformed-command"); }
        // SELECT covers DMV/MDX. DAX DEFINE/EVALUATE and DISCOVER rowset requests are read-only.
        if (Regex.IsMatch(value, @"^(?:EVALUATE|DEFINE|SELECT|WITH|DRILLTHROUGH|EXPLAIN)\b|^DISCOVER_[A-Z_]+\b|^TMSCHEMA_[A-Z_]+\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            return new(ModelCommandKind.ReadOnly, "query");
        if (Regex.IsMatch(value, @"^(?:ALTER|CREATE|DELETE|INSERT|UPDATE|DROP|PROCESS|REFRESH)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            return new(ModelCommandKind.Write, "write-statement");
        return new(ModelCommandKind.Unknown, "unrecognized-command");
    }

    private static ModelCommandClassification Xml(XElement node)
    {
        string operation = node.Name.LocalName;
        if (WriteOperations.Contains(operation)) return new(ModelCommandKind.Write, operation);
        if (ReadOperations.Contains(operation)) return new(ModelCommandKind.ReadOnly, operation);
        if (operation.Equals("Statement", StringComparison.OrdinalIgnoreCase)) return Classify(node.Value);
        if (!XmlContainers.Contains(operation)) return new(ModelCommandKind.Unknown, operation);
        var children = node.Elements().Where(x => !x.Name.LocalName.Equals("Properties", StringComparison.OrdinalIgnoreCase)).Select(Xml).ToArray();
        return Combine(children, operation);
    }

    private static ModelCommandClassification Tmsl(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return new(ModelCommandKind.Unknown, "invalid-tmsl");
        var classifications = new List<ModelCommandClassification>();
        foreach (var property in root.EnumerateObject())
        {
            if (WriteOperations.Contains(property.Name)) classifications.Add(new(ModelCommandKind.Write, property.Name));
            else if (property.Name.Equals("sequence", StringComparison.OrdinalIgnoreCase) && property.Value.ValueKind == JsonValueKind.Object && property.Value.TryGetProperty("operations", out var operations) && operations.ValueKind == JsonValueKind.Array)
                classifications.Add(Combine(operations.EnumerateArray().Select(Tmsl).ToArray(), "sequence"));
            else if (property.Name.Equals("statement", StringComparison.OrdinalIgnoreCase) && property.Value.ValueKind == JsonValueKind.String)
                classifications.Add(Classify(property.Value.GetString() ?? ""));
            else classifications.Add(new(ModelCommandKind.Unknown, "unrecognized-tmsl"));
        }
        return Combine(classifications.ToArray(), "tmsl");
    }

    private static ModelCommandClassification Combine(ModelCommandClassification[] children, string container)
    {
        var write = children.FirstOrDefault(x => x.Kind == ModelCommandKind.Write);
        if (write != null) return write;
        var unknown = children.FirstOrDefault(x => x.Kind == ModelCommandKind.Unknown);
        if (unknown != null) return unknown;
        return children.Length == 0 ? new(ModelCommandKind.Unknown, container + "-empty") : new(ModelCommandKind.ReadOnly, container + "-read-only");
    }

    internal static DateTimeOffset? ServerTime(object? raw)
    {
        if (raw == null || raw is DBNull) return null;
        if (raw is DateTime date)
        {
            if (date.Year < 2001) return null;
            return new DateTimeOffset(DateTime.SpecifyKind(date, DateTimeKind.Utc));
        }
        if (raw is DateTimeOffset timestamp) return timestamp.Year < 2001 ? null : timestamp.ToUniversalTime();
        return DateTimeOffset.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var value) && value.Year >= 2001 ? value : null;
    }

    internal static void AssertIdle(IEnumerable<ModelCommand> commands, ISet<int> ownSpids, DateTimeOffset extractionStarted, Action<string>? diagnostic)
    {
        foreach (var command in commands)
        {
            var classification = Classify(command.Text);
            bool own = command.Spid.HasValue && ownSpids.Contains(command.Spid.Value);
            string hash = Hash(command.Text);
            // DISCOVER_COMMANDS retains the last completed command. It is not evidence of ongoing processing.
            bool historical = command.EndedAt.HasValue && command.EndedAt.Value < extractionStarted;
            bool relevant = !historical && classification.Kind != ModelCommandKind.ReadOnly;
            string result = relevant ? "blocked" : historical ? "completed-before-extraction" : own ? "own-read-query" : "read-only";
            if (classification.Kind != ModelCommandKind.ReadOnly || own)
                diagnostic?.Invoke($"consistency.command result={result} spid={command.Spid?.ToString(CultureInfo.InvariantCulture) ?? "unknown"} own={own} kind={classification.Kind} operation={classification.Operation} started={command.StartedAt?.ToString("O") ?? "unknown"} ended={command.EndedAt?.ToString("O") ?? "running-or-unknown"} sha256={hash}");
            if (relevant)
                throw new InvalidOperationException(classification.Kind == ModelCommandKind.Write
                    ? $"Alteração real do modelo detectada ({classification.Operation}; sessão {command.Spid?.ToString(CultureInfo.InvariantCulture) ?? "não identificada"}). Aguarde a conclusão da alteração e tente novamente. Nenhum pacote novo será publicado."
                    : $"Não foi possível confirmar que um comando do modelo é somente leitura (sessão {command.Spid?.ToString(CultureInfo.InvariantCulture) ?? "não identificada"}; {classification.Operation}). Aguarde a conclusão e tente novamente. Consulte o log de diagnóstico; nenhum pacote novo será publicado.");
        }
    }

    internal static ConsistencySnapshot Snapshot(object structural, object data)
    {
        string structureJson = Canonical(JsonSerializer.SerializeToElement(structural, PackageWriter.Json));
        string dataJson = Canonical(JsonSerializer.SerializeToElement(data, PackageWriter.Json));
        string structureHash = Hash(structureJson), dataHash = Hash(dataJson);
        return new(structureJson, dataJson, structureHash, dataHash, Hash(structureHash + ":" + dataHash));
    }
    private static string Canonical(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(",", value.EnumerateObject().OrderBy(x => x.Name, StringComparer.Ordinal).Select(p => JsonSerializer.Serialize(p.Name) + ":" + Canonical(p.Value))) + "}",
        // Metadata collections are sets; ordinal fields remain part of each item when order is meaningful.
        JsonValueKind.Array => "[" + string.Join(",", value.EnumerateArray().Select(Canonical).Order(StringComparer.Ordinal)) + "]",
        _ => value.GetRawText()
    };
    internal static void AssertEquivalent(ConsistencySnapshot before, ConsistencySnapshot after, Action<string>? diagnostic)
    {
        if (before.Fingerprint == after.Fingerprint) { diagnostic?.Invoke($"consistency.snapshot result=stable structure_sha256={before.StructuralHash} data_sha256={before.DataHash}"); return; }
        string component = before.StructuralHash == after.StructuralHash ? "data-state" : "structure";
        using var left = JsonDocument.Parse(component == "structure" ? before.StructuralJson : before.DataJson);
        using var right = JsonDocument.Parse(component == "structure" ? after.StructuralJson : after.DataJson);
        var paths = Differences(left.RootElement, right.RootElement, "$root").Take(12).ToArray();
        diagnostic?.Invoke($"consistency.snapshot result=changed component={component} paths={string.Join(",", paths)} before_sha256={before.Fingerprint} after_sha256={after.Fingerprint}");
        throw new InvalidOperationException(component == "structure"
            ? "A estrutura do modelo mudou durante a extração. Pacote invalidado. Mantenha o PBIX sem edições e prepare novamente; consulte o log para os objetos alterados."
            : "O estado de processamento dos dados mudou durante a extração. Pacote invalidado. Aguarde a atualização terminar e prepare novamente; consulte o log para os objetos alterados.");
    }
    private static IEnumerable<string> Differences(JsonElement before, JsonElement after, string path)
    {
        if (before.GetRawText() == after.GetRawText()) yield break;
        if (before.ValueKind != after.ValueKind) { yield return path; yield break; }
        if (before.ValueKind == JsonValueKind.Object)
        {
            var keys = before.EnumerateObject().Select(p => p.Name).Union(after.EnumerateObject().Select(p => p.Name)).Order(StringComparer.Ordinal);
            foreach (string key in keys)
                if (!before.TryGetProperty(key, out var b) || !after.TryGetProperty(key, out var a)) yield return path + "." + key;
                else foreach (string difference in Differences(b, a, path + "." + key)) yield return difference;
        }
        else if (before.ValueKind == JsonValueKind.Array)
        {
            if (before.GetArrayLength() != after.GetArrayLength()) { yield return path + ".count"; yield break; }
            for (int i = 0; i < before.GetArrayLength(); i++) foreach (string difference in Differences(before[i], after[i], path + "[" + i + "]")) yield return difference;
        }
        else yield return path;
    }

    internal static void SelfTest()
    {
        static void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException("Consistency self-test: " + name); }
        string readBatch = "<Batch xmlns=\"http://schemas.microsoft.com/analysisservices/2003/engine\"><Statement>EVALUATE ROW(\"text\",\"&lt;Process&gt;\")</Statement></Batch>";
        // Captured Desktop/TOM command shape: querying metadata is wrapped in Batch/Discover.
        string metadataBatch = "<Batch xmlns=\"http://schemas.microsoft.com/analysisservices/2003/engine\"><Discover><RequestType>TMSCHEMA_TABLES</RequestType></Discover></Batch>";
        Check(Regex.IsMatch(metadataBatch, @"<(?:\w+:)?(?:Alter|Create|Delete|Process|Refresh|Batch)\b", RegexOptions.IgnoreCase), "legacy detector reproducibly flags metadata Batch");
        Check(Classify(metadataBatch).Kind == ModelCommandKind.ReadOnly, "captured TOM metadata shape is read-only");
        Check(Classify(readBatch).Kind == ModelCommandKind.ReadOnly, "XMLA read-only Batch is not processing");
        Check(Classify("<Batch><Process><Object/></Process></Batch>").Kind == ModelCommandKind.Write, "actual XMLA processing is blocked");
        Check(Classify("{\"sequence\":{\"operations\":[{\"refresh\":{\"type\":\"full\"}}]}}").Kind == ModelCommandKind.Write, "TMSL processing sequence");
        Check(Classify("EVALUATE ROW(\"refresh\",\"{\\\"alter\\\":1}\")").Kind == ModelCommandKind.ReadOnly, "DAX text is not executable TMSL");
        Check(Classify("<Batch><Process>").Kind == ModelCommandKind.Unknown, "malformed command fails closed");
        var start = new DateTimeOffset(2026, 11, 18, 12, 0, 0, TimeSpan.Zero);
        var own = new HashSet<int> { 10 };
        AssertIdle([new(10, "SELECT * FROM $SYSTEM.DISCOVER_COMMANDS", start, null), new(10, metadataBatch, start, start.AddSeconds(1)), new(11, readBatch, start, null), new(12, "<Batch><Alter/></Batch>", start.AddMinutes(-3), start.AddMinutes(-2))], own, start, null);
        static bool Blocks(Action action) { try { action(); return false; } catch (InvalidOperationException) { return true; } }
        Check(Blocks(() => AssertIdle([new(12, "{\"refresh\":{}}", start, null)], own, start, null)), "active write blocks");
        Check(Blocks(() => AssertIdle([new(12, "<Batch><Alter/></Batch>", start, start.AddSeconds(1))], own, start, null)), "completed write during extraction blocks");
        Check(Blocks(() => AssertIdle([new(12, "<Unknown/> ", start, null)], own, start, null)), "unknown active command blocks");
        var diagnostic = new List<string>();
        Check(Blocks(() => AssertIdle([new(12, "<Process><Object><DatabaseID>PRIVATE_MODEL_SENTINEL</DatabaseID></Object></Process>", start, null)], own, start, diagnostic.Add)), "writes produce diagnostic evidence");
        Check(diagnostic.Any(x => x.Contains("operation=Process", StringComparison.Ordinal)) && diagnostic.All(x => !x.Contains("PRIVATE_MODEL_SENTINEL", StringComparison.Ordinal)), "diagnostics preserve operation and hash without command contents");
        var a = Snapshot(new { columns = new[] { new { name = "B", type = "String" }, new { name = "A", type = "Int64" } } }, new { refreshed = "2026-11-18T10:00:00Z" });
        var reordered = Snapshot(new { columns = new[] { new { name = "A", type = "Int64" }, new { name = "B", type = "String" } } }, new { refreshed = "2026-11-18T10:00:00Z" });
        AssertEquivalent(a, reordered, null);
        Check(Blocks(() => AssertEquivalent(a, Snapshot(new { columns = new[] { new { name = "A", type = "Double" }, new { name = "B", type = "String" } } }, new { refreshed = "2026-11-18T10:00:00Z" }), null)), "schema mutation blocks");
        Check(Blocks(() => AssertEquivalent(a, Snapshot(new { columns = new[] { new { name = "A", type = "Int64" }, new { name = "B", type = "String" } } }, new { refreshed = "2026-11-18T10:01:00Z" }), null)), "persisted processing mutation blocks");
        Check(ServerTime(DBNull.Value) == null && ServerTime(DateTime.MinValue) == null, "idle time sentinel");
    }
}
