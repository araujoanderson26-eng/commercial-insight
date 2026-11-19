using System.Globalization;
using System.Text;
using System.Text.Json;

namespace ComercialInsight.Preparador;

internal sealed class DiagnosticLog
{
    private readonly object gate = new();
    internal string Path { get; }
    internal string? WriteFailure { get; private set; }
    internal DiagnosticLog(string directory)
    {
        Directory.CreateDirectory(directory);
        Path = System.IO.Path.Combine(directory, $"preparador-{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}.log");
        Write("run.start version=1.0.3");
    }
    internal void Write(string message)
    {
        lock (gate)
            try { File.AppendAllText(Path, JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow, message }) + "\n", new UTF8Encoding(false)); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { WriteFailure = ex.GetType().Name; }
    }
    internal void Error(Exception error)
    {
        Write($"run.error type={error.GetType().Name} hresult={error.HResult.ToString("X8", CultureInfo.InvariantCulture)}");
        // Provider errors can contain connection strings or query contents. Never serialize them.
        if (error is InvalidOperationException or InvalidDataException) Write(error.Message);
        if (error.InnerException != null) Write("run.error inner_type=" + error.InnerException.GetType().Name);
    }
}

internal static class PreparerCli
{
    internal static bool TryRun(string[] args, out int exitCode)
    {
        exitCode = 0;
        string Arg(string name) { int n = Array.IndexOf(args, name); return n >= 0 && n + 1 < args.Length ? args[n + 1] : ""; }
        bool check = args.Contains("--check-model"), validate = args.Contains("--validate-package"), prepare = args.Contains("--prepare");
        if (!check && !validate && !prepare) return false;
        string reportPath = Arg("--report");
        if (string.IsNullOrWhiteSpace(reportPath)) { exitCode = 2; return true; }
        reportPath = System.IO.Path.GetFullPath(reportPath);
        var log = new DiagnosticLog(System.IO.Path.GetDirectoryName(reportPath)!);
        object result;
        try
        {
            if (validate)
            {
                var package = PackageIntegrity.Validate(Arg("--validate-package"));
                result = new { status = "valid", package, log = log.Path, productionImport = false };
            }
            else if (prepare)
            {
                var mappingPath = Arg("--mapping");
                byte[] saved = File.ReadAllBytes(mappingPath); string mappingHash = PackageWriter.Hash(saved);
                var mapping = MappingSettings.Load(Encoding.UTF8.GetString(saved));
                using var source = new ModelSource(Arg("--server"), Arg("--database"), log.Write);
                new PackageWriter(source, mapping, log.Write).Export(Arg("--output"));
                if (PackageWriter.Hash(File.ReadAllBytes(mappingPath)) != mappingHash) throw new InvalidDataException("O mapeamento mudou durante a preparação.");
                var package = PackageIntegrity.Validate(Arg("--output"));
                result = new { status = "prepared", package, mappingHash, log = log.Path, productionImport = false };
            }
            else
            {
                using var source = new ModelSource(Arg("--server"), Arg("--database"), log.Write);
                var before = source.Inspect(); source.AssertIdle();
                // A constant query exercises ADOMD without exporting commercial records.
                var constant = source.Read("EVALUATE ROW(\"diagnostic\",1)").Single();
                if (Convert.ToInt32(constant[0], CultureInfo.InvariantCulture) != 1) throw new InvalidDataException("Consulta de diagnóstico incompleta.");
                var after = source.Inspect(); source.AssertIdle(); source.AssertUnchanged(before, after);
                var mappingPath = Arg("--mapping");
                string? mappingHash = null;
                var issues = new List<SemanticIssue>();
                NativeContract? nativeContract = null;
                if (!string.IsNullOrWhiteSpace(mappingPath))
                {
                    byte[] saved = File.ReadAllBytes(mappingPath); mappingHash = PackageWriter.Hash(saved);
                    var mapping = MappingSettings.Load(Encoding.UTF8.GetString(saved));
                    var nativePlan = NativeModel.Recognize(before, mapping, log.Write);
                    nativeContract = nativePlan?.Contract;
                    if (nativePlan == null)
                    {
                        issues = SemanticPreflight.Analyze(before.Measures, before.Columns, mapping);
                        issues.AddRange(SemanticPreflight.DimensionIssues(before.Relationships, mapping));
                    }
                    if (PackageWriter.Hash(File.ReadAllBytes(mappingPath)) != mappingHash) throw new InvalidDataException("O mapeamento mudou durante o diagnóstico.");
                }
                result = new { status = "stable", tables = before.TableNames.Count, measures = before.Measures.Count,
                    metadataReadsStable = true, constantDaxRead = true, exportAttempted = false, mappingHash,
                    semanticIssues = issues, nativeModel = nativeContract, log = log.Path, productionImport = false };
            }
        }
        catch (Exception ex)
        {
            log.Error(ex); exitCode = 1;
            result = new { status = "failed", type = ex.GetType().Name,
                error = ex is InvalidOperationException or InvalidDataException ? ex.Message : "Falha na leitura. Consulte os tipos e etapas no log privado.", log = log.Path, productionImport = false };
        }
        File.WriteAllText(reportPath, JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
        return true;
    }
}
