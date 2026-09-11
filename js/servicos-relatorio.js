/**
 * Geração do "Relatório Formatado" das notas de serviço: edita
 * cirurgicamente o assets/Fechamento_NFSe_Mensal.xlsx como um ZIP (igual ao
 * js/conciliacao-relatorio.js faz com o relatorio-fiscal.xlsx), preenchendo
 * a aba "Fechamento NFS-e" com os dados de state.reconciled.
 *
 * Esse modelo não tem Tabela/gráfico do Excel — é uma aba única com um
 * cabeçalho fixo (linhas 1-9), a tabela de notas (a partir da linha 10) e
 * uma linha de total logo depois. Como o nº de NFS-e varia mês a mês (o
 * modelo nasce com 40 linhas de exemplo, mas um mês real facilmente passa
 * disso), a aba inteira é reconstruída a cada geração — nº de linhas de
 * dados = nº de notas, sem truncar — e todas as referências de intervalo
 * que depend em do tamanho da tabela (fórmulas dos cartões, autoFiltro,
 * validação de lista, formatação condicional, linha de total) são
 * recalculadas para o novo tamanho.
 */
;(function (global) {
  'use strict'

  const Base = global.ConciliacaoEngine
  const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

  class ServicosRelatorioError extends Error {}

  const SHEET_NAME = 'Fechamento NFS-e'
  const FIRST_DATA_ROW = 10 // linha 9 = cabeçalho da tabela; dados a partir da 10
  const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M']
  const DATA_STYLES = [19, 19, 20, 19, 19, 19, 19, 21, 21, 22, 19, 22, 19]

  // Coluna L (Justificativa) do modelo tem a mesma lista da plataforma web
  // (Engine.JUSTIFICATIVA_OPCOES) — só muda a capitalização.
  const JUSTIFICATIVA_XLSX_MAP = {
    'NÃO PRECISA': 'Não precisa',
    'JÁ LANÇADA': 'Já lançada',
    'A LANÇAR': 'A lançar',
    'PARA REJEITAR': 'Para rejeitar',
    CANCELADA: 'Cancelada',
  }

  // Coluna J (Status) usa os mesmos status do fechamento de NFS-e na página
  // (Lançada/Não Lançada/Cancelada/Para Rejeitar) — 'A LANÇAR' cai em "Não
  // Lançada" (ainda não foi lançada no sistema).
  function statusDocumento(note) {
    if (note.cancelada || note.status === 'CANCELADA') return 'Cancelada'
    if (note.status === 'LANÇADA') return 'Lançada'
    if (note.status === 'PARA REJEITAR') return 'Para Rejeitar'
    return 'Não Lançada'
  }

  // Linhas geradas como "Não Lançada" ou "Para Rejeitar" ganham uma FÓRMULA
  // em vez de um valor fixo: se depois, já na planilha, o usuário mudar a
  // Justificativa (coluna L) daquela linha, o Status acompanha sozinho, sem
  // precisar gerar o relatório de novo. Linhas que já nasceram
  // Lançada/Cancelada ficam com valor fixo — são fatos já resolvidos
  // (casaram no sistema ou vieram canceladas do lote de XML).
  function statusJFormula(rowNum) {
    return (
      `IF($L${rowNum}="Cancelada","Cancelada",` +
      `IF($L${rowNum}="Já lançada","Lançada",` +
      `IF($L${rowNum}="Para rejeitar","Para Rejeitar","Não Lançada")))`
    )
  }

  function buildStatusCell(note, rowNum) {
    const base = statusDocumento(note)
    if (base === 'Lançada' || base === 'Cancelada') {
      return { ref: 'J' + rowNum, s: 22, t: 'str', v: base }
    }
    return { ref: 'J' + rowNum, s: 22, f: statusJFormula(rowNum), v: base }
  }

  const TXT = {
    titulo: '🧾  RELATÓRIO DE FECHAMENTO — NOTAS FISCAIS DE SERVIÇO (NFS-e)',
    subtitulo:
      'Conferência, lançamento contábil e status mensal das notas de serviço tomadas/prestadas',
    empresaLabel: '🏢 EMPRESA:',
    placeholder: '[ preencher ]',
    competenciaLabel: '📆 COMPETÊNCIA:',
    mmaaaa: 'MM/AAAA',
    responsavelLabel: '👤 RESPONSÁVEL:',
    geradoEmLabel: '🗓️ GERADO EM:',
    totalNotas: '🧾 TOTAL DE NOTAS',
    valorTotal: '💰 VALOR TOTAL',
    issTotal: '📊 ISS TOTAL',
    naoLancadas: '❌ NÃO LANÇADAS',
    canceladas: '🚫 CANCELADAS',
    totalDoMes: 'TOTAL DO MÊS',
    colunas: [
      '🧾 Nº Nota',
      '🔢 Série',
      '📅 Emissão',
      '🏢 CNPJ Prestador',
      '👤 Prestador',
      '📍 Município',
      '🏷️ Cód. Serviço',
      '💰 Valor',
      '📊 ISS',
      '🚦 Status',
      '📝 Descrição do Serviço',
      '❓ Justificativa (Não Lançamento)',
      '💬 Observações',
    ],
  }

  // -----------------------------------------------------------------------
  // Helpers (mesma receita de conciliacao-relatorio.js)
  // -----------------------------------------------------------------------

  function serializeXml(doc) {
    const serializer = new XMLSerializer()
    const body = serializer.serializeToString(doc).replace(/^\s*<\?xml[^?]*\?>\s*/, '')
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + body
  }

  function excelSerialDate(date) {
    const epoch = Date.UTC(1899, 11, 30)
    const utc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
    return Math.round((utc - epoch) / 86400000)
  }

  async function findSheetPath(zip, sheetName) {
    const workbookXml = await zip.file('xl/workbook.xml').async('string')
    const relsFile = zip.file('xl/_rels/workbook.xml.rels')
    if (!relsFile) throw new ServicosRelatorioError('Modelo sem xl/_rels/workbook.xml.rels')
    const relsXml = await relsFile.async('string')

    const parser = new DOMParser()
    const wbDoc = parser.parseFromString(workbookXml, 'application/xml')
    const relsDoc = parser.parseFromString(relsXml, 'application/xml')

    const sheets = Array.from(wbDoc.getElementsByTagName('sheet'))
    const target = sheets.find((s) => s.getAttribute('name') === sheetName)
    if (!target) throw new ServicosRelatorioError(`Aba "${sheetName}" não encontrada no modelo`)

    const rId = target.getAttribute('r:id') || target.getAttributeNS(NS_REL, 'id')
    const rels = Array.from(relsDoc.getElementsByTagName('Relationship'))
    const rel = rels.find((r) => r.getAttribute('Id') === rId)
    if (!rel) throw new ServicosRelatorioError(`Relação da aba "${sheetName}" não encontrada`)

    return 'xl/' + rel.getAttribute('Target').replace(/^\/?/, '')
  }

  async function forceFullCalcOnLoad(zip) {
    const path = 'xl/workbook.xml'
    const xml = await zip.file(path).async('string')
    const parser = new DOMParser()
    const doc = parser.parseFromString(xml, 'application/xml')

    let calcPr = doc.getElementsByTagNameNS(NS_MAIN, 'calcPr')[0]
    if (!calcPr) {
      calcPr = doc.createElementNS(NS_MAIN, 'calcPr')
      doc.documentElement.appendChild(calcPr)
    }
    calcPr.setAttribute('fullCalcOnLoad', '1')

    zip.file(path, serializeXml(doc))
  }

  // -----------------------------------------------------------------------
  // Construção de células/linhas
  // -----------------------------------------------------------------------

  function makeCell(doc, ref, opts) {
    const c = doc.createElementNS(NS_MAIN, 'c')
    c.setAttribute('r', ref)
    if (opts.s != null) c.setAttribute('s', String(opts.s))

    if (opts.f) {
      const fEl = doc.createElementNS(NS_MAIN, 'f')
      fEl.textContent = opts.f
      c.appendChild(fEl)
      if (opts.v != null) {
        const vEl = doc.createElementNS(NS_MAIN, 'v')
        vEl.textContent = String(opts.v)
        c.appendChild(vEl)
      }
      return c
    }

    if (opts.v == null || opts.v === '') return c

    if (opts.t === 'str') {
      c.setAttribute('t', 'inlineStr')
      const isEl = doc.createElementNS(NS_MAIN, 'is')
      const tEl = doc.createElementNS(NS_MAIN, 't')
      tEl.setAttribute('xml:space', 'preserve')
      tEl.textContent = String(opts.v)
      isEl.appendChild(tEl)
      c.appendChild(isEl)
    } else {
      const n = Number(opts.v)
      if (!isFinite(n)) return c
      const vEl = doc.createElementNS(NS_MAIN, 'v')
      vEl.textContent = String(n)
      c.appendChild(vEl)
    }
    return c
  }

  function makeRow(doc, rowNum, ht, cellSpecs) {
    const rowEl = doc.createElementNS(NS_MAIN, 'row')
    rowEl.setAttribute('r', String(rowNum))
    rowEl.setAttribute('spans', '1:13')
    if (ht != null) {
      rowEl.setAttribute('ht', String(ht))
      rowEl.setAttribute('customHeight', '1')
    }
    for (const spec of cellSpecs) rowEl.appendChild(makeCell(doc, spec.ref, spec))
    return rowEl
  }

  // Uma linha de dados (nota) ou, se `note` for null, uma linha em branco
  // (só com o estilo de cada coluna) — usada quando não há nenhuma nota.
  function buildDataRowCells(note, rowNum) {
    if (!note) return COLS.map((c, i) => ({ ref: c + rowNum, s: DATA_STYLES[i] }))

    const numParsed = parseInt(Base.normalizeNF(note.numero), 10)
    const cells = [
      {
        ref: 'A' + rowNum,
        s: 19,
        t: isNaN(numParsed) ? 'str' : 'num',
        v: isNaN(numParsed) ? note.numero || '' : numParsed,
      },
      { ref: 'B' + rowNum, s: 19, t: 'str', v: note.serie || '' },
    ]
    cells.push(
      note.emissao
        ? { ref: 'C' + rowNum, s: 20, t: 'num', v: excelSerialDate(note.emissao) }
        : { ref: 'C' + rowNum, s: 20, t: 'str', v: note.emissaoRaw || '' }
    )
    cells.push(
      { ref: 'D' + rowNum, s: 19, t: 'str', v: note.prestadorCnpjFormatado || '' },
      { ref: 'E' + rowNum, s: 19, t: 'str', v: note.prestador || '' },
      { ref: 'F' + rowNum, s: 19, t: 'str', v: note.municipio || '' },
      { ref: 'G' + rowNum, s: 19, t: 'str', v: note.codServico || '' },
      { ref: 'H' + rowNum, s: 21, t: 'num', v: Base.round2(note.valorServico || 0) },
      { ref: 'I' + rowNum, s: 21, t: 'num', v: Base.round2(note.iss || 0) },
      buildStatusCell(note, rowNum),
      { ref: 'K' + rowNum, s: 19, t: 'str', v: note.descricao || '' },
      {
        ref: 'L' + rowNum,
        s: 22,
        t: 'str',
        v: JUSTIFICATIVA_XLSX_MAP[note.justificativa] || 'Não precisa',
      },
      { ref: 'M' + rowNum, s: 19, t: 'str', v: note.observacao || '' }
    )
    return cells
  }

  // -----------------------------------------------------------------------
  // Empresa / competência — detectados a partir dos próprios dados
  // -----------------------------------------------------------------------

  function detectEmpresa(rows) {
    const counts = new Map()
    for (const r of rows) {
      const nome = (r.tomadorNome || '').trim()
      if (!nome) continue
      counts.set(nome, (counts.get(nome) || 0) + 1)
    }
    let best = ''
    let bestCount = 0
    for (const [nome, count] of counts) {
      if (count > bestCount) {
        best = nome
        bestCount = count
      }
    }
    return best
  }

  function detectCompetencia(rows) {
    const counts = new Map()
    for (const r of rows) {
      if (!r.emissao) continue
      const key = r.emissao.getFullYear() + '-' + r.emissao.getMonth()
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    if (!counts.size) return ''
    let bestKey = null
    let bestCount = -1
    for (const [k, c] of counts) {
      if (c > bestCount) {
        bestKey = k
        bestCount = c
      }
    }
    const [ano, mesIdx] = bestKey.split('-').map(Number)
    return String(mesIdx + 1).padStart(2, '0') + '/' + ano
  }

  // -----------------------------------------------------------------------
  // Ajusta autoFiltro / mesclagens / validação / formatação condicional
  // para o novo tamanho da tabela
  // -----------------------------------------------------------------------

  function updateRanges(doc, lastDataRow, totalRow) {
    const autoFilter = doc.getElementsByTagNameNS(NS_MAIN, 'autoFilter')[0]
    if (autoFilter) autoFilter.setAttribute('ref', `A9:M${lastDataRow}`)

    const totalMerge = Array.from(doc.getElementsByTagNameNS(NS_MAIN, 'mergeCell')).find(
      (m) => m.getAttribute('ref') === 'A50:G50'
    )
    if (totalMerge) totalMerge.setAttribute('ref', `A${totalRow}:G${totalRow}`)

    const rangeMap = {
      'A10:M49': `A10:M${lastDataRow}`,
      'H10:H49': `H10:H${lastDataRow}`,
      'J10:J49': `J10:J${lastDataRow}`,
      'L10:L49': `L10:L${lastDataRow}`,
    }
    for (const cf of Array.from(doc.getElementsByTagNameNS(NS_MAIN, 'conditionalFormatting'))) {
      const novo = rangeMap[cf.getAttribute('sqref')]
      if (novo) cf.setAttribute('sqref', novo)
    }
    for (const dv of Array.from(doc.getElementsByTagNameNS(NS_MAIN, 'dataValidation'))) {
      const novo = rangeMap[dv.getAttribute('sqref')]
      if (novo) dv.setAttribute('sqref', novo)
    }

    // duplicata do intervalo da barra de dados (extensão x14, formato mais novo)
    const xmSqref = doc.getElementsByTagName('xm:sqref')[0]
    if (xmSqref && xmSqref.textContent.trim() === 'H10:H49') {
      xmSqref.textContent = `H10:H${lastDataRow}`
    }

    const dimEl = doc.getElementsByTagNameNS(NS_MAIN, 'dimension')[0]
    if (dimEl) dimEl.setAttribute('ref', `A1:M${totalRow}`)
  }

  // -----------------------------------------------------------------------
  // Reconstrói a aba "Fechamento NFS-e" inteira
  // -----------------------------------------------------------------------

  async function writeFechamentoSheet(zip, sheetPath, rows, meta) {
    const file = zip.file(sheetPath)
    if (!file) throw new ServicosRelatorioError(`Parte "${sheetPath}" não encontrada no modelo`)
    const xmlText = await file.async('string')

    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlText, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) {
      throw new ServicosRelatorioError(`Não foi possível interpretar o XML de "${sheetPath}"`)
    }

    const sheetData = doc.getElementsByTagNameNS(NS_MAIN, 'sheetData')[0]
    if (!sheetData) throw new ServicosRelatorioError(`"${sheetPath}" não possui <sheetData>`)

    const n = rows.length
    const lastDataRow = FIRST_DATA_ROW + Math.max(n, 1) - 1
    const totalRow = lastDataRow + 1

    const empresa = detectEmpresa(rows)
    const competencia = detectCompetencia(rows)
    const responsavel = (meta && meta.responsavel) || ''

    const totalValor = rows.reduce((s, r) => s + (r.valorServico || 0), 0)
    const totalIss = rows.reduce((s, r) => s + (r.iss || 0), 0)
    const countNaoLancadas = rows.filter((r) => statusDocumento(r) === 'Não Lançada').length
    const countCancelada =
      rows.filter((r) => r.cancelada).length +
      rows.filter((r) => JUSTIFICATIVA_XLSX_MAP[r.justificativa] === 'Cancelada').length

    while (sheetData.firstChild) sheetData.removeChild(sheetData.firstChild)

    sheetData.appendChild(
      makeRow(doc, 1, 33.75, [
        { ref: 'A1', s: 14, t: 'str', v: TXT.titulo },
        ...COLS.slice(1).map((c) => ({ ref: c + '1', s: 14 })),
      ])
    )
    sheetData.appendChild(
      makeRow(doc, 2, 19.5, [
        { ref: 'A2', s: 13, t: 'str', v: TXT.subtitulo },
        ...COLS.slice(1).map((c) => ({ ref: c + '2', s: 13 })),
      ])
    )
    sheetData.appendChild(makeRow(doc, 3, 4.5, COLS.map((c) => ({ ref: c + '3', s: 12 }))))
    sheetData.appendChild(makeRow(doc, 4, 3.75, []))
    sheetData.appendChild(
      makeRow(doc, 5, 19.5, [
        { ref: 'A5', s: 11, t: 'str', v: TXT.empresaLabel },
        { ref: 'B5', s: 11 },
        { ref: 'C5', s: 11 },
        { ref: 'D5', s: 10, t: 'str', v: empresa || TXT.placeholder },
        { ref: 'E5', s: 10 },
        { ref: 'F5', s: 15, t: 'str', v: TXT.competenciaLabel },
        { ref: 'G5', s: 16, t: 'str', v: competencia || TXT.mmaaaa },
        { ref: 'H5', s: 11, t: 'str', v: TXT.responsavelLabel },
        { ref: 'I5', s: 11 },
        { ref: 'J5', s: 10, t: 'str', v: responsavel || TXT.placeholder },
        { ref: 'K5', s: 10 },
        { ref: 'L5', s: 15, t: 'str', v: TXT.geradoEmLabel },
        { ref: 'M5', s: 17, f: 'TODAY()', v: excelSerialDate(new Date()) },
      ])
    )
    sheetData.appendChild(makeRow(doc, 6, 6, []))
    sheetData.appendChild(
      makeRow(doc, 7, 15.75, [
        { ref: 'A7', s: 9, t: 'str', v: TXT.totalNotas },
        { ref: 'B7', s: 9 },
        { ref: 'C7', s: 9 },
        { ref: 'D7', s: 8, t: 'str', v: TXT.valorTotal },
        { ref: 'E7', s: 8 },
        { ref: 'F7', s: 8 },
        { ref: 'G7', s: 7, t: 'str', v: TXT.issTotal },
        { ref: 'H7', s: 7 },
        { ref: 'I7', s: 7 },
        { ref: 'J7', s: 6, t: 'str', v: TXT.naoLancadas },
        { ref: 'K7', s: 6 },
        { ref: 'L7', s: 5, t: 'str', v: TXT.canceladas },
        { ref: 'M7', s: 5 },
      ])
    )
    sheetData.appendChild(
      makeRow(doc, 8, 25.5, [
        { ref: 'A8', s: 4, f: `COUNTA(A${FIRST_DATA_ROW}:A${lastDataRow})`, v: n },
        { ref: 'B8', s: 4 },
        { ref: 'C8', s: 4 },
        {
          ref: 'D8',
          s: 3,
          f: `SUM(H${FIRST_DATA_ROW}:H${lastDataRow})`,
          v: Base.round2(totalValor),
        },
        { ref: 'E8', s: 3 },
        { ref: 'F8', s: 3 },
        {
          ref: 'G8',
          s: 2,
          f: `SUM(I${FIRST_DATA_ROW}:I${lastDataRow})`,
          v: Base.round2(totalIss),
        },
        { ref: 'H8', s: 2 },
        { ref: 'I8', s: 2 },
        {
          ref: 'J8',
          s: 1,
          f: `COUNTIF(J${FIRST_DATA_ROW}:J${lastDataRow},"Não Lançada")`,
          v: countNaoLancadas,
        },
        { ref: 'K8', s: 1 },
        {
          ref: 'L8',
          s: 34,
          f: `COUNTIF(J${FIRST_DATA_ROW}:J${lastDataRow},"Cancelada")+COUNTIF(L${FIRST_DATA_ROW}:L${lastDataRow},"Cancelada")`,
          v: countCancelada,
        },
        { ref: 'M8', s: 34 },
      ])
    )
    sheetData.appendChild(
      makeRow(doc, 9, 30, TXT.colunas.map((v, i) => ({ ref: COLS[i] + '9', s: 18, t: 'str', v })))
    )

    for (let i = 0; i < Math.max(n, 1); i++) {
      const rowNum = FIRST_DATA_ROW + i
      sheetData.appendChild(makeRow(doc, rowNum, 15.75, buildDataRowCells(i < n ? rows[i] : null, rowNum)))
    }

    sheetData.appendChild(
      makeRow(doc, totalRow, 21.75, [
        { ref: 'A' + totalRow, s: 35, t: 'str', v: TXT.totalDoMes },
        { ref: 'B' + totalRow, s: 35 },
        { ref: 'C' + totalRow, s: 35 },
        { ref: 'D' + totalRow, s: 35 },
        { ref: 'E' + totalRow, s: 35 },
        { ref: 'F' + totalRow, s: 35 },
        { ref: 'G' + totalRow, s: 35 },
        {
          ref: 'H' + totalRow,
          s: 23,
          f: `SUM(H${FIRST_DATA_ROW}:H${lastDataRow})`,
          v: Base.round2(totalValor),
        },
        {
          ref: 'I' + totalRow,
          s: 23,
          f: `SUM(I${FIRST_DATA_ROW}:I${lastDataRow})`,
          v: Base.round2(totalIss),
        },
        { ref: 'J' + totalRow, s: 24 },
        { ref: 'K' + totalRow, s: 24 },
        { ref: 'L' + totalRow, s: 24 },
        { ref: 'M' + totalRow, s: 24 },
      ])
    )

    updateRanges(doc, lastDataRow, totalRow)

    zip.file(sheetPath, serializeXml(doc))
  }

  // -----------------------------------------------------------------------
  // API pública
  // -----------------------------------------------------------------------

  async function gerar(templateUrl, reconciled, meta) {
    const resp = await fetch(templateUrl)
    if (!resp.ok) throw new ServicosRelatorioError('Falha ao buscar o modelo do relatório')
    const buffer = await resp.arrayBuffer()
    const zip = await global.JSZip.loadAsync(buffer)

    const sheetPath = await findSheetPath(zip, SHEET_NAME)
    await writeFechamentoSheet(zip, sheetPath, reconciled || [], meta || {})
    await forceFullCalcOnLoad(zip)

    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  }

  global.ServicosRelatorio = { gerar, ServicosRelatorioError }
})(typeof window !== 'undefined' ? window : globalThis)
