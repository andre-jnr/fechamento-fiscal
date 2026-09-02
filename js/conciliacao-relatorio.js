/**
 * Geração do "Relatório Formatado": em vez de reescrever o
 * relatorio-fiscal.xlsx inteiro via SheetJS (o que descarta Tabelas,
 * gráficos e slicers — SheetJS Community não preserva essas partes na
 * escrita, mesmo em um roundtrip sem nenhuma alteração), este módulo edita
 * cirurgicamente o .xlsx como um ZIP: troca apenas o XML das abas SEFAZ e
 * SISTEMA, mantendo todo o resto do arquivo (tabelas, fórmulas, dashboard,
 * gráficos) intocado byte a byte. Depende de JSZip e de ConciliacaoEngine.
 */
;(function (global) {
  'use strict'

  const Engine = global.ConciliacaoEngine
  const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

  class RelatorioFormatadoError extends Error {}

  // Estrutura fixa da aba RELATÓRIO no modelo: cabeçalho na linha 19, dados
  // a partir da 20 (RELATÓRIO!linha 20+i = SEFAZ!linha 2+i), colunas M/N =
  // Justificativa/Observação. A tabela RELATORIO vai até a linha 1106. A
  // coluna O (CHAVE) já faz parte do modelo, com fórmula própria puxando de
  // SEFAZ!B — não é escrita aqui.
  const RELATORIO_HEADER_ROW = 19
  const RELATORIO_COL_JUSTIFICATIVA = 'M'
  const RELATORIO_COL_OBSERVACAO = 'N'
  const RELATORIO_LIMITE_LINHAS = 1087 // tamanho da tabela RELATORIO no modelo (linhas 20-1106)

  // XMLSerializer às vezes já emite a própria declaração <?xml ...?> (a
  // depender do navegador); remove antes de prependar a nossa para não
  // duplicar (o que o Excel/lxml rejeita como XML inválido).
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

  function colLetter(idx0) {
    let n = idx0 + 1
    let s = ''
    while (n > 0) {
      const rem = (n - 1) % 26
      s = String.fromCharCode(65 + rem) + s
      n = Math.floor((n - 1) / 26)
    }
    return s
  }

  // -----------------------------------------------------------------------
  // Monta as linhas (header + dados) já tipadas (número/texto) para cada aba
  // -----------------------------------------------------------------------

  function buildSefazRows(sefaz) {
    const { rawMatrix, rows, colIndex } = sefaz
    const header = rawMatrix[0].map((h) => ({ t: 'str', v: h }))
    const out = [header]

    for (let i = 0; i < rows.length; i++) {
      const rawRow = rawMatrix[i + 1] || []
      const norm = rows[i]
      const line = rawRow.map((cellText, j) => {
        if (j === colIndex.emissao) {
          return norm.emissao
            ? { t: 'num', v: excelSerialDate(norm.emissao) }
            : { t: 'str', v: String(cellText == null ? '' : cellText) }
        }
        if (j === colIndex.valor) return { t: 'num', v: norm.valor }
        if (j === colIndex.cfop) return { t: 'num', v: norm.cfop }
        if (j === colIndex.nf) {
          const n = parseInt(Engine.normalizeNF(cellText), 10)
          return isNaN(n) ? { t: 'str', v: String(cellText == null ? '' : cellText) } : { t: 'num', v: n }
        }
        return { t: 'str', v: String(cellText == null ? '' : cellText) }
      })
      out.push(line)
    }
    return out
  }

  function buildSistemaRows(sistema) {
    return sistema.rawMatrix.map((row) =>
      row.map((cell) => {
        if (typeof cell === 'number') return { t: 'num', v: cell }
        return { t: 'str', v: String(cell == null ? '' : cell) }
      })
    )
  }

  // -----------------------------------------------------------------------
  // Localiza o arquivo XML de uma aba pelo nome, via workbook.xml + rels
  // -----------------------------------------------------------------------

  async function findSheetPath(zip, sheetName) {
    const workbookXml = await zip.file('xl/workbook.xml').async('string')
    const relsFile = zip.file('xl/_rels/workbook.xml.rels')
    if (!relsFile) throw new RelatorioFormatadoError('Modelo sem xl/_rels/workbook.xml.rels')
    const relsXml = await relsFile.async('string')

    const parser = new DOMParser()
    const wbDoc = parser.parseFromString(workbookXml, 'application/xml')
    const relsDoc = parser.parseFromString(relsXml, 'application/xml')

    const sheets = Array.from(wbDoc.getElementsByTagName('sheet'))
    const target = sheets.find((s) => s.getAttribute('name') === sheetName)
    if (!target) throw new RelatorioFormatadoError(`Aba "${sheetName}" não encontrada no modelo`)

    const rId = target.getAttribute('r:id') || target.getAttributeNS(NS_REL, 'id')
    const rels = Array.from(relsDoc.getElementsByTagName('Relationship'))
    const rel = rels.find((r) => r.getAttribute('Id') === rId)
    if (!rel) throw new RelatorioFormatadoError(`Relação da aba "${sheetName}" não encontrada`)

    return 'xl/' + rel.getAttribute('Target').replace(/^\/?/, '')
  }

  // -----------------------------------------------------------------------
  // Substitui o <sheetData> de uma planilha pelo conteúdo informado,
  // preservando todo o resto do XML (estilos de coluna, sheetViews etc.)
  // -----------------------------------------------------------------------

  async function writeSheetData(zip, sheetPath, rowsData) {
    const file = zip.file(sheetPath)
    if (!file) throw new RelatorioFormatadoError(`Parte "${sheetPath}" não encontrada no modelo`)
    const xmlText = await file.async('string')

    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlText, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) {
      throw new RelatorioFormatadoError(`Não foi possível interpretar o XML de "${sheetPath}"`)
    }

    const sheetData = doc.getElementsByTagNameNS(NS_MAIN, 'sheetData')[0]
    if (!sheetData) throw new RelatorioFormatadoError(`"${sheetPath}" não possui <sheetData>`)
    while (sheetData.firstChild) sheetData.removeChild(sheetData.firstChild)

    let maxCol = 0
    rowsData.forEach((cells, rIdx) => {
      const rowEl = doc.createElementNS(NS_MAIN, 'row')
      rowEl.setAttribute('r', String(rIdx + 1))
      cells.forEach((cell, cIdx) => {
        if (cell == null || cell.v === '' || cell.v == null) return
        const cEl = doc.createElementNS(NS_MAIN, 'c')
        cEl.setAttribute('r', colLetter(cIdx) + (rIdx + 1))
        if (cell.t === 'num') {
          const n = Number(cell.v)
          if (!isFinite(n)) return
          const vEl = doc.createElementNS(NS_MAIN, 'v')
          vEl.textContent = String(n)
          cEl.appendChild(vEl)
        } else {
          cEl.setAttribute('t', 'inlineStr')
          const isEl = doc.createElementNS(NS_MAIN, 'is')
          const tEl = doc.createElementNS(NS_MAIN, 't')
          tEl.setAttribute('xml:space', 'preserve')
          tEl.textContent = String(cell.v)
          isEl.appendChild(tEl)
          cEl.appendChild(isEl)
        }
        rowEl.appendChild(cEl)
        if (cIdx + 1 > maxCol) maxCol = cIdx + 1
      })
      sheetData.appendChild(rowEl)
    })

    const dimEl = doc.getElementsByTagNameNS(NS_MAIN, 'dimension')[0]
    if (dimEl) {
      const lastCol = colLetter(Math.max(maxCol - 1, 0))
      dimEl.setAttribute('ref', `A1:${lastCol}${Math.max(rowsData.length, 1)}`)
    }

    zip.file(sheetPath, serializeXml(doc))
  }

  // -----------------------------------------------------------------------
  // Edição pontual de células (usada na aba RELATÓRIO, que é cheia de
  // fórmulas — só as colunas Justificativa/Observação são alteradas, célula
  // a célula, sem tocar em mais nada da linha)
  // -----------------------------------------------------------------------

  function colToIndex(letters) {
    let n = 0
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
    return n - 1
  }

  function parseCellRef(ref) {
    const m = ref.match(/^([A-Z]+)(\d+)$/)
    if (!m) throw new RelatorioFormatadoError(`Referência de célula inválida: ${ref}`)
    return { col: m[1], colIdx: colToIndex(m[1]), row: parseInt(m[2], 10) }
  }

  function getOrCreateRow(doc, sheetData, rowNum) {
    const rows = Array.from(sheetData.children).filter((el) => el.tagName === 'row')
    let before = null
    for (const rowEl of rows) {
      const r = parseInt(rowEl.getAttribute('r'), 10)
      if (r === rowNum) return rowEl
      if (r > rowNum) {
        before = rowEl
        break
      }
    }
    const newRow = doc.createElementNS(NS_MAIN, 'row')
    newRow.setAttribute('r', String(rowNum))
    if (before) sheetData.insertBefore(newRow, before)
    else sheetData.appendChild(newRow)
    return newRow
  }

  function setCellInlineText(doc, rowEl, cellRef, text) {
    const { colIdx } = parseCellRef(cellRef)
    const cells = Array.from(rowEl.children).filter((el) => el.tagName === 'c')
    let cEl = null
    let before = null
    for (const c of cells) {
      const ref = c.getAttribute('r')
      if (ref === cellRef) {
        cEl = c
        break
      }
      if (colToIndex(ref.match(/^[A-Z]+/)[0]) > colIdx) {
        before = c
        break
      }
    }
    if (!cEl) {
      cEl = doc.createElementNS(NS_MAIN, 'c')
      cEl.setAttribute('r', cellRef)
      if (before) rowEl.insertBefore(cEl, before)
      else rowEl.appendChild(cEl)
    }
    // preserva o atributo de estilo (s) — só troca o tipo/conteúdo
    while (cEl.firstChild) cEl.removeChild(cEl.firstChild)
    cEl.removeAttribute('t')
    if (text === '' || text == null) return
    cEl.setAttribute('t', 'inlineStr')
    const isEl = doc.createElementNS(NS_MAIN, 'is')
    const tEl = doc.createElementNS(NS_MAIN, 't')
    tEl.setAttribute('xml:space', 'preserve')
    tEl.textContent = String(text)
    isEl.appendChild(tEl)
    cEl.appendChild(isEl)
  }

  async function writeJustificativasObservacoes(zip, relatorioPath, reconciled) {
    const file = zip.file(relatorioPath)
    if (!file) throw new RelatorioFormatadoError(`Parte "${relatorioPath}" não encontrada no modelo`)
    const xmlText = await file.async('string')

    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlText, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) {
      throw new RelatorioFormatadoError(`Não foi possível interpretar o XML de "${relatorioPath}"`)
    }

    const sheetData = doc.getElementsByTagNameNS(NS_MAIN, 'sheetData')[0]
    if (!sheetData) throw new RelatorioFormatadoError(`"${relatorioPath}" não possui <sheetData>`)

    const linhas = reconciled.slice(0, RELATORIO_LIMITE_LINHAS)
    linhas.forEach((row, i) => {
      const rowNum = RELATORIO_HEADER_ROW + 1 + i
      const rowEl = getOrCreateRow(doc, sheetData, rowNum)
      setCellInlineText(doc, rowEl, `${RELATORIO_COL_JUSTIFICATIVA}${rowNum}`, row.justificativa || 'NÃO PRECISA')
      setCellInlineText(doc, rowEl, `${RELATORIO_COL_OBSERVACAO}${rowNum}`, row.observacao || '')
    })

    zip.file(relatorioPath, serializeXml(doc))
  }

  // -----------------------------------------------------------------------
  // Marca o workbook para recalcular tudo ao abrir no Excel (os valores em
  // cache das fórmulas continuam sendo os do modelo até isso acontecer,
  // já que nada aqui avalia fórmulas)
  // -----------------------------------------------------------------------

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
  // API pública
  // -----------------------------------------------------------------------

  async function gerar(templateUrl, sefaz, sistema, reconciled) {
    const resp = await fetch(templateUrl)
    if (!resp.ok) throw new RelatorioFormatadoError('Falha ao buscar o modelo do relatório')
    const buffer = await resp.arrayBuffer()
    const zip = await global.JSZip.loadAsync(buffer)

    const sefazPath = await findSheetPath(zip, 'SEFAZ')
    const sistemaPath = await findSheetPath(zip, 'SISTEMA')
    const relatorioPath = await findSheetPath(zip, 'RELATÓRIO')

    await writeSheetData(zip, sefazPath, buildSefazRows(sefaz))
    await writeSheetData(zip, sistemaPath, buildSistemaRows(sistema))
    if (reconciled && reconciled.length) {
      await writeJustificativasObservacoes(zip, relatorioPath, reconciled)
    }
    await forceFullCalcOnLoad(zip)

    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  }

  global.ConciliacaoRelatorio = { gerar, RelatorioFormatadoError, RELATORIO_LIMITE_LINHAS }
})(typeof window !== 'undefined' ? window : globalThis)
