# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

Site estático (GitHub Pages) que auxilia o **fechamento fiscal**: concilia as notas
lançadas no ERP com as notas emitidas contra o CNPJ na SEFAZ. Sem backend, sem build,
sem dependências instaláveis — só HTML/CSS/JS servido como arquivo. Bibliotecas externas
(SheetJS, JSZip, highlight.js) vêm de CDN. UI, comentários e mensagens de commit em
**pt-BR** (Conventional Commits; o histórico commita direto na `main`, que é publicada).

Três páginas:

- `index.html` — landing com 3 cards: abrir `conciliacao.html`, abrir
  `conciliacao-servicos.html`, e baixar o modelo `assets/relatorio-fiscal.xlsx`. Link
  fixo no canto pra `controle-nf.xlsx` (planilha admin). Abaixo dos cards, um painel
  "Fechamento conectado ao ERP" baixa `assets/conector-erp.zip` — ver seção própria.
- `conciliacao.html` — a aplicação web de conciliação (notas da SEFAZ × ERP).
- `conciliacao-servicos.html` — conciliação das **NFS-e** (notas de serviço) emitidas
  contra o nosso CNPJ × entradas de serviço lançadas no ERP.

Pasta `assets/` guarda os dois modelos `.xlsx` usados pelos "Gerar Relatório Formatado"
(`relatorio-fiscal.xlsx` e `Fechamento_NFSe_Mensal.xlsx`) — ver seções específicas abaixo.

Pasta `arquivos_exemplo/` guarda arquivos reais só para teste local — **inteira no
`.gitignore`**, não versionar nada dela.

## Rodar e testar

- **Servir:** abrir `index.html` / `conciliacao.html` com o Live Server do VS Code
  (porta 5501, ver `.vscode/settings.json`) ou qualquer servidor estático. Não abra via
  `file://` — os `fetch` dos modelos em `assets/*.xlsx` e a API de clipboard exigem
  `http://`.
- **Testes:** abrir `tests/conciliacao-engine.test.html` e
  `tests/servicos-engine.test.html` no navegador — cada um roda sozinho e mostra
  "N/N testes passaram". Não há runner nem `npm test`.
- **Testes headless** (engine e parsers penduram os globals em `global`):
  ```bash
  node -e 'global.window=global;global.ConciliacaoEngine=require("./js/conciliacao-engine.js");require("./js/conciliacao-parsers.js");let h=require("fs").readFileSync("tests/conciliacao-engine.test.html","utf8");let c=h.split(/<script>/).pop().split("</script>")[0].replace(/\/\/ Render[\s\S]*$/,"")+"\nreturn results";const r=new Function(c)();const f=r.filter(x=>!x.pass);console.log((r.length-f.length)+"/"+r.length);f.forEach(x=>console.log("FAIL",x.name))'
  ```
- **Deploy:** `git push` na `main` (GitHub Pages, `andre-jnr/fechamento-fiscal`).
- **Fechamento conectado ao ERP (opcional):** `cd conector-erp && npm install && npm start`
  sobe um servidor local que também serve o site — abrir
  `http://localhost:3000/conciliacao.html` em vez do Live Server, precisa estar na VPN.
  Ver "`conector-erp/` — fechamento conectado ao ERP" mais abaixo.

## Arquitetura de `conciliacao.html`

Os scripts carregam **nesta ordem** e cada um pendura um global em `window`; o último é
o orquestrador:

| arquivo | global | papel |
|---|---|---|
| `js/conciliacao-engine.js` | `ConciliacaoEngine` | **lógica pura, sem DOM.** Normalização, `buildIndices`, `conciliarNota`, filtros, stats, `noteKey`/`overrideId`. Também `module.exports` p/ testes em Node. |
| `js/conciliacao-parsers.js` | `ConciliacaoParsers` | Lê e valida o CSV da SEFAZ e o XLSX/XLS do sistema. `parse*` (a partir de `File`) e `*RowsFromMatrix` (a partir da matriz bruta — usado na importação de `.json`). O arquivo do sistema tem duas origens: **Moura** (padrão) e **Atak** (filial do CD) — `detectSistemaOrigem` decide pela cara do arquivo e `sistemaRowsFromMatrix` delega para o parser certo. |
| `js/conciliacao-storage.js` | `ConciliacaoStorage` | IndexedDB (`conciliacao-fiscal`): store `noteOverrides` (o que o usuário alimenta, chave = `Engine.overrideId`) e `importHistory`. |
| `js/conciliacao-relatorio.js` | `ConciliacaoRelatorio` | Gera o "Relatório Formatado" editando `assets/relatorio-fiscal.xlsx` cirurgicamente como ZIP (ver abaixo). |
| `js/conciliacao-danfe.js` | `ConciliacaoDanfe` | Monta a **DANFE** (produto, modelo 55) a partir do XML padrão da NF-e (`http://www.portalfiscal.inf.br/nfe`) como HTML autossuficiente — réplica do leiaute clássico (canhoto, cabeçalho com código de barras decorativo, destinatário, cálculo do imposto, transportador, tabela de produtos). Mesmo espírito de `servicos-danfse.js`, mas pro layout de nota de produto. |
| `js/conciliacao-app.js` | — (IIFE) | Upload, execução da conciliação, dashboard, filtros, tabela, exportações, modal de novidades, modal da DANFE. Mantém o objeto `state`. |

**Fluxo:** upload SEFAZ (CSV `windows-1252`, separador `;`, lido pelo SheetJS — **ou**
um `.zip` de XML, ver abaixo) + sistema (XLSX/XLS, ou via `conector-erp/` — ver seção
própria) → `parsers` → `state.sefaz` / `state.sistema` → `Engine.buildIndices` +
`Engine.conciliarNota` por nota → `state.reconciled` → render. Edições inline de
Justificativa/Observação persistem no IndexedDB por `overrideId`.

**SEFAZ via `.zip` de XML — três jeitos de alimentar o card SEFAZ:** o card aceita CSV,
`.zip` de XML, ou **os dois juntos** (`accept=".csv,.zip" multiple`,
`setupSefazUpload` em `js/conciliacao-app.js` separa os arquivos selecionados pelo
nome). **O combo CSV + zip é o recomendado** — dá o melhor dos dois: SITUACAO/TIPO/
CFOP/VALOR/etc. sempre corretos (vêm do CSV, que é a fonte de verdade da SEFAZ) **e**
XML em toda nota que tiver correspondência no zip (habilita a DANFE).

- **Só CSV** (como sempre foi): `Parsers.parseSefazCsv`, sem mudança nenhuma.
- **CSV + zip**: `Parsers.attachXmlFromZip(sefazResult, zipFile)` — roda depois do CSV.
  Casa cada linha pela chave de acesso (`Id="NFe<44 dígitos>"` no XML) e só acrescenta
  `row.xml`; SITUACAO/TIPO/CFOP/VALOR continuam 100% do CSV, sem tocar neles.
  Reconstrói o `rawMatrix` com uma coluna `XML` a mais (ou atualiza se já existir),
  então o bundle `.json` de Exportar/Importar carrega tudo sem mudança de código.
- **Só zip** (`Parsers.parseSefazZip`) — **best-effort, com uma limitação de dado
  conhecida**: monta a linha inteira a partir do XML (`sefazRowRawFromXml`).
  - `TIPO` vem do campo oficial `ide/tpNF` (`0`→`ENTRADA`, `1`→`SAÍDA`) — é uma
    propriedade da nota/CFOP, não de quem somos nós. **Não** deduzir isso pelo CNPJ
    emitente (jeito antigo, errado — dava pra achar que uma compra em que somos
    destinatário seria sempre "Entrada", mas o `tpNF` real muitas vezes marca
    "Saída" mesmo assim; confirmado 1:1 contra o CSV real de
    `arquivos_exemplo/`: 232/232 notas bateram depois da correção).
  - `SITUACAO=CANCELADA` só é detectável quando o zip **também** tem o evento de
    cancelamento (`tpEvento=110111`, `cStat` 135/155 — `procEventoNFe`/similar,
    incluído no "Download de XMLs" só se a opção de baixar eventos for marcada no
    portal) ou uma pasta `Canceladas/`. **O "Download de XMLs" básico normalmente
    não inclui o evento** — nesse caso não existe NENHUM sinal de cancelamento no
    conteúdo do próprio XML da nota (`cStat` do `protNFe` continua `100`/Autorizado
    pra sempre, cancelamento é sempre um evento à parte) — `SITUACAO` fica vazia
    (equivalente a autorizada) mesmo pra notas já canceladas. **Por isso o combo
    CSV + zip é o caminho recomendado** sempre que SITUACAO importa — zip sozinho é
    só pra quando não se tem o CSV à mão e dá pra vivér sem saber quais notas foram
    canceladas depois da emissão.

Nos três casos, `FORNECEDOR` = nome do emitente (mesma semântica do CSV — a 1ª coluna
"RAZAO SOCIAL", sempre do emitente, entrada ou saída); `REJEITADA` sempre `N` no
caminho zip (só existe XML pra nota autorizada, rejeitada não gera XML válido). As
linhas do zip viram um `rawMatrix` sintético (cabeçalho igual ao do CSV + coluna
`XML`) que passa pelo **mesmo** `sefazRowsFromMatrix` do CSV — um único parser por
trás dos três caminhos. Um CSV puro nunca tem a coluna `XML`, então `row.xml` fica
vazio nesse caminho — sem tratamento especial.

Logo abaixo da grade de upload, `.conc-info-banner` (`conciliacao.html`) é um aviso
fixo (sempre visível, não é toast) explicando essa troca pro usuário em pt-BR direto:
dá pra ver a DANFE só com o `.zip`, mas conferir a Situação (Cancelada/Autorizada)
exige soltar o `.zip` **junto** com o CSV.

**Casagem SEFAZ × sistema (`Engine.encontraRecebida`):** tenta primeiro por **chave de
acesso** (44 dígitos, `Engine.chaveAcessoDigits`) — quando os dois lados têm chave, é
casagem exata, sem depender de NF/valor baterem. O parser do sistema só extrai `chave`
se o export tiver essa coluna (`SISTEMA_OPTIONAL_FIELDS`: "Chave de Acesso"/"Chave
NFe"/"Chave") — quando não tem (comum em exports antigos, ou linhas sem chave, ex.:
entradas de serviço), cai no fallback de sempre: NF + valor com tolerância R$0,02.
`buildIndices` monta `comprasPorChave` (Set) além do já existente `comprasPorNF`.

**Botão de DANFE (1ª coluna da tabela, antes de "Chave"):** existe pra uma nota quando
o XML dela veio de **qualquer um dos dois lados**:
1. **SEFAZ**, quando o `.zip` de XML entrou (sozinho ou junto com o CSV — ver acima)
   — nesse caso **todas** as notas que tiverem XML correspondente no zip ficam com o
   botão, mesmo sem nenhum arquivo do sistema importado.
2. **Sistema**, via `conector-erp` (busca direto no banco) — o export manual do XLSX
   nunca traz XML. O SQL de `conector-erp/query.js` já buscava
   `Conteudo_Arquivo_Xml`; ele sai no `rawMatrix` (coluna extra `XML NFe`, depois de
   "Empresa") e `SISTEMA_OPTIONAL_FIELDS` (`js/conciliacao-parsers.js`) lê essa coluna
   pro campo `row.xml` — um XLSX manual não tem essa coluna, `row.xml` fica vazio
   (sem tratamento especial). `buildIndices` monta `xmlPorChave` (Map chave→xml) além
   de `comprasPorChave`, casando pela chave de acesso da SEFAZ.

Em `runConciliacao`, cada linha reconciliada ganha
`xml: row.xml || (indices.xmlPorChave.get(chaveDaSefaz) || '')` — **o XML da própria
SEFAZ tem prioridade** sobre o do sistema (faz sentido: se a nota já veio com XML
próprio, não precisa do match). `danfeCell`/`openDanfe` (`js/conciliacao-app.js`) e o
modal `#danfeModalOverlay` seguem o mesmo padrão do modal da DANFSe em
`conciliacao-servicos.html` (iframe `srcdoc` + Imprimir + Abrir em nova aba), só que
renderizando via `ConciliacaoDanfe.buildHtml` (leiaute de NF-e, não de NFS-e).

**Sistema Atak (CD):** o nº da NF e a série saem da coluna "Documento"
(`filial-tipo-serie-numero`, ex.: `111-NEE-000-139439` → série `000`, NF `139439`); o
valor é a coluna "Valor Total". O parser do Atak devolve um `rawMatrix` já no layout do
Moura (Entrada/NF/Fornecedor/Desconto/Vlr. Nota/…) para que o "Relatório Formatado" e o
bundle `.json` funcionem sem tratamento especial. Esse layout não tem chave de acesso —
cai sempre no fallback NF+valor. CNPJ do CD: `19234190000644`.

**Exportar/Importar Conciliação:** um único `.json` com `sefaz.rawMatrix` +
`sistema.rawMatrix` + `notas[]` (id/justificativa/observação). Importar reconstrói as
linhas via `*RowsFromMatrix`, grava os overrides e re-concilia — reproduz o relatório de
quem enviou sem os arquivos originais.

## Arquitetura de `conciliacao-servicos.html`

Mesma pegada de `conciliacao.html` (globals em `window`, sem build). Reaproveita
`conciliacao-engine.js` (normalização) e `conciliacao-parsers.js` (parser do XLSX do
sistema, que é o mesmo layout Moura — Entrada/NF/Fornecedor/Vlr. Nota/Data Emissão/Chave).

| arquivo | global | papel |
|---|---|---|
| `js/servicos-engine.js` | `ServicosEngine` | Regra de casagem NFS-e × sistema, filtros, stats, `overrideId`. `module.exports` p/ testes. |
| `js/servicos-parsers.js` | `ServicosParsers` | Lê o **lote de NFS-e**: um `.zip` (JSZip) do portal nacional ou `.xml` soltos. `nfseRowFromXmlString` extrai os campos do layout nacional (`http://www.sped.fazenda.gov.br/nfse`) via `DOMParser` e guarda o XML (sem `<Signature>`) em `row.xml`. `nfseRowsFromPlain` reidrata as linhas na importação de `.json`. |
| `js/servicos-danfse.js` | `ServicosDanfse` | Monta a **DANFSe** a partir do `row.xml` como um HTML autossuficiente (`buildHtml`). Dois leiautes: `nacional` (réplica da DANFSe v2.0, para notas de AM) e `municipal` (estilo NFS-e paulistana, para SP / fora do estado) — `pickLayout` decide pela UF do prestador. |
| `js/servicos-relatorio.js` | `ServicosRelatorio` | Gera o "Relatório Formatado" editando `assets/Fechamento_NFSe_Mensal.xlsx` cirurgicamente como ZIP (ver abaixo). |
| `js/servicos-storage.js` | `ServicosStorage` | IndexedDB `conciliacao-servicos` (store `noteOverrides`, chave = `ServicosEngine.overrideId`). |
| `js/servicos-app.js` | — (IIFE) | Upload, conciliação, dashboard, filtros, tabela, exportações, bundle `.json`, modal da DANFSe / descrição completa, "Gerar Relatório Formatado". |

**Identidade da NFS-e:** `overrideId` = a **chave de acesso da NFS-e (50 dígitos)**, do
atributo `infNFSe/@Id` sem o prefixo `NFS`; fallback para `prestadorCnpj|nº|série|valor|emissão`.

**Regra de status** (`ServicosEngine.conciliar`): justificativa manual sobrescreve →
veio da pasta `Canceladas/` do lote → `CANCELADA`; casa com um lançamento do sistema
(nº+valor **ou** valor+nome do prestador, tolerância R$0,02, comparando contra `vServ`
e `vLiq`) → `LANÇADA`; emitida nos últimos 2 dias → `A LANÇAR`; senão `NÃO LANÇADA`.
O número da NFS-e (`nNFSe`) é comparado com a coluna `NF` do sistema; a casagem por
valor+prestador cobre os casos em que o ERP renumera a nota.

**Justificativa** (`JUSTIFICATIVA_OPCOES`): `NÃO PRECISA`, `JÁ LANÇADA`, `A LANÇAR`,
`PARA REJEITAR`, `CANCELADA` — mesmo nome/vocabulário da conciliação da SEFAZ. Quando
diferente de `NÃO PRECISA`, vira o status da nota via `JUSTIFICATIVA_STATUS`
(`JÁ LANÇADA`→`LANÇADA`, `PARA REJEITAR`→`PARA REJEITAR`, as demais 1:1).

**ISS:** `nfseRowFromXmlString` extrai `valores/vISSQN` (valor), `pAliqAplic`/`pAliq`
(alíquota) e `tribMun/tpRetISSQN` (`1` = retido pelo tomador). A coluna ISS mostra o
valor + a tag `ISS`/`RETIDO`; o filtro tem com ISS / ISS retido / **ISS não retido**
(o caso da NFS 10 do Auticom) / sem ISS, e há card no dashboard.

**DANFSe / descrição:** a 1ª coluna da tabela é um botão que abre a DANFSe
(`ServicosDanfse.buildHtml`) num modal com `<iframe srcdoc>` + botões Imprimir / Abrir
em nova aba. O texto da coluna Descrição é clicável e abre a descrição completa
(`xDescServ`) num modal. O `row.xml` viaja no bundle `.json` para a DANFSe funcionar
após importação.

**Tomador:** `nfseRowFromXmlString` também extrai `toma/CNPJ` e `toma/xNome` (`row.tomadorCnpj`/
`row.tomadorNome`) — não aparecem na tabela, só alimentam o campo "Empresa" do
"Gerar Relatório Formatado" (ver abaixo).

## Regra de conciliação — duas fontes que precisam ficar em sincronia

A mesma lógica existe em **dois lugares** e qualquer alteração de regra tem que ser
replicada nos dois:

1. `Engine.conciliarNota` em `js/conciliacao-engine.js` (a implementação executável);
2. a fórmula da coluna STATUS na tabela `RELATORIO` dentro de `relatorio-fiscal.xlsx`.

(`index.html` tinha uma 3ª cópia — o texto da fórmula exibido pra copiar no Excel — mas
essa seção foi removida no redesign da landing page; hoje `index.html` só tem os 3
cards de navegação, nada de fórmula.)

Ordem das regras: ENTRADA (sub-regras) → NF+valor casa no sistema (tolerância R$0,02) —
**na versão JS, casagem por chave de acesso tem prioridade sobre essa etapa, ver acima**
— → CANCELADA → indicador SEFAZ de rejeição → justificativa manual → CFOP 5926 → CFOP
5949 emitida por um CNPJ do próprio grupo (`Engine.CNPJS_PROPRIOS`) → valor casa com
ENTRADA do próprio SEFAZ → CFOP 5927 → UF ≠ AM → emissão nos últimos 2 dias →
NÃO LANÇADA.

**Gap conhecido e deliberado:** a fórmula da coluna STATUS em `relatorio-fiscal.xlsx`
(dentro da Tabela `RELATORIO`, via `XLOOKUP` em `tabela_compras[NF]`/`[Vlr. Nota]`)
**ainda não casa por chave** — só JS. Motivo: a Tabela do Excel `tabela_compras` (a
aba SISTEMA) só cobre as colunas `A:I` (9 colunas, dimensionada pro layout do Atak);
a coluna "Chave de Acesso" do Moura cai na coluna O, fora do intervalo da Tabela.
Alargar uma Tabela do Excel de verdade (com slicers dependendo dela) via edição bruta
de XML é arriscado demais pra fazer sem conseguir abrir o resultado no Excel pra
conferir — por isso ficou de fora por ora. Se for resolver: alargue a Tabela pelo
próprio Excel (Design da Tabela → Redimensionar Tabela, até a coluna O) e só então
peça pra atualizar a fórmula (aí é só texto, não estrutura). Enquanto isso, o
`relatorio-fiscal.xlsx` casa só por NF+valor — sem regressão, só um gap conhecido em
relação à página web.

## `relatorio-fiscal.xlsx` — edição cirúrgica

`conciliacao-relatorio.js` **não** reescreve o xlsx pelo SheetJS (isso descartaria
Tabelas, gráficos e slicers). Ele abre o arquivo como ZIP (JSZip) e troca só o necessário:
`<sheetData>` das abas SEFAZ e SISTEMA, e as células das colunas M/N/O da aba RELATÓRIO.

Premissas fixas presas ao modelo (revisar se o `.xlsx` for regravado pelo Excel):

- Aba SEFAZ com layout de colunas posicional: `A`=UF, `B`=CHAVE, `C`=NF, `D`=SÉRIE,
  `E`=EMISSÃO, `F`=CNPJ EMISSOR, `H`=FORNECEDOR, `L`=CFOP, `N`=SITUAÇÃO, `O`=TIPO,
  `P`=VALOR, `V`=REJEITADA (as fórmulas da aba RELATÓRIO referenciam essas posições).
- Tabela `RELATORIO` = `B19:O1106`; cabeçalho na linha 19; dados 20–1106
  (`RELATORIO_LIMITE_LINHAS = 1087`, `RELATORIO_HEADER_ROW = 19`); só `M`=Justificativa
  e `N`=Observação são escritas pelo app. `O`=CHAVE já faz parte do modelo, com fórmula
  própria (`IF(SEFAZ!B2="","",SEFAZ!B2)`) — o app não a toca.
- `forceFullCalcOnLoad` marca o workbook para recalcular ao abrir (os valores em cache
  das fórmulas continuam os do modelo até o Excel abrir).

## `Fechamento_NFSe_Mensal.xlsx` — edição cirúrgica

Modelo bem mais simples que o `relatorio-fiscal.xlsx`: uma aba única ("Fechamento NFS-e",
sem Tabela/gráfico do Excel) + uma aba de legenda que `servicos-relatorio.js` nem toca.
Como não há tabela do Excel para preservar, `writeFechamentoSheet` **reconstrói o
`<sheetData>` inteiro** a cada geração (diferente do `relatorio-fiscal.xlsx`, que só edita
células pontuais) — nº de linhas de dados = nº de NFS-e de `state.reconciled`, sem limite
fixo (o modelo nasce com 40 linhas de exemplo, mas isso é só o ponto de partida).

Estrutura fixa do modelo (linhas 1-9 = cabeçalho, reproduzidas linha a linha com os
mesmos estilos `s=` do original):

- Linha 5: metadados — `D5`=Empresa (moda de `row.tomadorNome` entre as notas), `G5`=
  Competência (`MM/AAAA`, mês/ano mais frequente em `row.emissao`), `J5`=Responsável
  (campo "Responsável:" da página), `M5`=fórmula `TODAY()` (não mexida).
- Linha 7/8: cartões do dashboard — Total de Notas, Valor Total, ISS Total, **Não
  Lançadas** (`COUNTIF(J10:J{lastDataRow},"Não Lançada")` — conta pela coluna `J`, não
  mais pela `L`) e Canceladas — fórmulas `COUNTA`/`SUM`/`COUNTIF` recalculadas para o novo
  intervalo.
- Linha 9: cabeçalho da tabela (A–M, com emoji, texto fixo).
- Linha 10 em diante: uma linha por NFS-e. Coluna `J` (Status) = os mesmos status do
  fechamento de NFS-e na página — `Lançada`/`Não Lançada`/`Cancelada`/**`Para Rejeitar`**
  (`statusDocumento`: `CANCELADA`/`row.cancelada` → Cancelada, `LANÇADA` → Lançada,
  `PARA REJEITAR` → Para Rejeitar, resto (`NÃO LANÇADA`/`A LANÇAR`) → Não Lançada); coluna
  `L` (Justificativa) = a mesma lista da página (`Engine.JUSTIFICATIVA_OPCOES`), só com
  capitalização de frase — `JUSTIFICATIVA_XLSX_MAP` traduz 1:1 (`NÃO PRECISA`→"Não
  precisa", ..., `PARA REJEITAR`→"Para rejeitar"). As listas suspensas do modelo
  (`J`=`Lançada,Não Lançada,Cancelada,Para Rejeitar`;
  `L`=`Não precisa,Já lançada,A lançar,Para rejeitar,Cancelada`), a formatação condicional
  e a legenda na aba "📘 Legenda & Instruções" foram todas atualizadas juntas para bater com
  esses valores. A cor "Para Rejeitar" (laranja-queimado, igual ao badge
  `--badge-para-rejeitar` da SEFAZ) exigiu estender `xl/styles.xml` com uma nova fonte,
  fill, `cellXf` (pill da legenda) e `dxf` (formatação condicional) — únicas partes deste
  modelo, além do `<sheetData>` das duas abas, que já foram editadas manualmente (fora do
  fluxo do `writeFechamentoSheet`, que só mexe na aba "Fechamento NFS-e").
- Linhas que nasceram **"Não Lançada"** ou **"Para Rejeitar"** recebem em `J` uma
  **fórmula** (`statusJFormula`), não um valor fixo: `IF($L="Cancelada","Cancelada",
  IF($L="Já lançada","Lançada",IF($L="Para rejeitar","Para Rejeitar","Não Lançada")))`.
  Assim, se depois — já na planilha — o usuário mudar a Justificativa daquela linha, o
  Status acompanha sozinho, sem regerar o relatório. Linhas que já nasceram
  Lançada/Cancelada (`buildStatusCell`) ficam com valor fixo — são fatos que vieram prontos
  da conciliação (casaram no sistema ou vieram canceladas do lote de XML) e não devem mudar
  por causa da Justificativa.
- Linha seguinte à última nota: "TOTAL DO MÊS" com `SUM` de Valor/ISS.

Depois de reescrever `<sheetData>`, `updateRanges` ajusta tudo que referenciava o
intervalo fixo `10:49`/`50` do modelo original: `autoFilter`, a `mergeCell` da linha de
total, as 4 `conditionalFormatting` (zebra, barra de dados do Valor — inclusive a
duplicata em `extLst > x14:conditionalFormattings > xm:sqref` — e as cores de Status/
Justificativa) e as 2 `dataValidation` (listas de Status/Justificativa), além de
`dimension`. `forceFullCalcOnLoad` também é chamado.

## `conector-erp/` — fechamento conectado ao ERP (opcional, local)

Pasta **inteira fora do repositório público** (`.gitignore`, mesmo padrão de
`arquivos_exemplo/`) — tem credencial real de banco no `.env`. Resolve o passo manual
de "exportar o XLSX do sistema e subir no site": é um servidor Node/Express que roda
na máquina do usuário (precisa estar na VPN da empresa) e:

1. **Serve o site estático inteiro** (raiz do repo) em `http://localhost:3000` — usar
   `http://localhost:3000/conciliacao.html` em vez da URL do GitHub Pages. Servir pela
   mesma origem evita *mixed content* (HTTPS não pode chamar `http://localhost`) sem
   precisar de certificado. A URL pública continua funcionando normalmente, sem
   nenhuma mudança — é 100% opt-in.
2. Expõe `GET /api/sistema?unidade=CHAVE&de=YYYY-MM-DD&ate=YYYY-MM-DD`, que consulta
   `Entrada_Produto` no SQL Server da unidade (`config/unidades.js` — Parque Dez,
   Ponta Negra, Morada do Sol, Monte das Oliveiras, CD) e devolve `{ rawMatrix }` **no
   mesmo layout do export manual do Moura**, incluindo a Chave de Acesso — por isso o
   front-end reaproveita `Parsers.sistemaRowsFromMatrix` sem nenhum parsing novo.

`conciliacao.html`/`js/conciliacao-app.js`: quando `location.hostname` é
`localhost`/`127.0.0.1`, o card SISTEMA mostra um bloco extra ("buscar direto do
sistema") com seletor de unidade + período + botão — `setupConectorErp()` busca
`/api/unidades` pra popular o seletor e, no clique, `fetch('/api/sistema?...')` →
`Parsers.sistemaRowsFromMatrix` → mesma atribuição a `state.sistema` que o upload
manual já fazia. Fora do localhost (GitHub Pages) o bloco nem aparece; o upload manual
continua como único caminho, sem alteração.

**Dois gaps só confirmáveis no banco real** (documentados com `TODO` em
`conector-erp/query.js` e no `README.md` da pasta — sem VPN/acesso ao banco, não deu
pra validar a query de ponta a ponta): (1) nome do Fornecedor — a consulta de
`Entrada_Produto` não traz, falta confirmar o JOIN certo; (2) "Vlr. Nota" (valor total
da nota) — só existe `Valor_Produtos` na consulta original, usado como placeholder.
Nenhum dos dois bloqueia a casagem por chave (que já vem completa via `Chave_NFE`),
só afetam a coluna Fornecedor exibida e o fallback NF+valor pras poucas notas sem
chave.

**`conector-erp/iniciar.bat`** — clique-duplo pra rodar sem terminal: confere Node.js
instalado, cria `.env` a partir do `.env.example` na 1ª vez (e para aí, pedindo pra
preencher usuário/senha), avisa se `config/unidades.js` ainda tem os placeholders
(`SERVIDOR_AQUI`/`BANCO_AQUI`), roda `npm install` só se `node_modules/` não existir, e
por fim sobe o servidor numa janela separada (`cmd /k`, fica aberta pra ver os logs) e
abre `http://localhost:3000/conciliacao.html` no navegador padrão. **Sempre salvar com
quebra de linha CRLF e sem caractere não-ASCII** — testado e confirmado que `.bat` com
só `LF` ou com caractere UTF-8 multi-byte (ex.: travessão "—") quebra o parser do
`cmd.exe` de um jeito sutil (perde os primeiros caracteres de cada linha, "setlocal"
virava "tlocal" etc.) sem erro óbvio.

**`assets/conector-erp.zip` — pacote público pra baixar em `index.html`:** como o
`conector-erp/` de verdade tem credencial real (`.env`, `config/unidades.js` com
hostname/IP/banco reais) e fica todo fora do git, o zip **não é esse `conector-erp/`
compactado direto** — é gerado à parte, sanitizado, e **esse sim é commitado
normalmente** (não está no `.gitignore`). Conteúdo do zip: todos os arquivos rastreados
pelo git na raiz do repo (`git ls-files`, exceto `tests/`, `CLAUDE.md` e `.gitignore` —
site inteiro, pra `conector-erp/server.js` conseguir servir estático a partir de
`__dirname/..`) **+** uma cópia sanitizada de `conector-erp/`: `package.json`,
`server.js`, `db.js`, `query.js`, `iniciar.bat` e `.env.example` são idênticos aos reais
(não têm segredo nenhum, só leem do `.env`/`config/unidades.js` em runtime) — só
`config/unidades.js` é **substituído por um placeholder** (`SERVIDOR_AQUI`/
`BANCO_AQUI`, sem os 5 hostnames/IPs/bancos reais) e o `.env` real **não entra**
(só o `.env.example`, já genérico). Documentado no `README.md` de dentro do zip.

**Se algum arquivo do site ou do `conector-erp/` mudar, o zip fica desatualizado** —
não há automação que regenera sozinho. Pra regenerar: montar uma pasta com
`git ls-files` (menos `tests/`, `CLAUDE.md`, `.gitignore`, e o próprio
`assets/conector-erp.zip`) + a cópia sanitizada de `conector-erp/` (tudo igual, exceto
`config/unidades.js` trocado pelo placeholder e sem `.env`), compactar com
`Compress-Archive` e sobrescrever `assets/conector-erp.zip`. **Cuidado:**
`git ls-files` só lista o que já está **commitado** — um arquivo novo criado na mesma
sessão (ex.: `js/conciliacao-danfe.js` quando foi criado) fica de fora até ser
commitado, então depois de criar um arquivo novo que o site precisa, copie-o pra pasta
de staging manualmente antes de compactar (e confira com `diff -r` contra
`js/`/`css/`/etc. do repo antes de sobrescrever, pra não deixar nada faltando de novo).
**Sempre conferir antes de commitar** (extrair o zip gerado e `grep` pela senha real e
pelos hostnames de `conector-erp/config/unidades.js` — nenhum dos dois pode aparecer).
**Nunca copie `conector-erp/config/unidades.js` direto pro staging** — é o arquivo com
os 5 hostnames/IPs/bancos reais; já aconteceu de copiar ele por engano (mesmo nome de
arquivo que o placeholder, fácil de confundir num loop de cópia). O placeholder correto
sempre vem de um zip já sanitizado anterior (extrair e reusar
`conector-erp/config/unidades.js` de dentro do `.zip`, não da pasta `conector-erp/`
real) ou reescrito do zero com `SERVIDOR_AQUI`/`BANCO_AQUI`.

## Identidade da nota

- `Engine.noteKey(row)` — chave composta `cnpjEmissor|NF|série|valorKey|emissão`, usada
  para deduplicar/casar dentro de uma execução.
- `Engine.overrideId(row)` — **chave de acesso da NF-e (44 dígitos)** quando existe, com
  fallback para `noteKey`. É o ID de persistência: estável entre exportações e entre
  importações de dias diferentes.
