using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AnalysisServices.AdomdClient;
using Microsoft.AnalysisServices.Tabular;
using JsonSerializer = System.Text.Json.JsonSerializer;

namespace ComercialInsight.Preparador;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        if (args.Contains("--self-test"))
        {
            try { PackageWriter.SelfTest(); Environment.Exit(0); }
            catch { Environment.Exit(1); }
            return;
        }
        string Arg(string name)
        {
            int i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : "";
        }
        Application.Run(new MainForm(Arg("--server"), Arg("--database")));
    }
}

internal sealed record Field(string Table, string Column)
{
    public override string ToString() => $"{Table} · {Column}";
}
internal sealed record Measure(string Table, string Name, string Expression, string Format);
internal sealed record MetricMapping(string Id, string Measure, string? Column, int Scale);
internal sealed record Mapping(string ModelName, string FactTable, Dictionary<string, Field> Dimensions,
    List<MetricMapping> Metrics, bool AdditivityReviewed, string ReviewNote, string SourceId, List<string> AllowEmptyTables);
internal sealed record PartInfo(int index, long rows, long bytes, string sha256);
internal sealed record TableInfo(string id, string name, object[] columns, long rowCount, long sourceRowCount, bool allowEmpty,
    string storageMode, object[] partitions, object metadata, List<PartInfo> parts);
internal sealed record ProjectionInfo(long rowCount, string from, string to, string grain, string[] dimensions, List<PartInfo> parts);
internal sealed record ColumnInfo(string Table, string Name, string Type, bool Hidden, bool IsKey,
    bool Nullable, string? Expression, string Format, string SourceColumn);
internal sealed record ModelInfo(string Id, string Name, string Fingerprint, string? UpdatedAt,
    List<ColumnInfo> Columns, List<Measure> Measures, object[] Relationships, object[] Dependencies,
    List<string> TableNames, Dictionary<string, object[]> Partitions, Dictionary<string, object> TableMetadata);

internal sealed class MainForm : Form
{
    private readonly string server, database;
    private readonly Label description = new() { Dock = DockStyle.Top, Height = 92, Padding = new Padding(14),
        Text = "Abra o PBIX atualizado, aguarde a conclusão da atualização e mantenha o modelo sem alterações durante a preparação. O preparador lê o modelo; não atualiza fontes nem modifica o PBIX." };
    private readonly TextBox log = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill };
    private readonly Button configure = new() { Text = "Configurar mapeamento", Width = 190, Height = 36 };
    private readonly Button prepare = new() { Text = "Preparar atualização", Width = 190, Height = 36, Enabled = false };
    private readonly string settingsPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ComercialInsight", "mapeamento.json");
    private ModelInfo? model;
    private Mapping? mapping;
    internal MainForm(string server, string database)
    {
        this.server = server; this.database = database;
        Text = "Preparar atualização Comercial Insight";
        Width = 820; Height = 600; MinimumSize = new Size(640, 440); StartPosition = FormStartPosition.CenterScreen;
        var actions = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 62, Padding = new Padding(10) };
        actions.Controls.AddRange([configure, prepare]); Controls.Add(log); Controls.Add(description); Controls.Add(actions);
        configure.Enabled = false;
        configure.Click += (_, _) => ConfigureMapping();
        prepare.Click += async (_, _) => await Prepare();
        Shown += async (_, _) => await LoadModel();
    }
    private void Log(string text) => BeginInvoke(() => log.AppendText($"{DateTime.Now:HH:mm:ss} {text}{Environment.NewLine}"));
    private async Task LoadModel()
    {
        try
        {
            if (!Regex.IsMatch(server, @"^(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$", RegexOptions.IgnoreCase) || string.IsNullOrWhiteSpace(database))
                throw new InvalidOperationException("Inicie pelo botão Ferramentas externas do Power BI Desktop. Apenas o modelo local é aceito; conexões corporativas remotas não são abertas pelo preparador.");
            Log("Lendo metadados TOM do modelo local...");
            model = await Task.Run(() => { using var source = new ModelSource(server, database); return source.Inspect(); });
            Log($"Modelo: {model.Name}; {model.TableNames.Count} tabelas; {model.Measures.Count} medidas. Nenhum dado foi enviado à internet.");
            if (File.Exists(settingsPath))
            {
                mapping = JsonSerializer.Deserialize<Mapping>(await File.ReadAllTextAsync(settingsPath), PackageWriter.Json);
                if (mapping != null && (!model.TableNames.Contains(mapping.FactTable) || mapping.Dimensions.Values.Any(f => !model.Columns.Any(c => c.Table == f.Table && c.Name == f.Column)) || mapping.Metrics.Any(m => !model.Measures.Any(x => x.Name == m.Measure))))
                { mapping = null; Log("O mapeamento salvo não corresponde aos objetos deste modelo. Configure antes de preparar."); }
                else if (mapping != null) Log($"Perfil de fonte selecionado: {mapping.ModelName}. Confira se o PBIX aberto é a fonte comercial correta antes de preparar.");
            }
            configure.Enabled = true; prepare.Enabled = mapping != null;
            if (mapping == null) ConfigureMapping();
        }
        catch (Exception ex) { ShowError(ex); }
    }
    private void ConfigureMapping()
    {
        if (model == null) return;
        using var dialog = new MappingForm(model, mapping);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        mapping = dialog.Result;
        Directory.CreateDirectory(Path.GetDirectoryName(settingsPath)!);
        File.WriteAllText(settingsPath, JsonSerializer.Serialize(mapping, PackageWriter.Json), new UTF8Encoding(false));
        prepare.Enabled = true;
        Log("Mapeamento inicial salvo para este modelo. As consultas de controle serão reexecutadas a cada preparação.");
    }
    private async Task Prepare()
    {
        if (mapping == null) return;
        using var save = new SaveFileDialog { Filter = "Pacote Comercial Insight (*.ci.ndjson)|*.ci.ndjson", DefaultExt = "ci.ndjson",
            FileName = $"ComercialInsight-{DateTime.Now:yyyy-MM-dd-HHmm}.ci.ndjson", OverwritePrompt = true };
        if (save.ShowDialog(this) != DialogResult.OK) return;
        prepare.Enabled = configure.Enabled = false;
        try
        {
            await Task.Run(() => { using var source = new ModelSource(server, database); new PackageWriter(source, mapping, Log).Export(save.FileName); });
            Log("Pacote concluído. Envie-o em Administração > Atualização de dados. A publicação ainda depende da validação no servidor.");
            MessageBox.Show(this, "Pacote preparado. No Comercial Insight, abra Administração > Atualização de dados e clique em Enviar e atualizar base.", "Preparação concluída", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex) { ShowError(ex); }
        finally { prepare.Enabled = configure.Enabled = true; }
    }
    private void ShowError(Exception ex)
    {
        // Driver errors can contain connection details; only a reviewed application message is shown.
        string message = ex is InvalidOperationException or InvalidDataException ? ex.Message : "A leitura do modelo falhou. Confirme o PBIX aberto, a conclusão da atualização e a disponibilidade do modelo local. Nenhum pacote válido foi produzido.";
        Log(message); MessageBox.Show(this, message, "Preparação interrompida", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}

internal sealed class MappingForm : Form
{
    internal Mapping? Result { get; private set; }
    private readonly ModelInfo model;
    private readonly ComboBox fact = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 520 };
    private readonly Dictionary<string, ComboBox> dimensions = [];
    private readonly Dictionary<string, ComboBox> measureFields = [];
    private readonly Dictionary<string, ComboBox> valueFields = [];
    private readonly NumericUpDown scale = new() { Minimum = 0, Maximum = 6, Value = 2 };
    private readonly CheckBox reviewed = new() { AutoSize = true, Text = "Revisei a granularidade, a aditividade dos valores e a propagação de filtros." };
    private readonly TextBox note = new() { Width = 520, PlaceholderText = "Responsável e fundamento da regra comercial (obrigatório)" };
    private readonly TextBox modelName = new() { Width = 520, PlaceholderText = "Nome reconhecível da fonte comercial (ex.: nome do modelo)" };
    private readonly CheckedListBox allowEmpty = new() { Width = 520, Height = 90, CheckOnClick = true };
    internal MappingForm(ModelInfo model, Mapping? existing)
    {
        this.model = model;
        Text = "Configuração inicial do modelo"; Width = 790; Height = 740; MinimumSize = new Size(650, 620); StartPosition = FormStartPosition.CenterParent;
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, AutoScroll = true, ColumnCount = 2, Padding = new Padding(14) };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 175)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        void Add(string label, Control c) { int r = grid.RowCount++; grid.Controls.Add(new Label { Text = label, AutoSize = true, MaximumSize = new Size(170, 0), Padding = new Padding(0, 8, 0, 0) }, 0, r); grid.Controls.Add(c, 1, r); }
        Add("Regra suportada", new Label { Text = "Um fato com linhas completas; valores monetários aditivos e/ou clientes distintos. Medidas complexas, estoque, metas e margem ficam indisponíveis até implementação e conciliação específicas. Não deduza a regra pelo nome da medida.", AutoSize = true, MaximumSize = new Size(520, 0) });
        Add("Identidade da fonte", modelName);
        fact.Items.AddRange(model.TableNames.Cast<object>().ToArray()); Add("Tabela fato", fact);
        foreach (var key in new[] { "date", "region", "client", "product", "category", "state" })
        {
            var c = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 520 };
            c.Items.AddRange(model.Columns.Where(x => !x.Name.StartsWith("RowNumber-", StringComparison.Ordinal)).Select(x => (object)new Field(x.Table, x.Name)).ToArray());
            dimensions.Add(key, c); Add(new Dictionary<string, string> { ["date"] = "Data do indicador", ["region"] = "Regional / representante", ["client"] = "Chave única do cliente", ["product"] = "Produto", ["category"] = "Categoria", ["state"] = "UF" }[key], c);
        }
        foreach (string id in new[] { "revenue", "returns", "buyers" })
        {
            var m = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 520 };
            m.Items.Add("(indisponível)"); m.Items.AddRange(model.Measures.Select(x => (object)x.Name).Distinct().ToArray()); m.SelectedIndex = 0;
            measureFields.Add(id, m); Add(id == "revenue" ? "Medida de faturamento *" : id == "returns" ? "Medida de devoluções" : "Medida clientes distintos", m);
            if (id != "buyers")
            {
                var c = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 520 };
                valueFields.Add(id, c); Add(id == "revenue" ? "Coluna aditiva faturamento *" : "Coluna aditiva devoluções", c);
            }
        }
        fact.SelectedIndexChanged += (_, _) =>
        {
            foreach (var c in valueFields.Values)
            {
                c.Items.Clear(); c.Items.Add("(indisponível)");
                c.Items.AddRange(model.Columns.Where(x => x.Table == fact.SelectedItem?.ToString() && new[] { "Int64", "Decimal", "Double" }.Contains(x.Type)).Select(x => (object)x.Name).ToArray()); c.SelectedIndex = 0;
            }
        };
        allowEmpty.Items.AddRange(model.TableNames.Cast<object>().ToArray());
        Add("Casas decimais monetárias", scale); Add("Tabelas autorizadas a ficarem vazias", allowEmpty); Add("Revisão inicial", reviewed); Add("Evidência da revisão", note);
        var ok = new Button { Text = "Salvar mapeamento", Width = 180, Height = 36 };
        ok.Click += (_, _) =>
        {
            if (modelName.Text.Trim().Length < 2 || modelName.Text.Trim().Length > 200 || fact.SelectedItem == null || dimensions.Values.Any(x => x.SelectedItem is not Field) || measureFields["revenue"].SelectedIndex < 1 || valueFields["revenue"].SelectedIndex < 1 || !reviewed.Checked || note.Text.Trim().Length < 12 || note.Text.Trim().Length > 500)
            { MessageBox.Show(this, "Preencha as dimensões, a medida e coluna de faturamento e documente a revisão inicial."); return; }
            var metrics = new List<MetricMapping>();
            foreach (var (id, c) in measureFields)
            {
                if (c.SelectedIndex < 1) continue;
                if (id != "buyers" && valueFields[id].SelectedIndex < 1) { MessageBox.Show(this, $"Selecione a coluna de {id} ou deixe a medida indisponível."); return; }
                metrics.Add(new MetricMapping(id, c.SelectedItem!.ToString()!, id == "buyers" ? null : valueFields[id].SelectedItem!.ToString(), id == "buyers" ? 0 : (int)scale.Value));
            }
            string sourceId = existing != null && existing.ModelName == modelName.Text.Trim() && Guid.TryParse(existing.SourceId, out _) ? existing.SourceId : Guid.NewGuid().ToString();
            Result = new Mapping(modelName.Text.Trim(), fact.SelectedItem!.ToString()!, dimensions.ToDictionary(x => x.Key, x => (Field)x.Value.SelectedItem!), metrics, true, note.Text.Trim(), sourceId, allowEmpty.CheckedItems.Cast<string>().ToList());
            DialogResult = DialogResult.OK;
        };
        Add("", ok); Controls.Add(grid);
        if (existing != null)
        {
            modelName.Text = existing.ModelName;
            fact.SelectedItem = existing.FactTable;
            foreach (var (key, c) in dimensions) { var item = c.Items.Cast<Field>().FirstOrDefault(x => x == existing.Dimensions.GetValueOrDefault(key)); if (item != null) c.SelectedItem = item; }
            foreach (var metric in existing.Metrics) { measureFields[metric.Id].SelectedItem = metric.Measure; if (metric.Column != null) valueFields[metric.Id].SelectedItem = metric.Column; }
            scale.Value = existing.Metrics.FirstOrDefault(x => x.Id == "revenue")?.Scale ?? 2; reviewed.Checked = existing.AdditivityReviewed; note.Text = existing.ReviewNote;
            for (int i = 0; i < allowEmpty.Items.Count; i++) allowEmpty.SetItemChecked(i, existing.AllowEmptyTables?.Contains(allowEmpty.Items[i]!.ToString()!) == true);
        }
    }
}

internal sealed class ModelSource : IDisposable
{
    private readonly Server tom = new();
    private readonly AdomdConnection connection;
    private readonly string database;
    internal ModelSource(string server, string database)
    {
        this.database = database;
        var cs = new System.Data.Common.DbConnectionStringBuilder { ["Data Source"] = server, ["Initial Catalog"] = database, ["Application Name"] = "Comercial Insight Preparador somente leitura" };
        tom.Connect(cs.ConnectionString);
        connection = new AdomdConnection(cs.ConnectionString); connection.Open();
    }
    internal IEnumerable<object?[]> Read(string dax)
    {
        using var command = connection.CreateCommand(); command.CommandTimeout = 0; command.CommandText = dax;
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var values = new object?[reader.FieldCount];
            for (int i = 0; i < values.Length; i++) values[i] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            yield return values;
        }
    }
    internal void AssertIdle()
    {
        foreach (var row in Read("SELECT * FROM $SYSTEM.DISCOVER_COMMANDS"))
            foreach (var value in row)
                if (value is string text && Regex.IsMatch(text, @"<(?:\w+:)?(?:Alter|Create|Delete|Process|Refresh|Batch)\b|\""(?:refresh|createOrReplace|alter)\""\s*:", RegexOptions.IgnoreCase))
                    throw new InvalidOperationException("Foi detectada uma alteração/atualização concorrente no modelo. Aguarde sua conclusão e prepare novamente.");
    }
    internal ModelInfo Inspect()
    {
        tom.Refresh();
        var db = tom.Databases.Cast<Database>().SingleOrDefault(x => x.ID == database || x.Name == database)
            ?? throw new InvalidOperationException("O modelo local não está disponível. Abra um PBIX com dados incorporados, não um relatório thin/live.");
        db.Refresh(true);
        var tables = db.Model.Tables.ToList();
        if (tables.Count == 0) throw new InvalidOperationException("Este relatório não contém tabelas locais. Obtenha um PBIX com dados ou uma exportação completa autorizada.");
        var columns = new List<ColumnInfo>(); var measures = new List<Measure>();
        var partitions = new Dictionary<string, object[]>();
        var tableMetadata = new Dictionary<string, object>();
        foreach (var t in tables)
        {
            tableMetadata[t.Name] = new
            {
                description = t.Description, hidden = t.IsHidden,
                calculationItems = t.CalculationGroup?.CalculationItems.Select(i => new { name = i.Name, expression = i.Expression, ordinal = i.Ordinal, formatStringExpression = i.FormatStringDefinition?.Expression }).ToArray(),
                hierarchies = t.Hierarchies.Select(h => new { name = h.Name, hidden = h.IsHidden, levels = h.Levels.Select(l => new { name = l.Name, column = l.Column?.Name, ordinal = l.Ordinal }).ToArray() }).ToArray()
            };
            partitions[t.Name] = t.Partitions.Select(p => (object)new
            {
                name = p.Name, mode = p.Mode.ToString(), state = Property(p, "State"),
                refreshedTime = Property(p, "RefreshedTime"), modifiedTime = Property(p, "ModifiedTime"),
                sourceType = p.Source?.GetType().Name ?? "none", expression = p.Source is CalculatedPartitionSource calculated ? calculated.Expression : null
            }).ToArray();
            foreach (var p in t.Partitions)
            {
                string mode = p.Mode.ToString() == "Default" ? db.Model.DefaultMode.ToString() : p.Mode.ToString();
                if (mode != "Import") throw new InvalidOperationException($"Tabela {t.Name}, partição {p.Name}: armazenamento {mode}. A preparação v1 exige modelo Import autocontido. DirectQuery, Dual e conexões live precisam de uma exportação completa com consistência comprovada; nenhuma tabela foi considerada vazia.");
                string state = Property(p, "State") ?? "";
                if (state is "NoData" or "CalculationNeeded" or "SemanticError" or "EvaluationError" or "DependencyError" or "Incomplete")
                    throw new InvalidOperationException($"Tabela {t.Name}, partição {p.Name}: estado {state}. Conclua a atualização do PBIX antes de preparar.");
            }
            foreach (var c in t.Columns)
            {
                if (c.Type.ToString() == "RowNumber") continue;
                if (Regex.IsMatch(c.Name, @"password|senha|client.?secret|access.?token|refresh.?token|account.?key|connection.?string", RegexOptions.IgnoreCase))
                    throw new InvalidOperationException($"A coluna {t.Name}[{c.Name}] pode conter credenciais. Remova credenciais do modelo ou solicite uma exclusão de objeto revisada; o preparador não inclui segredos no pacote.");
                columns.Add(new ColumnInfo(t.Name, c.Name, c.DataType.ToString(), c.IsHidden, c.IsKey, c.IsNullable,
                    c is CalculatedColumn cc ? cc.Expression : null, c.FormatString ?? "", c is DataColumn dc ? dc.SourceColumn : ""));
            }
            foreach (var m in t.Measures) measures.Add(new Measure(t.Name, m.Name, m.Expression ?? "", m.FormatString ?? ""));
        }
        var relationships = db.Model.Relationships.Select(r =>
        {
            var single = r as SingleColumnRelationship;
            return (object)new
            {
                name = r.Name, type = r.Type.ToString(), isActive = r.IsActive,
                crossFilteringBehavior = r.CrossFilteringBehavior.ToString(), securityFilteringBehavior = r.SecurityFilteringBehavior.ToString(),
                fromTable = single?.FromTable == null ? null : "t-" + PackageWriter.Hash(Encoding.UTF8.GetBytes(single.FromTable.Name))[..24], fromTableName = single?.FromTable?.Name, fromColumn = single?.FromColumn?.Name,
                fromCardinality = single?.FromCardinality.ToString(), toTable = single?.ToTable == null ? null : "t-" + PackageWriter.Hash(Encoding.UTF8.GetBytes(single.ToTable.Name))[..24], toTableName = single?.ToTable?.Name,
                toColumn = single?.ToColumn?.Name, toCardinality = single?.ToCardinality.ToString(),
                joinOnDateBehavior = single?.JoinOnDateBehavior.ToString(), relyOnReferentialIntegrity = single?.RelyOnReferentialIntegrity
            };
        }).ToArray();
        // Dependencies are names/types only: M expressions and connection strings can contain corporate credentials.
        var dependencies = new List<object>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT * FROM $SYSTEM.DISCOVER_CALC_DEPENDENCY";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var item = new Dictionary<string, string?>();
                for (int i = 0; i < reader.FieldCount; i++)
                    if (!reader.GetName(i).Contains("EXPRESSION", StringComparison.OrdinalIgnoreCase))
                        item[reader.GetName(i)] = reader.IsDBNull(i) ? null : Convert.ToString(reader.GetValue(i), CultureInfo.InvariantCulture);
                dependencies.Add(item);
            }
        }
        string fingerprint = PackageWriter.Hash(JsonSerializer.SerializeToUtf8Bytes(new { columns, measures, relationships, partitions, tableMetadata,
            modified = Property(db, "LastUpdate"), schema = Property(db, "LastSchemaUpdate"), mode = db.Model.DefaultMode.ToString() }, PackageWriter.Json));
        string? updated = tables.SelectMany(t => t.Partitions).Select(p => Property(p, "RefreshedTime")).Where(x => DateTimeOffset.TryParse(x, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) && date.Year >= 2001).Max();
        string semanticJson = JsonSerializer.Serialize(new { columns, measures, relationships, tableMetadata, partitions }, PackageWriter.Json);
        if (Regex.IsMatch(semanticJson, @"(?:password|pwd|client_secret|access_token|refresh_token|AccountKey|SharedAccessSignature)\s*(?:=|:)\s*[^\s,;]+", RegexOptions.IgnoreCase))
            throw new InvalidOperationException("Os metadados contêm uma possível credencial literal. Remova o segredo do modelo antes de preparar; nenhum pacote foi emitido.");
        return new ModelInfo(db.ID, db.Name, fingerprint, updated, columns, measures, relationships, dependencies.ToArray(), tables.Select(t => t.Name).ToList(), partitions, tableMetadata);
    }
    private static string? Property(object value, string name)
    {
        var v = value.GetType().GetProperty(name)?.GetValue(value);
        return v is DateTime date ? date.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) : Convert.ToString(v, CultureInfo.InvariantCulture);
    }
    public void Dispose() { connection.Dispose(); tom.Disconnect(); tom.Dispose(); }
}

internal sealed class PackageWriter(ModelSource source, Mapping mapping, Action<string> log)
{
    internal static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };
    internal static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static string Table(string name) => "'" + name.Replace("'", "''") + "'";
    private static string Col(Field field) => Table(field.Table) + "[" + field.Column.Replace("]", "]]") + "]";
    private static string Str(string text) => "\"" + text.Replace("\"", "\"\"") + "\"";
    private string Dimension(string key) => mapping.Dimensions[key].Table == mapping.FactTable ? Col(mapping.Dimensions[key]) : "RELATED(" + Col(mapping.Dimensions[key]) + ")";
    private static readonly string[] Dimensions = ["date", "region", "client", "product", "category", "state"];
    internal void Export(string target)
    {
        var before = source.Inspect(); source.AssertIdle();
        if (!mapping.AdditivityReviewed || !Guid.TryParse(mapping.SourceId, out _) || !mapping.Metrics.Any(x => x.Id == "revenue")) throw new InvalidOperationException("O modelo ou mapeamento mudou. Refaça a configuração inicial.");
        foreach (var f in mapping.Dimensions.Values) if (!before.Columns.Any(c => c.Table == f.Table && c.Name == f.Column)) throw new InvalidOperationException($"A dimensão {f} não existe mais. Revise o mapeamento.");
        foreach (var m in mapping.Metrics) if (!before.Measures.Any(x => x.Name == m.Measure)) throw new InvalidOperationException($"A medida {m.Measure} não existe mais. Revise o mapeamento.");
        string temporary = target + ".partial", bodyPath = target + ".body.partial";
        if (File.Exists(temporary) || File.Exists(bodyPath)) throw new InvalidOperationException("Já existe uma preparação parcial neste destino. Escolha outro nome de arquivo.");
        try
        {
            var tableInfo = new List<TableInfo>();
            using (var output = new FileStream(bodyPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            {
                foreach (var table in before.TableNames)
                {
                    source.AssertIdle(); log($"Exportando integralmente {table}...");
                    var cols = before.Columns.Where(x => x.Table == table).ToArray();
                    if (cols.Length == 0) throw new InvalidOperationException($"Tabela {table} sem colunas exportáveis; não é possível confirmar sua extração completa.");
                    long expected = Convert.ToInt64(source.Read($"EVALUATE ROW(\"n\",COUNTROWS({Table(table)}))").Single()[0], CultureInfo.InvariantCulture);
                    bool emptyAllowed = mapping.AllowEmptyTables?.Contains(table) == true;
                    if (expected == 0 && !emptyAllowed) throw new InvalidOperationException($"Tabela {table} confirmada vazia na origem, mas o contrato inicial não permite essa condição. Revise o perfil e autorize explicitamente a tabela vazia apenas se isso for correto.");
                    string tableId = "t-" + Hash(Encoding.UTF8.GetBytes(table))[..24];
                    string query = $"EVALUATE SELECTCOLUMNS({Table(table)}," + string.Join(",", cols.Select((c, i) => Str("c" + i) + "," + Col(new Field(table, c.Name)))) + ")";
                    long row = 0;
                    IEnumerable<object> Rows()
                    {
                        foreach (var values in source.Read(query))
                        {
                            row++;
                            yield return new { row, values = values.Select(Cell).ToArray() };
                        }
                    }
                    var parts = WriteParts(output, Rows(), (part, rows) => new { kind = "rows", table = tableId, part, rows });
                    long afterCount = Convert.ToInt64(source.Read($"EVALUATE ROW(\"n\",COUNTROWS({Table(table)}))").Single()[0], CultureInfo.InvariantCulture);
                    if (row != expected || afterCount != expected) throw new InvalidOperationException($"Contagem divergente em {table}: origem={expected}, exportação={row}, nova leitura={afterCount}. Pacote invalidado.");
                    tableInfo.Add(new TableInfo(tableId, table, cols.Select(c => (object)new { name = c.Name, type = c.Type, hidden = c.Hidden, isKey = c.IsKey, nullable = c.Nullable, expression = c.Expression, format = c.Format, sourceColumn = c.SourceColumn }).ToArray(), row, expected, emptyAllowed, "Import", before.Partitions[table], new { schema = before.TableMetadata[table], desktopSessionDatabaseId = before.Id, desktopSessionDatabaseName = before.Name }, parts));
                }
                source.AssertIdle(); log("Extraindo projeção comercial com a granularidade original do fato...");
                var dimensionSql = Dimensions.Select(k => Str(k) + "," + Dimension(k));
                var componentSql = mapping.Metrics.Where(x => x.Column != null).Select(m => Str(m.Id) + "," + Col(new Field(mapping.FactTable, m.Column!)));
                string projectionSql = "EVALUATE SELECTCOLUMNS(" + Table(mapping.FactTable) + "," + string.Join(",", dimensionSql.Concat(componentSql)) + ")";
                long factRows = 0; string? from = null, to = null;
                var distinct = new Dictionary<string, HashSet<string>>(Dimensions.Where(x => x != "date").ToDictionary(x => x, _ => new HashSet<string>(StringComparer.Ordinal)));
                var monthSet = new HashSet<string>(StringComparer.Ordinal);
                IEnumerable<object> Facts()
                {
                    foreach (var values in source.Read(projectionSql))
                    {
                        factRows++;
                        if (values[0] is not DateTime date) throw new InvalidOperationException("A data comercial deve ser uma coluna de data real. Texto não é convertido por inferência.");
                        string day = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                        from = from == null || string.CompareOrdinal(day, from) < 0 ? day : from;
                        to = to == null || string.CompareOrdinal(day, to) > 0 ? day : to;
                        monthSet.Add(day[..7]);
                        var dimensions = new string[5];
                        for (int i = 1; i < 6; i++)
                        {
                            dimensions[i - 1] = Cell(values[i]) as string ?? throw new InvalidOperationException($"Dimensão {Dimensions[i]} nula na linha {factRows}. Corrija a chave/relacionamento; nenhuma linha foi descartada.");
                            if (dimensions[i - 1].Length > 140) throw new InvalidOperationException($"Dimensão {Dimensions[i]} excede 140 caracteres na linha {factRows}.");
                            distinct[Dimensions[i]].Add(dimensions[i - 1]);
                        }
                        var amounts = new Dictionary<string, string?>(); int n = 6;
                        foreach (var metric in mapping.Metrics.Where(x => x.Column != null)) amounts[metric.Id] = DecimalValue(values[n++], metric.Scale, factRows, metric.Id);
                        yield return new { row = factRows, date = day, region = dimensions[0], client = dimensions[1], product = dimensions[2], category = dimensions[3], state = dimensions[4], values = amounts };
                    }
                }
                var factParts = WriteParts(output, Facts(), (part, rows) => new { kind = "facts", part, rows });
                if (factRows == 0 || from == null || to == null) throw new InvalidOperationException("A projeção comercial está vazia. A publicação inicial de faturamento exige fatos e controles reconciliáveis.");
                long factExpected = Convert.ToInt64(source.Read($"EVALUATE ROW(\"n\",COUNTROWS({Table(mapping.FactTable)}))").Single()[0], CultureInfo.InvariantCulture);
                if (factRows != factExpected) throw new InvalidOperationException("A projeção não preservou a contagem integral do fato.");
                log("Executando controles DAX reais: total, mês, regional, cliente, produto e UF...");
                string referenceDate = DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                var controls = BuildControls(from, to, referenceDate, monthSet, distinct);
                if (DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) != referenceDate) throw new InvalidOperationException("A data de referência mudou durante os controles. Prepare novamente para manter TODAY() consistente.");
                output.Flush(true);
                ValidateControls(bodyPath, controls);
                source.AssertIdle(); var after = source.Inspect();
                if (before.Fingerprint != after.Fingerprint) throw new InvalidOperationException("O esquema ou o estado de atualização do modelo mudou durante a extração. Pacote invalidado; prepare novamente com o modelo estável.");
                var metrics = mapping.Metrics.Select(m => (object)new Dictionary<string, object?>
                {
                    ["id"] = m.Id, ["originalName"] = m.Measure,
                    ["dax"] = before.Measures.First(x => x.Name == m.Measure).Expression,
                    ["unit"] = m.Id == "buyers" ? "count" : "money", ["kind"] = m.Id == "buyers" ? "distinctClient" : "sum",
                    ["scale"] = m.Scale, ["status"] = "validated", ["supportedFilters"] = Dimensions,
                }.Concat(m.Column != null ? new Dictionary<string, object?> { ["component"] = m.Id } : new Dictionary<string, object?>()).ToDictionary(x => x.Key, x => x.Value)).ToList();
                foreach (var key in new[] { "margin", "returns", "buyers" }.Where(k => !mapping.Metrics.Any(x => x.Id == k)))
                    metrics.Add(new { id = key, originalName = key, dax = "", unit = key == "margin" ? "percent" : key == "buyers" ? "count" : "money", kind = "unavailable", scale = 0, status = "unavailable", supportedFilters = Dimensions, reason = "Sem implementação e conciliação específicas neste mapeamento. Expressões originais disponíveis no inventário." });
                var manifest = new
                {
                    kind = "manifest", format = "commercial-insight", formatVersion = 1, sourceId = "commercial-main",
                    model = new { name = mapping.ModelName, id = mapping.SourceId }, extractedAt = DateTimeOffset.UtcNow.ToString("O"), sourceUpdatedAt = before.UpdatedAt,
                    referenceDate, synthetic = false, stableExtraction = true,
                    inventory = new { tables = tableInfo, measures = before.Measures, relationships = before.Relationships, dependencies = before.Dependencies,
                        excluded = new object[] { new { type = "connection-details", reason = "Strings de conexão, credenciais, fontes M e roles de segurança não são exportadas. Acessos não cria permissões no aplicativo." }, new { type = "internal-row-number", reason = "Colunas RowNumber internas do mecanismo não fazem parte dos dados de negócio." } } },
                    projection = new ProjectionInfo(factRows, from, to, $"Uma linha por linha original de {mapping.FactTable}; sem deduplicação. RELATED exige relação muitos-para-um válida. Revisão: {mapping.ReviewNote}", Dimensions, factParts), metrics, controls
                };
                byte[] header = Line(manifest);
                if (header.Length > 1024 * 1024) throw new InvalidOperationException("O inventário excede o limite de 1 MiB do manifesto. Nenhum dado foi truncado; ajuste a capacidade do importador antes de prosseguir.");
                // Flush body before reading it into the final package. No whole package is buffered.
                output.Flush(true);
                using var final = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                final.Write(header);
                output.Dispose();
                using var body = File.OpenRead(bodyPath); body.CopyTo(final, 1024 * 1024); final.Flush(true);
            }
            File.Move(temporary, target, true);
            log($"{tableInfo.Count} tabelas extraídas e preservadas no pacote privado. Cada parte tem SHA-256 e contagem verificável.");
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
            if (File.Exists(bodyPath)) File.Delete(bodyPath);
        }
    }
    private void ValidateControls(string bodyPath, List<object> controls)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(controls, Json));
        var contexts = document.RootElement.EnumerateArray().Select(x => x.Clone()).ToArray();
        var sums = new decimal[contexts.Length]; var counts = new long[contexts.Length];
        var buyers = Enumerable.Range(0, contexts.Length).Select(_ => new HashSet<string>(StringComparer.Ordinal)).ToArray();
        using var reader = new StreamReader(new FileStream(bodyPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite), new UTF8Encoding(false, true));
        while (reader.ReadLine() is { } line)
        {
            using var part = JsonDocument.Parse(line);
            if (part.RootElement.GetProperty("kind").GetString() != "facts") continue;
            foreach (var fact in part.RootElement.GetProperty("rows").EnumerateArray())
            {
                string day = fact.GetProperty("date").GetString()!;
                for (int i = 0; i < contexts.Length; i++)
                {
                    var filters = contexts[i].GetProperty("filters");
                    if (string.CompareOrdinal(day, filters.GetProperty("from").GetString()) < 0 || string.CompareOrdinal(day, filters.GetProperty("to").GetString()) > 0) continue;
                    bool matches = true;
                    foreach (var filter in filters.EnumerateObject()) if (filter.Name != "from" && filter.Name != "to" && fact.GetProperty(filter.Name).GetString() != filter.Value.GetString()) matches = false;
                    if (!matches) continue;
                    string metric = contexts[i].GetProperty("metric").GetString()!;
                    if (metric == "buyers") { buyers[i].Add(fact.GetProperty("client").GetString()!); counts[i]++; }
                    else if (fact.GetProperty("values").TryGetProperty(metric, out var value) && value.ValueKind != JsonValueKind.Null)
                    { sums[i] += decimal.Parse(value.GetString()!, CultureInfo.InvariantCulture); counts[i]++; }
                }
            }
        }
        for (int i = 0; i < contexts.Length; i++)
        {
            var context = contexts[i]; string metric = context.GetProperty("metric").GetString()!;
            decimal? actual = counts[i] == 0 ? null : metric == "buyers" ? buyers[i].Count : sums[i];
            var expectedValue = context.GetProperty("expected");
            decimal? expected = expectedValue.ValueKind == JsonValueKind.Null ? null : decimal.Parse(expectedValue.GetString()!, CultureInfo.InvariantCulture);
            if (actual != expected) throw new InvalidOperationException($"A medida {metric} divergiu no controle {context.GetProperty("context").GetString()}: projeção={actual?.ToString(CultureInfo.InvariantCulture) ?? "BLANK"}; Power BI={expected?.ToString(CultureInfo.InvariantCulture) ?? "BLANK"}. Revise a definição, granularidade e filtros; o pacote não será emitido.");
        }
        log($"{contexts.Length} controles DAX conciliados integralmente com as linhas extraídas. Outros contextos DAX não são automaticamente comprovados.");
    }
    private List<object> BuildControls(string from, string to, string referenceDate, HashSet<string> months, Dictionary<string, HashSet<string>> distinct)
    {
        var result = new List<object>();
        foreach (var metric in mapping.Metrics)
        {
            void Control(string context, string start, string end, string? dimension = null, string? value = null)
            {
                var filters = new Dictionary<string, string> { ["from"] = start, ["to"] = end };
                string date = Col(mapping.Dimensions["date"]);
                string DateDax(string day) => $"DATE({day[..4]},{int.Parse(day.Substring(5, 2), CultureInfo.InvariantCulture)},{int.Parse(day.Substring(8, 2), CultureInfo.InvariantCulture)})";
                var clauses = new List<string> { $"FILTER(ALL({date}),{date}>={DateDax(start)}&&{date}<{DateDax(end)}+1)" };
                if (dimension != null && value != null)
                {
                    filters[dimension] = value;
                    clauses.Add($"TREATAS({{{Str(value)}}},{Col(mapping.Dimensions[dimension])})");
                }
                string dax = $"EVALUATE ROW(\"value\",CALCULATE([{metric.Measure.Replace("]", "]]")}],{string.Join(",", clauses)}))";
                object? answer = source.Read(dax).Single()[0];
                string? expected = metric.Id == "buyers" ? answer == null ? null : Convert.ToDecimal(answer, CultureInfo.InvariantCulture).ToString("0", CultureInfo.InvariantCulture) : DecimalValue(answer, metric.Scale, 0, metric.Id);
                result.Add(new { metric = metric.Id, context, filters, expected, dax, referenceDate, tolerance = "0" });
                source.AssertIdle();
            }
            Control("total", from, to);
            foreach (string month in months.Order(StringComparer.Ordinal))
            {
                var first = DateTime.ParseExact(month + "-01", "yyyy-MM-dd", CultureInfo.InvariantCulture);
                Control("month", first.ToString("yyyy-MM-dd"), first.AddMonths(1).AddDays(-1).ToString("yyyy-MM-dd"));
            }
            // Representative cuts rotate deterministically with the extraction date, while including both boundaries.
            foreach (string key in new[] { "region", "client", "product", "state" })
            {
                var values = distinct[key].Order(StringComparer.Ordinal).ToArray();
                foreach (string value in new[] { values.First(), values[values.Length / 2], values.Last() }.Distinct(StringComparer.Ordinal))
                    Control(key, from, to, key, value);
            }
        }
        return result;
    }
    internal static object? Cell(object? value) => value switch
    {
        null or DBNull => null, bool b => b, DateTime d => d.ToString("yyyy-MM-ddTHH:mm:ss.fffffff", CultureInfo.InvariantCulture),
        byte[] => throw new InvalidOperationException("Coluna binária não suportada; nenhuma conversão silenciosa foi aplicada."),
        double n when !double.IsFinite(n) => throw new InvalidOperationException("Valor numérico não finito no modelo."),
        double n => n.ToString("R", CultureInfo.InvariantCulture), float n => n.ToString("R", CultureInfo.InvariantCulture),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture), _ => value.ToString()
    };
    private static string? DecimalValue(object? value, int scale, long row, string component)
    {
        if (value == null || value is DBNull) return null;
        decimal number = Convert.ToDecimal(value, CultureInfo.InvariantCulture);
        if (decimal.Round(number, scale, MidpointRounding.ToEven) != number) throw new InvalidOperationException($"Componente {component}, linha {row}: precisão superior a {scale} casas. Corrija a escala inicial; o preparador não arredonda valores comerciais silenciosamente.");
        decimal scaled = number * (decimal)Math.Pow(10, scale);
        if (Math.Abs(scaled) > 9007199254740991m) throw new InvalidOperationException($"Componente {component}, linha {row}: valor excede a faixa inteira segura suportada pelo servidor.");
        return number.ToString("F" + scale, CultureInfo.InvariantCulture);
    }
    private static byte[] Line(object value) => Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value, Json) + "\n");
    private static List<PartInfo> WriteParts(Stream output, IEnumerable<object> rows, Func<int, object[], object> envelope)
    {
        var parts = new List<PartInfo>(); var batch = new List<object>(); int index = 1; int estimatedBytes = 0;
        void Flush()
        {
            if (batch.Count == 0) return;
            byte[] bytes = Line(envelope(index, batch.ToArray()));
            if (bytes.Length > 1024 * 1024) throw new InvalidOperationException("Uma parte excedeu 1 MiB. Uma linha pode ser larga demais; nenhum conteúdo foi truncado.");
            output.Write(bytes); parts.Add(new PartInfo(index++, batch.Count, bytes.Length, Hash(bytes))); batch.Clear(); estimatedBytes = 0;
        }
        foreach (object row in rows)
        {
            int rowBytes = JsonSerializer.SerializeToUtf8Bytes(row, Json).Length + 1;
            if (rowBytes > 1024 * 1024 - 2048) throw new InvalidOperationException("Uma linha excede o tamanho seguro de parte. Nenhum campo foi truncado; dimensione o formato e o importador antes de prosseguir.");
            if (batch.Count > 0 && estimatedBytes + rowBytes > 1024 * 1024 - 2048) Flush();
            batch.Add(row); estimatedBytes += rowBytes; if (batch.Count == 100) Flush();
        }
        Flush(); return parts;
    }
    internal static void SelfTest()
    {
        using var output = new MemoryStream();
        var rows = Enumerable.Range(1, 201).Select(n => (object)new { row = n, values = new object?[] { "0001", "São João \"Sul\"\nlinha", null, true, "-12.3400" } });
        var parts = WriteParts(output, rows, (part, values) => new { kind = "rows", table = "t-test", part, rows = values });
        if (parts.Count != 3 || parts.Sum(x => x.rows) != 201) throw new InvalidOperationException("Partes incorretas.");
        var lines = Encoding.UTF8.GetString(output.ToArray()).Split('\n', StringSplitOptions.RemoveEmptyEntries);
        for (int i = 0; i < lines.Length; i++) if (Hash(Encoding.UTF8.GetBytes(lines[i] + "\n")) != parts[i].sha256) throw new InvalidOperationException("Checksum incorreto.");
        if ((string?)Cell("0001") != "0001" || (string?)Cell(12.3400m) != "12.3400" || Cell(null) != null) throw new InvalidOperationException("Preservação incorreta.");
        using var wide = new MemoryStream();
        var wideParts = WriteParts(wide, Enumerable.Range(1, 3).Select(n => (object)new { row = n, values = new[] { new string('x', 600000) } }), (part, values) => new { kind = "rows", table = "wide", part, rows = values });
        if (wideParts.Count != 3 || wideParts.Any(p => p.bytes > 1024 * 1024)) throw new InvalidOperationException("Divisão por bytes incorreta.");
        try { DecimalValue(1.001m, 2, 1, "revenue"); throw new InvalidOperationException("Precisão não bloqueada."); } catch (InvalidOperationException ex) when (ex.Message.Contains("precisão")) { }
        var errorPath = Path.Combine(Path.GetTempPath(), "ci-preparador-selftest.txt"); File.WriteAllText(errorPath, "PASS: multipart checksums, row count, Unicode, leading zeros, nulls, exact decimals, excess precision rejection.");
    }
}
