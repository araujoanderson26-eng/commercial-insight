using System.Text;
using System.Text.Json;

namespace ComercialInsight.Preparador;

internal static class MappingSettings
{
    internal static Mapping Load(string json)
    {
        var saved = JsonSerializer.Deserialize<Mapping>(json.TrimStart('\uFEFF'), PackageWriter.Json)
            ?? throw new InvalidDataException("O arquivo de mapeamento está vazio. Sua cópia foi preservada; abra Configurar mapeamento.");
        if (saved.Dimensions == null || saved.Metrics == null) throw new InvalidDataException("Mapeamento incompleto: faltam dimensões ou métricas. O arquivo original foi preservado.");
        return saved with { AllowEmptyTables = saved.AllowEmptyTables ?? [], SourceId = string.IsNullOrWhiteSpace(saved.SourceId) ? Guid.NewGuid().ToString() : saved.SourceId };
    }
    internal static void Save(string path, Mapping mapping)
    {
        string full = Path.GetFullPath(path), directory = Path.GetDirectoryName(full)!;
        Directory.CreateDirectory(directory);
        string temporary = full + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(mapping, PackageWriter.Json), new UTF8Encoding(false));
            if (File.Exists(full)) File.Replace(temporary, full, full + ".backup-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss") + "-" + Guid.NewGuid().ToString("N"));
            else File.Move(temporary, full);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    internal static void SelfTest()
    {
        const string legacy = "{\"modelName\":\"Modelo sintético\",\"factTable\":\"Fato\",\"dimensions\":{\"client\":{\"table\":\"Fato\",\"column\":\"Código\"}},\"metrics\":[{\"id\":\"revenue\",\"measure\":\"Receita\",\"column\":\"Valor\",\"scale\":2}],\"additivityReviewed\":true,\"reviewNote\":\"Revisão sintética\",\"sourceId\":\"9c690f1e-b944-426f-9f07-0016e1eb605c\",\"allowEmptyTables\":[]}";
        var original = Load(legacy);
        var copy = Load(JsonSerializer.Serialize(original, PackageWriter.Json));
        if (copy.SourceId != original.SourceId || copy.Metrics[0] != original.Metrics[0] || copy.Dimensions["client"] != original.Dimensions["client"] || copy.AllowEmptyTables.Count != 0)
            throw new InvalidOperationException("Mapping self-test: configuração alterada no roundtrip.");
        var older = Load(legacy.Replace(",\"sourceId\":\"9c690f1e-b944-426f-9f07-0016e1eb605c\",\"allowEmptyTables\":[]", ""));
        if (!Guid.TryParse(older.SourceId, out _) || older.AllowEmptyTables.Count != 0) throw new InvalidOperationException("Mapping self-test: compatibilidade anterior.");
        string directory = Path.Combine(Path.GetTempPath(), "ci-mapping-test-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        string file = Path.Combine(directory, "mapeamento.json");
        try
        {
            File.WriteAllText(file, legacy, new UTF8Encoding(false)); string hash = PackageWriter.Hash(File.ReadAllBytes(file));
            _ = Load(File.ReadAllText(file)); if (PackageWriter.Hash(File.ReadAllBytes(file)) != hash) throw new InvalidOperationException("Mapping self-test: leitura modificou arquivo.");
            Save(file, copy); if (Load(File.ReadAllText(file)).SourceId != original.SourceId) throw new InvalidOperationException("Mapping self-test: edição perdeu identidade.");
        }
        finally { foreach (string created in Directory.GetFiles(directory)) File.Delete(created); Directory.Delete(directory); }
    }
}
