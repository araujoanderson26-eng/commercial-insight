using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ComercialInsight.Preparador;

internal sealed record NativeSales(string Table, string Date, string Client, string Product, string Category, string State, string Municipality, string Amount);
internal sealed record NativeReturns(string Table, string Date, string Client, string Product, string Category, string State, string Amount);
internal sealed record NativeCustomers(string Table, string Client, string Representative, string State);
internal sealed record NativeCalendar(string Table, string Date);
internal sealed record NativeRegions(string Table, string State, string Regional, string? Manager);
internal sealed record NativeMunicipalities(string Table, string Name);
internal sealed record NativeStateTable(string Table, string State);
internal sealed record NativeRecipe(string Measure, string Dax, string Kind);
internal sealed record NativeRecipes(NativeRecipe Gross, NativeRecipe Returns, NativeRecipe Revenue, NativeRecipe Buyers);
internal sealed record NativeContract(string Kind, int Scale, NativeSales Sales, NativeReturns Returns, NativeCustomers Customers,
    NativeCalendar Calendar, NativeRegions Regions, NativeMunicipalities Municipalities, NativeStateTable Latitudes, NativeStateTable RepArea, NativeRecipes Recipes);
internal sealed record NativePlan(NativeContract Contract, Dictionary<string, Field> Bindings, Dictionary<string, string> TableNames,
    string GrossTable, string ReturnsTable, string CustomerTable, string CalendarTable, string RegionTable, string MunicipalityTable, string LatitudeTable, string RepAreaTable);

/// <summary>A small, explicit semantic contract. It recognizes expression syntax and real keys, never formulas by labels.</summary>
internal static class NativeModel
{
    private const string Reference = @"(?:'(?<table>(?:[^']|'')+)'|(?<table>[\p{L}_][\p{L}\p{N}_]*))\s*\[(?<column>(?:[^\]]|\]\])+)\]";
    private sealed record Relation(string Name, bool Active, string FromTable, string FromColumn, string FromCardinality, string ToTable, string ToColumn, string ToCardinality, string Direction);
    internal static string TableId(string name) => "t-" + PackageWriter.Hash(Encoding.UTF8.GetBytes(name))[..24];
    internal static NativePlan? Recognize(ModelInfo model, Mapping mapping, Action<string>? log = null)
    {
        var byName = model.Measures.ToDictionary(x => x.Name, StringComparer.OrdinalIgnoreCase);
        var revenueMapping = mapping.Metrics.SingleOrDefault(x => x.Id == "revenue");
        if (revenueMapping == null || !byName.TryGetValue(revenueMapping.Measure, out var net)) return null;
        var difference = Regex.Match(Clean(net.Expression), @"^\s*\[(?<gross>(?:[^\]]|\]\])+)\]\s*-\s*\[(?<returns>(?:[^\]]|\]\])+)\]\s*$", RegexOptions.CultureInvariant);
        if (!difference.Success) return null;
        string GrossName = difference.Groups["gross"].Value.Replace("]]", "]"), ReturnsName = difference.Groups["returns"].Value.Replace("]]", "]");
        if (!byName.TryGetValue(GrossName, out var gross) || !byName.TryGetValue(ReturnsName, out var returned) || !DirectSum(gross.Expression, out var grossSource) || !BlankZeroSum(returned.Expression, out var returnSource))
            throw Incompatible("A medida líquida mudou: o contrato precisa de uma soma bruta menos uma soma de devoluções com BLANK convertido em zero. As expressões atuais não correspondem à regra validada.");
        if (grossSource.Table == returnSource.Table) return null;
        if (!string.Equals(grossSource.Table, mapping.FactTable, StringComparison.Ordinal)) throw Incompatible("A soma bruta não utiliza a tabela fato salva. O perfil foi preservado; revise a mudança do PBIX.");
        var returnsMapping = mapping.Metrics.SingleOrDefault(x => x.Id == "returns");
        if (returnsMapping != null && !string.Equals(returnsMapping.Measure, returned.Name, StringComparison.OrdinalIgnoreCase)) throw Incompatible("A medida de devoluções salva não é a mesma deduzida pela medida líquida. Nenhuma substituição foi aplicada.");
        var buyersMapping = mapping.Metrics.SingleOrDefault(x => x.Id == "buyers") ?? throw Incompatible("O perfil não possui medida de clientes distintos para o contrato relacional.");
        if (!byName.TryGetValue(buyersMapping.Measure, out var buyers) || !DirectDistinct(buyers.Expression, out var buyerSource) || buyerSource.Table != grossSource.Table)
            throw Incompatible("A expressão de clientes precisa ser DISTINCTCOUNT da chave do fato, sem filtro implícito de ano atual. O nome da medida não determina essa regra.");
        Field Required(string key)
        {
            if (!mapping.Dimensions.TryGetValue(key, out var field) || !model.Columns.Any(c => c.Table == field.Table && c.Name == field.Column)) throw Incompatible("A dimensão salva " + key + " não existe no modelo atual.");
            return field;
        }
        var date = Required("date"); var representative = Required("region");
        var client = Required("client"); var product = Required("product"); var category = Required("category"); var state = Required("state");
        if (new[] { client, product, category, state }.Any(f => f.Table != grossSource.Table) || client != buyerSource) throw Incompatible("Cliente, produto, categoria e UF do contrato devem usar as colunas salvas no fato bruto; a medida de clientes deve contar a mesma chave.");
        var relations = model.Relationships.Select(Parse).Where(r => r.Active).ToArray();
        Relation One(string message, Func<Relation, bool> test)
        {
            var matches = relations.Where(test).ToArray(); if (matches.Length != 1) throw Incompatible(message + ": esperado um relacionamento ativo inequívoco; encontrados " + matches.Length + "."); return matches[0];
        }
        static bool OneDirection(Relation r) => r.Direction == "OneDirection";
        static bool Both(Relation r) => r.Direction == "BothDirections";
        string OtherColumn(Relation r, string table) => r.FromTable == table ? r.ToColumn : r.FromColumn;
        string OtherTable(Relation r, string table) => r.FromTable == table ? r.ToTable : r.FromTable;
        string LocalColumn(Relation r, string table) => r.FromTable == table ? r.FromColumn : r.ToColumn;
        bool Joins(Relation r, string a, string ac, string b, string? bc = null) =>
            r.FromTable == a && r.FromColumn == ac && r.ToTable == b && (bc == null || r.ToColumn == bc) ||
            r.ToTable == a && r.ToColumn == ac && r.FromTable == b && (bc == null || r.FromColumn == bc);
        var salesDate = One("Data comercial das vendas", r => r.FromTable == grossSource.Table && r.ToTable == date.Table && r.ToColumn == date.Column && r.FromCardinality == "Many" && r.ToCardinality == "One" && OneDirection(r));
        var returnsDate = One("Data comercial das devoluções", r => r.FromTable == returnSource.Table && r.ToTable == date.Table && r.ToColumn == date.Column && r.FromCardinality == "Many" && r.ToCardinality == "One" && OneDirection(r));
        var customerBridge = One("Carteira e representantes", r => Joins(r, grossSource.Table, client.Column, representative.Table) && Both(r));
        string customerKey = OtherColumn(customerBridge, grossSource.Table);
        var returnedCustomer = One("Clientes das devoluções", r => r.FromTable == returnSource.Table && r.ToTable == representative.Table && r.ToColumn == customerKey && OneDirection(r));
        var regionBridge = One("UF e regional das vendas", r => r.FromTable == grossSource.Table && r.FromColumn == state.Column && r.ToCardinality == "One" && OneDirection(r));
        string regionsTable = regionBridge.ToTable, regionState = regionBridge.ToColumn;
        var returnRegion = One("UF das devoluções", r => r.FromTable == returnSource.Table && r.ToTable == regionsTable && r.ToColumn == regionState && OneDirection(r));
        var customerRegion = One("UF da carteira", r => r.FromTable == representative.Table && r.ToTable == regionsTable && r.ToColumn == regionState && OneDirection(r));
        var municipalityBridge = One("Municípios das vendas", r => Both(r) && (r.FromTable == grossSource.Table || r.ToTable == grossSource.Table) && OtherTable(r, grossSource.Table) != representative.Table);
        string municipalityTable = OtherTable(municipalityBridge, grossSource.Table), salesMunicipality = LocalColumn(municipalityBridge, grossSource.Table), municipalityKey = OtherColumn(municipalityBridge, grossSource.Table);
        var latitudeBridge = One("Propagação de UF da carteira", r => Both(r) && Joins(r, representative.Table, customerRegion.FromColumn, r.FromTable == representative.Table ? r.ToTable : r.FromTable) && OtherTable(r, representative.Table) != grossSource.Table);
        string latitudeTable = OtherTable(latitudeBridge, representative.Table), latitudeState = OtherColumn(latitudeBridge, representative.Table);
        var repAreaBridge = One("Propagação de UF da área comercial", r => Both(r) && (r.FromTable == latitudeTable && r.FromColumn == latitudeState || r.ToTable == latitudeTable && r.ToColumn == latitudeState) && OtherTable(r, latitudeTable) != representative.Table);
        string repAreaTable = OtherTable(repAreaBridge, latitudeTable), repAreaState = OtherColumn(repAreaBridge, latitudeTable);
        _ = One("UF e regional das latitudes", r => r.FromTable == latitudeTable && r.FromColumn == latitudeState && r.ToTable == regionsTable && r.ToColumn == regionState && OneDirection(r));
        string Attribute(string table, string name, bool optional = false)
        {
            var column = model.Columns.SingleOrDefault(c => c.Table == table && c.Name == name && c.Type == "String");
            if (column != null) return column.Name;
            if (optional) return "";
            throw Incompatible("A coluna de atributo '" + table + "'[" + name + "] não existe ou não é textual.");
        }
        string regional = Attribute(regionsTable, "Regional"), manager = Attribute(regionsTable, "Gerente", true);
        // Product/category in the saved contract are fact filters. They must not be reapplied to returned products.
        string ReturnedAttribute(string name) => model.Columns.SingleOrDefault(c => c.Table == returnSource.Table && c.Name == name)?.Name ?? throw Incompatible("Coluna de rastreabilidade ausente nas devoluções: " + name);
        string returnedProduct = ReturnedAttribute(product.Column), returnedCategory = ReturnedAttribute(category.Column);
        var knownBoth = new HashSet<string>([customerBridge.Name, municipalityBridge.Name, latitudeBridge.Name, repAreaBridge.Name], StringComparer.Ordinal);
        var component = new HashSet<string>([grossSource.Table, representative.Table, municipalityTable, latitudeTable, repAreaTable], StringComparer.Ordinal);
        if (relations.Any(r => Both(r) && (component.Contains(r.FromTable) || component.Contains(r.ToTable)) && !knownBoth.Contains(r.Name))) throw Incompatible("O componente de filtros muitos-para-muitos mudou. É necessária nova conciliação das relações antes de exportar.");
        var tableNames = new[] { grossSource.Table, returnSource.Table, representative.Table, date.Table, regionsTable, municipalityTable, latitudeTable, repAreaTable }.Distinct().ToDictionary(TableId, x => x, StringComparer.Ordinal);
        int scale = model.Columns.Any(c => c.Table == grossSource.Table && c.Name == grossSource.Column && c.Type == "Decimal") || model.Columns.Any(c => c.Table == returnSource.Table && c.Name == returnSource.Column && c.Type == "Decimal") ? Math.Max(4, revenueMapping.Scale) : revenueMapping.Scale;
        var contract = new NativeContract("panizzon-relational-v1", scale,
            new(TableId(grossSource.Table), salesDate.FromColumn, client.Column, product.Column, category.Column, state.Column, salesMunicipality, grossSource.Column),
            new(TableId(returnSource.Table), returnsDate.FromColumn, returnedCustomer.FromColumn, returnedProduct, returnedCategory, returnRegion.FromColumn, returnSource.Column),
            new(TableId(representative.Table), customerKey, representative.Column, customerRegion.FromColumn),
            new(TableId(date.Table), date.Column), new(TableId(regionsTable), regionState, regional, manager.Length == 0 ? null : manager),
            new(TableId(municipalityTable), municipalityKey), new(TableId(latitudeTable), latitudeState), new(TableId(repAreaTable), repAreaState),
            new(new(gross.Name, gross.Expression, "sum"), new(returned.Name, returned.Expression, "sumBlankZero"), new(net.Name, net.Expression, "grossMinusReturns"), new(buyers.Name, buyers.Expression, "distinctClient")));
        var bindings = new Dictionary<string, Field>(mapping.Dimensions, StringComparer.Ordinal) { ["regional"] = new(regionsTable, regional) };
        if (manager.Length != 0) bindings["manager"] = new(regionsTable, manager);
        log?.Invoke("Contrato relacional reconhecido pelas expressões DAX e chaves ativas. Devoluções usam sua própria tabela; receita líquida será bruto menos devoluções uma única vez. O perfil salvo não foi alterado.");
        return new(contract, bindings, tableNames, grossSource.Table, returnSource.Table, representative.Table, date.Table, regionsTable, municipalityTable, latitudeTable, repAreaTable);
    }
    private static Relation Parse(object item)
    {
        var r = JsonSerializer.SerializeToElement(item, PackageWriter.Json);
        string Text(string name) => r.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString()! : "";
        return new(Text("name"), r.TryGetProperty("isActive", out var a) && a.ValueKind == JsonValueKind.True, Text("fromTableName"), Text("fromColumn"), Text("fromCardinality"), Text("toTableName"), Text("toColumn"), Text("toCardinality"), Text("crossFilteringBehavior"));
    }
    internal static bool DirectSum(string expression, out Field field) => Direct("SUM", expression, out field);
    internal static bool DirectDistinct(string expression, out Field field) => Direct("DISTINCTCOUNT", expression, out field);
    private static bool Direct(string function, string expression, out Field field)
    {
        var match = Regex.Match(Clean(expression), "^\\s*" + function + @"\s*\(\s*" + Reference + @"\s*\)\s*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        field = match.Success ? new(match.Groups["table"].Value.Replace("''", "'"), match.Groups["column"].Value.Replace("]]", "]")) : new("", "");
        return match.Success;
    }
    internal static bool BlankZeroSum(string expression, out Field field)
    {
        string text = Clean(expression);
        var sums = Regex.Matches(text, @"SUM\s*\(\s*" + Reference + @"\s*\)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant).ToArray();
        field = new("", ""); if (sums.Length is not (1 or 2)) return false;
        string normalized = Regex.Replace(text, @"\s+", "");
        string Mask(Match match) => Regex.Replace(match.Value, @"\s+", "");
        string one = Mask(sums[0]);
        if (sums.Length == 1 && string.Equals(normalized, "COALESCE(" + one + ",0)", StringComparison.OrdinalIgnoreCase) || sums.Length == 2 && string.Equals(one, Mask(sums[1]), StringComparison.OrdinalIgnoreCase) && string.Equals(normalized, "IF(ISBLANK(" + one + "),0," + one + ")", StringComparison.OrdinalIgnoreCase))
        { field = new(sums[0].Groups["table"].Value.Replace("''", "'"), sums[0].Groups["column"].Value.Replace("]]", "]")); return true; }
        return false;
    }
    private static string Clean(string expression) => Regex.Replace(Regex.Replace(expression, @"/\*.*?\*/", " ", RegexOptions.Singleline), @"(?m)//[^\r\n]*|--[^\r\n]*", " ");
    private static InvalidOperationException Incompatible(string message) => new("O modelo não corresponde ao contrato relacional validado: " + message + " O perfil salvo foi preservado.");
}
