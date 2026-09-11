# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

Site estático (GitHub Pages) que auxilia o **fechamento fiscal**: concilia as notas
lançadas no ERP com as notas emitidas contra o CNPJ na SEFAZ. Sem backend, sem build,
sem dependências instaláveis — só HTML/CSS/JS servido como arquivo. Bibliotecas externas
(SheetJS, JSZip, highlight.js) vêm de CDN. UI, comentários e mensagens de commit em
**pt-BR** (Conventional Commits; o histórico commita direto na `main`, que é publicada).

Três páginas:

- `index.html` — landing: baixa o modelo `assets/relatorio-fiscal.xlsx`, baixa
  `controle-nf.xlsx` (planilha admin) e exibe a fórmula principal da conciliação para
  copiar no Excel.
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

## Arquitetura de `conciliacao.html`

Os scripts carregam **nesta ordem** e cada um pendura um global em `window`; o último é
o orquestrador:

| arquivo | global | papel |
|---|---|---|
| `js/conciliacao-engine.js` | `ConciliacaoEngine` | **lógica pura, sem DOM.** Normalização, `buildIndices`, `conciliarNota`, filtros, stats, `noteKey`/`overrideId`. Também `module.exports` p/ testes em Node. |
| `js/conciliacao-parsers.js` | `ConciliacaoParsers` | Lê e valida o CSV da SEFAZ e o XLSX/XLS do sistema. `parse*` (a partir de `File`) e `*RowsFromMatrix` (a partir da matriz bruta — usado na importação de `.json`). O arquivo do sistema tem duas origens: **Moura** (padrão) e **Atak** (filial do CD) — `detectSistemaOrigem` decide pela cara do arquivo e `sistemaRowsFromMatrix` delega para o parser certo. |
| `js/conciliacao-storage.js` | `ConciliacaoStorage` | IndexedDB (`conciliacao-fiscal`): store `noteOverrides` (o que o usuário alimenta, chave = `Engine.overrideId`) e `importHistory`. |
| `js/conciliacao-relatorio.js` | `ConciliacaoRelatorio` | Gera o "Relatório Formatado" editando `assets/relatorio-fiscal.xlsx` cirurgicamente como ZIP (ver abaixo). |
| `js/conciliacao-app.js` | — (IIFE) | Upload, execução da conciliação, dashboard, filtros, tabela, exportações, modal de novidades. Mantém o objeto `state`. |

**Fluxo:** upload SEFAZ (CSV `windows-1252`, separador `;`, lido pelo SheetJS) + sistema
(XLSX/XLS) → `parsers` → `state.sefaz` / `state.sistema` → `Engine.buildIndices` +
`Engine.conciliarNota` por nota → `state.reconciled` → render. Edições inline de
Justificativa/Observação persistem no IndexedDB por `overrideId`.

**Sistema Atak (CD):** o nº da NF e a série saem da coluna "Documento"
(`filial-tipo-serie-numero`, ex.: `111-NEE-000-139439` → série `000`, NF `139439`); o
valor é a coluna "Valor Total". O parser do Atak devolve um `rawMatrix` já no layout do
Moura (Entrada/NF/Fornecedor/Desconto/Vlr. Nota/…) para que o "Relatório Formatado" e o
bundle `.json` funcionem sem tratamento especial. A casagem SEFAZ×sistema é por NF+valor
(tolerância R$0,02), igual ao Moura. CNPJ do CD: `19234190000644`.

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

## Regra de conciliação — três fontes que precisam ficar em sincronia

A mesma lógica existe em **três lugares** e qualquer alteração de regra tem que ser
replicada nos três:

1. `Engine.conciliarNota` em `js/conciliacao-engine.js` (a implementação executável);
2. a fórmula da coluna STATUS na tabela `RELATORIO` dentro de `relatorio-fiscal.xlsx`;
3. a fórmula exibida (em português do Excel) em `index.html`.

Ordem das regras: ENTRADA (sub-regras) → NF+valor casa no sistema (tolerância R$0,02) →
CANCELADA → indicador SEFAZ de rejeição → justificativa manual → CFOP 5926 → CFOP 5949
emitida por um CNPJ do próprio grupo (`Engine.CNPJS_PROPRIOS`) → valor casa com ENTRADA
do próprio SEFAZ → CFOP 5927 → UF ≠ AM → emissão nos últimos 2 dias → NÃO LANÇADA.

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

## Identidade da nota

- `Engine.noteKey(row)` — chave composta `cnpjEmissor|NF|série|valorKey|emissão`, usada
  para deduplicar/casar dentro de uma execução.
- `Engine.overrideId(row)` — **chave de acesso da NF-e (44 dígitos)** quando existe, com
  fallback para `noteKey`. É o ID de persistência: estável entre exportações e entre
  importações de dias diferentes.
