namespace ComercialInsight.Preparador;

/// <summary>Contains search, preserving the exact typed object selected from model metadata.</summary>
internal sealed class SearchPicker : UserControl
{
    private readonly TextBox search = new() { Dock = DockStyle.Top, PlaceholderText = "Pesquisar pelo nome..." };
    private readonly ComboBox choice = new() { Dock = DockStyle.Bottom, DropDownStyle = ComboBoxStyle.DropDownList };
    private object[] all = [];
    private bool updating;
    internal event EventHandler? SelectedValueChanged;
    [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    internal object? SelectedItem { get => choice.SelectedItem; set { if (value != null && !choice.Items.Contains(value)) search.Clear(); choice.SelectedItem = value; } }
    internal string? SelectedName => SelectedItem?.ToString();
    internal SearchPicker()
    {
        Width = 520; Height = 58; Margin = new Padding(0, 2, 0, 7); MinimumSize = new Size(220, 58); Anchor = AnchorStyles.Left | AnchorStyles.Right;
        Controls.Add(choice); Controls.Add(search);
        search.TextChanged += (_, _) => Filter();
        choice.SelectedValueChanged += (_, _) => { if (!updating) SelectedValueChanged?.Invoke(this, EventArgs.Empty); };
    }
    internal void SetItems(IEnumerable<object> items)
    {
        all = items.OrderBy(x => x.ToString(), StringComparer.Create(System.Globalization.CultureInfo.GetCultureInfo("pt-BR"), true)).ToArray();
        Filter();
    }
    private void Filter()
    {
        object? selected = choice.SelectedItem; updating = true;
        choice.BeginUpdate(); choice.Items.Clear();
        choice.Items.AddRange(all.Where(x => (x.ToString() ?? "").Contains(search.Text.Trim(), StringComparison.CurrentCultureIgnoreCase)).ToArray());
        choice.SelectedItem = selected; choice.EndUpdate(); updating = false;
        if (!Equals(selected, choice.SelectedItem)) SelectedValueChanged?.Invoke(this, EventArgs.Empty);
    }
    internal static void SelfTest()
    {
        using var picker = new SearchPicker();
        picker.SetItems(["Zulu", "Base Clientes", "Alfa"]); picker.SelectedItem = "Base Clientes";
        picker.search.Text = "clientes";
        if (picker.choice.Items.Count != 1 || picker.SelectedName != "Base Clientes") throw new InvalidOperationException("Picker self-test: busca por parte do nome.");
        picker.search.Clear();
        if (picker.choice.Items[0]?.ToString() != "Alfa" || picker.SelectedName != "Base Clientes") throw new InvalidOperationException("Picker self-test: ordenação e seleção.");
    }
}

internal sealed class MappingForm : Form
{
    internal Mapping? Result { get; private set; }
    private readonly SearchPicker fact = new();
    private readonly Dictionary<string, SearchPicker> dimensions = [], measureFields = [], valueFields = [];
    private readonly NumericUpDown scale = new() { Minimum = 0, Maximum = 6, Value = 2 };
    private readonly CheckBox reviewed = new() { AutoSize = true, MaximumSize = new Size(520, 0), Text = "Revisei a granularidade, a aditividade e a propagação dos filtros." };
    private readonly TextBox note = new() { Width = 520, PlaceholderText = "Responsável e fundamento da regra comercial (obrigatório)" };
    private readonly TextBox modelName = new() { Width = 520, PlaceholderText = "Nome da fonte comercial" };
    private readonly CheckedListBox allowEmpty = new() { Width = 520, Height = 100, CheckOnClick = true };
    private readonly ErrorProvider errors = new() { BlinkStyle = ErrorBlinkStyle.NeverBlink };
    private const string Unavailable = "(indisponível)";
    internal MappingForm(ModelInfo model, Mapping? existing)
    {
        Text = "Configurar mapeamento Comercial Insight"; Width = 840; Height = 800; MinimumSize = new Size(700, 600); StartPosition = FormStartPosition.CenterParent;
        errors.ContainerControl = this;
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, AutoScroll = true, ColumnCount = 2, Padding = new Padding(14, 14, 32, 14) };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        void Add(string label, Control control)
        {
            int row = grid.RowCount++; grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            grid.Controls.Add(new Label { Text = label, AutoSize = true, MaximumSize = new Size(180, 0), Padding = new Padding(0, 8, 0, 0) }, 0, row);
            grid.Controls.Add(control, 1, row);
        }
        Add("Compatibilidade", new Label { Text = "A projeção atual usa um fato. Medidas que combinam faturamento e devoluções em tabelas diferentes precisam de implementação própria e conciliação. Não associe medidas distintas à mesma coluna para contornar esse limite.", AutoSize = true, MaximumSize = new Size(520, 0) });
        Add("Identidade da fonte", modelName);
        fact.SetItems(model.TableNames.Cast<object>()); Add("Tabela fato", fact);
        var labels = new Dictionary<string, string> { ["date"] = "Data do indicador", ["region"] = "Regional / representante", ["client"] = "Chave única do cliente", ["product"] = "Produto", ["category"] = "Categoria", ["state"] = "UF" };
        foreach (var (key, label) in labels)
        {
            var picker = new SearchPicker(); picker.SetItems(model.Columns.Select(x => new Field(x.Table, x.Name)).Distinct().Cast<object>());
            dimensions.Add(key, picker); Add(label, picker);
        }
        foreach (string id in new[] { "revenue", "returns", "buyers" })
        {
            var picker = new SearchPicker(); picker.SetItems(new[] { Unavailable }.Concat(model.Measures.Select(x => x.Name).Distinct()).Cast<object>()); picker.SelectedItem = Unavailable;
            measureFields.Add(id, picker); Add(id == "revenue" ? "Medida de faturamento *" : id == "returns" ? "Medida de devoluções" : "Clientes distintos", picker);
            if (id == "buyers") continue;
            var value = new SearchPicker(); valueFields.Add(id, value); Add(id == "revenue" ? "Coluna aditiva faturamento *" : "Coluna aditiva devoluções", value);
        }
        fact.SelectedValueChanged += (_, _) =>
        {
            foreach (var value in valueFields.Values)
            {
                value.SetItems(new[] { Unavailable }.Concat(model.Columns.Where(x => x.Table == fact.SelectedName && new[] { "Int64", "Decimal", "Double" }.Contains(x.Type)).Select(x => x.Name)).Cast<object>());
                if (value.SelectedItem == null) value.SelectedItem = Unavailable;
            }
        };
        allowEmpty.Items.AddRange(model.TableNames.OrderBy(x => x, StringComparer.CurrentCultureIgnoreCase).Cast<object>().ToArray());
        Add("Casas decimais", scale); Add("Tabelas autorizadas a ficarem vazias", allowEmpty); Add("Revisão inicial", reviewed); Add("Evidência da revisão", note);
        var save = new Button { Text = "Salvar mapeamento", Width = 190, Height = 36 };
        save.Click += (_, _) =>
        {
            errors.Clear(); var messages = new List<string>();
            void Invalid(Control control, string message) { errors.SetError(control, message); messages.Add(message); }
            if (modelName.Text.Trim().Length is < 2 or > 200) Invalid(modelName, "Fonte: informe um nome entre 2 e 200 caracteres.");
            if (fact.SelectedItem == null) Invalid(fact, "Tabela fato: selecione uma tabela do modelo.");
            foreach (var (key, picker) in dimensions) if (picker.SelectedItem is not Field) Invalid(picker, labels[key] + ": selecione uma coluna do modelo.");
            if (measureFields["revenue"].SelectedItem == null || measureFields["revenue"].SelectedName == Unavailable) Invalid(measureFields["revenue"], "Faturamento: selecione a medida DAX original.");
            if (valueFields["revenue"].SelectedItem == null || valueFields["revenue"].SelectedName == Unavailable) Invalid(valueFields["revenue"], "Faturamento: selecione a coluna aditiva equivalente à medida.");
            foreach (var (id, picker) in measureFields)
                if (id != "buyers" && picker.SelectedItem != null && picker.SelectedName != Unavailable && (valueFields[id].SelectedItem == null || valueFields[id].SelectedName == Unavailable))
                    Invalid(valueFields[id], (id == "returns" ? "Devoluções" : "Faturamento") + ": selecione a coluna equivalente ou deixe o indicador indisponível.");
            if (!reviewed.Checked) Invalid(reviewed, "Confirme a revisão das regras e relacionamentos.");
            if (note.Text.Trim().Length is < 12 or > 500) Invalid(note, "Revisão: descreva o responsável e a regra usando 12 a 500 caracteres.");
            if (messages.Count != 0) { MessageBox.Show(this, string.Join(Environment.NewLine, messages), "Revise os campos indicados", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            var metrics = measureFields.Where(x => x.Value.SelectedItem != null && x.Value.SelectedName != Unavailable)
                .Select(x => new MetricMapping(x.Key, x.Value.SelectedName!, x.Key == "buyers" ? null : valueFields[x.Key].SelectedName, x.Key == "buyers" ? 0 : (int)scale.Value)).ToList();
            string sourceId = existing != null && Guid.TryParse(existing.SourceId, out _) ? existing.SourceId : Guid.NewGuid().ToString();
            Result = new Mapping(modelName.Text.Trim(), fact.SelectedName!, dimensions.ToDictionary(x => x.Key, x => (Field)x.Value.SelectedItem!), metrics, true, note.Text.Trim(), sourceId, allowEmpty.CheckedItems.Cast<string>().ToList());
            DialogResult = DialogResult.OK;
        };
        Add("", save); Controls.Add(grid);
        if (existing == null) return;
        modelName.Text = existing.ModelName; fact.SelectedItem = existing.FactTable;
        foreach (var (key, picker) in dimensions) picker.SelectedItem = existing.Dimensions.GetValueOrDefault(key);
        foreach (var metric in existing.Metrics)
        {
            if (measureFields.TryGetValue(metric.Id, out var measure)) measure.SelectedItem = metric.Measure;
            if (metric.Column != null && valueFields.TryGetValue(metric.Id, out var value)) value.SelectedItem = metric.Column;
        }
        scale.Value = Math.Clamp(existing.Metrics.FirstOrDefault(x => x.Id == "revenue")?.Scale ?? 2, 0, 6);
        reviewed.Checked = existing.AdditivityReviewed; note.Text = existing.ReviewNote;
        for (int i = 0; i < allowEmpty.Items.Count; i++) allowEmpty.SetItemChecked(i, existing.AllowEmptyTables?.Contains(allowEmpty.Items[i]!.ToString()!) == true);
    }
    protected override void Dispose(bool disposing) { if (disposing) errors.Dispose(); base.Dispose(disposing); }
}
