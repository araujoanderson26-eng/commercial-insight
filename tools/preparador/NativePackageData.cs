using System.Globalization;
using System.Text.Json;

namespace ComercialInsight.Preparador;

/// <summary>Reconstructs the recognized native contract and rechecks every DAX control from package rows.</summary>
internal sealed class NativePackageData(NativeDataSet data, Dictionary<string, ColumnInfo[]> columns)
{
    internal NativeDataSet Data => data;
    internal void Add(string table, JsonElement[] values) => data.Add(table, columns[table], values.Select(v => v.ValueKind switch { JsonValueKind.Null => null, JsonValueKind.String => (object?)v.GetString(), JsonValueKind.True => true, JsonValueKind.False => false, _ => throw new InvalidDataException("Tipo de célula nativa inválido.") }).ToArray());
    internal static NativePackageData Create(JsonElement manifest)
    {
        if (!manifest.TryGetProperty("nativeModel", out var native)) throw new InvalidDataException("Contrato relacional v2 ausente.");
        var contract = native.Deserialize<NativeContract>(PackageWriter.Json) ?? throw new InvalidDataException("Contrato nativo inválido.");
        if (contract.Kind != "panizzon-relational-v1" || contract.Scale is < 0 or > 6) throw new InvalidDataException("Contrato nativo não suportado.");
        var inventory = manifest.GetProperty("inventory"); var tableRows = inventory.GetProperty("tables").EnumerateArray().ToArray();
        var names = tableRows.ToDictionary(t => t.GetProperty("id").GetString()!, t => t.GetProperty("name").GetString()!, StringComparer.Ordinal);
        var columns = new Dictionary<string, ColumnInfo[]>(StringComparer.Ordinal);
        foreach (var table in tableRows)
        {
            string id = table.GetProperty("id").GetString()!, name = names[id];
            string Text(JsonElement c, string key) => c.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString()! : "";
            bool Flag(JsonElement c, string key) => c.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.True;
            columns.Add(id, table.GetProperty("columns").EnumerateArray().Select(c => new ColumnInfo(name, Text(c, "name"), Text(c, "type"), Flag(c, "hidden"), Flag(c, "isKey"), Flag(c, "nullable"), Text(c, "expression") is { Length: > 0 } e ? e : null, Text(c, "format"), Text(c, "sourceColumn"))).ToArray());
        }
        var measures = inventory.GetProperty("measures").Deserialize<List<Measure>>(PackageWriter.Json) ?? [];
        var relationships = inventory.GetProperty("relationships").EnumerateArray().Select(r => (object)r.Clone()).ToArray();
        var model = new ModelInfo("package-local", "package-local", "", null, columns.Values.SelectMany(c => c).ToList(), measures, relationships, [], names.Values.ToList(), [], []);
        string Name(string id) => names.TryGetValue(id, out var name) ? name : throw new InvalidDataException("Tabela nativa ausente no inventário: " + id);
        var mapping = new Mapping("package-local", Name(contract.Sales.Table), new Dictionary<string, Field> {
            ["date"] = new(Name(contract.Calendar.Table), contract.Calendar.Date),
            ["region"] = new(Name(contract.Customers.Table), contract.Customers.Representative),
            ["client"] = new(Name(contract.Sales.Table), contract.Sales.Client),
            ["product"] = new(Name(contract.Sales.Table), contract.Sales.Product),
            ["category"] = new(Name(contract.Sales.Table), contract.Sales.Category),
            ["state"] = new(Name(contract.Sales.Table), contract.Sales.State)
        }, [new("revenue", contract.Recipes.Revenue.Measure, null, contract.Scale), new("returns", contract.Recipes.Returns.Measure, null, contract.Scale), new("buyers", contract.Recipes.Buyers.Measure, null, 0)], true, "Validação local do contrato explícito.", "package-local", []);
        var recognized = NativeModel.Recognize(model, mapping) ?? throw new InvalidDataException("O DAX original do pacote não confirma o contrato nativo.");
        if (JsonSerializer.Serialize(recognized.Contract, PackageWriter.Json) != JsonSerializer.Serialize(contract, PackageWriter.Json)) throw new InvalidDataException("As referências, expressões ou relações do contrato nativo divergem do inventário original.");
        foreach (var table in tableRows.Where(t => t.TryGetProperty("metadataOnly", out var marker) && marker.ValueKind == JsonValueKind.True))
        {
            string id = table.GetProperty("id").GetString()!, name = names[id];
            if (recognized.TableNames.ContainsKey(id) || table.GetProperty("rowCount").GetInt64() != 0 || !measures.Any(m => m.Table == name)) throw new InvalidDataException("Marcador de tabela apenas de metadados inválido.");
            foreach (JsonElement relation in relationships)
                if (relation.GetProperty("fromTableName").GetString() == name || relation.GetProperty("toTableName").GetString() == name) throw new InvalidDataException("Tabela apenas de metadados participa de relacionamento.");
            foreach (var column in columns[id])
            {
                string quoted = "'" + name.Replace("'", "''") + "'[" + column.Name.Replace("]", "]]") + "]", plain = name + "[" + column.Name.Replace("]", "]]") + "]";
                if (measures.Select(m => m.Expression).Concat(model.Columns.Select(c => c.Expression ?? "")).Any(e => e.Contains(quoted, StringComparison.OrdinalIgnoreCase) || e.Contains(plain, StringComparison.OrdinalIgnoreCase))) throw new InvalidDataException("Coluna física de tabela apenas de metadados possui dependência.");
            }
        }
        var metrics = manifest.GetProperty("metrics").EnumerateArray().ToArray();
        foreach (var pair in new[] { ("gross", contract.Recipes.Gross), ("returns", contract.Recipes.Returns), ("revenue", contract.Recipes.Revenue), ("buyers", contract.Recipes.Buyers) })
        {
            var matches = metrics.Where(m => m.GetProperty("id").GetString() == pair.Item1).ToArray();
            if (matches.Length != 1) throw new InvalidDataException("Métrica nativa obrigatória ausente.");
            var metric = matches[0];
            if (metric.GetProperty("kind").GetString() != "native" || metric.GetProperty("status").GetString() != "validated" || metric.GetProperty("originalName").GetString() != pair.Item2.Measure || metric.GetProperty("dax").GetString() != pair.Item2.Dax || metric.GetProperty("scale").GetInt32() != (pair.Item1 == "buyers" ? 0 : contract.Scale)) throw new InvalidDataException("Catálogo nativo diverge do DAX e da escala do contrato.");
        }
        return new(new NativeDataSet(recognized), columns);
    }
    internal void ValidateControls(JsonElement manifest)
    {
        var controls = manifest.GetProperty("controls").EnumerateArray().ToArray();
        var cached = new Dictionary<string, NativeResult>(StringComparer.Ordinal);
        foreach (var control in controls)
        {
            var filters = control.GetProperty("filters").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!, StringComparer.Ordinal);
            string key = JsonSerializer.Serialize(filters.OrderBy(p => p.Key, StringComparer.Ordinal).ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal), PackageWriter.Json);
            if (!cached.TryGetValue(key, out var result)) { result = data.Evaluate(filters); cached.Add(key, result); }
            string metric = control.GetProperty("metric").GetString()!;
            decimal? expected = control.GetProperty("expected").ValueKind == JsonValueKind.Null ? null : decimal.Parse(control.GetProperty("expected").GetString()!, CultureInfo.InvariantCulture);
            if (control.GetProperty("tolerance").GetString() != "0" || result.Value(metric) != expected) throw new InvalidDataException("Controle DAX nativo não concilia com o pacote: " + metric + "/" + control.GetProperty("context").GetString());
        }
        var requiredContexts = data.Contexts();
        foreach (string metric in new[] { "gross", "returns", "revenue", "buyers" })
        {
            foreach (var context in requiredContexts.Where(c => c.Context is "total" or "month"))
                if (!controls.Any(c => c.GetProperty("metric").GetString() == metric && c.GetProperty("context").GetString() == context.Context && c.GetProperty("filters").GetProperty("from").GetString() == context.Filters["from"] && c.GetProperty("filters").GetProperty("to").GetString() == context.Filters["to"])) throw new InvalidDataException("Controles não cobrem todos os meses e totais das métricas nativas.");
            foreach (string dimension in new[] { "region", "client", "product", "category", "state", "regional" }.Concat(data.Contract.Regions.Manager == null ? [] : new[] { "manager" }))
                if (!controls.Any(c => c.GetProperty("metric").GetString() == metric && c.GetProperty("context").GetString() == dimension && c.GetProperty("filters").TryGetProperty(dimension, out _))) throw new InvalidDataException("Controle de dimensão nativa ausente: " + dimension);
            if (!controls.Any(c => c.GetProperty("metric").GetString() == metric && c.GetProperty("filters").EnumerateObject().Count() > 3)) throw new InvalidDataException("Controle combinado de escopo ausente.");
        }
    }
}
