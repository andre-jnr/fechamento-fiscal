/**
 * Leitura e validação dos arquivos importados (CSV da SEFAZ e XLSX/XLS do
 * sistema interno). Usa SheetJS (window.XLSX) para os dois formatos.
 */
;(function (global) {
  'use strict'

  const Engine = global.ConciliacaoEngine

  class ConciliacaoImportError extends Error {}

  const MSG_ARQUIVO_INVALIDO =
    'Arquivo inválido. Verifique se o arquivo corresponde ao layout esperado.'
  const MSG_ARQUIVO_VAZIO = 'O arquivo não possui registros para conciliação.'
  const MSG_FORMATO_INVALIDO = 'Não foi possível interpretar os dados deste arquivo.'
  const msgColunaAusente = (nome) =>
    `Não foi possível importar o arquivo porque a coluna "${nome}" não foi encontrada.`

  function normalizeHeader(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim()
  }

  function findColumnIndex(headerRow, candidates, fromIndex) {
    const normalized = headerRow.map(normalizeHeader)
    const wanted = candidates.map(normalizeHeader)
    for (let i = fromIndex || 0; i < normalized.length; i++) {
      if (wanted.includes(normalized[i])) return i
    }
    return -1
  }

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(file)
    })
  }

  function bytesStartWith(bytes, signature) {
    if (bytes.length < signature.length) return false
    for (let i = 0; i < signature.length; i++) {
      if (bytes[i] !== signature[i]) return false
    }
    return true
  }

  function isZipSignature(bytes) {
    return bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04])
  }

  function isOleSignature(bytes) {
    return bytesStartWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  }

  // Algumas exportações de Excel gravam um "!ref" (dimensão) desatualizado,
  // menor do que os dados reais da planilha — recalcula a partir das
  // células realmente presentes para não truncar linhas/colunas.
  function fixSheetRange(sheet) {
    let minR = Infinity
    let minC = Infinity
    let maxR = -Infinity
    let maxC = -Infinity
    for (const key of Object.keys(sheet)) {
      if (key[0] === '!') continue
      const addr = global.XLSX.utils.decode_cell(key)
      if (addr.r < minR) minR = addr.r
      if (addr.c < minC) minC = addr.c
      if (addr.r > maxR) maxR = addr.r
      if (addr.c > maxC) maxC = addr.c
    }
    if (maxR === -Infinity) return
    sheet['!ref'] = global.XLSX.utils.encode_range({
      s: { r: minR, c: minC },
      e: { r: maxR, c: maxC },
    })
  }

  // -----------------------------------------------------------------------
  // SEFAZ (CSV)
  // -----------------------------------------------------------------------

  const SEFAZ_REQUIRED_FIELDS = [
    { key: 'uf', names: ['UF'], label: 'UF' },
    { key: 'nf', names: ['NUMERO', 'NF', 'NUMERO NF'], label: 'NF (NUMERO)' },
    { key: 'serie', names: ['SERIE'], label: 'Série' },
    { key: 'emissao', names: ['EMISSAO', 'DATA EMISSAO'], label: 'Emissão' },
    { key: 'cnpjEmissor', names: ['CNPJ EMISSOR'], label: 'CNPJ Emissor' },
    {
      key: 'cnpjDestinatario',
      names: ['CNPJ-CPF DESTINATARIO', 'CNPJ DESTINATARIO', 'CPF-CNPJ DESTINATARIO'],
      label: 'CNPJ/CPF Destinatário',
    },
    { key: 'cfop', names: ['CFOP'], label: 'CFOP' },
    { key: 'situacao', names: ['SITUACAO'], label: 'Situação' },
    { key: 'tipo', names: ['TIPO'], label: 'Tipo' },
    { key: 'valor', names: ['VALOR'], label: 'Valor' },
    { key: 'rejeitada', names: ['REJEITADA'], label: 'Rejeitada' },
  ]

  async function parseSefazCsv(file) {
    let buffer
    try {
      buffer = await readFileAsArrayBuffer(file)
    } catch (e) {
      throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    }

    const bytes = new Uint8Array(buffer.slice(0, 8))
    if (isZipSignature(bytes) || isOleSignature(bytes)) {
      // Excel disfarçado de CSV
      throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    }

    let text
    try {
      text = new TextDecoder('windows-1252').decode(buffer)
    } catch (e) {
      text = new TextDecoder('utf-8').decode(buffer)
    }

    // remove BOM e a linha de pragma "sep=;" usada por exportações do Excel
    text = text.replace(/^﻿/, '')
    text = text.replace(/^sep=.\r?\n/i, '')

    let workbook
    try {
      workbook = global.XLSX.read(text, { type: 'string', FS: ';', raw: true })
    } catch (e) {
      throw new ConciliacaoImportError(MSG_FORMATO_INVALIDO)
    }

    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new ConciliacaoImportError(MSG_FORMATO_INVALIDO)
    const sheet = workbook.Sheets[sheetName]
    fixSheetRange(sheet)

    let matrix
    try {
      matrix = global.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
    } catch (e) {
      throw new ConciliacaoImportError(MSG_FORMATO_INVALIDO)
    }

    matrix = matrix.filter((row) => row.some((cell) => String(cell).trim() !== ''))
    if (matrix.length === 0) throw new ConciliacaoImportError(MSG_ARQUIVO_VAZIO)

    const headerRow = matrix[0]
    const dataRows = matrix.slice(1)
    if (dataRows.length === 0) throw new ConciliacaoImportError(MSG_ARQUIVO_VAZIO)

    const colIndex = {}
    for (const field of SEFAZ_REQUIRED_FIELDS) {
      const idx = findColumnIndex(headerRow, field.names)
      if (idx === -1) throw new ConciliacaoImportError(msgColunaAusente(field.label))
      colIndex[field.key] = idx
    }

    // Fornecedor = 1ª "RAZAO SOCIAL", de preferência logo após "IE EMISSOR"
    const ieEmissorIdx = findColumnIndex(headerRow, ['IE EMISSOR'])
    let fornecedorIdx = -1
    if (ieEmissorIdx !== -1 && normalizeHeader(headerRow[ieEmissorIdx + 1]) === 'RAZAO SOCIAL') {
      fornecedorIdx = ieEmissorIdx + 1
    } else {
      fornecedorIdx = findColumnIndex(headerRow, ['RAZAO SOCIAL', 'FORNECEDOR', 'NOME EMISSOR'])
    }
    if (fornecedorIdx === -1) throw new ConciliacaoImportError(msgColunaAusente('Fornecedor'))

    const chaveIdx = findColumnIndex(headerRow, ['CHAVE', 'CHAVE DE ACESSO'])

    const rows = dataRows.map((cells) => {
      const get = (idx) => (idx == null || idx === -1 ? '' : cells[idx])
      const cnpjEmissorDigits = Engine.normalizeCNPJ(get(colIndex.cnpjEmissor))
      const cnpjDestinatarioDigits = Engine.normalizeCNPJ(get(colIndex.cnpjDestinatario))
      return {
        uf: Engine.stripQuotes(get(colIndex.uf)).toUpperCase(),
        chave: Engine.stripQuotes(get(chaveIdx)),
        nf: Engine.stripQuotes(get(colIndex.nf)),
        serie: Engine.stripQuotes(get(colIndex.serie)),
        emissaoRaw: Engine.stripQuotes(get(colIndex.emissao)),
        emissao: Engine.parseDateBR(get(colIndex.emissao)),
        cnpjEmissor: cnpjEmissorDigits,
        cnpjEmissorFormatado: Engine.formatCNPJ(cnpjEmissorDigits),
        fornecedor: Engine.stripQuotes(get(fornecedorIdx)),
        cnpjDestinatario: cnpjDestinatarioDigits,
        cfop: parseInt(Engine.stripQuotes(get(colIndex.cfop)), 10) || 0,
        situacao: Engine.stripQuotes(get(colIndex.situacao)).toUpperCase(),
        tipo: Engine.stripQuotes(get(colIndex.tipo)).toUpperCase(),
        valor: Engine.normalizeValor(get(colIndex.valor)),
        rejeitada: Engine.stripQuotes(get(colIndex.rejeitada)).toUpperCase(),
      }
    })

    return { rows, fileName: file.name, rawMatrix: matrix, colIndex }
  }

  // -----------------------------------------------------------------------
  // Sistema (XLSX/XLS)
  // -----------------------------------------------------------------------

  const SISTEMA_REQUIRED_FIELDS = [
    { key: 'nf', names: ['NF', 'NUMERO NF', 'NUMERO', 'Nº NF'], label: 'NF' },
    {
      key: 'valor',
      names: ['VLR. NOTA', 'VLR NOTA', 'VALOR DA NOTA', 'VALOR NOTA', 'VLR. DA NOTA', 'VALOR'],
      label: 'Vlr. Nota',
    },
  ]

  const SISTEMA_OPTIONAL_FIELDS = [
    { key: 'fornecedor', names: ['FORNECEDOR'] },
    { key: 'dataEmissao', names: ['DATA EMISSAO', 'DATA DE EMISSAO', 'EMISSAO'] },
  ]

  async function parseSistemaXlsx(file) {
    let buffer
    try {
      buffer = await readFileAsArrayBuffer(file)
    } catch (e) {
      throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    }

    const bytes = new Uint8Array(buffer.slice(0, 8))
    if (!isZipSignature(bytes) && !isOleSignature(bytes)) {
      throw new ConciliacaoImportError(MSG_ARQUIVO_INVALIDO)
    }

    let workbook
    try {
      workbook = global.XLSX.read(buffer, { type: 'array' })
    } catch (e) {
      throw new ConciliacaoImportError(MSG_FORMATO_INVALIDO)
    }

    // usa a primeira planilha com conteúdo
    let matrix = []
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      fixSheetRange(sheet)
      const candidate = global.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })
      const filtered = candidate.filter((row) => row.some((cell) => String(cell).trim() !== ''))
      if (filtered.length > 1) {
        matrix = filtered
        break
      }
    }

    if (matrix.length === 0) throw new ConciliacaoImportError(MSG_ARQUIVO_VAZIO)

    const headerRow = matrix[0]
    const dataRows = matrix.slice(1)
    if (dataRows.length === 0) throw new ConciliacaoImportError(MSG_ARQUIVO_VAZIO)

    const colIndex = {}
    for (const field of SISTEMA_REQUIRED_FIELDS) {
      const idx = findColumnIndex(headerRow, field.names)
      if (idx === -1) throw new ConciliacaoImportError(msgColunaAusente(field.label))
      colIndex[field.key] = idx
    }
    for (const field of SISTEMA_OPTIONAL_FIELDS) {
      colIndex[field.key] = findColumnIndex(headerRow, field.names)
    }

    const rows = dataRows.map((cells) => {
      const get = (idx) => (idx == null || idx === -1 ? '' : cells[idx])
      return {
        nf: Engine.stripQuotes(get(colIndex.nf)),
        valor: Engine.normalizeValor(get(colIndex.valor)),
        fornecedor: Engine.stripQuotes(get(colIndex.fornecedor)),
        dataEmissao: get(colIndex.dataEmissao),
      }
    })

    return { rows, fileName: file.name, rawMatrix: matrix }
  }

  global.ConciliacaoParsers = {
    ConciliacaoImportError,
    parseSefazCsv,
    parseSistemaXlsx,
    MSG_ARQUIVO_INVALIDO,
    MSG_ARQUIVO_VAZIO,
    MSG_FORMATO_INVALIDO,
  }
})(typeof window !== 'undefined' ? window : globalThis)
