import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, WORKER_URL, SEU_NOME } from "./config.js";
import { NICHOS } from "./nichos.js";
import { zipSync, strToU8 } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";

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

// ---------- levar o site pra outro Claude ----------
const LEIA_ME = (nome, slug) => `Site de ${nome} (slug ${slug})

Pra gerar em qualquer Claude:
1. Abra uma conversa nova e anexe TODOS os arquivos desta pasta: manual.md, design-director.md, dados.json e as fotos da pasta img.
2. Cole o conteúdo de PROMPT.txt como mensagem e envie.
3. O Claude responde com a direção e o HTML. Salve o HTML como index.html nesta mesma pasta (ao lado da pasta img) e abra com dois cliques pra conferir.
4. Pra publicar: painel, Sites gerados, botão "Publicar HTML" neste site, e escolha o index.html.
`;

async function baixarArquivos(site, nome, botao) {
  botao.disabled = true;
  const textoOriginal = botao.textContent;
  botao.textContent = "Montando o zip…";
  try {
    const r = await fetch(`${WORKER_URL}/api/arquivos/${site.slug}`, { headers: { Authorization: `Bearer ${await token()}` } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro || `erro ${r.status}`);
    const pasta = site.slug;
    const arquivos = {
      [`${pasta}/LEIA-ME.txt`]: strToU8(LEIA_ME(nome, site.slug)),
      [`${pasta}/PROMPT.txt`]: strToU8(`Siga primeiro o manual.md (regras da casa) e depois o design-director.md (pacote de direção; o manual vence quando divergirem). As fotos anexadas são os arquivos img/N.jpg citados nos dados.\n\n${d.prompt}`),
      [`${pasta}/manual.md`]: strToU8(d.manual),
      [`${pasta}/design-director.md`]: strToU8(d.pacote),
      [`${pasta}/dados.json`]: strToU8(JSON.stringify(d.dados, null, 2)),
    };
    for (const f of d.dados.fotos) {
      const img = await fetch(`${WORKER_URL}/s/${site.slug}/${f.arquivo}`);
      if (img.ok) arquivos[`${pasta}/${f.arquivo}`] = [new Uint8Array(await img.arrayBuffer()), { level: 0 }];
    }
    const blob = new Blob([zipSync(arquivos)], { type: "application/zip" });
    // Link visível: se o navegador barrar o download automático, é só clicar nele.
    botao.parentElement.querySelector(".link-zip")?.remove();
    const a = document.createElement("a");
    a.className = "botao botao--forte link-zip";
    a.href = URL.createObjectURL(blob);
    a.download = `${site.slug}.zip`;
    a.textContent = `Salvar ${site.slug}.zip`;
    botao.after(a);
    a.click();
    botao.textContent = textoOriginal;
  } catch (e) {
    botao.textContent = `Falhou: ${e.message}`;
  } finally {
    botao.disabled = false;
  }
}

function publicarHtml(site, botao) {
  const entrada = document.createElement("input");
  entrada.type = "file";
  entrada.accept = ".html,text/html";
  entrada.addEventListener("change", async () => {
    const arquivo = entrada.files?.[0];
    if (!arquivo) return;
    botao.disabled = true;
    botao.textContent = "Publicando…";
    try {
      const r = await fetch(`${WORKER_URL}/api/publicar/${site.slug}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "text/html; charset=utf-8" },
        body: await arquivo.text(),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.erro || `erro ${r.status}`);
      const erros = (d.achados || []).filter((a) => a.gravidade === "erro");
      botao.textContent = erros.length ? `Publicado, com ${erros.length} alerta(s) do verificador` : "Publicado";
      setTimeout(carregarSites, 1500);
    } catch (e) {
      botao.textContent = `Falhou: ${e.message}`;
    } finally {
      botao.disabled = false;
    }
  });
  entrada.click();
}

// ---------- login ----------
const formLogin = $("#form-login");
formLogin.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(formLogin);
  const { error } = await sb.auth.signInWithPassword({ email: f.get("email"), password: f.get("senha") });
  $(".mensagem", formLogin).textContent = error ? `Não entrou: ${error.message}` : "";
});
$("#sair").addEventListener("click", () => sb.auth.signOut());

sb.auth.onAuthStateChange((_evento, sessao) => {
  $("#tela-login").hidden = !!sessao;
  $("#tela-app").hidden = !sessao;
  if (sessao) abrirAba(location.hash.slice(1) || "buscar");
});

// ---------- menu lateral ----------
const SECOES = {
  buscar: "Buscar leads", oportunidades: "Oportunidades", criar: "Criar site",
  contatos: "Meus contatos", historico: "Histórico de buscas", sites: "Sites gerados",
};
const menu = $("#menu");
const fundoMenu = $("#fundo-menu");
const botaoMenu = $("#abrir-menu");
function menuMovel(aberto) {
  menu.classList.toggle("aberto", aberto);
  fundoMenu.hidden = !aberto;
  botaoMenu.setAttribute("aria-expanded", String(aberto));
  if (aberto) $(".menu__item[aria-current]", menu)?.focus();
}
botaoMenu.addEventListener("click", () => menuMovel(!menu.classList.contains("aberto")));
fundoMenu.addEventListener("click", () => menuMovel(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu.classList.contains("aberto")) { menuMovel(false); botaoMenu.focus(); } });

function abrirAba(nome) {
  if (!SECOES[nome]) nome = "buscar";
  document.querySelectorAll(".menu__item").forEach((b) => {
    if (b.dataset.aba === nome) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-painel]").forEach((p) => (p.hidden = p.dataset.painel !== nome));
  $("#titulo-movel").textContent = SECOES[nome];
  history.replaceState(null, "", `#${nome}`);
  menuMovel(false);
  if (nome === "buscar") mostrarCota();
  if (nome === "oportunidades") carregarOportunidades();
  if (nome === "criar") carregarCriar();
  if (nome === "contatos") carregarContatos();
  if (nome === "historico") carregarHistorico();
  if (nome === "sites") carregarSites();
}
document.querySelectorAll(".menu__item").forEach((b) => b.addEventListener("click", () => abrirAba(b.dataset.aba)));
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

  const briefing = $(".lead__briefing textarea", li);
  briefing.value = lead.briefing || "";
  briefing.addEventListener("change", async () => {
    await sb.from("leads").update({ briefing: briefing.value }).eq("id", lead.id);
    lead.briefing = briefing.value;
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
  // Salva o briefing antes de gerar, pra não perder o que acabou de ser digitado.
  const salvarBriefing = async () => {
    if ((lead.briefing || "") === briefing.value) return;
    await sb.from("leads").update({ briefing: briefing.value }).eq("id", lead.id);
    lead.briefing = briefing.value;
  };
  botaoGerar.addEventListener("click", async () => { await salvarBriefing(); gerarPelaApi(lead, botaoGerar, progresso); });
  botaoLocal.addEventListener("click", async () => { await salvarBriefing(); prepararLocal(lead, botaoLocal, progresso); });
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
    if ((r.headers.get("content-type") || "").includes("application/json")) {
      const d = await r.json();
      acompanharFila(d.site_id, progresso);
      return;
    }
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

// Modo lote: o pedido fica na fila da API. Confere a cada 30 s enquanto a página estiver aberta;
// com a página fechada, o Worker confere sozinho a cada 5 min e o link aparece em "Sites".
async function conferirSite(siteId) {
  const r = await chamarWorker("/api/status", { site_id: siteId });
  const d = await r.json();
  if (!r.ok) throw new Error(d.erro || `erro ${r.status}`);
  return d;
}

function mostrarPronto(progresso, d) {
  progresso.innerHTML = "";
  const a = document.createElement("a");
  a.href = d.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Abrir o site";
  progresso.append("Pronto. ", a);
  if (d.pendencias?.length) progresso.append(` Confirmar com o cliente: ${d.pendencias.join("; ")}.`);
}

function acompanharFila(siteId, progresso) {
  const inicio = Date.now();
  const texto = (etapa) =>
    `Na fila da API${etapa === "corrigir" ? " (ajustando detalhes)" : ""}. Costuma levar minutos, pode passar de uma hora. Pode fechar: o link aparece em Sites. Esperando há ${Math.round((Date.now() - inicio) / 60000)} min.`;
  progresso.textContent = texto("gerar");
  const tique = async () => {
    if (!progresso.isConnected) return;
    try {
      const d = await conferirSite(siteId);
      if (d.status === "pronto") return mostrarPronto(progresso, d);
      if (d.status === "erro") {
        progresso.innerHTML = "";
        const s = document.createElement("span");
        s.className = "erro"; s.textContent = `Falhou: ${d.erro || "erro"}`;
        return progresso.append(s);
      }
      progresso.textContent = texto(d.etapa);
    } catch {
      // falha de rede: tenta de novo no próximo tique
    }
    setTimeout(tique, 30000);
  };
  setTimeout(tique, 30000);
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
    const levar = document.createElement("div");
    levar.className = "lead__acoes";
    levar.style.marginTop = "var(--e2)";
    const baixar = document.createElement("button");
    baixar.type = "button"; baixar.className = "botao"; baixar.textContent = "Baixar arquivos (.zip) pra outro Claude";
    baixar.addEventListener("click", () => baixarArquivos({ slug: d.slug }, lead.nome, baixar));
    levar.append(baixar);
    progresso.append(levar);
  } catch (e) {
    progresso.textContent = `Falhou: ${e.message}`;
  } finally {
    botao.disabled = false;
  }
}

function desenharLeads(lista, ul, extra, textoVazio = "Nada por aqui.") {
  ul.replaceChildren(...lista.map((l) => {
    const li = cartaoLead(l);
    if (extra) extra(li, l);
    return li;
  }));
  if (!lista.length) {
    const li = document.createElement("li");
    li.className = "vazio"; li.textContent = textoVazio;
    ul.append(li);
  }
}

// ---------- buscar ----------
const selNicho = $("#sel-nicho");
const selSub = $("#sel-subnicho");
const txtNicho = $("#txt-nicho");
const formBusca = $("#form-busca");
NICHOS.forEach((n, i) => selNicho.add(new Option(n.nome, String(i))));
function preencherSubnichos() {
  selSub.replaceChildren(...NICHOS[Number(selNicho.value)].subnichos.map((s) => new Option(s, s)));
  avisarRepetida();
}
selNicho.addEventListener("change", preencherSubnichos);
selSub.addEventListener("change", avisarRepetida);
txtNicho.addEventListener("input", avisarRepetida);
formBusca.elements.cidade.addEventListener("change", avisarRepetida);

function termoBuscado() {
  return txtNicho.value.trim() || selSub.value;
}

let historicoCache = null;
async function historico() {
  if (!historicoCache) {
    const { data } = await sb.from("buscas").select("*").order("criado_em", { ascending: false }).limit(500);
    historicoCache = data || [];
  }
  return historicoCache;
}
const normal = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
async function avisarRepetida() {
  const aviso = $("#aviso-repetida");
  const cidade = normal(formBusca.elements.cidade.value);
  const termo = normal(termoBuscado());
  if (!cidade || !termo) { aviso.textContent = ""; return; }
  const igual = (await historico()).find((b) => normal(b.cidade) === cidade && normal(b.nicho) === termo);
  aviso.textContent = igual
    ? `Você já buscou isso em ${new Date(igual.criado_em).toLocaleDateString("pt-BR")} (${igual.sem_site} sem site). Buscar de novo atualiza a lista e mantém status e anotações.`
    : "";
}
preencherSubnichos();

async function executarBusca(nicho, cidade) {
  const botao = $('button[type="submit"]', formBusca);
  const resumo = $("#resumo-busca");
  botao.disabled = true;
  resumo.textContent = `Buscando "${nicho}" em ${cidade} no Google Maps…`;
  try {
    const r = await chamarWorker("/api/buscar", { nicho, cidade });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro || `erro ${r.status}`);
    historicoCache = null;
    mostrarCota();
    const soRede = d.leads.filter((l) => l.site_atual).length;
    resumo.textContent = `${d.total} encontrados, ${d.leads.length} sem site${soRede ? ` (${soRede} só com rede social)` : ""}.`;
    desenharLeads(d.leads.sort((a, b) => pontuar(b) - pontuar(a)), $("#lista-busca"));
  } catch (err) {
    resumo.textContent = `Falhou: ${err.message}`;
  } finally {
    botao.disabled = false;
  }
}
formBusca.addEventListener("submit", (e) => {
  e.preventDefault();
  executarBusca(termoBuscado(), formBusca.elements.cidade.value.trim());
});

// ---------- cota grátis do Google ----------
// Mesmos limites do Worker (wrangler.toml). O mês segue o fuso do faturamento do Google.
const LIMITE = { busca: 950, detalhes: 950, fotos: 950 };
async function mostrarCota() {
  const p = $("#cota-google");
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" })
      .formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  const { data, error } = await sb.from("uso_google").select("tipo, chamadas").eq("mes", `${partes.year}-${partes.month}`);
  if (error) { p.textContent = ""; return; }
  const uso = { busca: 0, detalhes: 0, fotos: 0 };
  for (const r of data) uso[r.tipo] = r.chamadas;
  const pesquisas = Math.floor((LIMITE.busca - uso.busca) / 3);
  const sites = Math.min(LIMITE.detalhes - uso.detalhes, Math.floor((LIMITE.fotos - uso.fotos) / 10));
  p.textContent = `Grátis do Google neste mês: ainda dá pra umas ${Math.max(pesquisas, 0)} pesquisas e ${Math.max(sites, 0)} sites com 10 fotos. Ao chegar no limite o sistema para sozinho, sem cobrar.`;
}
// ---------- oportunidades ----------
// Pontua o quanto vale ligar: sem site, nota boa, muitas avaliações, fotos (o site sai melhor).
function pontuar(l) {
  let p = l.site_atual ? 1 : 2;
  if (l.nota >= 4.5) p += 2; else if (l.nota >= 4) p += 1;
  if (l.avaliacoes >= 50) p += 2; else if (l.avaliacoes >= 15) p += 1;
  if (l.qtd_fotos >= 5) p += 2; else if (l.qtd_fotos >= 1) p += 1;
  if (!l.telefone_intl) p -= 3;
  return p;
}
function motivos(l) {
  const m = [];
  if (!l.site_atual) m.push("sem site nenhum"); else m.push("só rede social");
  if (l.nota >= 4.5 && l.avaliacoes >= 15) m.push(`${String(l.nota).replace(".", ",")} com ${l.avaliacoes} avaliações`);
  if (l.qtd_fotos >= 5) m.push(`${l.qtd_fotos} fotos pro site`);
  if (whatsDoLead(l.telefone_intl)) m.push("tem WhatsApp");
  if (!l.telefone_intl) m.push("sem telefone no Maps");
  return m.join(" · ");
}
async function carregarOportunidades() {
  const { data, error } = await sb.from("leads").select("*").in("status", ["novo", "sem_resposta"]).limit(1000);
  if (error) return;
  const lista = data.sort((a, b) => pontuar(b) - pontuar(a)).slice(0, 100);
  desenharLeads(lista, $("#lista-oportunidades"), (li, l) => {
    const p = document.createElement("p");
    p.className = "motivos"; p.textContent = motivos(l);
    $(".lead__cabeca > div", li).append(p);
  });
}

// ---------- criar site ----------
let criarCache = [];
async function carregarCriar() {
  const [{ data: leads }, { data: sites }] = await Promise.all([
    sb.from("leads").select("*").limit(1000),
    sb.from("sites").select("lead_id, status"),
  ]);
  const comSite = new Set((sites || []).filter((s) => s.status !== "erro").map((s) => s.lead_id));
  const ordem = { fechado: 0, interessado: 1, liguei: 2, sem_resposta: 3, novo: 4, perdido: 5 };
  criarCache = (leads || [])
    .map((l) => ({ ...l, _temSite: comSite.has(l.id) }))
    .sort((a, b) => (a._temSite - b._temSite) || (ordem[a.status] - ordem[b.status]) || (pontuar(b) - pontuar(a)));
  filtrarCriar();
}
function filtrarCriar() {
  const q = normal($("#busca-criar").value);
  const lista = q
    ? criarCache.filter((l) => normal(l.nome).includes(q))
    : criarCache.filter((l) => ["interessado", "fechado"].includes(l.status) && !l._temSite);
  desenharLeads(lista.slice(0, 50), $("#lista-criar"), (li, l) => {
    if (l._temSite) {
      const p = document.createElement("p");
      p.className = "motivos"; p.textContent = "Já tem site gerado (veja em Sites gerados)";
      $(".lead__cabeca > div", li).append(p);
    }
  }, q ? "Nenhum lead com esse nome." : "Nenhum interessado sem site. Procure pelo nome acima ou marque leads como Interessado.");
}
$("#busca-criar").addEventListener("input", filtrarCriar);

// ---------- meus contatos ----------
async function carregarContatos() {
  const { data, error } = await sb.from("leads").select("*").order("atualizado_em", { ascending: false }).limit(1000);
  if (error) return;
  leadsCache = data;
  filtrarContatos();
}
function filtrarContatos() {
  const st = $("#filtro-status").value;
  const q = normal($("#filtro-texto").value);
  const lista = leadsCache.filter((l) =>
    (st ? l.status === st : l.status !== "novo") &&
    (!q || normal([l.nome, l.endereco, l.categoria].join(" ")).includes(q)));
  desenharLeads(lista, $("#lista-contatos"), null, st ? "Ninguém com esse status." : "Você ainda não mudou o status de nenhum lead. Comece por Oportunidades.");
}
$("#filtro-status").addEventListener("change", filtrarContatos);
$("#filtro-texto").addEventListener("input", filtrarContatos);

// ---------- histórico ----------
async function carregarHistorico() {
  historicoCache = null;
  const buscas = await historico();
  const ul = $("#lista-historico");
  if (!buscas.length) { ul.innerHTML = '<li class="vazio">Nenhuma busca ainda.</li>'; return; }
  ul.replaceChildren(...buscas.map((b) => {
    const li = document.createElement("li");
    li.className = "site historico";
    const info = document.createElement("div");
    const h = document.createElement("h2");
    h.className = "historico__titulo"; h.textContent = `${b.nicho} · ${b.cidade}`;
    const meta = document.createElement("p");
    meta.className = "site__meta";
    meta.textContent = `${new Date(b.criado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} · ${b.total} encontrados · ${b.sem_site} sem site`;
    info.append(h, meta);
    const acoes = document.createElement("div");
    acoes.className = "lead__acoes";
    const ver = document.createElement("button");
    ver.type = "button"; ver.className = "botao"; ver.textContent = "Ver leads";
    const lista = document.createElement("ul");
    lista.className = "lista historico__leads";
    lista.hidden = true;
    ver.addEventListener("click", async () => {
      if (!lista.hidden) { lista.hidden = true; ver.textContent = "Ver leads"; return; }
      const { data } = await sb.from("leads").select("*").eq("busca_id", b.id).limit(100);
      desenharLeads((data || []).sort((x, y) => pontuar(y) - pontuar(x)), lista, null,
        "Os leads dessa busca foram atualizados por uma busca mais nova.");
      lista.hidden = false; ver.textContent = "Esconder";
    });
    const repetir = document.createElement("button");
    repetir.type = "button"; repetir.className = "botao"; repetir.textContent = "Buscar de novo";
    repetir.addEventListener("click", () => {
      abrirAba("buscar");
      txtNicho.value = b.nicho;
      formBusca.elements.cidade.value = b.cidade;
      executarBusca(b.nicho, b.cidade);
    });
    acoes.append(ver, repetir);
    li.append(info, acoes, lista);
    return li;
  }));
}
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
    const estado = {
      pronto: "pronto", gerando: "preparando fotos", na_fila: "na fila da API",
      aguardando: "esperando o Claude Code", erro: "erro",
    }[s.status];
    meta.textContent = `${estado} · ${s.modelo || ""} · ${quando}`;
    li.append(h, meta);
    if (s.status === "erro" && s.erro) {
      const p = document.createElement("p");
      p.className = "erro"; p.textContent = s.erro;
      li.append(p);
    }
    if (s.status === "na_fila") {
      const conferir = document.createElement("button");
      conferir.type = "button"; conferir.className = "botao"; conferir.textContent = "Conferir agora";
      conferir.addEventListener("click", async () => {
        conferir.disabled = true;
        try {
          const d = await conferirSite(s.id);
          if (d.status !== "na_fila") return carregarSites();
          conferir.textContent = "Ainda na fila";
        } catch (e) {
          conferir.textContent = `Falhou: ${e.message}`;
        } finally {
          conferir.disabled = false;
        }
      });
      li.append(conferir);
    }
    if (s.status !== "gerando" && s.status !== "na_fila") {
      const levar = document.createElement("div");
      levar.className = "lead__acoes";
      const baixar = document.createElement("button");
      baixar.type = "button"; baixar.className = "botao"; baixar.textContent = "Baixar arquivos (.zip)";
      baixar.addEventListener("click", () => baixarArquivos(s, nome, baixar));
      const subir = document.createElement("button");
      subir.type = "button"; subir.className = "botao"; subir.textContent = "Publicar HTML";
      subir.addEventListener("click", () => publicarHtml(s, subir));
      levar.append(baixar, subir);
      li.append(levar);
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
