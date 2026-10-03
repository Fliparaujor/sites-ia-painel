import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, WORKER_URL, SEU_NOME } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (s, el = document) => el.querySelector(s);

const STATUS = [
  ["novo", "Novo"], ["liguei", "Liguei"], ["sem_resposta", "Sem resposta"],
  ["interessado", "Interessado"], ["fechado", "Fechado"], ["perdido", "Perdido"],
];

let leadsCache = [];

// ---------- utilidades ----------
function whatsDoLead(intl, texto) {
  const d = (intl || "").replace(/\D/g, "");
  if (!/^55\d{2}9\d{8}$/.test(d)) return null;
  return `https://wa.me/${d}${texto ? `?text=${encodeURIComponent(texto)}` : ""}`;
}
function notaTexto(lead) {
  if (lead.nota == null) return "sem nota";
  return `${String(lead.nota).replace(".", ",")} no Google (${lead.avaliacoes})`;
}
async function token() {
  const { data } = await sb.auth.getSession();
  return data.session?.access_token;
}
async function chamarWorker(caminho, corpo) {
  const r = await fetch(`${WORKER_URL}${caminho}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
    body: JSON.stringify(corpo),
  });
  return r;
}

// ---------- login ----------
const formLogin = $("#form-login");
formLogin.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(formLogin);
  const { error } = await sb.auth.signInWithPassword({ email: f.get("email"), password: f.get("senha") });
  $(".mensagem", formLogin).textContent = error ? `Não entrou: ${error.message}` : "";
});
$("#criar-conta").addEventListener("click", async () => {
  const f = new FormData(formLogin);
  if (!formLogin.reportValidity()) return;
  const { error } = await sb.auth.signUp({ email: f.get("email"), password: f.get("senha") });
  $(".mensagem", formLogin).textContent = error
    ? `Não criou: ${error.message}`
    : "Conta criada. Se o Supabase pedir confirmação, abra o e-mail e depois entre.";
});
$("#sair").addEventListener("click", () => sb.auth.signOut());

sb.auth.onAuthStateChange((_evento, sessao) => {
  $("#tela-login").hidden = !!sessao;
  $("#tela-app").hidden = !sessao;
  if (sessao) abrirAba(location.hash.slice(1) || "buscar");
});

// ---------- abas ----------
function abrirAba(nome) {
  if (!["buscar", "leads", "sites"].includes(nome)) nome = "buscar";
  document.querySelectorAll(".aba").forEach((b) => {
    if (b.dataset.aba === nome) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-painel]").forEach((p) => (p.hidden = p.dataset.painel !== nome));
  history.replaceState(null, "", `#${nome}`);
  if (nome === "leads") carregarLeads();
  if (nome === "sites") carregarSites();
}
document.querySelectorAll(".aba").forEach((b) => b.addEventListener("click", () => abrirAba(b.dataset.aba)));

// ---------- cartão de lead ----------
function cartaoLead(lead) {
  const li = $("#modelo-lead").content.firstElementChild.cloneNode(true);
  $(".lead__nome", li).textContent = lead.nome;
  $(".lead__meta", li).textContent = [lead.categoria, notaTexto(lead), `${lead.qtd_fotos} fotos`, lead.site_atual ? "só rede social" : null]
    .filter(Boolean).join(" · ");
  $(".lead__endereco", li).textContent = lead.endereco || "";

  const sel = $(".lead__status select", li);
  for (const [v, t] of STATUS) sel.add(new Option(t, v, false, v === lead.status));
  sel.addEventListener("change", async () => {
    await sb.from("leads").update({ status: sel.value }).eq("id", lead.id);
    lead.status = sel.value;
  });

  const obs = $(".lead__obs textarea", li);
  obs.value = lead.obs || "";
  obs.addEventListener("change", () => sb.from("leads").update({ obs: obs.value }).eq("id", lead.id));

  const ligar = $('[data-acao="ligar"]', li);
  if (lead.telefone_intl) ligar.href = `tel:+${lead.telefone_intl.replace(/\D/g, "")}`;
  else ligar.setAttribute("aria-disabled", "true");
  const whats = $('[data-acao="whats"]', li);
  const w = whatsDoLead(lead.telefone_intl);
  if (w) whats.href = w; else whats.remove();
  const maps = $('[data-acao="maps"]', li);
  if (lead.maps_url) maps.href = lead.maps_url; else maps.remove();

  const progresso = $(".lead__progresso", li);
  const botaoGerar = $('[data-acao="gerar"]', li);
  const botaoLocal = $('[data-acao="local"]', li);
  if (lead.qtd_fotos === 0) {
    botaoGerar.title = "Sem fotos no Maps: o site vai sair só com texto";
  }
  botaoGerar.addEventListener("click", () => gerarPelaApi(lead, botaoGerar, progresso));
  botaoLocal.addEventListener("click", () => prepararLocal(lead, botaoLocal, progresso));
  return li;
}

const ROTULOS = {
  detalhes: () => "Lendo o perfil no Google…",
  fotos: (e) => (e.aviso ? e.aviso : `Baixando fotos ${e.atual}/${e.total}…`),
  direcao: () => "Olhando as fotos e decidindo a direção…",
  direcao_ok: (e) => `Direção: ${e.ideia}`,
  html: (e) => `Escrevendo o site… ${Math.round((e.caracteres || 0) / 1000)} mil caracteres`,
  revisao: (e) => `Corrigindo ${e.problemas} problema(s) apontados pelo verificador…`,
};

async function gerarPelaApi(lead, botao, progresso) {
  botao.disabled = true;
  progresso.textContent = "Começando…";
  let ideia = "";
  try {
    const r = await chamarWorker("/api/gerar", { lead_id: lead.id });
    if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).erro || `erro ${r.status}`);
    const leitor = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let resto = "";
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      resto += value;
      const linhas = resto.split("\n");
      resto = linhas.pop();
      for (const l of linhas) {
        if (!l.trim()) continue;
        const ev = JSON.parse(l);
        if (ev.etapa === "direcao_ok") ideia = ev.ideia;
        if (ev.etapa === "erro") throw new Error(ev.erro);
        if (ev.etapa === "pronto") {
          progresso.innerHTML = "";
          const a = document.createElement("a");
          a.href = ev.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Abrir o site";
          progresso.append("Pronto. ", a, ideia ? `. ${ideia}` : "");
          if (ev.pendencias?.length) progresso.append(` Confirmar com o cliente: ${ev.pendencias.join("; ")}.`);
          continue;
        }
        progresso.textContent = (ROTULOS[ev.etapa] || (() => ev.etapa))(ev);
      }
    }
  } catch (e) {
    progresso.innerHTML = "";
    const s = document.createElement("span");
    s.className = "erro"; s.textContent = `Falhou: ${e.message}`;
    progresso.append(s);
  } finally {
    botao.disabled = false;
  }
}

async function prepararLocal(lead, botao, progresso) {
  botao.disabled = true;
  progresso.textContent = "Baixando dados e fotos pro Claude Code…";
  try {
    const r = await chamarWorker("/api/preparar", { lead_id: lead.id });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro || `erro ${r.status}`);
    progresso.innerHTML = "";
    const c = document.createElement("code");
    c.textContent = d.comando;
    const copiar = document.createElement("button");
    copiar.type = "button"; copiar.className = "botao botao--texto"; copiar.textContent = "Copiar";
    copiar.addEventListener("click", async () => {
      await navigator.clipboard.writeText(d.comando);
      copiar.textContent = "Copiado";
    });
    progresso.append(`${d.fotos} fotos prontas. No Claude Code, rode `, c, " ", copiar);
  } catch (e) {
    progresso.textContent = `Falhou: ${e.message}`;
  } finally {
    botao.disabled = false;
  }
}

function desenharLeads(lista, ul) {
  ul.replaceChildren(...lista.map(cartaoLead));
  if (!lista.length) {
    const li = document.createElement("li");
    li.className = "vazio"; li.textContent = "Nada por aqui.";
    ul.append(li);
  }
}

// ---------- buscar ----------
$("#form-busca").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const botao = $('button[type="submit"]', e.target);
  const resumo = $("#resumo-busca");
  botao.disabled = true;
  resumo.textContent = "Buscando no Google Maps…";
  try {
    const r = await chamarWorker("/api/buscar", { nicho: f.get("nicho"), cidade: f.get("cidade") });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro || `erro ${r.status}`);
    const soRede = d.leads.filter((l) => l.site_atual).length;
    resumo.textContent = `${d.total} encontrados, ${d.leads.length} sem site${soRede ? ` (${soRede} só com rede social)` : ""}.`;
    desenharLeads(d.leads.sort((a, b) => (b.avaliacoes || 0) - (a.avaliacoes || 0)), $("#lista-busca"));
  } catch (err) {
    resumo.textContent = `Falhou: ${err.message}`;
  } finally {
    botao.disabled = false;
  }
});

// ---------- leads ----------
async function carregarLeads() {
  const { data, error } = await sb.from("leads").select("*").order("criado_em", { ascending: false }).limit(1000);
  if (error) return;
  leadsCache = data;
  filtrarLeads();
}
function filtrarLeads() {
  const st = $("#filtro-status").value;
  const q = $("#filtro-texto").value.trim().toLowerCase();
  const lista = leadsCache.filter((l) =>
    (!st || l.status === st) &&
    (!q || [l.nome, l.endereco, l.categoria].join(" ").toLowerCase().includes(q)));
  desenharLeads(lista, $("#lista-leads"));
}
$("#filtro-status").addEventListener("change", filtrarLeads);
$("#filtro-texto").addEventListener("input", filtrarLeads);

// ---------- sites ----------
async function carregarSites() {
  const ul = $("#lista-sites");
  const { data, error } = await sb.from("sites")
    .select("id, slug, url, status, erro, pendencias, modelo, criado_em, leads(nome, telefone_intl)")
    .order("criado_em", { ascending: false }).limit(200);
  if (error) return;
  ul.replaceChildren(...data.map((s) => {
    const li = document.createElement("li");
    li.className = "site";
    const nome = s.leads?.nome || s.slug;
    const h = document.createElement("h2");
    h.className = "site__nome"; h.textContent = nome;
    const meta = document.createElement("p");
    meta.className = "site__meta";
    const quando = new Date(s.criado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    const estado = { pronto: "pronto", gerando: "gerando", aguardando: "esperando o Claude Code", erro: "erro" }[s.status];
    meta.textContent = `${estado} · ${s.modelo || ""} · ${quando}`;
    li.append(h, meta);
    if (s.status === "erro" && s.erro) {
      const p = document.createElement("p");
      p.className = "erro"; p.textContent = s.erro;
      li.append(p);
    }
    if (s.status === "aguardando") {
      const p = document.createElement("p");
      p.className = "site__meta";
      p.innerHTML = `No Claude Code: <span class="comando"></span>`;
      $(".comando", p).textContent = `/gerar-site ${s.slug}`;
      li.append(p);
    }
    if (s.url && s.status === "pronto") {
      const acoes = document.createElement("div");
      acoes.className = "lead__acoes";
      const abrir = document.createElement("a");
      abrir.className = "botao botao--forte"; abrir.href = s.url; abrir.target = "_blank"; abrir.rel = "noopener";
      abrir.textContent = "Abrir";
      const copiar = document.createElement("button");
      copiar.type = "button"; copiar.className = "botao"; copiar.textContent = "Copiar link";
      copiar.addEventListener("click", async () => { await navigator.clipboard.writeText(s.url); copiar.textContent = "Copiado"; });
      acoes.append(abrir, copiar);
      const w = whatsDoLead(s.leads?.telefone_intl, `Oi! Aqui é o ${SEU_NOME}, falamos agora há pouco. Montei uma prévia do site da ${nome}, dá uma olhada no celular: ${s.url}`);
      if (w) {
        const enviar = document.createElement("a");
        enviar.className = "botao"; enviar.href = w; enviar.target = "_blank"; enviar.rel = "noopener";
        enviar.textContent = "Mandar no WhatsApp";
        acoes.append(enviar);
      }
      li.append(acoes);
    }
    if (s.pendencias?.length) {
      const div = document.createElement("div");
      div.className = "site__pendencias";
      div.textContent = "Confirmar com o cliente:";
      const lista = document.createElement("ul");
      for (const p of s.pendencias) { const i = document.createElement("li"); i.textContent = p; lista.append(i); }
      div.append(lista);
      li.append(div);
    }
    return li;
  }));
  if (!data.length) ul.innerHTML = '<li class="vazio">Nenhum site ainda.</li>';
}
