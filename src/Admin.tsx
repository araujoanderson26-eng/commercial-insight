import {
  CheckCircle2,
  Database,
  KeyRound,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { metricKeys, metrics, roles, type ModelConfig, type User } from "../shared/domain";
import { api, Busy, ErrorBox, message } from "./ui";
type Settings = { model: ModelConfig | null; revision: number; secrets: Record<string, boolean> };
const base: ModelConfig = {
  tenant: "",
  application: "",
  workspace: "",
  dataset: "",
  mode: "delegated",
  factTable: "",
  columns: {
    date: { table: "", column: "" },
    region: { table: "", column: "" },
    client: { table: "", column: "" },
    product: { table: "", column: "" },
    category: { table: "", column: "" },
  },
  measures: { revenue: "", margin: null, buyers: null, returns: null },
  marginScale: "fraction",
  scopedMeasuresReviewed: false,
  allowAI: false,
};
const dims = {
  date: "Data diária",
  region: "Regional",
  client: "Cliente",
  product: "Produto",
  category: "Categoria",
};
const ids = {
  tenant: "Tenant ID",
  application: "Client ID",
  workspace: "Workspace ID",
  dataset: "Semantic model ID",
};
const secretLabels: Record<string, string> = {
  microsoft: "Segredo Microsoft",
  encryption: "Criptografia de tokens",
  openai: "Chave da OpenAI",
  mail: "E-mail de recuperação",
};
export function Integrations({ changed }: { changed: () => void }) {
  const [s, setS] = useState<Settings | null>(null),
    [m, set] = useState<ModelConfig>(base),
    [err, E] = useState(""),
    [note, N] = useState(""),
    [busy, B] = useState(false);
  async function load() {
    const v = await api<Settings>("admin/config");
    setS(v);
    set(v.model ?? base);
  }
  useEffect(() => {
    load().catch((e) => E(message(e)));
  }, []);
  async function save(ev: FormEvent) {
    ev.preventDefault();
    B(true);
    E("");
    N("");
    try {
      await api("admin/config", "PUT", { model: m, revision: s!.revision });
      await load();
      changed();
      N("Mapeamento salvo. Consulte os indicadores para validar o modelo.");
    } catch (e) {
      E(message(e));
    } finally {
      B(false);
    }
  }
  return (
    <div className="stack">
      <div className="pageintro">
        <div className="mini">
          <Database size={15} /> Administração
        </div>
        <h1>Integrações</h1>
        <p>Conecte o modelo semântico e escolha as medidas disponíveis para a equipe.</p>
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
      {!s ? (
        <Busy />
      ) : (
        <>
          <div className="panel">
            <h2>Credenciais do Worker</h2>
            <div className="chips">
              {Object.entries(s.secrets).map(([k, v]) => (
                <span className={v ? "pill good" : "pill"} key={k}>
                  <KeyRound size={12} />
                  {secretLabels[k]} · {v ? "cadastrado" : "pendente"}
                </span>
              ))}
            </div>
          </div>
          <form className="panel formpanel" onSubmit={save}>
            <h2>Microsoft Power BI</h2>
            <div className="formgrid">
              {(Object.keys(ids) as (keyof typeof ids)[]).map((k) => (
                <label key={k}>
                  {ids[k]}
                  <input
                    required
                    value={m[k]}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    onChange={(e) => set({ ...m, [k]: e.target.value.trim() })}
                  />
                </label>
              ))}
              <label>
                Autorização
                <select
                  value={m.mode}
                  onChange={(e) => set({ ...m, mode: e.target.value as ModelConfig["mode"] })}
                >
                  <option value="delegated">Delegada · conta por usuário (RLS/SSO)</option>
                  <option value="application">Aplicativo · modelo sem RLS/SSO</option>
                </select>
              </label>
              <label>
                Tabela fato das vendas
                <input
                  required
                  value={m.factTable}
                  onChange={(e) => set({ ...m, factTable: e.target.value })}
                />
              </label>
            </div>
            <h3>Dimensões do modelo</h3>
            {(Object.keys(dims) as (keyof typeof dims)[]).map((k) => (
              <div className="dimension" key={k}>
                <b>{dims[k]}</b>
                {(["table", "column"] as const).map((t) => (
                  <label key={t}>
                    {t === "table" ? "Tabela" : "Coluna"}
                    <input
                      required
                      value={m.columns[k][t]}
                      onChange={(e) =>
                        set({
                          ...m,
                          columns: { ...m.columns, [k]: { ...m.columns[k], [t]: e.target.value } },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            ))}
            <h3>Medidas DAX publicadas</h3>
            <div className="formgrid">
              {metricKeys.map((k) => (
                <label key={k}>
                  {metrics[k].label}
                  <input
                    required={k === "revenue"}
                    placeholder={k === "revenue" ? "Nome da medida" : "Opcional"}
                    value={m.measures[k] ?? ""}
                    onChange={(e) =>
                      set({ ...m, measures: { ...m.measures, [k]: e.target.value || null } })
                    }
                  />
                </label>
              ))}
              <label>
                Escala da margem
                <select
                  value={m.marginScale}
                  onChange={(e) =>
                    set({ ...m, marginScale: e.target.value as ModelConfig["marginScale"] })
                  }
                >
                  <option value="fraction">Fração · 0,25 equivale a 25%</option>
                  <option value="points">Percentual · 25 equivale a 25%</option>
                </select>
              </label>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={m.scopedMeasuresReviewed}
                onChange={(e) => set({ ...m, scopedMeasuresReviewed: e.target.checked })}
              />
              Validei que as dimensões filtram a tabela fato e que as medidas respeitam os filtros
              de carteira e regional.
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={m.allowAI}
                onChange={(e) => set({ ...m, allowAI: e.target.checked })}
              />
              Autorizar o envio da pergunta, filtros e resultados agregados à OpenAI para análise
              comercial.
            </label>
            <p className="sub">
              Ao salvar, cada usuário precisará vincular novamente a conta Microsoft no modo
              delegado. Conversas do mapeamento anterior deixam de aparecer.
            </p>
            {note && <div className="notice">{note}</div>}
            <button className="primary" disabled={busy}>
              <Save size={16} />
              {busy ? "Salvando…" : "Salvar mapeamento"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
const blank: User = {
  id: "",
  name: "",
  email: "",
  role: "comercial",
  regions: [],
  clients: [],
  active: true,
  national: false,
  entraOid: null,
};
export function Team({ self, scopeLabel = "Regionais" }: { self: string; scopeLabel?: string }) {
  const [users, S] = useState<User[]>([]),
    [edit, U] = useState<User | null>(null),
    [regions, R] = useState(""),
    [clients, C] = useState(""),
    [pw, P] = useState(""),
    [err, E] = useState(""),
    [busy, B] = useState(false);
  const load = () => api<User[]>("admin/users").then(S);
  useEffect(() => {
    load().catch((e) => E(message(e)));
  }, []);
  function begin(u: User) {
    U({ ...u });
    R(u.regions.join("\n"));
    C(u.clients.join("\n"));
    P("");
    E("");
  }
  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (!edit) return;
    B(true);
    E("");
    try {
      const { id, ...user } = edit;
      const lines = (s: string) =>
        s
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean);
      await api("admin/users" + (id ? "/" + id : ""), id ? "PUT" : "POST", {
        user: { ...user, regions: lines(regions), clients: lines(clients) },
        ...(pw ? { password: pw } : {}),
      });
      await load();
      U(null);
    } catch (e) {
      E(message(e));
    } finally {
      B(false);
    }
  }
  return (
    <div className="stack">
      <div className="pageintro">
        <div className="mini">
          <Users size={15} /> Administração
        </div>
        <h1>Equipe e permissões</h1>
        <p>Defina quem pode consultar {scopeLabel.toLowerCase()} e carteiras autorizadas.</p>
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
      <section className="panel">
        <div className="sectionhead">
          <h2>Usuários ({users.length})</h2>
          <button className="primary compact" onClick={() => begin(blank)}>
            <Plus size={16} />
            Novo usuário
          </button>
        </div>
        {users.map((u) => (
          <div className="userrow" key={u.id}>
            <div className="avatar">{u.name.slice(0, 1)}</div>
            <div>
              <b>{u.name}</b>
              <small>
                {u.email} · {roles[u.role]} · {u.active ? "Ativo" : "Inativo"}
              </small>
            </div>
            {u.id !== self && (
              <button className="iconbtn" aria-label={"Editar " + u.name} onClick={() => begin(u)}>
                <Pencil size={16} />
              </button>
            )}
          </div>
        ))}
      </section>
      {edit && (
        <form className="panel formpanel" onSubmit={save}>
          <div className="sectionhead">
            <h2>{edit.id ? "Editar usuário" : "Novo usuário"}</h2>
            <button className="iconbtn" type="button" onClick={() => U(null)} aria-label="Fechar">
              <X size={18} />
            </button>
          </div>
          <div className="formgrid">
            <label>
              Nome
              <input
                required
                value={edit.name}
                onChange={(e) => U({ ...edit, name: e.target.value })}
              />
            </label>
            <label>
              E-mail
              <input
                required
                type="email"
                value={edit.email}
                onChange={(e) => U({ ...edit, email: e.target.value })}
              />
            </label>
            <label>
              Perfil
              <select
                value={edit.role}
                onChange={(e) =>
                  U({ ...edit, role: e.target.value as User["role"], national: false })
                }
              >
                {Object.entries(roles).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              ID de objeto Microsoft
              <input
                value={edit.entraOid ?? ""}
                onChange={(e) => U({ ...edit, entraOid: e.target.value.trim() || null })}
                placeholder="Obrigatório para vínculo delegado"
              />
            </label>
            <label>
              {scopeLabel} · um valor por linha
              <textarea value={regions} onChange={(e) => R(e.target.value)} disabled={edit.role === "operador"} />
              {scopeLabel === "Representantes" && <small className="muted">Este campo limita o acesso aos representantes autorizados. Para gerentes, informe os representantes da equipe. Regional, gerente e UF nas análises são filtros adicionais e não ampliam esse acesso.</small>}
            </label>
            <label>
              Clientes · um por linha
              <textarea value={clients} onChange={(e) => C(e.target.value)} disabled={edit.role === "operador"} />
            </label>
            <label>
              {edit.id ? "Alterar senha (opcional)" : "Senha inicial"}
              <input
                required={!edit.id}
                minLength={12}
                value={pw}
                onChange={(e) => P(e.target.value)}
                type="password"
                autoComplete="new-password"
              />
            </label>
          </div>
          {edit.role === "operador" && <p className="sub">Este perfil envia e acompanha os próprios pacotes. Consultas comerciais, IA, configurações, restauração e downloads da base são restritos.</p>}
          {edit.role === "diretoria" && (
            <label className="check">
              <input
                type="checkbox"
                checked={edit.national}
                onChange={(e) => U({ ...edit, national: e.target.checked })}
              />
              Acesso nacional
            </label>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={edit.active}
              onChange={(e) => U({ ...edit, active: e.target.checked })}
            />
            Conta ativa
          </label>
          <button className="primary" disabled={busy}>
            <CheckCircle2 size={16} />
            Salvar usuário
          </button>
        </form>
      )}
    </div>
  );
}
export function Audit() {
  const [rows, S] = useState<
      { id: number; actor: string | null; action: string; target: string | null; created: number }[]
    >([]),
    [err, E] = useState("");
  useEffect(() => {
    api<typeof rows>("admin/audit")
      .then(S)
      .catch((e) => E(message(e)));
  }, []);
  return (
    <div className="stack">
      <div className="pageintro">
        <div className="mini">
          <ShieldCheck size={15} /> Administração
        </div>
        <h1>Auditoria</h1>
        <p>Últimos 150 eventos de acesso, consulta e administração.</p>
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
      <div className="panel tablewrap">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Usuário</th>
              <th>Evento</th>
              <th>Alvo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.created * 1000).toLocaleString("pt-BR")}</td>
                <td>{r.actor || "Sistema"}</td>
                <td>{r.action.replaceAll("_", " ")}</td>
                <td>{r.target || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
