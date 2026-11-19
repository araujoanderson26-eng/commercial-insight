using System.Globalization;
using System.Text;
using System.Text.Json;

namespace ComercialInsight.Preparador;

internal sealed record NativeContext(string Context, Dictionary<string, string> Filters);
internal sealed record NativeResult(decimal? Gross, decimal Returns, decimal Revenue, long? Buyers, long Records)
{
    internal decimal? Value(string id) => id switch { "gross" => Gross, "returns" => Returns, "revenue" => Revenue, "buyers" => Buyers, _ => throw new InvalidDataException("Métrica nativa desconhecida.") };
}

/// <summary>Set-based implementation of the explicitly recognized relationship component; no monetary joins.</summary>
internal sealed class NativeDataSet(NativePlan plan)
{
    private sealed record Sale(string? Date, string? Client, string? Product, string? Category, string? State, string? Municipality, decimal? Amount);
    private sealed record Returned(string? Date, string? Client, string? State, decimal? Amount);
    private sealed record Customer(string? Client, string? Representative, string? State);
    private sealed record Region(string? State, string? Regional, string? Manager);
    private readonly List<Sale> sales = [];
    private readonly List<Returned> returns = [];
    private readonly List<Customer> customers = [];
    private readonly List<Region> regions = [];
    private readonly HashSet<string?> calendar = new(StringComparer.Ordinal), municipalities = new(StringComparer.Ordinal), latitudes = new(StringComparer.Ordinal), repArea = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Dictionary<string, int>> columnIndexes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> pool = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<string>> labels = plan.Bindings.Keys.Where(k => k != "date").ToDictionary(k => k, _ => new HashSet<string>(StringComparer.Ordinal), StringComparer.Ordinal);
    private decimal absoluteScaled;
    private long retainedRows, retainedCharacters;
    internal string? From { get; private set; }
    internal string? To { get; private set; }
    internal long FactRows => sales.Count + returns.Count;
    internal NativeContract Contract => plan.Contract;
    internal static string? Key(string? text)
    {
        if (text == null) return null;
        text = text.Normalize(NormalizationForm.FormC).TrimEnd();
        if (text.Length == 0) return null;
        // ECMAScript full casing expands these characters. Such keys require a new explicit collation contract.
        const string expansions = "\u00df\u0149\u01f0\u0390\u03b0\u0587\u1e96\u1e97\u1e98\u1e99\u1e9a\u1f50\u1f52\u1f54\u1f56\u1fb6\u1fc6\u1fd2\u1fd3\u1fd6\u1fd7\u1fe2\u1fe3\u1fe4\u1fe6\u1fe7\u1ff6\ufb00\ufb01\ufb02\ufb03\ufb04\ufb05\ufb06\ufb13\ufb14\ufb15\ufb16\ufb17";
        if (text.Any(c => expansions.Contains(c) || c is >= '\u1f80' and <= '\u1faf' || c is '\u1fb3' or '\u1fbc' or '\u1fc3' or '\u1fcc' or '\u1ff3' or '\u1ffc' or '\u1fb7' or '\u1fc7' or '\u1ff7'))
            throw new InvalidDataException("Chave com expansão de caixa Unicode não suportada. Nenhum valor foi alterado.");
        return text.ToUpperInvariant();
    }
    private string? Intern(string? value)
    {
        string? key = Key(value); if (key == null) return null;
        if (pool.TryGetValue(key, out var known)) return known;
        retainedCharacters += key.Length;
        if (retainedCharacters > 120_000_000) throw Capacity();
        pool.Add(key, key); return key;
    }
    private static InvalidOperationException Capacity() => new("O modelo excede a capacidade de conciliação local desta versão (2 milhões de registros relacionais ou 1,5 GiB). Nenhum dado foi truncado; o pacote não foi publicado.");
    internal void Add(string table, ColumnInfo[] columns, object?[] values)
    {
        if (!plan.TableNames.ContainsKey(table)) return;
        if (!columnIndexes.TryGetValue(table, out var indexes)) { indexes = columns.Select((c, i) => (c.Name, Index: i)).ToDictionary(c => c.Name, c => c.Index, StringComparer.Ordinal); columnIndexes.Add(table, indexes); }
        int Index(string name) => indexes.TryGetValue(name, out int i) ? i : throw new InvalidDataException("Coluna vinculada ausente: " + name);
        string? Text(string name) => NativeExport.Cell(values[Index(name)]) as string;
        string? K(string name) => Intern(Text(name));
        string? Date(string name)
        {
            string? text = Text(name); if (text == null) return null;
            if (!DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var date) || date.TimeOfDay != TimeSpan.Zero)
                throw new InvalidDataException("Data de relacionamento fora da meia-noite ou inválida em " + plan.TableNames[table] + "[" + name + "]. O horário não será descartado.");
            return date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
        decimal? Money(string name)
        {
            object? value = values[Index(name)]; if (value == null || value is DBNull) return null;
            string text = NativeExport.Cell(value) as string ?? throw new InvalidDataException("Valor monetário não numérico.");
            if (!decimal.TryParse(text, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var amount)) throw new InvalidDataException("Valor monetário fora da precisão decimal suportada.");
            decimal factor = Pow10(plan.Contract.Scale);
            if (decimal.Truncate(amount * factor) != amount * factor) throw new InvalidDataException("Precisão monetária superior à escala original validada; nenhum arredondamento aplicado.");
            absoluteScaled += Math.Abs(amount * factor);
            if (absoluteScaled > 9007199254740991m) throw new InvalidDataException("Soma absoluta monetária excede a faixa inteira segura do servidor.");
            return amount;
        }
        void Coverage(string? date) { if (date == null) return; if (From == null || string.CompareOrdinal(date, From) < 0) From = date; if (To == null || string.CompareOrdinal(date, To) > 0) To = date; }
        var m = plan.Contract;
        if (table == m.Sales.Table) { string? date = Date(m.Sales.Date); Coverage(date); sales.Add(new(date, K(m.Sales.Client), K(m.Sales.Product), K(m.Sales.Category), K(m.Sales.State), K(m.Sales.Municipality), Money(m.Sales.Amount))); }
        else if (table == m.Returns.Table) { string? date = Date(m.Returns.Date); Coverage(date); returns.Add(new(date, K(m.Returns.Client), K(m.Returns.State), Money(m.Returns.Amount))); }
        else if (table == m.Customers.Table) customers.Add(new(K(m.Customers.Client), K(m.Customers.Representative), K(m.Customers.State)));
        else if (table == m.Calendar.Table) calendar.Add(Date(m.Calendar.Date));
        else if (table == m.Regions.Table) regions.Add(new(K(m.Regions.State), K(m.Regions.Regional), m.Regions.Manager == null ? null : K(m.Regions.Manager)));
        else if (table == m.Municipalities.Table) municipalities.Add(K(m.Municipalities.Name));
        else if (table == m.Latitudes.Table) latitudes.Add(K(m.Latitudes.State));
        else if (table == m.RepArea.Table) repArea.Add(K(m.RepArea.State));
        foreach (var binding in plan.Bindings.Where(b => b.Key != "date" && NativeModel.TableId(b.Value.Table) == table))
        {
            string? label = Text(binding.Value.Column);
            if (!string.IsNullOrWhiteSpace(label)) { if (label.Length > 200) throw new InvalidDataException("Rótulo de filtro excede 200 caracteres: " + binding.Key); labels[binding.Key].Add(label); }
        }
        retainedRows++;
        if (retainedRows > 2_000_000 || retainedRows % 10_000 == 0 && GC.GetTotalMemory(false) > 1536L * 1024 * 1024) throw Capacity();
    }
    internal NativeResult Evaluate(IReadOnlyDictionary<string, string> filters)
    {
        string from = filters["from"], to = filters["to"];
        string? Filter(string name) => filters.TryGetValue(name, out var v) && v.Length != 0 ? Key(v) : null;
        string? representative = Filter("region"), client = Filter("client"), product = Filter("product"), category = Filter("category"), state = Filter("state"), regional = Filter("regional"), manager = Filter("manager");
        bool geoActive = regional != null || manager != null;
        var geo = regions.Where(r => (regional == null || r.Regional == regional) && (manager == null || r.Manager == manager)).Select(r => r.State).ToHashSet(StringComparer.Ordinal);
        // Only filters originating on Customers propagate back to Sales. A cycle from Sales must never prune its own origin.
        var representativeClients = customers.Where(c => (representative == null || c.Representative == representative) && (!geoActive || geo.Contains(c.State))).Select(c => c.Client).ToHashSet(StringComparer.Ordinal);
        bool salesFilterActive = client != null || product != null || category != null || state != null;
        bool DateMatches(string? date) => date != null && string.CompareOrdinal(date, from) >= 0 && string.CompareOrdinal(date, to) <= 0 && calendar.Contains(date);
        decimal? gross = null; long records = 0;
        var visibleClients = new HashSet<string?>(StringComparer.Ordinal);
        foreach (var s in sales)
        {
            if (!DateMatches(s.Date) || client != null && s.Client != client || product != null && s.Product != product || category != null && s.Category != category || state != null && s.State != state || geoActive && !geo.Contains(s.State) || representative != null && !representativeClients.Contains(s.Client)) continue;
            records++; visibleClients.Add(s.Client); if (s.Amount != null) gross = (gross ?? 0) + s.Amount;
        }
        // Calendar and Regions have direct paths to Returns. They do not activate a competing Sales cohort.
        // An explicit Sales-column filter activates Sales->Customers->Returns; its cohort then includes the actual Sales context/date.
        long? distinctBuyers = records == 0 ? null : visibleClients.Count;
        if (salesFilterActive) visibleClients.IntersectWith(representativeClients);
        decimal returned = 0;
        foreach (var r in returns)
            if (DateMatches(r.Date) && (!geoActive || geo.Contains(r.State)) && (representative == null || representativeClients.Contains(r.Client)) && (!salesFilterActive || visibleClients.Contains(r.Client))) returned += r.Amount ?? 0;
        return new(gross, returned, (gross ?? 0) - returned, distinctBuyers, records);
    }
    internal List<NativeContext> Contexts()
    {
        if (From == null || To == null || FactRows == 0) throw new InvalidOperationException("Fatos comerciais sem cobertura de datas.");
        var result = new List<NativeContext>();
        void Add(string context, string from, string to, params (string Key, string Value)[] cuts)
        { var filters = new Dictionary<string, string>(StringComparer.Ordinal) { ["from"] = from, ["to"] = to }; foreach (var c in cuts) filters[c.Key] = c.Value; result.Add(new(context, filters)); }
        Add("total", From, To);
        var month = DateOnly.ParseExact(From[..7] + "-01", "yyyy-MM-dd", CultureInfo.InvariantCulture);
        var end = DateOnly.ParseExact(To, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        for (; month <= end; month = month.AddMonths(1)) Add("month", month.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), month.AddMonths(1).AddDays(-1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        foreach (var key in new[] { "region", "client", "product", "category", "state", "regional", "manager" })
        {
            if (!labels.TryGetValue(key, out var labelSet)) continue;
            var values = labelSet.Order(StringComparer.Ordinal).ToArray();
            if (values.Length == 0) throw new InvalidOperationException("A dimensão " + key + " não tem rótulos não vazios para conciliação.");
            foreach (string value in new[] { values[0], values[values.Length / 2], values[^1] }.Distinct(StringComparer.Ordinal)) Add(key, From, To, (key, value));
        }
        // Real combinations exercise propagation at the same time as user scope restrictions.
        foreach (var keys in new[] { new[] { "region", "product" }, new[] { "client", "category" }, new[] { "regional", "state" }, new[] { "manager", "region" }, new[] { "region", "client", "product", "category", "state" } })
        {
            var cuts = keys.Where(labels.ContainsKey).Select(k => (Key: k, Value: labels[k].Order(StringComparer.Ordinal).FirstOrDefault())).ToArray();
            if (cuts.Length == 0 || cuts.Any(c => c.Value == null)) continue;
            Add(keys[0], From, To, cuts.Select(c => (c.Key, c.Value!)).ToArray());
        }
        return result;
    }
    internal static decimal Pow10(int scale) { decimal n = 1; for (int i = 0; i < scale; i++) n *= 10; return n; }
    internal static void SelfTest()
    {
        NativeSelfTests.Run();
        if (Key("São João  ") != Key("SÃO JOÃO") || Key("") != null || Key("0001") == Key("1")) throw new InvalidDataException("Chaves nativas inconsistentes.");
        if (!NativeModel.DirectSum("SUM('Sales'[Amount])", out var f) || f != new Field("Sales", "Amount") || NativeModel.DirectSum("SUM('Sales'[Amount])-1", out _) || !NativeModel.BlankZeroSum("IF(ISBLANK(SUM('Returns'[Amount])),0,SUM('Returns'[Amount]))", out _)) throw new InvalidDataException("Reconhecimento de receita inválido.");
        if ((string?)NativeExport.Cell(1E-7) != "0.0000001" || (string?)NativeExport.Cell(1.2E20) != "120000000000000000000") throw new InvalidDataException("Expansão decimal não exata.");
    }
}
