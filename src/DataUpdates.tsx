import { sha256 } from "@noble/hashes/sha2.js";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  FileUp,
  History,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api, Busy, Empty, ErrorBox, message } from "./ui";

type ValidationReport = {
  checks?: { name: string; status: string; detail: string }[];
  controls?: {
    metric: string;
    context: unknown;
    expected: unknown;
    actual: unknown;
    passed: boolean;
  }[];
  errors?: { table?: string; row?: number; column?: string; message: string }[];
  metrics?: unknown;
};
type ImportItem = {
  id: string;
  status: string;
  created: number | string;
  updated: number | string;
  filename: string;
  bytes: number;
  uploadedBytes: number;
  processedBytes: number;
  processedRows?: number;
  rows: number;
  tables: number;
  error: string | null;
  report: ValidationReport | null;
  versionId: string;
};
type DataState = {
  source: "manual" | "powerbi";
  staleDays: number;
  allowAI: boolean;
  active: {
    id: string;
    publishedAt: number | string;
    actor: string;
    extractedAt: string;
    sourceUpdatedAt: string | null;
    from: string;
    to: string;
    rows: number;
    tables: number;
  } | null;
  history: ImportItem[];
  limits: { partBytes: number; maxBytes: number; format: string };
};
type UploadedPart = { partNumber: number; etag: string };
type UploadInit = {
  id: string;
  partBytes: number;
  parts: unknown;
  uploadedParts?: UploadedPart[];
  existing?: boolean;
  status?: string;
};
const labels: Record<string, string> = {
  uploading: "Recebendo arquivo",
  created: "Aguardando envio",
  received: "Arquivo recebido",
  queued: "Aguardando importação",
  importing: "Importando dados",
  processing: "Importando dados",
  validating: "Validando a base",
  publishing: "Publicando versão",
  published: "Publicada",
  failed: "Reprovada",
  cancelled: "Cancelada",
  superseded: "Publicação impedida por concorrência",
  conflict: "Publicação impedida por concorrência",
};
const checkLabels: Record<string, string> = {
  integridade: "Integridade do pacote",
  contagens: "Conferência de contagens",
  chaves_referencias: "Chaves e relacionamentos",
  precisao: "Precisão numérica",
  capacidade: "Capacidade de armazenamento",
  reconciliacao: "Conciliação dos indicadores",
  relacionamentos: "Limites das análises",
  continuidade: "Continuidade do histórico",
  publicacao: "Publicação da base",
  importacao: "Importação dos dados",
};
const running = (s: string) =>
  ["received", "queued", "importing", "processing", "validating", "publishing"].includes(s);
const n = (value: number) => (Number.isFinite(value) ? value : 0).toLocaleString("pt-BR");
const bytes = (value: number) => {
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + " GB";
  if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + " MB";
  return (value / 1024).toFixed(1) + " KB";
};
const dateValue = (value: string | number) =>
  new Date(typeof value === "number" ? value * 1000 : value);
const date = (value: string | number | null | undefined) => {
  if (!value) return "Não informada";
  const d = dateValue(value);
  return Number.isNaN(d.getTime())
    ? "Não informada"
    : d.toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "short",
        timeStyle: "short",
      });
};
const progress = (done: number, total: number) =>
  total > 0 ? Math.min(100, Math.max(0, (100 * done) / total)) : 0;
const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v) ?? "—");

async function fileDigest(file: File, update: (done: number) => void, signal: AbortSignal) {
  const hash = sha256.create();
  const reader = file.stream().getReader();
  let done = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Envio interrompido.", "AbortError");
      const part = await reader.read();
      if (part.done) break;
      hash.update(part.value);
      done += part.value.byteLength;
      update(done);
    }
    return Array.from(hash.digest(), (v) => v.toString(16).padStart(2, "0")).join("");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function sendPart(
  id: string,
  partNumber: number,
  blob: Blob,
  update: (sent: number) => void,
  signal: AbortSignal,
): Promise<{ etag: string; uploadedBytes?: number }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = () => signal.removeEventListener("abort", abort);
    request.open("PUT", `/api/admin/data/imports/${id}/parts/${partNumber}`);
    request.withCredentials = true;
    request.timeout = 180000;
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.onprogress = (ev) => update(ev.loaded);
    request.onload = () => {
      finish();
      let result: { error?: string; etag?: string; uploadedBytes?: number };
      try {
        result = JSON.parse(request.responseText);
      } catch {
        reject(Error("Resposta de envio inválida. Selecione o mesmo pacote para retomar."));
        return;
      }
      if (request.status === 401) window.dispatchEvent(new Event("session-ended"));
      if (request.status >= 200 && request.status < 300 && result.etag)
        resolve({ etag: result.etag, uploadedBytes: result.uploadedBytes });
      else reject(Error(result.error || "Não foi possível enviar a parte do pacote."));
    };
    request.onerror = () => {
      finish();
      reject(Error("O envio foi interrompido. Selecione o mesmo pacote para retomar."));
    };
    request.ontimeout = () => {
      finish();
      reject(Error("O envio demorou para responder. Selecione o mesmo pacote para retomar."));
    };
    request.onabort = () => {
      finish();
      reject(new DOMException("Envio interrompido.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      finish();
      reject(new DOMException("Envio interrompido.", "AbortError"));
    } else request.send(blob);
  });
}

function Validation({ report }: { report: ValidationReport }) {
  return (
    <div className="du-validation">
      {!!report.checks?.length && (
        <ul className="du-checks">
          {report.checks.map((check, index) => (
            <li key={index}>
              {check.status === "passed" ? (
                <CheckCircle2 size={15} className="du-passed" />
              ) : (
                <AlertTriangle size={15} className="du-warning" />
              )}
              <div>
                <b>{checkLabels[check.name] ?? check.name}</b>
                <p>{check.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!!report.controls?.length && (
        <details>
          <summary>Conciliação com o Power BI · {n(report.controls.length)} controles</summary>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Indicador e contexto</th>
                  <th>Power BI</th>
                  <th>D1</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {report.controls.map((control, index) => (
                  <tr key={index}>
                    <td>
                      <b>{control.metric}</b>
                      <small>{text(control.context)}</small>
                    </td>
                    <td>{text(control.expected)}</td>
                    <td>{text(control.actual)}</td>
                    <td>{control.passed ? "Conferido" : "Divergente"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {!!report.errors?.length && (
        <div className="tablewrap">
          <table>
            <caption>Erros que impedem a publicação</caption>
            <thead>
              <tr>
                <th>Localização</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {report.errors.map((error, index) => (
                <tr key={index}>
                  <td>
                    {[error.table, error.column, error.row != null ? `linha ${error.row}` : ""]
                      .filter(Boolean)
                      .join(" · ") || "Pacote"}
                  </td>
                  <td>{error.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DataUpdates({ changed }: { changed: () => void }) {
  const [state, setState] = useState<DataState | null>(null);
  const [source, setSource] = useState<DataState["source"]>("manual");
  const [staleDays, setStaleDays] = useState(7);
  const [allowAI, setAllowAI] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [stage, setStage] = useState<"hash" | "upload" | "accepted" | "">("");
  const [sent, setSent] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [currentId, setCurrentId] = useState("");
  const [restoreId, setRestoreId] = useState("");
  const [retryId, setRetryId] = useState("");
  const [expanded, setExpanded] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const changedRef = useRef(changed);
  const activeId = useRef<string | null | undefined>(undefined);
  const mounted = useRef(true);
  changedRef.current = changed;

  async function load(initial = false) {
    const result = await api<DataState>("admin/data");
    if (!mounted.current) return;
    setState(result);
    if (initial) {
      setSource(result.source);
      setStaleDays(result.staleDays);
      setAllowAI(result.allowAI);
    }
    if (activeId.current !== undefined && activeId.current !== (result.active?.id ?? null))
      changedRef.current();
    activeId.current = result.active?.id ?? null;
  }
  useEffect(() => {
    mounted.current = true;
    load(true).catch((e) => setError(message(e)));
    const timer = window.setInterval(() => {
      load().catch((e) => {
        if (mounted.current) setError(message(e));
      });
    }, 5000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!sending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sending]);

  const active = state?.active;
  const activeAge = active
    ? Date.now() - dateValue(active.sourceUpdatedAt || active.extractedAt).getTime()
    : 0;
  const activeImport = state?.history.find((item) => item.versionId === active?.id);
  const stale = !!active && activeAge > (state?.staleDays ?? 7) * 86400000;
  const current = state?.history.find((item) => item.id === currentId);
  const pending = current && running(current.status) ? current : state?.history.find((item) => running(item.status));
  const unfinished = state?.history.find((item) => item.status === "uploading");

  function selectFile(value: File | null) {
    setError("");
    setNotice("");
    if (!value) return;
    if (!value.name.toLowerCase().endsWith(".ci.ndjson")) {
      setError("Selecione o pacote .ci.ndjson gerado pelo preparador Comercial Insight.");
      return;
    }
    if (value.size <= 0 || (state && value.size > state.limits.maxBytes)) {
      setError(
        `O pacote precisa ter conteúdo e respeitar o limite de ${bytes(state?.limits.maxBytes ?? 0)} deste ambiente. A base não será cortada para caber.`,
      );
      return;
    }
    setFile(value);
    setStage("");
    setSent(0);
  }
  function drop(ev: DragEvent) {
    ev.preventDefault();
    setDragging(false);
    if (sending) return;
    if (ev.dataTransfer.files.length !== 1) {
      setError("Envie um único pacote completo por atualização.");
      return;
    }
    selectFile(ev.dataTransfer.files.item(0));
  }
  async function save(ev: FormEvent) {
    ev.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api("admin/data/settings", "PUT", { source, staleDays, allowAI });
      await load(true);
      changedRef.current();
      setNotice("Configuração da fonte salva.");
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }
  async function upload() {
    if (!file || !state || sending) return;
    const abort = new AbortController();
    controller.current = abort;
    setSending(true);
    setError("");
    setNotice("");
    setStage("hash");
    setSent(0);
    try {
      const digest = await fileDigest(file, setSent, abort.signal);
      let created = await api<UploadInit>("admin/data/imports", "POST", {
        filename: file.name,
        bytes: file.size,
        sha256: digest,
      });
      setCurrentId(created.id);
      if (created.status && ["failed", "cancelled", "superseded"].includes(created.status))
        created = await api<UploadInit>(`admin/data/imports/${created.id}/retry`, "POST", {});
      if (created.status === "published") {
        setStage("accepted");
        setNotice("Este conteúdo já foi publicado. Nenhuma linha foi duplicada.");
        await load();
        return;
      }
      if (created.status && running(created.status)) {
        setStage("accepted");
        setNotice("Este pacote já está em processamento no servidor.");
        await load();
        return;
      }
      const partBytes = created.partBytes || state.limits.partBytes;
      const count = Math.ceil(file.size / partBytes);
      const parts = new Map<number, string>();
      for (const part of created.uploadedParts ?? []) parts.set(part.partNumber, part.etag);
      let completed = 0;
      setStage("upload");
      for (let partNumber = 1; partNumber <= count; partNumber++) {
        if (abort.signal.aborted) throw new DOMException("Envio interrompido.", "AbortError");
        const start = (partNumber - 1) * partBytes;
        const part = file.slice(start, Math.min(file.size, start + partBytes));
        if (!parts.has(partNumber)) {
          const result = await sendPart(
            created.id,
            partNumber,
            part,
            (partSent) => setSent(completed + partSent),
            abort.signal,
          );
          parts.set(partNumber, result.etag);
        }
        completed += part.size;
        setSent(completed);
      }
      await api(`admin/data/imports/${created.id}/complete`, "POST", {
        parts: [...parts].map(([partNumber, etag]) => ({ partNumber, etag })),
      });
      setStage("accepted");
      setNotice("Arquivo recebido por completo. O servidor continuará a importação e as validações mesmo após fechar esta página.");
      await load();
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "AbortError"
          ? "Envio interrompido. Selecione o mesmo pacote para retomar as partes já recebidas."
          : message(e),
      );
    } finally {
      setSending(false);
      controller.current = null;
    }
  }
  async function cancel(id: string) {
    setError("");
    try {
      await api(`admin/data/imports/${id}/cancel`, "POST", {});
      await load();
      setNotice("Importação cancelada. A versão ativa continua disponível.");
    } catch (e) {
      setError(message(e));
    }
  }
  async function restore(item: ImportItem) {
    if (!state?.active) return;
    setRestoreId(item.id);
    setError("");
    setNotice("");
    try {
      await api("admin/data/restore", "POST", {
        versionId: item.versionId,
        expectedActiveVersionId: state.active.id,
      });
      await load();
      changedRef.current();
      setNotice("Versão anterior restaurada. As próximas consultas usarão essa versão.");
    } catch (e) {
      setError(message(e));
    } finally {
      setRestoreId("");
    }
  }
  async function retry(item: ImportItem) {
    setRetryId(item.id);
    setError("");
    setNotice("");
    try {
      const result = await api<UploadInit>(`admin/data/imports/${item.id}/retry`, "POST", {});
      setCurrentId(result.id);
      setStage(result.status === "uploading" ? "" : "accepted");
      await load();
      setNotice(result.status === "uploading"
        ? "O envio foi reaberto. Selecione o mesmo pacote e clique em Enviar e atualizar base."
        : "O reprocessamento foi solicitado. Todas as validações obrigatórias serão executadas novamente.");
    } catch (e) {
      setError(message(e));
    } finally {
      setRetryId("");
    }
  }

  return (
    <div className="stack data-updates">
      <div className="pageintro">
        <div className="mini"><Database size={15} /> Administração</div>
        <h1>Atualização de dados</h1>
        <p>Publique uma base completa e acompanhe a validação dos indicadores.</p>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {notice && <div className="notice" role="status">{notice}</div>}
      {!state ? <Busy label="Carregando a fonte de dados…" /> : <>
        <section className="panel">
          <div className="sectionhead">
            <div><div className="mini"><ShieldCheck size={14} /> Fonte comercial</div><h2>Base em uso</h2></div>
            <span className={active && state.source === "manual" ? "pill good" : "pill"}>
              {state.source === "manual" ? "Arquivo manual" : "Power BI online"}
            </span>
          </div>
          {active ? <>
            <dl className="du-metadata">
              <div><dt>Última publicação</dt><dd>{date(active.publishedAt)}</dd></div>
              <div><dt>Responsável</dt><dd>{active.actor || "Administrador"}</dd></div>
              <div><dt>Extração do modelo</dt><dd>{date(active.extractedAt)}</dd></div>
              <div><dt>Atualização na origem</dt><dd>{date(active.sourceUpdatedAt)}</dd></div>
              <div><dt>Upload do pacote</dt><dd>{date(activeImport?.created)}</dd></div>
              <div><dt>Período coberto</dt><dd>{active.from} a {active.to}</dd></div>
              <div><dt>Conteúdo da versão</dt><dd>{n(active.tables)} tabelas · {n(active.rows)} linhas</dd></div>
              <div className="du-version"><dt>Versão da base manual</dt><dd>{active.id}</dd></div>
            </dl>
            {stale && <div className="du-callout" role="status"><Clock3 size={18} /><span>A {active.sourceUpdatedAt ? "atualização na origem" : "extração"} tem mais de {n(state.staleDays)} dias. Prepare uma nova atualização para manter as análises atuais.</span></div>}
            {state.source === "powerbi" && <p className="sub">Esta versão manual está preservada. As consultas seguem a conexão Power BI online selecionada.</p>}
          </> : <Empty title="Nenhuma versão manual publicada">Prepare e envie o pacote completo. Os indicadores manuais ficarão indisponíveis até uma publicação validada.</Empty>}
          <form className="du-settings" onSubmit={save}>
            <div className="formgrid">
              <label>Fonte selecionada<select value={source} onChange={(ev) => setSource(ev.target.value as DataState["source"])}><option value="manual">Arquivo manual</option><option value="powerbi">Power BI online</option></select></label>
              <label>Avisar após quantos dias sem extração<input type="number" min={1} max={365} required value={staleDays} onChange={(ev) => setStaleDays(Number(ev.target.value))} /></label>
            </div>
            <label className="check"><input type="checkbox" checked={allowAI} onChange={(ev) => setAllowAI(ev.target.checked)} />Autorizar o envio de perguntas, filtros e resultados agregados da base manual à OpenAI para análise comercial.</label>
            <button className="soft compact" disabled={saving || sending}><Save size={14} />{saving ? "Salvando…" : "Salvar configuração"}</button>
          </form>
        </section>
        <section className="panel">
          <div className="sectionhead"><div><div className="mini"><UploadCloud size={14} /> Atualização completa</div><h2>Enviar nova base</h2></div></div>
          <ol className="du-steps"><li>Abra o PBIX atualizado no Power BI Desktop.</li><li>Em Ferramentas externas, clique em <b>Preparar atualização Comercial Insight</b>.</li><li>Envie o pacote <b>.ci.ndjson</b> gerado pelo preparador.</li></ol>
          <div className="du-links"><a href="/preparador-comercial-insight.zip" download><Download size={14} />Baixar preparador</a><a href="/atualizacao-dados.md" target="_blank" rel="noreferrer">Instalação e instruções</a></div>
          {unfinished && !sending && <div className="du-callout"><Clock3 size={17} /><span>Há um envio incompleto de <b>{unfinished.filename}</b>. Selecione o mesmo pacote para retomar as partes já recebidas.</span></div>}
          <div className={`du-drop ${dragging ? "du-dragging" : ""}`} onDragOver={(ev) => { ev.preventDefault(); if (!sending) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
            <FileUp size={29} />
            <b>{file ? file.name : "Arraste seu pacote de atualização"}</b>
            <span>{file ? `${bytes(file.size)} · pacote completo` : `Arquivo .ci.ndjson · até ${bytes(state.limits.maxBytes)} neste ambiente`}</span>
            <button className="soft compact" disabled={sending} onClick={() => input.current?.click()}>{file ? "Selecionar outro pacote" : "Selecionar pacote"}</button>
            <input ref={input} className="du-file" type="file" accept=".ndjson,application/x-ndjson" onChange={(ev) => selectFile(ev.target.files?.item(0) ?? null)} disabled={sending} aria-label="Selecionar pacote de atualização Comercial Insight" />
          </div>
          <p className="sub du-upload-note">A publicação acontece automaticamente após todas as validações obrigatórias. A versão atual permanece disponível durante o processamento.</p>
          {sending && <div className="du-progress" role="status"><div><LoaderCircle className="spin" size={15} /><b>{stage === "hash" ? "Verificando o arquivo no computador" : "Enviando pacote"}</b><span>{progress(sent, file?.size ?? 0).toFixed(0)}%</span></div><progress max={100} value={progress(sent, file?.size ?? 0)} /><small>{bytes(sent)} de {bytes(file?.size ?? 0)} · mantenha esta página aberta até concluir o envio.</small></div>}
          <div className="du-actions"><button className="primary" disabled={!file || sending || saving || stage === "accepted"} onClick={upload}><UploadCloud size={16} />{sending ? "Enviando…" : "Enviar e atualizar base"}</button>{sending && <button className="soft" onClick={() => controller.current?.abort()}><X size={15} />Interromper envio</button>}</div>
          {pending && <div className="du-job" role="status"><div className="sectionhead"><div><b><LoaderCircle size={15} className="spin" />{labels[pending.status] ?? pending.status}</b><p>{pending.filename}</p></div><button className="textlink" onClick={() => cancel(pending.id)}>Cancelar importação</button></div><progress max={100} value={progress(pending.processedBytes, pending.bytes)} /><p>{bytes(pending.processedBytes)} verificados de {bytes(pending.bytes)} · {n(pending.processedRows ?? pending.rows)} linhas processadas, incluindo a projeção. {pending.status === "validating" ? `${n(pending.report?.controls?.length ?? 0)} controles DAX conferidos.` : ""}</p><small>O processamento aceito continua no servidor. Você pode fechar esta página e voltar para acompanhar.</small></div>}
        </section>
        <section className="panel">
          <div className="sectionhead"><div><div className="mini"><History size={14} /> Rastreabilidade</div><h2>Histórico de importações</h2></div><button className="soft compact" onClick={() => load().catch((e) => setError(message(e)))}><RefreshCw size={14} />Atualizar</button></div>
          {!state.history.length ? <Empty title="Nenhuma importação recebida">Os envios e seus resultados aparecerão aqui.</Empty> : <div className="du-history">{state.history.map((item) => <article key={item.id} className="du-history-item"><div className="du-history-head"><div><b>{item.filename}</b><small>Upload: {date(item.created)} · {bytes(item.bytes)}</small><small>{n(item.tables)} tabelas · {n(item.rows)} linhas</small></div><span className={`pill ${item.status === "published" ? "good" : ""}`}>{item.versionId === active?.id ? "Versão ativa" : labels[item.status] ?? item.status}</span></div>{item.error && <ErrorBox>{item.error}</ErrorBox>}<div className="du-actions"><button className="textlink" onClick={() => setExpanded(expanded === item.id ? "" : item.id)}>{expanded === item.id ? "Ocultar detalhes" : "Validações e detalhes"}</button>{["failed", "cancelled", "superseded"].includes(item.status) && <button className="soft compact" disabled={!!retryId || sending} onClick={() => retry(item)}><RefreshCw size={13} />{retryId === item.id ? "Retomando…" : "Tentar novamente"}</button>}{item.status === "published" && item.versionId !== active?.id && <button className="soft compact" disabled={!!restoreId || sending} onClick={() => restore(item)}><RotateCcw size={13} />{restoreId === item.id ? "Restaurando…" : "Restaurar esta versão"}</button>}</div>{expanded === item.id && <div className="du-details"><small>Importação {item.id}<br />Versão {item.versionId || "ainda não criada"}<br />Última mudança: {date(item.updated)}</small>{item.report ? <Validation report={item.report} /> : <p className="sub">O relatório de validação ficará disponível durante o processamento.</p>}<div className="du-links">{item.status !== "uploading" && <a className="textlink" href={`/api/admin/data/imports/${item.id}/package`} download>Baixar pacote original privado</a>}<a className="textlink" href={`/api/admin/data/imports/${item.id}/report`} target="_blank" rel="noreferrer">Abrir relatório completo</a></div></div>}</article>)}</div>}
        </section>
      </>}
    </div>
  );
}
