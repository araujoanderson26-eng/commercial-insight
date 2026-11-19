using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ComercialInsight.Preparador;

/// <summary>Lossless raw inventory plus a verified, explicit relational analytical contract.</summary>
internal sealed class NativeExport(ModelSource source, Mapping mapping, ModelInfo before, NativePlan plan, Action<string> log)
{
    private static readonly string[] Dimensions = ["date", "region", "client", "product", "category", "state"];
    private static string Table(string name) => "'" + name.Replace("'", "''") + "'";
    private static string Col(Field field) => Table(field.Table) + "[" + field.Column.Replace("]", "]]") + "]";
    private static string Str(string value) => "\"" + value.Replace("\"", "\"\"") + "\"";
    internal void Export(string target)
    {
        using var publication = new AtomicPackageFile(target, log);
        var tableInfo = new List<TableInfo>(); var excluded = new List<object>
        {
            new { type = "connection-details", reason = "Strings de conexão, credenciais, fontes M e roles de segurança não são exportadas. Acesso ao pacote não cria permissões no aplicativo." },
            new { type = "internal-row-number", reason = "Colunas RowNumber internas do mecanismo não fazem parte dos dados de negócio." }
        };
        var data = new NativeDataSet(plan);
        using (var output = new FileStream(publication.BodyPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
        {
            foreach (string table in before.TableNames)
            {
                source.AssertIdle(); log("Exportando integralmente " + table + "...");
                var columns = before.Columns.Where(c => c.Table == table).ToArray();
                long expected = Count(table); bool emptyAllowed = mapping.AllowEmptyTables?.Contains(table) == true;
                bool metadataOnly = expected == 0 && IsMetadataOnly(table, columns);
                if (columns.Length == 0 && !metadataOnly) throw new InvalidOperationException("Tabela sem colunas exportáveis: " + table + ". Nenhum dado foi descartado.");
                if (expected == 0 && !emptyAllowed && !metadataOnly) throw new InvalidOperationException("Tabela de negócio vazia na origem sem autorização no perfil: " + table + ". O perfil salvo foi preservado.");
                string id = NativeModel.TableId(table); long rows = 0;
                string query = "EVALUATE SELECTCOLUMNS(" + Table(table) + "," + string.Join(",", columns.Select((c, i) => Str("c" + i) + "," + Col(new(table, c.Name)))) + ")";
                IEnumerable<object> Rows()
                {
                    if (metadataOnly) yield break;
                    foreach (var values in source.Read(query))
                    {
                        rows++;
                        if (values.Length != columns.Length) throw new InvalidDataException("Quantidade de colunas mudou durante a leitura de " + table);
                        data.Add(id, columns, values);
                        yield return new { row = rows, values = values.Select(Cell).ToArray() };
                    }
                }
                var parts = PackageWriter.WriteParts(output, Rows(), (part, values) => new { kind = "rows", table = id, part, rows = values }, maximumRows: 1000);
                long after = Count(table);
                if (expected != rows || after != expected) throw new InvalidOperationException("Contagem divergente em " + table + ": origem=" + expected + ", exportação=" + rows + ", nova leitura=" + after + ". Pacote invalidado.");
                tableInfo.Add(new(id, table, columns.Select(c => (object)new { name = c.Name, type = c.Type, hidden = c.Hidden, isKey = c.IsKey, nullable = c.Nullable, expression = c.Expression, format = c.Format, sourceColumn = c.SourceColumn }).ToArray(),
                    rows, expected, emptyAllowed, "Import", before.Partitions[table], new { schema = before.TableMetadata[table], desktopSessionDatabaseId = before.Id, desktopSessionDatabaseName = before.Name }, parts, metadataOnly));
                if (metadataOnly) excluded.Add(new { type = "metadata-only-table", table = id, reason = "Tabela de medidas confirmada com zero linhas físicas, sem vínculo relacional ou referência às colunas físicas. Todo o esquema e as medidas são preservados; nenhuma linha de negócio existe para exportar." });
                log(table + ": " + rows.ToString("N0", CultureInfo.InvariantCulture) + " linhas completas, " + parts.Count + " partes.");
            }
            long expectedFacts = tableInfo.Where(t => t.id == plan.Contract.Sales.Table || t.id == plan.Contract.Returns.Table).Sum(t => t.rowCount);
            if (data.FactRows != expectedFacts || data.From == null || data.To == null) throw new InvalidOperationException("O contrato relacional não preservou a cobertura integral das duas tabelas de fatos.");
            log("Conciliando DAX real com as relações muitos-para-muitos: bruto, devoluções, líquido e clientes; todos os meses e cortes de escopo...");
            string referenceDate = DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var controls = BuildControls(data, referenceDate);
            if (referenceDate != DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)) throw new InvalidOperationException("A data de referência mudou durante a conciliação. Prepare novamente.");
            source.AssertIdle(); var afterSnapshot = source.Inspect(); source.AssertUnchanged(before, afterSnapshot);
            var recipe = plan.Contract.Recipes;
            var recipes = new Dictionary<string, NativeRecipe>(StringComparer.Ordinal) { ["gross"] = recipe.Gross, ["returns"] = recipe.Returns, ["revenue"] = recipe.Revenue, ["buyers"] = recipe.Buyers };
            var supportedFilters = plan.Bindings.Keys.ToArray();
            var metrics = recipes.Select(pair => (object)new { id = pair.Key, originalName = pair.Value.Measure, dax = pair.Value.Dax, unit = pair.Key == "buyers" ? "count" : "money", kind = "native", scale = pair.Key == "buyers" ? 0 : plan.Contract.Scale, status = "validated", supportedFilters }).ToList();
            metrics.Add(new { id = "margin", originalName = "margin", dax = "", unit = "percent", kind = "unavailable", scale = 0, status = "unavailable", supportedFilters, reason = "Sem receita de margem reconciliada neste contrato. As expressões originais foram preservadas no inventário." });
            var manifest = new
            {
                kind = "manifest", format = "commercial-insight", formatVersion = 2, sourceId = "commercial-main",
                model = new { name = mapping.ModelName, id = mapping.SourceId }, extractedAt = DateTimeOffset.UtcNow.ToString("O"), sourceUpdatedAt = before.UpdatedAt, referenceDate, synthetic = false, stableExtraction = true,
                inventory = new { tables = tableInfo, measures = before.Measures, relationships = before.Relationships, dependencies = before.Dependencies, excluded },
                projection = new ProjectionInfo(data.FactRows, data.From, data.To, "Contrato relacional nativo: vendas e devoluções integrais em tabelas próprias; filtros propagados por conjuntos distintos de chaves, sem junção monetária nem deduplicação dos fatos. Receita líquida = bruto - devoluções uma única vez.", Dimensions, []),
                nativeModel = plan.Contract, metrics, controls
            };
            byte[] header = PackageWriter.Line(manifest);
            log("Manifesto: " + header.Length.ToString("N0", CultureInfo.InvariantCulture) + " bytes; " + controls.Count + " controles DAX exatos.");
            if (header.Length > 1024 * 1024) throw new InvalidOperationException("O manifesto relacional excede 1 MiB (" + header.Length + " bytes). Nenhum conteúdo foi truncado; amplie o formato/importador antes da publicação.");
            output.Flush(true);
            using var final = new FileStream(publication.TemporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            final.Write(header); output.Dispose();
            using var body = File.OpenRead(publication.BodyPath); body.CopyTo(final, 1024 * 1024); final.Flush(true);
        }
        var validation = publication.Publish();
        log("Integridade local aprovada: " + validation.Tables + " tabelas, " + validation.RawRows + " linhas de origem, " + validation.ProjectionRows + " linhas de fatos relacionais, " + validation.Bytes + " bytes. SHA-256 " + validation.Sha256 + ".");
    }
    private long Count(string table) => Convert.ToInt64(source.Read("EVALUATE ROW(\"n\",COUNTROWS(" + Table(table) + "))").Single()[0], CultureInfo.InvariantCulture);
    private bool IsMetadataOnly(string table, ColumnInfo[] columns)
    {
        if (!before.Measures.Any(m => m.Table == table) || plan.TableNames.Values.Contains(table, StringComparer.Ordinal)) return false;
        foreach (var relationship in before.Relationships)
        {
            var r = JsonSerializer.SerializeToElement(relationship, PackageWriter.Json);
            if (r.TryGetProperty("fromTableName", out var from) && from.GetString() == table || r.TryGetProperty("toTableName", out var to) && to.GetString() == table) return false;
        }
        var expressions = before.Measures.Select(m => m.Expression).Concat(before.Columns.Where(c => c.Expression != null).Select(c => c.Expression!));
        foreach (var column in columns)
        {
            string quoted = Col(new(table, column.Name)), simple = table + "[" + column.Name.Replace("]", "]]") + "]";
            if (expressions.Any(e => e.Contains(quoted, StringComparison.OrdinalIgnoreCase) || e.Contains(simple, StringComparison.OrdinalIgnoreCase))) return false;
        }
        return true;
    }
    private List<object> BuildControls(NativeDataSet data, string referenceDate)
    {
        var result = new List<object>(); int done = 0;
        var r = plan.Contract.Recipes;
        var metrics = new Dictionary<string, NativeRecipe> { ["gross"] = r.Gross, ["returns"] = r.Returns, ["revenue"] = r.Revenue, ["buyers"] = r.Buyers };
        foreach (var context in data.Contexts())
        {
            source.AssertIdle(); var actual = data.Evaluate(context.Filters);
            string date = Col(plan.Bindings["date"]);
            string DateDax(string day) => "DATE(" + day[..4] + "," + int.Parse(day.Substring(5, 2), CultureInfo.InvariantCulture) + "," + int.Parse(day.Substring(8, 2), CultureInfo.InvariantCulture) + ")";
            var clauses = new List<string> { "FILTER(ALL(" + date + ")," + date + ">=" + DateDax(context.Filters["from"]) + "&&" + date + "<" + DateDax(context.Filters["to"]) + "+1)" };
            foreach (var cut in context.Filters.Where(c => c.Key is not ("from" or "to"))) clauses.Add("TREATAS({" + Str(cut.Value) + "}," + Col(plan.Bindings[cut.Key]) + ")");
            string call = string.Join(",", clauses);
            foreach (var metric in metrics)
            {
                string dax = "EVALUATE ROW(\"value\",CALCULATE([" + metric.Value.Measure.Replace("]", "]]") + "]," + call + "))";
                object? answer = source.Read(dax).Single()[0];
                decimal? expected = answer == null || answer is DBNull ? null : Convert.ToDecimal(answer, CultureInfo.InvariantCulture);
                int scale = metric.Key == "buyers" ? 0 : plan.Contract.Scale;
                if (expected != null && decimal.Truncate(expected.Value * NativeDataSet.Pow10(scale)) != expected.Value * NativeDataSet.Pow10(scale)) throw new InvalidOperationException("O DAX retornou precisão superior à escala validada: " + metric.Key);
                decimal? observed = actual.Value(metric.Key);
                if (expected != observed) throw new InvalidOperationException("Divergência na conciliação " + metric.Key + "/" + context.Context + " " + JsonSerializer.Serialize(context.Filters) + ": dados extraídos=" + (observed?.ToString(CultureInfo.InvariantCulture) ?? "BLANK") + "; Power BI=" + (expected?.ToString(CultureInfo.InvariantCulture) ?? "BLANK") + ". Nenhum pacote foi publicado.");
                result.Add(new { metric = metric.Key, context = context.Context, filters = context.Filters, expected = expected?.ToString("F" + scale, CultureInfo.InvariantCulture), dax, referenceDate, tolerance = "0" });
            }
            if (++done % 10 == 0) log(done + " contextos DAX conciliados (4 métricas por contexto).");
        }
        log(result.Count + " controles DAX conciliados exatamente com todas as linhas relacionais extraídas.");
        return result;
    }
    internal static object? Cell(object? value)
    {
        object? result = PackageWriter.Cell(value);
        if (value is double or float && result is string number && number.IndexOfAny(['E', 'e']) >= 0) return ExpandExponent(number);
        return result;
    }
    private static string ExpandExponent(string text)
    {
        int e = text.IndexOfAny(['E', 'e']); if (e < 0) return text;
        string mantissa = text[..e]; bool negative = mantissa.StartsWith('-'); if (negative) mantissa = mantissa[1..];
        int exponent = int.Parse(text[(e + 1)..], CultureInfo.InvariantCulture);
        int dot = mantissa.IndexOf('.'); if (dot < 0) dot = mantissa.Length;
        string digits = mantissa.Replace(".", ""); int position = dot + exponent;
        string expanded = position <= 0 ? "0." + new string('0', -position) + digits : position >= digits.Length ? digits + new string('0', position - digits.Length) : digits[..position] + "." + digits[position..];
        return negative ? "-" + expanded : expanded;
    }
}
