import { KeyRound, Link2, LogOut, ShieldCheck, UserCircle } from "lucide-react";
import { useState } from "react";
import { roles, type Session } from "../shared/domain";
import { api, ErrorBox, message } from "./ui";
export default function Profile({
  s,
  logout,
  reload,
}: {
  s: Session;
  logout: () => void;
  reload: () => void;
}) {
  const [current, C] = useState(""),
    [pw, P] = useState(""),
    [busy, B] = useState(false),
    [err, E] = useState(""),
    [note, N] = useState(
      location.search.includes("microsoft=vinculado")
        ? "Conta Microsoft vinculada."
        : location.search.includes("microsoft=erro")
          ? "O vínculo falhou. Confira a conta e o cadastro com o administrador."
          : "",
    );
  async function run(fn: () => Promise<void>) {
    E("");
    B(true);
    try {
      await fn();
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
          <UserCircle size={15} /> Conta
        </div>
        <h1>Meu perfil</h1>
        <p>
          {s.user.name} · {s.user.email}
        </p>
      </div>
      {err && <ErrorBox>{err}</ErrorBox>}
      {note && <div className="notice">{note}</div>}
      <section className="panel">
        <div className="mini">
          <ShieldCheck size={14} /> Permissões
        </div>
        <h2>{roles[s.user.role]}</h2>
        <p className="sub">
          {s.user.role === "admin" || s.user.national
            ? "Acesso nacional."
            : [
                "Regionais: " + (s.user.regions.join(", ") || "sem lista específica"),
                "Clientes: " + (s.user.clients.join(", ") || "sem lista específica"),
              ].join(" · ")}
        </p>
      </section>
      <section className="panel">
        <div className="mini">
          <Link2 size={14} /> Fonte de dados
        </div>
        <h2>Microsoft Power BI</h2>
        <p className="sub">
          {!s.integrations.configured
            ? "O modelo ou a credencial do aplicativo aguarda configuração."
            : s.integrations.mode === "application"
              ? "A autorização utiliza a identidade do aplicativo."
              : s.integrations.linked
                ? "Sua conta Microsoft está vinculada."
                : "Vincule sua conta corporativa para consultar o modelo."}
        </p>
        {s.integrations.configured && s.integrations.mode === "delegated" && (
          <button
            className="soft"
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (s.integrations.linked) {
                  await api("microsoft", "DELETE");
                  reload();
                  N("Vínculo removido.");
                } else {
                  const r = await api<{ url: string }>("microsoft/start", "POST", {});
                  location.assign(r.url);
                }
              })
            }
          >
            {s.integrations.linked ? "Desvincular Microsoft" : "Vincular conta Microsoft"}
          </button>
        )}
      </section>
      <form
        className="panel formpanel"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("auth/password", "POST", { current, password: pw });
            logout();
          });
        }}
      >
        <div className="mini">
          <KeyRound size={14} /> Segurança
        </div>
        <h2>Alterar senha</h2>
        <div className="formgrid">
          <label>
            Senha atual
            <input
              required
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => C(e.target.value)}
            />
          </label>
          <label>
            Nova senha · mínimo de 12 caracteres
            <input
              required
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={pw}
              onChange={(e) => P(e.target.value)}
            />
          </label>
        </div>
        <button disabled={busy} className="primary">
          Salvar e entrar novamente
        </button>
      </form>
      <div>
        <button
          className="soft"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api("auth/logout", "POST", {});
              logout();
            })
          }
        >
          <LogOut size={16} />
          Sair da conta
        </button>
      </div>
    </div>
  );
}
