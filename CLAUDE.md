# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

Site estático (GitHub Pages) que auxilia o **fechamento fiscal**: concilia as notas
lançadas no ERP com as notas emitidas contra o CNPJ na SEFAZ. Sem backend, sem build,
sem dependências instaláveis — só HTML/CSS/JS servido como arquivo. Bibliotecas externas
(SheetJS, JSZip, highlight.js) vêm de CDN. UI, comentários e mensagens de commit em
**pt-BR** (Conventional Commits; o histórico commita direto na `main`, que é publicada).

Duas páginas:

- `index.html` — landing: baixa o modelo `relatorio-fiscal.xlsx`, baixa `controle-nf.xlsx`
  (planilha admin) e exibe a fórmula principal da conciliação para copiar no Excel.
- `conciliacao.html` — a aplicação web de conciliação.

## Rodar e testar

- **Servir:** abrir `index.html` / `conciliacao.html` com o Live Server do VS Code
  (porta 5501, ver `.vscode/settings.json`) ou qualquer servidor estático. Não abra via
  `file://` — os `fetch` de `relatorio-fiscal.xlsx` e a API de clipboard exigem `http://`.
- **Testes:** abrir `tests/conciliacao-engine.test.html` no navegador — roda sozinho e
  mostra "N/N testes passaram". Não há runner nem `npm test`.
- **Testes headless** (o engine também exporta via `module.exports`):
  ```bash
  node -e 'const E=require("./js/conciliacao-engine.js");let h=require("fs").readFileSync("tests/conciliacao-engine.test.html","utf8");let c=h.split(/<script>/).pop().split("</script>")[0].replace(/const Engine = window\.ConciliacaoEngine/,"const Engine=arguments[0]").replace(/\/\/ Render[\s\S]*$/,"")+"\nreturn results";const r=new Function(c)(E);const f=r.filter(x=>!x.pass);console.log((r.length-f.length)+"/"+r.length);f.forEach(x=>console.log("FAIL",x.name))'
  ```
- **Deploy:** `git push` na `main` (GitHub Pages, `andre-jnr/fechamento-fiscal`).

## Arquitetura de `conciliacao.html`

Os scripts carregam **nesta ordem** e cada um pendura um global em `window`; o último é
o orquestrador:

| arquivo | global | papel |
|---|---|---|
| `js/conciliacao-engine.js` | `ConciliacaoEngine` | **lógica pura, sem DOM.** Normalização, `buildIndices`, `conciliarNota`, filtros, stats, `noteKey`/`overrideId`. Também `module.exports` p/ testes em Node. |
| `js/conciliacao-parsers.js` | `ConciliacaoParsers` | Lê e valida o CSV da SEFAZ e o XLSX do sistema. `parse*` (a partir de `File`) e `*RowsFromMatrix` (a partir da matriz bruta — usado na importação de `.json`). |
| `js/conciliacao-storage.js` | `ConciliacaoStorage` | IndexedDB (`conciliacao-fiscal`): store `noteOverrides` (o que o usuário alimenta, chave = `Engine.overrideId`) e `importHistory`. |
| `js/conciliacao-relatorio.js` | `ConciliacaoRelatorio` | Gera o "Relatório Formatado" editando `relatorio-fiscal.xlsx` cirurgicamente como ZIP (ver abaixo). |
| `js/conciliacao-app.js` | — (IIFE) | Upload, execução da conciliação, dashboard, filtros, tabela, exportações, modal de novidades. Mantém o objeto `state`. |

**Fluxo:** upload SEFAZ (CSV `windows-1252`, separador `;`, lido pelo SheetJS) + sistema
(XLSX) → `parsers` → `state.sefaz` / `state.sistema` → `Engine.buildIndices` +
`Engine.conciliarNota` por nota → `state.reconciled` → render. Edições inline de
Justificativa/Observação persistem no IndexedDB por `overrideId`.

**Exportar/Importar Conciliação:** um único `.json` com `sefaz.rawMatrix` +
`sistema.rawMatrix` + `notas[]` (id/justificativa/observação). Importar reconstrói as
linhas via `*RowsFromMatrix`, grava os overrides e re-concilia — reproduz o relatório de
quem enviou sem os arquivos originais.

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

- Aba SEFAZ com layout de colunas posicional: `A`=UF, `C`=NF, `D`=SÉRIE, `E`=EMISSÃO,
  `F`=CNPJ EMISSOR, `H`=FORNECEDOR, `L`=CFOP, `N`=SITUAÇÃO, `O`=TIPO, `P`=VALOR,
  `V`=REJEITADA (as fórmulas da aba RELATÓRIO referenciam essas posições).
- Tabela `RELATORIO` = `B18:O1105`; cabeçalho na linha 18; dados 19–1105
  (`RELATORIO_LIMITE_LINHAS = 1087`); `M`=Justificativa, `N`=Observação, `O`=CHAVE
  (coluna adicionada por `patchRelatorioTable`).
- `forceFullCalcOnLoad` marca o workbook para recalcular ao abrir (os valores em cache
  das fórmulas continuam os do modelo até o Excel abrir).

## Identidade da nota

- `Engine.noteKey(row)` — chave composta `cnpjEmissor|NF|série|valorKey|emissão`, usada
  para deduplicar/casar dentro de uma execução.
- `Engine.overrideId(row)` — **chave de acesso da NF-e (44 dígitos)** quando existe, com
  fallback para `noteKey`. É o ID de persistência: estável entre exportações e entre
  importações de dias diferentes.
