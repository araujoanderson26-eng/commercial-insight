using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ComercialInsight.Preparador;

internal sealed record SemanticIssue(string Field, string Message);

/// <summary>
/// Finds demonstrably incompatible mappings before any file is created. This is a
/// deliberately small recognizer, not a DAX evaluator. Unknown expressions still
/// require the existing full local/D1 controls and are never rewritten by name.
/// </summary>
internal static class SemanticPreflight
{
    private const string ColumnReference = @"(?:(?:'(?<table>(?:[^']|'')+)'|(?<plain>[\p{L}_][\p{L}\p{N}_]*))\s*)?\[(?<column>(?:[^\]]|\]\])+)\]";
    private static readonly Regex Sum = new(@"\bSUM\s*\(\s*" + ColumnReference + @"\s*\)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex Reference = new(ColumnReference, RegexOptions.CultureInvariant);
    private static readonly Regex VolatileCalendar = new(@"\b(TODAY|NOW|UTCNOW|UTCTODAY|DATESYTD|TOTALYTD|DATESMTD|TOTALMTD)\s*\(", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    internal static void Validate(ModelInfo model, Mapping mapping, Action<string> diagnostic)
    {
        var issues = Analyze(model.Measures, model.Columns, mapping);
        issues.AddRange(DimensionIssues(model.Relationships, mapping));
        foreach (var issue in issues) diagnostic($"Mapeamento incompatível — {issue.Field}: {issue.Message}");
        if (issues.Count != 0)
            throw new InvalidOperationException("O mapeamento salvo foi preservado, mas contém regras incompatíveis com a projeção atual:" + Environment.NewLine +
                string.Join(Environment.NewLine, issues.Select(i => $"• {i.Field}: {i.Message}")) + Environment.NewLine +
                "Edite o mapeamento ou implemente a regra explicitamente; nenhum pacote foi emitido. Não subtraia devoluções novamente de um faturamento já líquido.");
        diagnostic("Pré-validação semântica concluída. As medidas serão conciliadas com DAX real; seus nomes não definem fórmulas.");
    }

    internal static List<SemanticIssue> Analyze(IReadOnlyList<Measure> measures, IReadOnlyList<ColumnInfo> columns, Mapping mapping)
    {
        var issues = new List<SemanticIssue>();
        var actual = new Dictionary<string, Measure>(StringComparer.OrdinalIgnoreCase);
        foreach (var measure in measures) actual.TryAdd(measure.Name, measure);
        foreach (var metric in mapping.Metrics)
        {
            string label = metric.Id switch { "revenue" => "Faturamento", "returns" => "Devoluções", "buyers" => "Clientes distintos", _ => metric.Id };
            if (!actual.TryGetValue(metric.Measure, out var measure))
            { issues.Add(new(label, $"A medida [{metric.Measure}] não existe no modelo carregado.")); continue; }
            var expressions = Expand(measure, actual).ToArray();
            if (metric.Id == "buyers")
            {
                if (expressions.Any(e => VolatileCalendar.IsMatch(WithoutCommentsAndStrings(e.Expression))))
                    issues.Add(new(label, $"A expressão real de [{metric.Measure}] depende da data atual ou de MTD/YTD. A receita de clientes distintos da base histórica não transporta esse filtro. Selecione uma medida histórica equivalente ou deixe o indicador indisponível; a medida original será preservada no inventário."));
                continue;
            }
            if (metric.Column == null || !columns.Any(c => c.Table == mapping.FactTable && c.Name == metric.Column))
            { issues.Add(new(label, $"A coluna mapeada {mapping.FactTable}[{metric.Column ?? "não selecionada"}] não existe ou não foi selecionada.")); continue; }
            var inputs = expressions.SelectMany(e => SumInputs(e.Expression)).Distinct().ToArray();
            var otherFacts = inputs.Where(f => !string.Equals(f.Table, mapping.FactTable, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (otherFacts.Length != 0)
                issues.Add(new(label, $"O DAX real de [{metric.Measure}] agrega {string.Join(", ", otherFacts.Select(Display))}, mas a coluna escolhida é {Display(new Field(mapping.FactTable, metric.Column))}. A projeção de um único fato não representa essa origem. Mantenha a medida indisponível ou use uma implementação explícita com as dimensões e relacionamentos corretos; não copie o valor de faturamento para devoluções."));
            else if (TryDirectSum(measure.Expression, out var direct) &&
                (!string.Equals(direct.Table, mapping.FactTable, StringComparison.OrdinalIgnoreCase) || !string.Equals(direct.Column, metric.Column, StringComparison.OrdinalIgnoreCase)))
                issues.Add(new(label, $"O DAX soma {Display(direct)}, enquanto o mapeamento seleciona {Display(new Field(mapping.FactTable, metric.Column))}. Corrija o campo; os nomes das medidas não autorizam substituir a coluna."));
        }
        var revenue = mapping.Metrics.FirstOrDefault(m => m.Id == "revenue");
        var returns = mapping.Metrics.FirstOrDefault(m => m.Id == "returns");
        if (revenue?.Column != null && returns?.Column == revenue.Column &&
            actual.TryGetValue(revenue.Measure, out var r) && actual.TryGetValue(returns.Measure, out var d) &&
            Normalize(r.Expression) != Normalize(d.Expression))
            issues.Add(new("Faturamento e devoluções", $"As medidas [{revenue.Measure}] e [{returns.Measure}] têm expressões diferentes, mas foram associadas à mesma coluna {Display(new Field(mapping.FactTable, revenue.Column))}. Isso faria o preparador repetir o mesmo valor em indicadores distintos. Faturamento líquido deve ser conciliado com sua expressão real, com devoluções deduzidas uma única vez."));
        return issues;
    }

    internal static IEnumerable<Field> SumInputs(string expression)
    {
        foreach (Match match in Sum.Matches(WithoutCommentsAndStrings(expression)))
        {
            string table = match.Groups["table"].Success ? match.Groups["table"].Value.Replace("''", "'") : match.Groups["plain"].Value;
            if (table.Length != 0) yield return new Field(table, match.Groups["column"].Value.Replace("]]", "]"));
        }
    }

    internal static List<SemanticIssue> DimensionIssues(IReadOnlyList<object> relationships, Mapping mapping)
    {
        var edges = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (object relation in relationships)
        {
            var r = JsonSerializer.SerializeToElement(relation, PackageWriter.Json);
            string? Text(string key) => r.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            bool active = r.TryGetProperty("isActive", out var flag) && flag.ValueKind == JsonValueKind.True;
            if (!active) continue;
            string? from = Text("fromTableName"), to = Text("toTableName");
            if (from == null || to == null) continue; // Missing exact metadata cannot establish a RELATED path.
            void Edge(string a, string b) { if (!edges.TryGetValue(a, out var list)) edges[a] = list = []; list.Add(b); }
            if (string.Equals(Text("toCardinality"), "One", StringComparison.OrdinalIgnoreCase)) Edge(from, to);
            if (string.Equals(Text("fromCardinality"), "One", StringComparison.OrdinalIgnoreCase)) Edge(to, from);
        }
        bool Reachable(string destination)
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase); var pending = new Stack<string>(); pending.Push(mapping.FactTable);
            while (pending.TryPop(out var table))
            {
                if (!seen.Add(table)) continue;
                if (string.Equals(table, destination, StringComparison.OrdinalIgnoreCase)) return true;
                if (edges.TryGetValue(table, out var targets)) foreach (string target in targets) pending.Push(target);
            }
            return false;
        }
        var issues = new List<SemanticIssue>();
        foreach (var (key, field) in mapping.Dimensions)
            if (!Reachable(field.Table))
            {
                string label = key switch { "date" => "Data", "region" => "Regional / representante", "client" => "Cliente", "product" => "Produto", "category" => "Categoria", "state" => "UF", _ => key };
                issues.Add(new(label, $"A coluna {Display(field)} exige RELATED a partir de '{mapping.FactTable}', mas não existe um caminho ativo de cardinalidade muitos-para-um comprovado. Relacionamentos muitos-para-muitos não escolhem uma única linha de dimensão. Revise a chave e a regra de projeção; nenhum representante ou outro valor será deduzido por nome."));
            }
        return issues;
    }
    private static bool TryDirectSum(string expression, out Field target)
    {
        string value = WithoutCommentsAndStrings(expression).Trim();
        var match = Sum.Match(value);
        var inputs = SumInputs(value).ToArray();
        if (match.Success && match.Index == 0 && match.Length == value.Length && inputs.Length == 1)
        { target = inputs[0]; return true; }
        target = new Field("", ""); return false;
    }
    private static IEnumerable<Measure> Expand(Measure first, Dictionary<string, Measure> measures)
    {
        var stack = new Stack<Measure>(); var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase); stack.Push(first);
        while (stack.TryPop(out var measure))
        {
            if (!seen.Add(measure.Name)) continue;
            yield return measure;
            foreach (Match match in Reference.Matches(WithoutCommentsAndStrings(measure.Expression)))
            {
                string name = match.Groups["column"].Value.Replace("]]", "]");
                if (measures.TryGetValue(name, out var dependency))
                {
                    string table = match.Groups["table"].Success ? match.Groups["table"].Value.Replace("''", "'") : match.Groups["plain"].Value;
                    if (table.Length == 0 || string.Equals(table, dependency.Table, StringComparison.OrdinalIgnoreCase)) stack.Push(dependency);
                }
            }
        }
    }
    private static string Normalize(string expression) => Regex.Replace(WithoutCommentsAndStrings(expression), @"\s+", "").ToUpperInvariant();
    private static string Display(Field field) => $"'{field.Table.Replace("'", "''")}'[{field.Column.Replace("]", "]]")}]";
    private static string WithoutCommentsAndStrings(string text)
    {
        var output = new StringBuilder(text.Length); bool quotedTable = false;
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (c == '\'')
            {
                output.Append(c);
                if (quotedTable && i + 1 < text.Length && text[i + 1] == '\'') output.Append(text[++i]);
                else quotedTable = !quotedTable;
            }
            else if (!quotedTable && c == '"')
            {
                output.Append(' ');
                while (++i < text.Length)
                    if (text[i] == '"') { if (i + 1 < text.Length && text[i + 1] == '"') i++; else break; }
            }
            else if (!quotedTable && i + 1 < text.Length && ((c == '/' && text[i + 1] == '/') || (c == '-' && text[i + 1] == '-')))
            {
                while (i < text.Length && text[i] != '\n') i++;
                output.Append('\n');
            }
            else if (!quotedTable && c == '/' && i + 1 < text.Length && text[i + 1] == '*')
            {
                i += 2; while (i + 1 < text.Length && !(text[i] == '*' && text[i + 1] == '/')) i++;
                i++; output.Append(' ');
            }
            else output.Append(c);
        }
        return output.ToString();
    }

    internal static void SelfTest()
    {
        var dimensions = new Dictionary<string, Field> { ["client"] = new("Faturamento", "Código Cliente") };
        Mapping Profile(params MetricMapping[] metrics) => new("Panizzon teste", "Faturamento", dimensions, metrics.ToList(), true, "Regra revisada para teste", Guid.NewGuid().ToString(), []);
        var columns = new List<ColumnInfo> { new("Faturamento", "Valor mercadorias", "Decimal", false, false, true, null, "", ""), new("Faturamento", "Outro valor", "Decimal", false, false, true, null, "", "") };
        var gross = new Measure("Medidas", "Fat. Bruto", "SUM('Faturamento'[Valor mercadorias])", "");
        var net = new Measure("Medidas", "Fat. Liq.", "[Fat. Bruto] - [Dev. Fat]", "");
        var returns = new Measure("Medidas", "Dev. Fat", "IF(ISBLANK(SUM('DEVOLUÇÃO'[Valor mercadorias])),0,SUM('DEVOLUÇÃO'[Valor mercadorias]))", "");
        // Real observed expression: its misleading name does not imply a year filter.
        var actualBuyers = new Measure("Medidas", "Clientes Atual (ano atual)", "DISTINCTCOUNT(Faturamento[Codigo Cliente])", "");
        var filteredBuyers = new Measure("Medidas", "Clientes com filtro explícito", "CALCULATE(DISTINCTCOUNT('Faturamento'[Codigo Cliente]),YEAR('dCalendario'[Date])=YEAR(TODAY()))", "");
        var measures = new List<Measure> { gross, net, returns, actualBuyers, filteredBuyers };
        if (Analyze(measures, columns, Profile(new MetricMapping("revenue", "Fat. Bruto", "Valor mercadorias", 2))).Count != 0) throw new InvalidOperationException("Soma aditiva válida bloqueada.");
        var wrongSum = Analyze(measures, columns, Profile(new MetricMapping("revenue", "Fat. Bruto", "Outro valor", 2)));
        if (!wrongSum.Any(i => i.Message.Contains("Corrija o campo"))) throw new InvalidOperationException("Coluna de soma incompatível não detectada.");
        if (Analyze(measures, columns, Profile(new MetricMapping("revenue", "Fat. Bruto", "Valor mercadorias", 2), new MetricMapping("buyers", actualBuyers.Name, null, 0))).Count != 0)
            throw new InvalidOperationException("Nome de medida foi confundido com filtro de ano não existente no DAX.");
        var saved = Profile(new MetricMapping("revenue", "Fat. Liq.", "Valor mercadorias", 2), new MetricMapping("returns", "Dev. Fat", "Valor mercadorias", 2), new MetricMapping("buyers", filteredBuyers.Name, null, 0));
        string before = JsonSerializer.Serialize(saved, PackageWriter.Json);
        var issues = Analyze(measures, columns, saved);
        if (!issues.Any(i => i.Message.Contains("DEVOLUÇÃO")) || !issues.Any(i => i.Field == "Faturamento e devoluções") || !issues.Any(i => i.Field == "Clientes distintos"))
            throw new InvalidOperationException("Mapeamento Panizzon incompatível não diagnosticado.");
        if (before != JsonSerializer.Serialize(saved, PackageWriter.Json)) throw new InvalidOperationException("A pré-validação alterou o mapeamento salvo.");
        var relationMapping = Profile(new MetricMapping("revenue", "Fat. Bruto", "Valor mercadorias", 2)) with { Dimensions = new Dictionary<string, Field> {
            ["region"] = new("Base Clientes", "Representantes"), ["date"] = new("dCalendario", "Date"), ["product"] = new("Faturamento", "Código do item") } };
        object[] relations = [
            new { isActive = true, fromTableName = "Base Clientes", toTableName = "Faturamento", fromCardinality = "Many", toCardinality = "Many" },
            new { isActive = true, fromTableName = "Faturamento", toTableName = "dCalendario", fromCardinality = "Many", toCardinality = "One" },
        ];
        var dimensionIssues = DimensionIssues(relations, relationMapping);
        if (dimensionIssues.Count != 1 || dimensionIssues[0].Field != "Regional / representante") throw new InvalidOperationException("Caminho RELATED muitos-para-muitos não foi distinguido de um relacionamento válido.");
        if (SumInputs("\"SUM('Ignorar'[Senha])\"").Count() != 0) throw new InvalidOperationException("String literal reconhecida como fórmula.");
        if (SumInputs("SUM('Faturamento'[Valor mercadorias]) // SUM('Ignorar'[Valor])").Count() != 1) throw new InvalidOperationException("Comentário confundido com DAX executável.");
        VerifyNetAndReturnsControls();
    }

    private static void VerifyNetAndReturnsControls()
    {
        // Synthetic controls exercise the same verifier used before package emission.
        // Gross100/returns10 gives the model control net90. The verifier consumes net
        // and returns independently; it must not deduct returns from net a second time.
        var controls = new List<object> {
            new { metric = "revenue", context = "total", filters = new { from = "2026-01-01", to = "2026-01-31" }, expected = "90.00" },
            new { metric = "returns", context = "total", filters = new { from = "2026-01-01", to = "2026-01-31" }, expected = "10.00" },
        };
        string path = Path.Combine(Path.GetTempPath(), "ci-semantic-test-" + Guid.NewGuid().ToString("N") + ".partial");
        void Write(string net) => File.WriteAllText(path, JsonSerializer.Serialize(new { kind = "facts", rows = new[] {
            new { date = "2026-01-10", values = new Dictionary<string, string> { ["revenue"] = net, ["returns"] = "10.00" } }
        } }, PackageWriter.Json) + "\n", new UTF8Encoding(false));
        try
        {
            Write("90.00"); PackageWriter.ValidateControlRows(path, controls, _ => { });
            Write("80.00");
            bool rejected = false;
            try { PackageWriter.ValidateControlRows(path, controls, _ => { }); }
            catch (InvalidOperationException ex) when (ex.Message.Contains("divergiu")) { rejected = true; }
            if (!rejected) throw new InvalidOperationException("Dupla dedução de devoluções não reprovou o controle de faturamento líquido.");
        }
        finally { if (File.Exists(path)) File.Delete(path); }
    }
}
