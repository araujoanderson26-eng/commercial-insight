import { ArrowLeft, ArrowRight, BarChart3, Eye, EyeOff, LockKeyhole, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, Brand, Credit, ErrorBox, message } from "./ui";
import { isNativeApp, setNativeToken } from "./lib/runtime";
export default function Auth({ done }: { done: () => void }) {
  const [code] = useState(() => (location.pathname === "/redefinir" ? location.hash.slice(1) : ""));
  const [mode, setMode] = useState<"login" | "forgot" | "reset">(code ? "reset" : "login"),
    [email, setEmail] = useState(""),
    [pw, setPw] = useState(""),
    [show, setShow] = useState(false),
    [busy, setBusy] = useState(false),
    [err, setErr] = useState(""),
    [note, setNote] = useState("");
  async function send(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setErr("");
    setNote("");
    try {
      if (mode === "login") {
        const loginRes = await api<{ ok: boolean; token?: string }>("auth/login", "POST", {
          email,
          password: pw,
        });
        if (isNativeApp() && loginRes?.token) await setNativeToken(loginRes.token);
        if (location.pathname === "/redefinir") history.replaceState({}, "", "/");
        done();
      } else if (mode === "forgot") {
        await api("auth/forgot", "POST", { email });
        setNote("Se houver uma conta ativa, você receberá um link por e-mail.");
      } else {
        await api("auth/reset", "POST", { token: code, password: pw });
        history.replaceState({}, "", "/");
        switchMode("login");
        setNote("Senha redefinida. Entre com a nova senha.");
      }
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }
  function switchMode(m: typeof mode) {
    setMode(m);
    setErr("");
    setNote("");
    setPw("");
  }
  return (
    <main className="auth">
      <div className="authvisual">
        <Brand />
        <div className="authcopy">
          <div className="heroeyebrow">
            <Sparkles size={15} /> Inteligência Comercial com IA
          </div>
          <h1>
            Seu assistente <br />
            de inteligência <br />
            <em>comercial.</em>
          </h1>
          <p>Analise resultados, clientes e oportunidades com os dados do seu Power BI.</p>
        </div>
        <div className="herobottom">
          <span className="line" />
          <Credit />
        </div>
      </div>
      <div className="authform">
        <div className="authinner">
          <div className="authmark">
            <BarChart3 />
          </div>
          <h1>
            {mode === "login"
              ? "Acesse sua conta"
              : mode === "forgot"
                ? "Recupere sua senha"
                : "Crie uma nova senha"}
          </h1>
          <p className="sub">
            {mode === "login"
              ? "Entre para consultar seus indicadores e conversar com o assistente."
              : mode === "forgot"
                ? "Informe o e-mail cadastrado para receber o link de recuperação."
                : "Use pelo menos 12 caracteres para proteger sua conta."}
          </p>
          <form onSubmit={send}>
            {mode !== "reset" && (
              <label>
                E-mail corporativo
                <input
                  type="email"
                  inputMode="email"
                  required
                  autoComplete="username"
                  enterKeyHint={mode === "login" ? "next" : "go"}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="voce@empresa.com.br"
                />
              </label>
            )}
            {mode !== "forgot" && (
              <label>
                {mode === "reset" ? "Nova senha" : "Senha"}
                <div className="passwrap">
                  <input
                    type={show ? "text" : "password"}
                    required
                    minLength={mode === "reset" ? 12 : 1}
                    maxLength={128}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                  />
                  <button
                    type="button"
                    className="iconbtn"
                    aria-label={show ? "Ocultar senha" : "Mostrar senha"}
                    onClick={() => setShow(!show)}
                  >
                    {show ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </label>
            )}
            {mode === "login" && (
              <button
                className="textlink alignend"
                type="button"
                onClick={() => switchMode("forgot")}
              >
                Esqueci minha senha
              </button>
            )}
            {err && <ErrorBox>{err}</ErrorBox>}
            {note && (
              <div className="notice" role="status">
                {note}
              </div>
            )}
            <button className="primary full" disabled={busy}>
              {busy
                ? "Aguarde…"
                : mode === "login"
                  ? "Entrar no Comercial Insight"
                  : mode === "forgot"
                    ? "Enviar link"
                    : "Salvar nova senha"}
              <ArrowRight size={17} />
            </button>
            {mode !== "login" && (
              <button type="button" className="textlink" onClick={() => switchMode("login")}>
                <ArrowLeft size={15} /> Voltar ao login
              </button>
            )}
          </form>
          <div className="private">
            <LockKeyhole size={14} /> Acesso restrito à equipe autorizada
          </div>
        </div>
        <div className="authcredit">
          <Credit />
        </div>
      </div>
    </main>
  );
}
