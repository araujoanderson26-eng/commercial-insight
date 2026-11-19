using System.Globalization;
using System.Text;
using System.Text.Json;

namespace ComercialInsight.Preparador;

internal static class NativeSelfTests
{
    internal static void Run()
    {
        using var batchTest = new MemoryStream();
        var batchParts = PackageWriter.WriteParts(batchTest, Enumerable.Range(1,1001).Select(n => (object)new { row = n, values = new[] { "SINTÉTICO" } }), (part, values) => new { kind = "rows", table = "synthetic", part, rows = values }, maximumRows: 1000);
        if (batchParts.Count != 2 || batchParts[0].rows != 1000 || batchParts[1].rows != 1 || batchParts.Any(p => p.bytes > 1024 * 1024)) throw new InvalidDataException("Partes nativas de 1000 linhas inconsistentes.");
        string[] names = ["Sales", "Returns", "Customers", "Calendar", "Geo", "Municipalities", "Latitudes", "RepArea", "Measures"];
        var columns = new List<ColumnInfo>();
        void Columns(string table, params (string Name, string Type)[] fields) => columns.AddRange(fields.Select(f => new ColumnInfo(table, f.Name, f.Type, false, false, true, null, "", f.Name)));
        Columns("Sales", ("Date", "DateTime"), ("Client", "String"), ("Product", "String"), ("Category", "String"), ("State", "String"), ("Municipality", "String"), ("Amount", "Decimal"));
        Columns("Returns", ("Date", "DateTime"), ("Client", "String"), ("Product", "String"), ("Category", "String"), ("State", "String"), ("Amount", "Decimal"));
        Columns("Customers", ("Client", "String"), ("Representative", "String"), ("State", "String"));
        Columns("Calendar", ("Date", "DateTime")); Columns("Geo", ("State", "String"), ("Regional", "String"), ("Gerente", "String"));
        Columns("Municipalities", ("Name", "String")); Columns("Latitudes", ("State", "String")); Columns("RepArea", ("State", "String")); Columns("Measures", ("Dummy", "String"));
        var relationships = new List<object>();
        void Relation(string a, string ac, string b, string bc, string direction = "OneDirection", string cardinality = "One") =>
            relationships.Add(new { name = "r" + relationships.Count, isActive = true, fromTableName = a, fromColumn = ac, fromCardinality = "Many", toTableName = b, toColumn = bc, toCardinality = cardinality, crossFilteringBehavior = direction });
        Relation("Sales", "Date", "Calendar", "Date"); Relation("Returns", "Date", "Calendar", "Date");
        Relation("Sales", "Client", "Customers", "Client", "BothDirections", "Many"); Relation("Returns", "Client", "Customers", "Client", cardinality: "Many");
        Relation("Sales", "State", "Geo", "State"); Relation("Returns", "State", "Geo", "State"); Relation("Customers", "State", "Geo", "State");
        Relation("Sales", "Municipality", "Municipalities", "Name", "BothDirections", "Many");
        Relation("Customers", "State", "Latitudes", "State", "BothDirections", "Many");
        Relation("Latitudes", "State", "RepArea", "State", "BothDirections", "Many"); Relation("Latitudes", "State", "Geo", "State");
        var measures = new List<Measure> { new("Measures", "Gross", "SUM('Sales'[Amount])", ""), new("Measures", "Returned", "IF(ISBLANK(SUM('Returns'[Amount])),0,SUM('Returns'[Amount]))", ""), new("Measures", "Net", "[Gross]-[Returned]", ""), new("Measures", "Buyers", "DISTINCTCOUNT('Sales'[Client])", "") };
        var model = new ModelInfo("test", "SINTÉTICO NATIVO", "", null, columns, measures, relationships.ToArray(), [], names.ToList(), [], []);
        var mapping = new Mapping("SINTÉTICO NATIVO", "Sales", new Dictionary<string, Field> { ["date"] = new("Calendar", "Date"), ["region"] = new("Customers", "Representative"), ["client"] = new("Sales", "Client"), ["product"] = new("Sales", "Product"), ["category"] = new("Sales", "Category"), ["state"] = new("Sales", "State") }, [new("revenue", "Net", "Amount", 2), new("returns", "Returned", "WRONG_SAVED_COLUMN_PRESERVED", 2), new("buyers", "Buyers", null, 0)], true, "TESTE SINTÉTICO", Guid.Empty.ToString(), []);
        var plan = NativeModel.Recognize(model, mapping) ?? throw new InvalidDataException("Contrato nativo não reconhecido no teste sintético.");
        if (plan.Contract.Scale != 4 || plan.Contract.Returns.Table != NativeModel.TableId("Returns")) throw new InvalidDataException("Escala original ou tabela real de devoluções não reconhecida.");
        var rows = names.ToDictionary(n => n, _ => new List<object?[]>(), StringComparer.Ordinal);
        void Row(string table, params object?[] values) => rows[table].Add(values);
        Row("Sales", "2025-01-01", "C1", "P1", "X", "RS", "A", "100.0000"); Row("Sales", "2025-01-02", "C1", "P2", "Y", "RS", "A", "50.0000");
        Row("Sales", "2025-01-03", "C2", "P1", "X", "SP", "B", "200.0000"); Row("Sales", "2025-01-01", "C1", "P1", "X", "RS", "MISSING", "999.0000");
        Row("Sales", "2025-01-01", "C0", "P_ORPHAN", "X", "ZZ", "UNMAPPED", "7.0000");
        Row("Returns", "2025-01-01", "C1", "OTHER", "OTHER", "RS", "30.0000"); Row("Returns", "2025-02-01", "C1", "OTHER", "OTHER", "RS", "20.0000");
        Row("Returns", "2025-01-02", "C2", "OTHER", "OTHER", "SP", "10.0000"); Row("Returns", "2025-01-01", "C9", "OTHER", "OTHER", "RS", "77.0000");
        Row("Customers", "C1", "R1", "RS"); Row("Customers", "C1", "R1", "RS"); Row("Customers", "C2", "R2", "SP"); Row("Customers", "C9", "R9", "XX");
        for (int n = 0; n < 1001; n++) Row("Calendar", new DateOnly(2025,1,1).AddDays(n).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        Row("Geo", "RS", "SUL", "M1"); Row("Geo", "SP", "SUDESTE", "M2"); Row("Municipalities", "A"); Row("Municipalities", "B");
        foreach (string state in new[] { "RS", "SP" }) { Row("Latitudes", state); Row("RepArea", state); }
        var data = new NativeDataSet(plan);
        foreach (string name in names) foreach (var row in rows[name]) data.Add(NativeModel.TableId(name), columns.Where(c => c.Table == name).ToArray(), row);
        NativeResult Eval(params (string, string)[] filters) { var f = new Dictionary<string, string> { ["from"] = "2025-01-01", ["to"] = "2025-02-28" }; foreach (var (key, value) in filters) f[key] = value; return data.Evaluate(f); }
        void Expect(NativeResult actual, decimal? gross, decimal returned, decimal net, long? buyers)
        { if (actual.Gross != gross || actual.Returns != returned || actual.Revenue != net || actual.Buyers != buyers) throw new InvalidDataException("Semântica nativa divergiu no teste de fanout/M:M/filtros: " + JsonSerializer.Serialize(actual)); }
        Expect(Eval(), 1356, 137, 1219, 3); Expect(Eval(("client", "C0")), 7, 0, 7, 1); Expect(Eval(("product", "P1")), 1299, 60, 1239, 2); Expect(Eval(("product", "P2")), 50, 50, 0, 1);
        Expect(Eval(("region", "R1")), 1149, 50, 1099, 1); Expect(Eval(("state", "SP")), 200, 10, 190, 1); Expect(Eval(("manager", "M2")), 200, 10, 190, 1);
        Expect(Eval(("to", "2025-01-31")), 1356, 117, 1239, 3); Expect(Eval(("from", "2025-02-01")), null, 20, -20, null);
        // Round-trip the actual v2 stream, including the zero-row measure shell and every raw row.
        using var body = new MemoryStream(); var tables = new List<object>();
        foreach (string name in names)
        {
            string id = NativeModel.TableId(name); var cols = columns.Where(c => c.Table == name).ToArray();
            var parts = PackageWriter.WriteParts(body, rows[name].Select((values, i) => (object)new { row = i + 1, values }), (part, values) => new { kind = "rows", table = id, part, rows = values }, maximumRows: 1000);
            tables.Add(new { id, name, columns = cols.Select(c => new { name = c.Name, type = c.Type }).ToArray(), rowCount = rows[name].Count, sourceRowCount = rows[name].Count, allowEmpty = false, metadataOnly = name == "Measures", storageMode = "Import", partitions = Array.Empty<object>(), parts });
        }
        var recipe = plan.Contract.Recipes;
        var metrics = new Dictionary<string, NativeRecipe> { ["gross"] = recipe.Gross, ["returns"] = recipe.Returns, ["revenue"] = recipe.Revenue, ["buyers"] = recipe.Buyers };
        var controls = data.Contexts().SelectMany(c => metrics.Select(m => new { metric = m.Key, context = c.Context, filters = c.Filters, expected = data.Evaluate(c.Filters).Value(m.Key)?.ToString(m.Key == "buyers" ? "F0" : "F4", CultureInfo.InvariantCulture), dax = "EVALUATE ROW(\"value\",[" + m.Value.Measure + "]) /* TESTE SINTÉTICO */", referenceDate = "2026-11-18", tolerance = "0" })).ToArray();
        var manifest = new { kind = "manifest", format = "commercial-insight", formatVersion = 2, sourceId = "commercial-main", model = new { name = "SINTÉTICO NATIVO", id = "synthetic-native" }, extractedAt = "2026-11-18T12:00:00Z", sourceUpdatedAt = (string?)null, referenceDate = "2026-11-18", synthetic = true, stableExtraction = true, inventory = new { tables, measures, relationships, dependencies = Array.Empty<object>(), excluded = Array.Empty<object>() }, projection = new ProjectionInfo(data.FactRows, data.From!, data.To!, "TESTE SINTÉTICO com conjuntos relacionais.", ["date", "region", "client", "product", "category", "state"], []), nativeModel = plan.Contract, metrics = metrics.Select(m => new { id = m.Key, originalName = m.Value.Measure, dax = m.Value.Dax, unit = m.Key == "buyers" ? "count" : "money", kind = "native", scale = m.Key == "buyers" ? 0 : 4, status = "validated", supportedFilters = plan.Bindings.Keys.ToArray() }).ToArray(), controls };
        byte[] bytes = PackageWriter.Line(manifest).Concat(body.ToArray()).ToArray(); string file = Path.Combine(Path.GetTempPath(), "ci-native-selftest-" + Guid.NewGuid().ToString("N") + ".ci.ndjson");
        try
        {
            File.WriteAllBytes(file, bytes); var summary = PackageIntegrity.Validate(file);
            if (summary.FormatVersion != 2 || summary.RawRows != rows.Values.Sum(r => r.Count) || summary.ProjectionRows != 9) throw new InvalidDataException("Integridade v2 perdeu linhas do inventário.");
            bytes[^10] ^= 1; File.WriteAllBytes(file, bytes); bool rejected = false; try { PackageIntegrity.Validate(file); } catch (InvalidDataException) { rejected = true; } if (!rejected) throw new InvalidDataException("Corrupção nativa aceita.");
        }
        finally { if (File.Exists(file)) File.Delete(file); }
    }
}
